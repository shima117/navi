import { dialog, ipcMain } from 'electron';
import { realpath } from 'node:fs/promises';
import { IPC } from '../ipc';
import type { AppContext } from '../context';
import type { Feature } from './Feature';
import { detectTaskIntent } from '../../src/core/tasks/TaskIntent';
import { formatTaskSnapshots, type TaskSnapshot } from '../../src/core/tasks/TaskSnapshotPublisher';
import { TASK_TERMINAL, type TaskControl } from '../../src/core/tasks/TaskProtocol';
import { approveOpenAiText } from '../../src/core/cloud/OpenAiApproval';

let notices = new Map<string, TaskSnapshot>();
let noticeTimer: ReturnType<typeof setInterval> | null = null;
let selectingProject = false;
let selectingCloud = false;
let consentEpoch = 0;

async function inspectProject(ctx: AppContext): Promise<string | null> {
  if (selectingProject || selectingCloud || !ctx.windows.main) return null;
  selectingProject = true;
  const epoch = consentEpoch;
  try {
    const choice = await dialog.showOpenDialog(ctx.windows.main, { title: '読み取り確認するプロジェクトを選ぶ', properties: ['openDirectory'] });
    if (choice.canceled || !choice.filePaths[0] || epoch !== consentEpoch) return null;
    const root = await realpath(choice.filePaths[0]);
    if (epoch !== consentEpoch || !ctx.windows.main) return null;
    const confirmation = await dialog.showMessageBox(ctx.windows.main, {
      type: 'question', title: 'プロジェクトの読み取り確認', message: 'このプロジェクトだけを読み取り確認しますか？',
      detail: `対象: ${root}\n読むもの: package.json（最大1MB）の形式だけ\n行わないこと: ファイル変更、scripts実行、再帰スキャン、モデル・Cloudへの内容送信\n料金: 外部APIを使用しません\n承認範囲: この1作業、15分間、再起動で失効\n承認しない場合: 読み取りせずに戻ります`,
      buttons: ['やめる', 'この作業だけ許可'], defaultId: 0, cancelId: 0, noLink: true,
    });
    if (confirmation.response !== 1 || epoch !== consentEpoch) return null;
    return ctx.agent.enqueueProject(root);
  } finally { selectingProject = false; }
}

function formatResult(snapshot?: TaskSnapshot): string {
  const report = snapshot?.lastReport;
  if (!report) return 'まだ確認結果はありません。';
  return `${snapshot!.title}\n${report.summary}${report.reason ? `\n理由: ${report.reason}` : ''}${report.verification ? `\n確認: ${report.verification.result}` : ''}${report.nextAction ? `\n次は: ${report.nextAction}` : ''}`;
}

export const agentFeature: Feature = {
  name: 'agent',
  setup(ctx) {
    const mainOnly = (event: Electron.IpcMainInvokeEvent) => {
      if (event.sender.id !== ctx.windows.main?.webContents.id || event.senderFrame !== event.sender.mainFrame) throw new Error('Task access denied');
    };
    ipcMain.handle(IPC.tasksStartHealth, (event, key?: unknown) => {
      mainOnly(event);
      if (key !== undefined && (typeof key !== 'string' || !/^[a-z0-9-]{1,80}$/i.test(key))) throw new Error('Invalid idempotency key');
      return ctx.agent.enqueue('LOCAL_HEALTH', undefined, key as string | undefined);
    });
    ipcMain.handle(IPC.tasksInspectProject, (event) => { mainOnly(event); return inspectProject(ctx); });
    ipcMain.handle(IPC.tasksCloudState, (event) => { mainOnly(event); return ctx.agent.cloudState(); });
    ipcMain.handle(IPC.tasksOpenAiText, async (event, input: unknown) => {
      mainOnly(event);
      if (selectingCloud || selectingProject || !ctx.windows.main) return null;
      selectingCloud = true;
      const epoch = consentEpoch;
      try {
        return await approveOpenAiText(input, ctx.agent.cloudState(), Date.now(), async (detail) => {
          if (!ctx.windows.main) return false;
          const result = await dialog.showMessageBox(ctx.windows.main, {
            type: 'question', title: 'OpenAIへの外部送信・料金確認', message: 'この文章だけをOpenAI APIに送りますか？', detail,
            buttons: ['送らない', 'この1回だけ送信を許可'], defaultId: 0, cancelId: 0, noLink: true,
          });
          return result.response === 1;
        }, () => epoch === consentEpoch && Boolean(ctx.windows.main), (payload) => ctx.agent.enqueueOpenAi(payload));
      } finally { selectingCloud = false; }
    });
    ipcMain.handle(IPC.tasksApprovals, (event) => { mainOnly(event); return ctx.agent.listApprovals(); });
    ipcMain.handle(IPC.tasksControl, (event, command: TaskControl, id?: unknown) => {
      mainOnly(event);
      if (!['PAUSE', 'RESUME', 'CANCEL', 'PRIORITIZE', 'DEPRIORITIZE'].includes(command) || (id !== undefined && (typeof id !== 'string' || !ctx.tasks.read(id)))) throw new Error('Invalid task control');
      if (command === 'CANCEL' || command === 'PAUSE') consentEpoch++;
      ctx.agent.control(command, id as string | undefined);
    });
    ipcMain.handle(IPC.tasksAgentState, (event) => { mainOnly(event); return ctx.agent.status(); });
    ctx.taskCommand = (text, turnId) => {
      const intent = detectTaskIntent(text);
      if (intent.type === 'none') return null;
      try {
        if (intent.type === 'start') {
          if (intent.kind === 'PROJECT_INSPECT') {
            void inspectProject(ctx).catch(() => ctx.windows.showText('プロジェクトを確認できませんでした。選んだフォルダと作業サービスを確認してください。', 'RESULT', 'FAILED'));
            return '対象のフォルダを選んでください。ファイルは変更せずに確認します。';
          }
          ctx.agent.enqueue('LOCAL_HEALTH', undefined, undefined, turnId);
          return '確認します。裏で進めるので、そのまま話していて大丈夫です。';
        }
        const tasks = ctx.tasks.list();
        if (intent.type === 'result') return formatResult([...tasks].filter((t) => t.lastReport).sort((a, b) => b.lastUpdateAt - a.lastUpdateAt)[0]);
        if (intent.type === 'status') {
          const selected = tasks.filter((t) => intent.target ? t.title.includes(intent.target === 'project' ? 'プロジェクト' : '環境') : !TASK_TERMINAL.has(t.status));
          return formatTaskSnapshots(selected.length ? selected : tasks.slice(-1));
        }
        if (intent.command === 'CANCEL' || intent.command === 'PAUSE') consentEpoch++;
        const eligible = tasks.filter((t) => !TASK_TERMINAL.has(t.status) && (intent.command !== 'RESUME' || t.status === 'PAUSED' || t.status === 'WAITING'));
        if (!eligible.length) return '今は操作できる裏作業はありません。';
        if (!intent.all && eligible.length > 1) return '作業が複数あります。作業タブで対象を選んでください。';
        ctx.agent.control(intent.command, intent.all ? undefined : eligible[0]!.id);
        if (intent.command === 'CANCEL') notices.clear();
        return intent.command === 'CANCEL' ? '裏作業を止めますね。' : intent.command === 'PAUSE' ? '一旦止めますね。' : intent.command === 'RESUME' ? '続けますね。' : '作業の順番を変えますね。';
      } catch (err) { return err instanceof Error ? err.message : '作業を開始できませんでした。'; }
    };
    ctx.bus.on('task.report', (snapshot) => {
      if (notices.size >= 32) notices.delete(notices.keys().next().value!);
      notices.set(snapshot.id, snapshot);
    });
    ctx.bus.on('voice.partial', ({ text, source }) => {
      if (source !== 'USER_MIC') return;
      const intent = detectTaskIntent(text);
      if (intent.type === 'control' && intent.command === 'CANCEL' && (selectingProject || selectingCloud || ctx.tasks.list().some((t) => !TASK_TERMINAL.has(t.status)))) {
        consentEpoch++;
        try { ctx.agent.control('CANCEL'); notices.clear(); } catch { /* Worker already stopped. */ }
      }
    });
  },
  start(ctx) {
    notices = new Map();
    ctx.agent.start();
    noticeTimer = setInterval(() => {
      const snapshot = notices.values().next().value as TaskSnapshot | undefined;
      if (snapshot && ctx.orchestrator.reportTask(snapshot)) notices.delete(snapshot.id);
    }, 2000);
  },
  async stop(ctx) {
    consentEpoch++;
    if (noticeTimer) clearInterval(noticeTimer);
    notices.clear();
    ctx.taskCommand = undefined;
    await ctx.agent.stop();
  },
};

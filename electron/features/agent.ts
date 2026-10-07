import { dialog, ipcMain } from 'electron';
import { realpath } from 'node:fs/promises';
import { IPC } from '../ipc';
import type { AppContext } from '../context';
import type { Feature } from './Feature';
import { detectTaskIntent } from '../../src/core/tasks/TaskIntent';
import { formatTaskSnapshots, type TaskSnapshot } from '../../src/core/tasks/TaskSnapshotPublisher';
import { TASK_TERMINAL, type TaskControl } from '../../src/core/tasks/TaskProtocol';

let notices = new Map<string, TaskSnapshot>();
let noticeTimer: ReturnType<typeof setInterval> | null = null;
let selectingProject = false;

async function inspectProject(ctx: AppContext): Promise<string | null> {
  if (selectingProject || !ctx.windows.main) return null;
  selectingProject = true;
  try {
    const choice = await dialog.showOpenDialog(ctx.windows.main, { title: '読み取り確認するプロジェクトを選ぶ', properties: ['openDirectory'] });
    if (choice.canceled || !choice.filePaths[0]) return null;
    const root = await realpath(choice.filePaths[0]);
    return ctx.agent.enqueue('PROJECT_INSPECT', root);
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
    const mainOnly = (id: number) => { if (id !== ctx.windows.main?.webContents.id) throw new Error('Task access denied'); };
    ipcMain.handle(IPC.tasksStartHealth, (event, key?: unknown) => {
      mainOnly(event.sender.id);
      if (key !== undefined && (typeof key !== 'string' || !/^[a-z0-9-]{1,80}$/i.test(key))) throw new Error('Invalid idempotency key');
      return ctx.agent.enqueue('LOCAL_HEALTH', undefined, key as string | undefined);
    });
    ipcMain.handle(IPC.tasksInspectProject, (event) => { mainOnly(event.sender.id); return inspectProject(ctx); });
    ipcMain.handle(IPC.tasksControl, (event, command: TaskControl, id?: unknown) => {
      mainOnly(event.sender.id);
      if (!['PAUSE', 'RESUME', 'CANCEL', 'PRIORITIZE', 'DEPRIORITIZE'].includes(command) || (id !== undefined && (typeof id !== 'string' || !ctx.tasks.read(id)))) throw new Error('Invalid task control');
      ctx.agent.control(command, id as string | undefined);
    });
    ipcMain.handle(IPC.tasksAgentState, (event) => { mainOnly(event.sender.id); return ctx.agent.status(); });
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
      if (intent.type === 'control' && intent.command === 'CANCEL' && ctx.tasks.list().some((t) => !TASK_TERMINAL.has(t.status))) {
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
    if (noticeTimer) clearInterval(noticeTimer);
    notices.clear();
    ctx.taskCommand = undefined;
    await ctx.agent.stop();
  },
};

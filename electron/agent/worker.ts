import { DatabaseSync } from 'node:sqlite';
import { openSqliteDb } from '../../src/core/memory/Db';
import { TaskDatabase } from '../../src/core/tasks/TaskDatabase';
import { TaskEngine } from '../../src/core/tasks/TaskEngine';
import { ApprovalStore } from '../../src/core/tasks/ApprovalStore';
import { PolicyEngine } from '../../src/core/tasks/PolicyEngine';
import { runLocalTask } from '../../src/core/tasks/LocalTaskRunner';
import type { AgentCommand, AgentEvent } from '../../src/core/tasks/TaskProtocol';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { OpenAiLedger } from '../../src/core/cloud/OpenAiLedger';
import { openAiRunner } from '../../src/core/cloud/OpenAiClient';

const port = process.parentPort;
const send = (event: AgentEvent) => port.postMessage(event);
let engine: TaskEngine | null = null;
let db: TaskDatabase | null = null;
let shutdown = false;

async function stop(): Promise<void> {
  if (shutdown) return;
  shutdown = true;
  await engine?.stop();
  db?.close();
  process.exit(0);
}

void (async () => {
  const dir = process.env.NAVI_AGENT_DATA;
  if (!dir || !path.isAbsolute(dir)) throw new Error('Agent data directory unavailable');
  await fs.mkdir(dir, { recursive: true });
  const connection = openSqliteDb(DatabaseSync, path.join(dir, 'tasks.sqlite'));
  db = new TaskDatabase(connection);
  const approvals = new ApprovalStore(connection);
  approvals.invalidateSession();
  const cloud = new OpenAiLedger(connection);
  cloud.invalidateSession();
  const cloudState = () => cloud.state(Boolean(process.env.OPENAI_API_KEY));
  const remote = openAiRunner(cloud, () => process.env.OPENAI_API_KEY);
  const policy = new PolicyEngine(approvals, cloud);
  engine = new TaskEngine(db, async (...args) => {
    try { return await (args[0].kind === 'OPENAI_TEXT' ? remote : runLocalTask)(...args); }
    finally { send({ type: 'cloud', state: cloudState() }); }
  }, send, Date.now, 2, policy);
  port.on('message', ({ data }: { data: AgentCommand }) => {
    if (shutdown || !data || typeof data !== 'object') return;
    try {
      if (data.type === 'enqueue') {
        // Only trusted native main sends this envelope. Task payloads cannot mint approval.
        if (data.consent) {
          if (data.request.kind !== 'PROJECT_INSPECT' || data.consent.taskId !== data.request.id
            || data.consent.id !== data.request.approvalId || data.consent.projectRoot !== data.request.projectRoot) throw new Error('Consent scope mismatch');
          approvals.grantProject(data.consent);
        }
        if (data.cloudConsent) {
          if (data.request.kind !== 'OPENAI_TEXT' || !data.request.cloud || data.cloudConsent.taskId !== data.request.id
            || data.cloudConsent.id !== data.request.approvalId) throw new Error('OpenAI consent scope mismatch');
          cloud.grant(data.cloudConsent, data.request.cloud);
        }
        engine!.enqueue(data.request);
        send({ type: 'approvals', records: approvals.list() });
        send({ type: 'cloud', state: cloudState() });
      }
      else if (data.type === 'control' && ['PAUSE', 'RESUME', 'CANCEL', 'PRIORITIZE', 'DEPRIORITIZE'].includes(data.command)) {
        engine!.control(data.command, data.id);
        send({ type: 'approvals', records: approvals.list() });
        send({ type: 'cloud', state: cloudState() });
      }
      else if (data.type === 'shutdown') void stop();
      else throw new Error('Unknown agent command');
    } catch (err) {
      send({ type: 'unavailable', reason: err instanceof Error ? err.message.slice(0, 300) : '作業処理でエラーが発生しました。' });
    }
  });
  send({ type: 'ready', pid: process.pid, snapshots: engine.list(), approvals: approvals.list(), cloud: cloudState() });
  // Refresh UTC day/month rollover even when no tasks run; main only reads the cache.
  setInterval(() => {
    try { send({ type: 'cloud', state: cloudState() }); }
    catch { send({ type: 'unavailable', reason: 'OpenAIの利用記録を確認できないため、作業サービスを停止します。' }); }
  }, 60000).unref();
})().catch(() => { send({ type: 'unavailable', reason: '作業用データを開けませんでした。保存先を確認してください。' }); process.exit(1); });
process.on('SIGTERM', () => void stop());

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
  const policy = new PolicyEngine(approvals);
  engine = new TaskEngine(db, runLocalTask, send, Date.now, 2, policy);
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
        engine!.enqueue(data.request);
        send({ type: 'approvals', records: approvals.list() });
      }
      else if (data.type === 'control' && ['PAUSE', 'RESUME', 'CANCEL', 'PRIORITIZE', 'DEPRIORITIZE'].includes(data.command)) {
        engine!.control(data.command, data.id);
        send({ type: 'approvals', records: approvals.list() });
      }
      else if (data.type === 'shutdown') void stop();
      else throw new Error('Unknown agent command');
    } catch (err) {
      send({ type: 'unavailable', reason: err instanceof Error ? err.message.slice(0, 300) : '作業処理でエラーが発生しました。' });
    }
  });
  send({ type: 'ready', pid: process.pid, snapshots: engine.list(), approvals: approvals.list() });
})().catch(() => { send({ type: 'unavailable', reason: '作業用データを開けませんでした。保存先を確認してください。' }); process.exit(1); });
process.on('SIGTERM', () => void stop());

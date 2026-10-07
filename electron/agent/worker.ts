import { DatabaseSync } from 'node:sqlite';
import { openSqliteDb } from '../../src/core/memory/Db';
import { TaskDatabase } from '../../src/core/tasks/TaskDatabase';
import { TaskEngine } from '../../src/core/tasks/TaskEngine';
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
  db = new TaskDatabase(openSqliteDb(DatabaseSync, path.join(dir, 'tasks.sqlite')));
  engine = new TaskEngine(db, runLocalTask, send);
  port.on('message', ({ data }: { data: AgentCommand }) => {
    if (shutdown || !data || typeof data !== 'object') return;
    try {
      if (data.type === 'enqueue') engine!.enqueue(data.request);
      else if (data.type === 'control' && ['PAUSE', 'RESUME', 'CANCEL', 'PRIORITIZE', 'DEPRIORITIZE'].includes(data.command)) engine!.control(data.command, data.id);
      else if (data.type === 'shutdown') void stop();
      else throw new Error('Unknown agent command');
    } catch (err) {
      send({ type: 'unavailable', reason: err instanceof Error ? err.message.slice(0, 300) : '作業処理でエラーが発生しました。' });
    }
  });
  send({ type: 'ready', pid: process.pid, snapshots: engine.list() });
})().catch(() => { send({ type: 'unavailable', reason: '作業用データを開けませんでした。保存先を確認してください。' }); process.exit(1); });
process.on('SIGTERM', () => void stop());

import type { TaskSnapshot } from './TaskSnapshotPublisher';
import type { OperationReport } from './OperationReport';
import type { ApprovalRecord, ProjectConsent } from './ApprovalStore';
import type { CloudConsent, OpenAiPayload } from '../cloud/OpenAiScope';
import type { OpenAiCloudState } from '../cloud/OpenAiOptions';

export type TaskKind = 'LOCAL_HEALTH' | 'PROJECT_INSPECT' | 'OPENAI_TEXT';
export type TaskControl = 'PAUSE' | 'RESUME' | 'CANCEL' | 'PRIORITIZE' | 'DEPRIORITIZE';
export interface TaskRequest {
  id: string;
  idempotencyKey: string;
  kind: TaskKind;
  projectRoot?: string;
  approvalId?: string;
  cloud?: OpenAiPayload;
  traceId: string;
  turnId?: string;
  createdAt: number;
}
export interface TaskRecord {
  request: TaskRequest;
  snapshot: TaskSnapshot;
  attempts: number;
  startedAt: number | null;
  endedAt: number | null;
  lastFailure?: { signature: string; consecutive: number };
}
export type AgentCommand =
  | { type: 'enqueue'; request: TaskRequest; consent?: ProjectConsent; cloudConsent?: CloudConsent }
  | { type: 'control'; command: TaskControl; id?: string }
  | { type: 'shutdown' };
export type AgentEvent =
  | { type: 'ready'; pid: number; snapshots: TaskSnapshot[]; approvals: ApprovalRecord[]; cloud?: OpenAiCloudState }
  | { type: 'cloud'; state: OpenAiCloudState }
  | { type: 'approvals'; records: ApprovalRecord[] }
  | { type: 'snapshot'; snapshot: TaskSnapshot; report?: OperationReport }
  | { type: 'unavailable'; reason: string };

export const TASK_TERMINAL = new Set<TaskSnapshot['status']>(['DONE', 'FAILED', 'CANCELLED']);
export function validTaskRequest(value: unknown): value is TaskRequest {
  if (!value || typeof value !== 'object') return false;
  const r = value as TaskRequest;
  return typeof r.id === 'string' && /^[a-z0-9-]{1,80}$/i.test(r.id)
    && typeof r.idempotencyKey === 'string' && /^[a-z0-9-]{1,80}$/i.test(r.idempotencyKey)
    && (r.kind === 'LOCAL_HEALTH' || r.kind === 'PROJECT_INSPECT' || r.kind === 'OPENAI_TEXT')
    && typeof r.traceId === 'string' && r.traceId.length <= 80
    && Number.isFinite(r.createdAt)
    && (r.approvalId === undefined || (typeof r.approvalId === 'string' && /^[a-z0-9-]{1,80}$/i.test(r.approvalId)))
    && (r.kind !== 'PROJECT_INSPECT' || (typeof r.projectRoot === 'string' && r.projectRoot.length > 0 && r.projectRoot.length <= 4096));
}

export function initialTask(request: TaskRequest): TaskRecord {
  return { request, attempts: 0, startedAt: null, endedAt: null, snapshot: {
    id: request.id, title: request.kind === 'LOCAL_HEALTH' ? 'NAVIの環境確認' : request.kind === 'OPENAI_TEXT' ? 'OpenAIへの文章相談' : 'プロジェクトの読み取り確認',
    status: 'PLANNING', phase: 'queue', currentAction: '裏作業の順番を待っています。',
    progress: null, eta: null, lastUpdateAt: request.createdAt,
  } };
}

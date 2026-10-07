import path from 'node:path';
import type { ApprovalStore } from './ApprovalStore';
import type { TaskRequest } from './TaskProtocol';

export type PolicyDecision = { state: 'ALLOW' } | { state: 'DENY' | 'NEEDS_APPROVAL'; reason: string };
export function checkCapability(kind: unknown): void {
  if (kind !== 'LOCAL_HEALTH' && kind !== 'PROJECT_INSPECT') throw new Error('この操作は許可されていません。');
}
/** Deny by default. No model, approval flag or settings toggle can enable a new capability. */
export class PolicyEngine {
  constructor(private readonly approvals?: ApprovalStore) {}
  authorize(request: TaskRequest): PolicyDecision {
    try { checkCapability(request.kind); } catch { return { state: 'DENY', reason: 'この操作は許可されていません。' }; }
    if (request.kind === 'LOCAL_HEALTH') {
      if (request.projectRoot !== undefined || request.approvalId !== undefined) return { state: 'DENY', reason: '環境確認の対象は固定されています。' };
      return { state: 'ALLOW' };
    }
    if (!request.projectRoot || !path.isAbsolute(request.projectRoot) || path.resolve(request.projectRoot) !== request.projectRoot)
      return { state: 'DENY', reason: '明示選択したプロジェクトの絶対パスが必要です。' };
    if (!this.approvals?.authorize(request)) return { state: 'NEEDS_APPROVAL', reason: '読み取り承認がないか、期限切れ・撤回済みです。対象をもう一度選び、確認してください。' };
    return { state: 'ALLOW' };
  }
  cancel(request: TaskRequest): void { this.approvals?.revokeTask(request.id); }
}

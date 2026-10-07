export interface OperationReport {
  taskId: string;
  action: string;
  state: 'STARTING' | 'SUCCESS' | 'FAILED' | 'PARTIAL' | 'WAITING_USER';
  summary: string;
  reason?: string;
  verified: boolean;
  verification?: { method: 'EXIT_CODE' | 'BUILD' | 'FILE' | 'HTTP' | 'CHECKSUM'; result: 'PASS' | 'FAIL'; evidence: string };
  nextAction?: string;
  timestamp: number;
}

/** Workers must supply observable evidence; an LLM summary is not evidence. */
export function isVerifiedSuccess(report: OperationReport | undefined, taskId: string): boolean {
  return report?.taskId === taskId && report.state === 'SUCCESS' && report.verified === true
    && report.verification?.result === 'PASS'
    && ['EXIT_CODE', 'BUILD', 'FILE', 'HTTP', 'CHECKSUM'].includes(report.verification.method)
    && report.verification.evidence.trim().length > 0;
}

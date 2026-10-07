/** Reconnect schedule from design doc §19: 1, 2, 5, 10, 30 s, then 30 s forever. */
export const RECONNECT_SCHEDULE_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;

export function backoffDelay(attempt: number): number {
  return RECONNECT_SCHEDULE_MS[Math.min(attempt, RECONNECT_SCHEDULE_MS.length - 1)]!;
}

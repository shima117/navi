/**
 * VRAM readout for the Diagnostics tab (§4: a 12 GB GPU is shared with the game).
 * Parses `nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader,nounits`.
 */
export const NVIDIA_SMI_ARGS = ['--query-gpu=memory.used,memory.total', '--format=csv,noheader,nounits'] as const;

export interface VramReading {
  /** First GPU (the one games normally render on). */
  usedMiB: number;
  totalMiB: number;
  /** GPUs reported by nvidia-smi. */
  gpus: number;
}

/** Null for anything that is not a usable reading (no GPU, driver error text, …). */
export function parseNvidiaSmi(stdout: string): VramReading | null {
  const rows = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split(',').map((c) => Number(c.trim())))
    .filter((r) => r.length === 2 && r.every((n) => Number.isFinite(n) && n >= 0));
  const first = rows[0];
  if (!first || first[1]! <= 0) return null;
  return { usedMiB: first[0]!, totalMiB: first[1]!, gpus: rows.length };
}

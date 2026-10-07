from __future__ import annotations

import numpy as np


def pcm16_to_mono_16k(pcm: bytes, sample_rate: int, channels: int = 1) -> bytes:
    """Mix PCM16 to mono and linearly resample without changing host device rates."""
    if sample_rate <= 0 or channels <= 0:
        raise ValueError("invalid audio format")
    raw = np.frombuffer(pcm[: len(pcm) - (len(pcm) % 2)], dtype=np.int16)
    if raw.size == 0:
        return b""
    if channels > 1:
        frames = raw.size // channels
        raw = raw[: frames * channels].reshape(frames, channels).astype(np.float32).mean(axis=1)
    else:
        raw = raw.astype(np.float32)
    if sample_rate != 16_000 and raw.size > 1:
        out_len = max(1, round(raw.size * 16_000 / sample_rate))
        source_x = np.arange(raw.size, dtype=np.float64)
        target_x = np.linspace(0, raw.size - 1, out_len, dtype=np.float64)
        raw = np.interp(target_x, source_x, raw)
    return np.clip(np.rint(raw), -32768, 32767).astype(np.int16).tobytes()


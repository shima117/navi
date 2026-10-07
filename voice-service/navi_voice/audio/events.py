"""Conservative acoustic activity classification for SYSTEM audio.

This detects a sudden transient, not its real-world cause. Game-specific
labels such as gunshots require a trained classifier and corroborating context.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class AudioEvent:
    type: str
    confidence: float
    at: int

    def json(self) -> dict:
        return {"type": self.type, "confidence": self.confidence, "at": self.at}


class AudioEventClassifier:
    def __init__(self, cooldown_ms: int = 1_000) -> None:
        self.background = 0.01
        self.last_event_at = -1_000_000_000
        self.cooldown_ms = cooldown_ms

    def process(self, pcm16: bytes, at_ms: int) -> AudioEvent | None:
        samples = np.frombuffer(pcm16[: len(pcm16) - len(pcm16) % 2], dtype=np.int16)
        if samples.size < 160:
            return None
        signal = samples.astype(np.float32) / 32768.0
        rms = float(np.sqrt(np.mean(np.square(signal))))
        peak = float(np.max(np.abs(signal)))
        prior = self.background
        self.background = 0.985 * prior + 0.015 * min(rms, prior * 2 + 0.02)
        if (
            rms < 0.1
            or peak < 0.35
            or rms < max(0.1, prior * 3.0)
            or at_ms - self.last_event_at < self.cooldown_ms
        ):
            return None
        self.last_event_at = at_ms
        confidence = min(0.65, 0.35 + (rms - 0.1) * 0.8)
        return AudioEvent("transient_candidate", round(confidence, 3), at_ms)


def classify_recent(pcm16: bytes, at_ms: int, sample_rate: int = 16_000) -> AudioEvent | None:
    """Inspect up to six seconds of RAM audio when the user asks about a sound."""
    classifier = AudioEventClassifier()
    frame_bytes = sample_rate * 2 // 10
    last: AudioEvent | None = None
    chunks = [pcm16[index:index + frame_bytes] for index in range(0, len(pcm16), frame_bytes)]
    origin = at_ms - len(chunks) * 100
    for index, chunk in enumerate(chunks):
        event = classifier.process(chunk, origin + index * 100)
        if event is not None:
            last = event
    return last

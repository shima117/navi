from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .resampler import pcm16_to_mono_16k
from .ring_buffer import PcmRingBuffer
from .sources import AudioSource


@dataclass(frozen=True)
class RoutedAudio:
    source: AudioSource
    pcm16_mono_16k: bytes
    rms: float


class AudioRouter:
    def __init__(self) -> None:
        self.rings = {
            AudioSource.USER_MIC: PcmRingBuffer(30),
            AudioSource.SYSTEM: PcmRingBuffer(20),
            AudioSource.REMOTE: PcmRingBuffer(30),
            AudioSource.NAVI_RAW: PcmRingBuffer(30),
            AudioSource.NAVI_FINAL: PcmRingBuffer(30),
        }

    def route(self, source: AudioSource, pcm: bytes, sample_rate: int, channels: int = 1) -> RoutedAudio:
        converted = pcm16_to_mono_16k(pcm, sample_rate, channels)
        self.rings[source].append(converted)
        samples = np.frombuffer(converted, dtype=np.int16).astype(np.float32)
        rms = float(np.sqrt(np.mean(np.square(samples / 32768.0)))) if samples.size else 0.0
        return RoutedAudio(source, converted, rms)

    def recent(self, source: AudioSource, seconds: float) -> bytes:
        return self.rings[source].recent(seconds)


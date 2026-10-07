"""Streaming speech segmentation driven by per-frame VAD decisions (design doc §11.1).

Kept free of audio/ML dependencies so it can be unit-tested directly.
"""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from typing import Deque, List, Optional

SAMPLE_RATE = 16_000
FRAME_MS = 30
FRAME_SAMPLES = SAMPLE_RATE * FRAME_MS // 1000  # 480
FRAME_BYTES = FRAME_SAMPLES * 2  # int16 mono


@dataclass
class SegmenterConfig:
    start_frames: int = 3  # ~90 ms of voice before we call it speech
    end_frames: int = 20  # ~600 ms of silence ends an utterance
    preroll_frames: int = 10  # keep ~300 ms before the detected start
    max_frames: int = 1000  # 30 s hard cap
    min_speech_frames: int = 8  # ignore blips shorter than ~240 ms


@dataclass
class SegmentEvent:
    kind: str  # "speech_started" | "speech_ended"
    audio: Optional[bytes] = None  # set on speech_ended when long enough to transcribe


@dataclass
class Segmenter:
    config: SegmenterConfig = field(default_factory=SegmenterConfig)
    _preroll: Deque[bytes] = field(default_factory=deque)
    _speech: List[bytes] = field(default_factory=list)
    _voiced_run: int = 0
    _silent_run: int = 0
    _voiced_total: int = 0
    _in_speech: bool = False

    def push(self, frame: bytes, is_voiced: bool) -> List[SegmentEvent]:
        events: List[SegmentEvent] = []
        cfg = self.config
        if not self._in_speech:
            self._preroll.append(frame)
            while len(self._preroll) > cfg.preroll_frames:
                self._preroll.popleft()
            self._voiced_run = self._voiced_run + 1 if is_voiced else 0
            if self._voiced_run >= cfg.start_frames:
                self._in_speech = True
                self._speech = list(self._preroll)
                self._preroll.clear()
                self._silent_run = 0
                self._voiced_total = self._voiced_run
                events.append(SegmentEvent("speech_started"))
            return events

        self._speech.append(frame)
        if is_voiced:
            self._silent_run = 0
            self._voiced_total += 1
        else:
            self._silent_run += 1
        if self._silent_run >= cfg.end_frames or len(self._speech) >= cfg.max_frames:
            audio = b"".join(self._speech) if self._voiced_total >= cfg.min_speech_frames else None
            events.append(SegmentEvent("speech_ended", audio))
            self._in_speech = False
            self._speech = []
            self._voiced_run = 0
            self._voiced_total = 0
        return events


class FrameAssembler:
    """Re-chunks arbitrary int16 byte chunks into fixed 30 ms frames."""

    def __init__(self) -> None:
        self._buf = bytearray()

    def feed(self, chunk: bytes) -> List[bytes]:
        self._buf.extend(chunk)
        frames = []
        while len(self._buf) >= FRAME_BYTES:
            frames.append(bytes(self._buf[:FRAME_BYTES]))
            del self._buf[:FRAME_BYTES]
        return frames

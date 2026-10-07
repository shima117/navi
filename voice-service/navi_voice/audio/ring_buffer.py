from __future__ import annotations

from collections import deque
from threading import RLock


class PcmRingBuffer:
    """Bounded PCM16 mono buffer. Contents are never written to disk."""

    def __init__(self, seconds: float, sample_rate: int = 16_000) -> None:
        if seconds <= 0 or sample_rate <= 0:
            raise ValueError("seconds and sample_rate must be positive")
        self.sample_rate = sample_rate
        self.capacity = int(seconds * sample_rate) * 2
        self._chunks: deque[bytes] = deque()
        self._size = 0
        self._lock = RLock()

    def append(self, pcm: bytes) -> None:
        if not pcm:
            return
        # Preserve int16 alignment and only retain the newest capacity bytes.
        chunk = bytes(pcm[: len(pcm) - (len(pcm) % 2)])
        if len(chunk) > self.capacity:
            chunk = chunk[-self.capacity :]
        with self._lock:
            self._chunks.append(chunk)
            self._size += len(chunk)
            while self._size > self.capacity and self._chunks:
                excess = self._size - self.capacity
                first = self._chunks[0]
                if len(first) <= excess:
                    self._size -= len(self._chunks.popleft())
                else:
                    self._chunks[0] = first[excess - (excess % 2) :]
                    self._size = sum(map(len, self._chunks))

    def recent(self, seconds: float) -> bytes:
        wanted = max(0, min(self.capacity, int(seconds * self.sample_rate) * 2))
        with self._lock:
            data = b"".join(self._chunks)
        return data[-wanted:] if wanted else b""

    @property
    def duration(self) -> float:
        with self._lock:
            return self._size / 2 / self.sample_rate

    def clear(self) -> None:
        with self._lock:
            self._chunks.clear()
            self._size = 0


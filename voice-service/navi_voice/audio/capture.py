from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Callable

from .sources import AudioSource

try:
    import sounddevice as sd
except Exception:  # optional until installed on Windows
    sd = None


@dataclass(frozen=True)
class AudioDevice:
    id: str
    name: str
    kind: str
    channels: int
    sample_rate: int

    def json(self) -> dict:
        return asdict(self)


def list_devices() -> list[AudioDevice]:
    if sd is None:
        return []
    result: list[AudioDevice] = []
    for index, raw in enumerate(sd.query_devices()):
        rate = int(raw.get("default_samplerate") or 48_000)
        if int(raw.get("max_input_channels") or 0) > 0:
            result.append(AudioDevice(str(index), str(raw["name"]), "input", int(raw["max_input_channels"]), rate))
        if int(raw.get("max_output_channels") or 0) > 0:
            result.append(AudioDevice(str(index), str(raw["name"]), "output", int(raw["max_output_channels"]), rate))
    return result


def find_input_device(*tokens: str) -> AudioDevice | None:
    lowered = [t.lower() for t in tokens if t]
    for device in list_devices():
        name = device.name.lower()
        if device.kind == "input" and any(token in name for token in lowered):
            return device
    return None


class InputCapture:
    """Thin optional sounddevice stream; callback receives raw PCM and format."""

    def __init__(self, source: AudioSource, device_id: str, callback: Callable[[AudioSource, bytes, int, int], None]) -> None:
        if sd is None:
            raise RuntimeError("sounddevice is not installed")
        self.source = source
        self.device_id = int(device_id)
        self.callback = callback
        info = sd.query_devices(self.device_id, "input")
        self.sample_rate = int(info.get("default_samplerate") or 48_000)
        self.channels = max(1, min(2, int(info.get("max_input_channels") or 1)))
        self._stream = None

    def start(self) -> None:
        def receive(data, _frames, _time, status) -> None:
            if status:
                # PortAudio status is diagnostic only; losing one block must not stop conversation.
                pass
            self.callback(self.source, bytes(data), self.sample_rate, self.channels)

        self._stream = sd.RawInputStream(
            device=self.device_id,
            samplerate=self.sample_rate,
            channels=self.channels,
            dtype="int16",
            callback=receive,
            blocksize=0,
        )
        self._stream.start()

    def stop(self) -> None:
        if self._stream is not None:
            self._stream.stop()
            self._stream.close()
            self._stream = None


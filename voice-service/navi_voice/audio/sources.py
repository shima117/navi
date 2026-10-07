from __future__ import annotations

from enum import Enum


class AudioSource(str, Enum):
    USER_MIC = "USER_MIC"
    SYSTEM = "SYSTEM"
    REMOTE = "REMOTE"
    NAVI_RAW = "NAVI_RAW"
    NAVI_FINAL = "NAVI_FINAL"

    @classmethod
    def parse(cls, value: str | None, default: "AudioSource" | None = None) -> "AudioSource":
        if value:
            try:
                return cls(value.upper())
            except ValueError as exc:
                raise ValueError(f"unknown audio source: {value!r}") from exc
        if default is not None:
            return default
        raise ValueError(f"unknown audio source: {value!r}")


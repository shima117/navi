from __future__ import annotations

import ctypes
import json
import os
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from threading import RLock


VM_TYPES = {1: "basic", 2: "banana", 3: "potato"}
ROUTES = ("A1", "A2", "A3", "A4", "A5", "B1", "B2", "B3")


@dataclass
class ChangedParameter:
    parameter: str
    before: float
    applied: float


@dataclass
class RoutingSnapshot:
    version: int = 1
    capturedAt: str = ""
    voicemeeterType: str = "unknown"
    strips: dict = field(default_factory=dict)
    buses: dict = field(default_factory=dict)
    changed: list[ChangedParameter] = field(default_factory=list)

    def json(self) -> dict:
        raw = asdict(self)
        raw["changed"] = [asdict(x) for x in self.changed]
        return raw


def _candidate_dlls() -> list[Path]:
    paths = []
    if os.environ.get("NAVI_VOICEMEETER_DLL"):
        paths.append(Path(os.environ["NAVI_VOICEMEETER_DLL"]))
    for root in (os.environ.get("PROGRAMFILES"), os.environ.get("PROGRAMFILES(X86)")):
        if root:
            paths.extend(
                [
                    Path(root) / "VB" / "Voicemeeter" / "VoicemeeterRemote64.dll",
                    Path(root) / "VB-Audio" / "Voicemeeter" / "VoicemeeterRemote64.dll",
                ]
            )
    return paths


class VoicemeeterController:
    """Minimal Remote API wrapper. Never writes Gain or sample-rate parameters."""

    def __init__(self, dll=None, state_dir: Path | None = None) -> None:
        self.dll = dll
        self._logged_in = False
        self._lock = RLock()
        self.state_dir = state_dir or Path(os.environ.get("NAVI_USER_DATA", Path.home() / ".navi"))
        self.snapshot_file = self.state_dir / "voicemeeter_snapshot.json"
        self.manual_snapshot_file = self.state_dir / "voicemeeter_manual_snapshot.json"
        self.crash_file = self.state_dir / "last_session_audio_state.json"

    def detect(self) -> dict:
        if self.dll is None:
            for path in _candidate_dlls():
                if path.exists():
                    try:
                        self.dll = ctypes.WinDLL(str(path))
                        break
                    except (OSError, AttributeError):
                        continue
        if self.dll is None:
            return {"connected": False, "type": "unknown", "dll": None}
        try:
            self.login()
            return {"connected": True, "type": self.vm_type(), "dll": "loaded"}
        except Exception as exc:
            return {"connected": False, "type": "unknown", "error": str(exc)}

    def login(self) -> None:
        if self.dll is None:
            raise RuntimeError("VoicemeeterRemote64.dll not found")
        if self._logged_in:
            return
        result = int(self.dll.VBVMR_Login())
        if result < 0:
            raise RuntimeError(f"VBVMR_Login failed: {result}")
        self._logged_in = True

    def logout(self) -> None:
        if self.dll is not None and self._logged_in:
            self.dll.VBVMR_Logout()
        self._logged_in = False

    def vm_type(self) -> str:
        self.login()
        value = ctypes.c_long()
        result = int(self.dll.VBVMR_GetVoicemeeterType(ctypes.byref(value)))
        if result < 0:
            raise RuntimeError(f"GetVoicemeeterType failed: {result}")
        return VM_TYPES.get(value.value, "unknown")

    def _get(self, parameter: str) -> float:
        self.login()
        value = ctypes.c_float()
        result = int(self.dll.VBVMR_GetParameterFloat(parameter.encode("ascii"), ctypes.byref(value)))
        if result < 0:
            raise RuntimeError(f"read {parameter} failed: {result}")
        return float(value.value)

    def _set(self, parameter: str, value: float) -> None:
        if ".Gain" in parameter:
            raise ValueError("NAVI must never change a Voicemeeter Gain parameter")
        self.login()
        result = int(self.dll.VBVMR_SetParameterFloat(parameter.encode("ascii"), ctypes.c_float(value)))
        if result < 0:
            raise RuntimeError(f"write {parameter} failed: {result}")

    def read_routing(self) -> RoutingSnapshot:
        vm_type = self.vm_type()
        if vm_type != "potato":
            return RoutingSnapshot(capturedAt=_iso_now(), voicemeeterType=vm_type)
        strips = {}
        for name, index in (("VAIO", 5), ("AUX", 6), ("VAIO3", 7)):
            strips[name] = {route: bool(round(self._get(f"Strip[{index}].{route}"))) for route in ROUTES}
        return RoutingSnapshot(capturedAt=_iso_now(), voicemeeterType=vm_type, strips=strips)

    def snapshot(self, save: bool = True) -> RoutingSnapshot:
        snapshot = self.read_routing()
        if save:
            self.state_dir.mkdir(parents=True, exist_ok=True)
            # A user-requested backup must not replace the active restore journal.
            self.manual_snapshot_file.write_text(json.dumps(snapshot.json(), ensure_ascii=False, indent=2), encoding="utf-8")
        return snapshot

    def auto_configure(self) -> RoutingSnapshot:
        with self._lock:
            # Re-applying while NAVI owns routes must retain the original values.
            pending = self.crash_recovery()["pending"]
            snapshot = self._load_restore_snapshot() if pending else self.read_routing()
            if snapshot.voicemeeterType != "potato":
                raise RuntimeError("Voicemeeter Potato is required for VAIO3 routing")
            if not pending:
                self.state_dir.mkdir(parents=True, exist_ok=True)
                self.snapshot_file.write_text(json.dumps(snapshot.json(), ensure_ascii=False, indent=2), encoding="utf-8")
                self._write_session_state(snapshot, active=True)
            # Potato virtual strips are 5=VAIO, 6=AUX, 7=VAIO3. Only disable feedback buses.
            for route in ("B1", "B2", "B3"):
                parameter = f"Strip[7].{route}"
                before = self._get(parameter)
                previous = next((change for change in snapshot.changed if change.parameter == parameter), None)
                # The user moved this route since NAVI applied it; a re-apply must respect that.
                if previous is not None:
                    continue
                if before != 0.0:
                    snapshot.changed.append(ChangedParameter(parameter, before, 0.0))
                    # Journal before the native write so a crash between routes is recoverable.
                    self.snapshot_file.write_text(json.dumps(snapshot.json(), ensure_ascii=False, indent=2), encoding="utf-8")
                    self._set(parameter, 0.0)
            return snapshot

    def restore(self, snapshot: RoutingSnapshot | None = None) -> dict:
        with self._lock:
            if snapshot is None:
                if not self.snapshot_file.exists():
                    return {"restored": 0, "skipped": 0}
                snapshot = self._load_restore_snapshot()
            restored = skipped = 0
            for change in snapshot.changed:
                if ".Gain" in change.parameter:
                    skipped += 1
                    continue
                # Difference-aware restore: only undo NAVI's value if the user did not change it.
                if abs(self._get(change.parameter) - change.applied) <= 0.001:
                    self._set(change.parameter, change.before)
                    restored += 1
                else:
                    skipped += 1
            self._write_session_state(snapshot, active=False)
            return {"restored": restored, "skipped": skipped}

    def _load_restore_snapshot(self) -> RoutingSnapshot:
        raw = json.loads(self.snapshot_file.read_text(encoding="utf-8"))
        return RoutingSnapshot(
            version=raw.get("version", 1),
            capturedAt=raw.get("capturedAt", ""),
            voicemeeterType=raw.get("voicemeeterType", "unknown"),
            strips=raw.get("strips", {}),
            buses=raw.get("buses", {}),
            changed=[ChangedParameter(**item) for item in raw.get("changed", [])],
        )

    def crash_recovery(self) -> dict:
        if not self.crash_file.exists():
            return {"pending": False}
        raw = json.loads(self.crash_file.read_text(encoding="utf-8"))
        return {"pending": bool(raw.get("active")), "capturedAt": raw.get("capturedAt")}

    def _write_session_state(self, snapshot: RoutingSnapshot, active: bool) -> None:
        self.state_dir.mkdir(parents=True, exist_ok=True)
        self.crash_file.write_text(
            json.dumps({"version": 1, "active": active, "capturedAt": snapshot.capturedAt}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )


def _iso_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


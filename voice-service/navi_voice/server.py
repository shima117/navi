"""NAVI localhost voice service: multi-source capture, VAD/STT and Voicemeeter control.

The browser sends USER_MIC PCM to ``/ws?source=USER_MIC``. Optional Windows
PortAudio captures expose Voicemeeter B2 as SYSTEM and B3 as REMOTE. All rings
remain in RAM. Routing changes go through the difference-aware controller and
never touch VAIO3 Gain.
"""
from __future__ import annotations

import asyncio
import io
import json
import os
import time
import wave
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

import numpy as np
import uvicorn
import webrtcvad
from fastapi import FastAPI, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from .audio.capture import InputCapture, find_input_device, list_devices
from .audio.router import AudioRouter, RoutedAudio
from .audio.sources import AudioSource
from .segmenter import SAMPLE_RATE, FrameAssembler, Segmenter
from .voicemeeter import VoicemeeterController

HOST = "127.0.0.1"
PORT = int(os.environ.get("NAVI_VOICE_PORT", "17650"))
MODEL_NAME = os.environ.get("NAVI_STT_MODEL", "large-v3-turbo")
DEVICE = os.environ.get("NAVI_STT_DEVICE", "cuda")
COMPUTE = os.environ.get("NAVI_STT_COMPUTE", "int8_float16" if DEVICE == "cuda" else "int8")
PARTIAL_EVERY_MS = int(os.environ.get("NAVI_PARTIAL_EVERY_MS", "1200"))

app = FastAPI()
_executor = ThreadPoolExecutor(max_workers=1)
_model = None
_router = AudioRouter()
_voicemeeter = VoicemeeterController()


def get_model():
    global _model
    if _model is None:
        from faster_whisper import WhisperModel

        try:
            _model = WhisperModel(MODEL_NAME, device=DEVICE, compute_type=COMPUTE)
        except Exception:
            _model = WhisperModel(MODEL_NAME, device="cpu", compute_type="int8")
    return _model


def transcribe(pcm: bytes) -> str:
    audio = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
    segments, _ = get_model().transcribe(
        audio, language="ja", beam_size=1, vad_filter=False, condition_on_previous_text=False
    )
    return "".join(s.text for s in segments).strip()


def now_ms() -> int:
    return int(time.time() * 1000)


@dataclass
class SocketClient:
    websocket: WebSocket
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


class EventHub:
    def __init__(self) -> None:
        self.clients: dict[int, SocketClient] = {}

    def add(self, websocket: WebSocket) -> SocketClient:
        client = SocketClient(websocket)
        self.clients[id(websocket)] = client
        return client

    def remove(self, websocket: WebSocket) -> None:
        self.clients.pop(id(websocket), None)

    async def send(self, client: SocketClient, payload: dict) -> None:
        async with client.lock:
            await client.websocket.send_text(json.dumps(payload, ensure_ascii=False))

    async def publish(self, payload: dict) -> None:
        for key, client in list(self.clients.items()):
            try:
                await self.send(client, payload)
            except Exception:
                self.clients.pop(key, None)


_hub = EventHub()
_capture_queue: asyncio.Queue[RoutedAudio] | None = None
_capture_worker_task: asyncio.Task | None = None
_captures: dict[AudioSource, InputCapture] = {}
_capture_loop: asyncio.AbstractEventLoop | None = None


class AudioStartRequest(BaseModel):
    listenSystem: bool = True
    listenRemote: bool = True
    systemDeviceId: str | None = None
    remoteDeviceId: str | None = None


@app.on_event("startup")
async def startup() -> None:
    global _capture_queue, _capture_worker_task, _capture_loop
    _capture_loop = asyncio.get_running_loop()
    _capture_queue = asyncio.Queue(maxsize=256)
    _capture_worker_task = asyncio.create_task(_capture_worker())


@app.on_event("shutdown")
async def shutdown() -> None:
    await stop_captures()
    if _capture_worker_task:
        _capture_worker_task.cancel()
    _voicemeeter.logout()


@app.get("/health")
def health():
    vm = _voicemeeter.detect()
    return {
        "ok": True,
        "model": MODEL_NAME,
        "loaded": _model is not None,
        "voicemeeter": vm,
        "capture": {source.value: True for source in _captures},
    }


@app.get("/audio/devices")
def audio_devices():
    return {"devices": [device.json() for device in list_devices()]}


@app.get("/audio/state")
def audio_state():
    vm = _voicemeeter.detect()
    return {
        "voiceService": True,
        "voicemeeter": bool(vm.get("connected")),
        "voicemeeterType": vm.get("type", "unknown"),
        "systemListener": AudioSource.SYSTEM in _captures,
        "remoteListener": AudioSource.REMOTE in _captures,
        "crashRecovery": _voicemeeter.crash_recovery(),
    }


@app.post("/audio/start")
async def start_audio(req: AudioStartRequest):
    await stop_captures()
    try:
        if req.listenSystem:
            device = _resolve_input(req.systemDeviceId, "out b2", "output b2", "voicemeeter b2")
            if device:
                _start_capture(AudioSource.SYSTEM, device.id)
        if req.listenRemote:
            device = _resolve_input(req.remoteDeviceId, "out b3", "output b3", "voicemeeter b3")
            if device:
                _start_capture(AudioSource.REMOTE, device.id)
    except Exception as exc:
        await stop_captures()
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {"started": [source.value for source in _captures]}


@app.post("/audio/stop")
async def stop_audio():
    await stop_captures()
    return {"ok": True}


@app.get("/audio/recent/{source}")
def recent_audio(source: str, seconds: float = 4.0):
    parsed = AudioSource.parse(source)
    if parsed not in (AudioSource.SYSTEM, AudioSource.REMOTE):
        raise HTTPException(status_code=400, detail="recent export is limited to context sources")
    data = _router.recent(parsed, max(0.0, min(6.0, seconds)))
    return Response(
        content=data,
        media_type="audio/L16;rate=16000;channels=1",
        headers={"X-Navi-Audio-Source": parsed.value, "X-Navi-Sample-Rate": str(SAMPLE_RATE)},
    )


@app.post("/audio/reference")
async def audio_reference(request: Request):
    """Keep NAVI's current TTS in RAM for acoustic echo rejection.

    VOICEVOX returns WAV. No audio is persisted and the router's bounded ring
    automatically drops old reference data.
    """
    payload = await request.body()
    if not payload:
        raise HTTPException(status_code=400, detail="empty audio reference")
    try:
        pcm, sample_rate, channels = _decode_reference(payload)
        routed = _router.route(AudioSource.NAVI_RAW, pcm, sample_rate, channels)
    except (ValueError, wave.Error) as exc:
        raise HTTPException(status_code=400, detail=f"invalid audio reference: {exc}") from exc
    return {"ok": True, "bytes": len(routed.pcm16_mono_16k)}


@app.get("/voicemeeter/detect")
def vm_detect():
    return _voicemeeter.detect()


@app.get("/voicemeeter/routing")
def vm_routing():
    try:
        return _voicemeeter.read_routing().json()
    except Exception as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.post("/voicemeeter/snapshot")
def vm_snapshot():
    try:
        return _voicemeeter.snapshot(save=True).json()
    except Exception as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.post("/voicemeeter/auto-configure")
def vm_auto_configure():
    try:
        return _voicemeeter.auto_configure().json()
    except Exception as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.post("/voicemeeter/restore")
def vm_restore():
    try:
        return _voicemeeter.restore()
    except Exception as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    try:
        source = AudioSource.parse(ws.query_params.get("source"), AudioSource.USER_MIC)
    except ValueError:
        await ws.close(code=1008, reason="unknown audio source")
        return
    client = _hub.add(ws)
    vad = webrtcvad.Vad(int(os.environ.get("NAVI_VAD_AGGRESSIVENESS", "2")))
    assembler = FrameAssembler()
    segmenter = Segmenter()
    loop = asyncio.get_running_loop()
    last_partial_ms = 0
    speech_started_at = 0
    try:
        while True:
            message = await ws.receive()
            if message.get("bytes") is None:
                continue
            routed = _router.route(source, message["bytes"], SAMPLE_RATE, 1)
            for frame in assembler.feed(routed.pcm16_mono_16k):
                for ev in segmenter.push(frame, vad.is_speech(frame, SAMPLE_RATE)):
                    if ev.kind == "speech_started":
                        speech_started_at = now_ms()
                    await _hub.send(client, {"type": ev.kind, "at": now_ms(), "source": source.value})
                    if ev.kind == "speech_ended" and ev.audio:
                        text = await loop.run_in_executor(_executor, transcribe, ev.audio)
                        if text:
                            await _hub.send(client, {
                                "type": "transcript", "text": text, "at": now_ms(), "source": source.value,
                                "durationMs": max(0, now_ms() - speech_started_at), "energy": routed.rms,
                                "echoCorrelation": _echo_correlation(ev.audio),
                            })
                if segmenter.in_speech and segmenter.speech_duration_ms - last_partial_ms >= PARTIAL_EVERY_MS:
                    last_partial_ms = segmenter.speech_duration_ms
                    partial = await loop.run_in_executor(_executor, transcribe, segmenter.current_audio())
                    if partial:
                        await _hub.send(client, {
                            "type": "partial", "text": partial, "at": now_ms(), "source": source.value,
                            "durationMs": segmenter.speech_duration_ms, "energy": routed.rms,
                            "echoCorrelation": _echo_correlation(segmenter.current_audio()),
                        })
                if not segmenter.in_speech:
                    last_partial_ms = 0
    except WebSocketDisconnect:
        pass
    finally:
        _hub.remove(ws)


def _resolve_input(device_id: str | None, *tokens: str):
    if device_id is not None:
        return next((d for d in list_devices() if d.kind == "input" and d.id == device_id), None)
    return find_input_device(*tokens)


def _start_capture(source: AudioSource, device_id: str) -> None:
    capture = InputCapture(source, device_id, _capture_callback)
    capture.start()
    _captures[source] = capture


def _capture_callback(source: AudioSource, pcm: bytes, sample_rate: int, channels: int) -> None:
    routed = _router.route(source, pcm, sample_rate, channels)
    queue, loop = _capture_queue, _capture_loop
    if queue is None or loop is None or loop.is_closed():
        return
    def put() -> None:
        if not queue.full():
            queue.put_nowait(routed)
    loop.call_soon_threadsafe(put)


async def stop_captures() -> None:
    for capture in list(_captures.values()):
        try:
            capture.stop()
        except Exception:
            pass
    _captures.clear()


async def _capture_worker() -> None:
    assert _capture_queue is not None
    pipelines = {
        AudioSource.SYSTEM: (FrameAssembler(), Segmenter()),
        AudioSource.REMOTE: (FrameAssembler(), Segmenter()),
    }
    vad = webrtcvad.Vad(int(os.environ.get("NAVI_VAD_AGGRESSIVENESS", "2")))
    loop = asyncio.get_running_loop()
    while True:
        routed = await _capture_queue.get()
        if routed.source not in pipelines:
            continue
        assembler, segmenter = pipelines[routed.source]
        for frame in assembler.feed(routed.pcm16_mono_16k):
            for ev in segmenter.push(frame, vad.is_speech(frame, SAMPLE_RATE)):
                await _hub.publish({"type": ev.kind, "at": now_ms(), "source": routed.source.value})
                if ev.kind == "speech_ended" and ev.audio:
                    text = await loop.run_in_executor(_executor, transcribe, ev.audio)
                    if text:
                        await _hub.publish({
                            "type": "transcript", "text": text, "at": now_ms(), "source": routed.source.value,
                            "durationMs": len(ev.audio) // 2 * 1000 // SAMPLE_RATE, "energy": routed.rms,
                        })


def _decode_reference(payload: bytes) -> tuple[bytes, int, int]:
    if payload[:4] != b"RIFF":
        if len(payload) % 2:
            raise ValueError("PCM16 payload must be sample-aligned")
        return payload, SAMPLE_RATE, 1
    with wave.open(io.BytesIO(payload), "rb") as wav:
        if wav.getsampwidth() != 2:
            raise ValueError("only PCM16 WAV is supported")
        return wav.readframes(wav.getnframes()), wav.getframerate(), wav.getnchannels()


def _echo_correlation(mic_pcm: bytes) -> float:
    """Coarse normalized envelope correlation against recent NAVI_RAW audio."""
    reference = _router.recent(AudioSource.NAVI_RAW, 6.0)
    if len(mic_pcm) < 3_200 or len(reference) < 3_200:
        return 0.0
    mic = np.frombuffer(mic_pcm, dtype=np.int16).astype(np.float32)
    ref = np.frombuffer(reference, dtype=np.int16).astype(np.float32)
    # 10 ms energy envelopes make lag search inexpensive and robust to device latency.
    mic_env = _energy_envelope(mic)
    ref_env = _energy_envelope(ref)
    if mic_env.size < 8 or ref_env.size < 8:
        return 0.0
    longer, needle = (ref_env, mic_env) if ref_env.size >= mic_env.size else (mic_env, ref_env)
    needle = needle - needle.mean()
    if float(np.linalg.norm(needle)) <= 1e-8:
        return 0.0
    # Normalize each lag window independently; using the whole 6-second reference
    # would dilute a perfect one-second match below the rejection threshold.
    dots = np.correlate(longer, needle, mode="valid")
    width = needle.size
    sums = np.convolve(longer, np.ones(width, dtype=np.float32), mode="valid")
    squares = np.convolve(np.square(longer), np.ones(width, dtype=np.float32), mode="valid")
    variances = np.maximum(0.0, squares - np.square(sums) / width)
    denom = np.sqrt(variances) * float(np.linalg.norm(needle))
    valid = denom > 1e-8
    if not np.any(valid):
        return 0.0
    scores = np.zeros_like(dots, dtype=np.float32)
    scores[valid] = np.abs(dots[valid]) / denom[valid]
    return float(np.clip(np.max(scores), 0.0, 1.0))


def _energy_envelope(samples: np.ndarray, window: int = 160) -> np.ndarray:
    usable = samples.size - samples.size % window
    if usable <= 0:
        return np.empty(0, dtype=np.float32)
    frames = samples[:usable].reshape(-1, window) / 32768.0
    return np.sqrt(np.mean(np.square(frames), axis=1)).astype(np.float32)


def main() -> None:
    _executor.submit(get_model)
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")


if __name__ == "__main__":
    main()

"""navi-voice-service: VAD + faster-whisper over a localhost WebSocket (design doc §18).

Protocol (ws://127.0.0.1:17650/ws):
  client → server: binary frames of 16 kHz mono int16 PCM
  server → client: JSON {"type": "speech_started"|"speech_ended"|"transcript", "at": ms, "text"?: str}

Run:  python -m navi_voice.server
Env:  NAVI_STT_MODEL (default large-v3-turbo), NAVI_STT_DEVICE (cuda|cpu), NAVI_STT_COMPUTE
"""
from __future__ import annotations

import asyncio
import json
import os
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import uvicorn
import webrtcvad
from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from .segmenter import SAMPLE_RATE, FrameAssembler, Segmenter

HOST = "127.0.0.1"  # never bind to an external interface
PORT = int(os.environ.get("NAVI_VOICE_PORT", "17650"))
MODEL_NAME = os.environ.get("NAVI_STT_MODEL", "large-v3-turbo")
DEVICE = os.environ.get("NAVI_STT_DEVICE", "cuda")
COMPUTE = os.environ.get("NAVI_STT_COMPUTE", "int8_float16" if DEVICE == "cuda" else "int8")

app = FastAPI()
_executor = ThreadPoolExecutor(max_workers=1)
_model = None


def get_model():
    global _model
    if _model is None:
        from faster_whisper import WhisperModel

        try:
            _model = WhisperModel(MODEL_NAME, device=DEVICE, compute_type=COMPUTE)
        except Exception:
            # Fall back to CPU INT8 when VRAM is tight (design doc §3.3).
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


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL_NAME, "loaded": _model is not None}


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    vad = webrtcvad.Vad(int(os.environ.get("NAVI_VAD_AGGRESSIVENESS", "2")))
    assembler = FrameAssembler()
    segmenter = Segmenter()
    loop = asyncio.get_running_loop()

    async def send(payload: dict) -> None:
        await ws.send_text(json.dumps(payload, ensure_ascii=False))

    try:
        while True:
            chunk = await ws.receive_bytes()
            for frame in assembler.feed(chunk):
                for ev in segmenter.push(frame, vad.is_speech(frame, SAMPLE_RATE)):
                    await send({"type": ev.kind, "at": now_ms()})
                    if ev.kind == "speech_ended" and ev.audio:
                        text = await loop.run_in_executor(_executor, transcribe, ev.audio)
                        if text:
                            await send({"type": "transcript", "text": text, "at": now_ms()})
    except WebSocketDisconnect:
        return


def main() -> None:
    # Warm the model in the background so the first utterance is fast.
    _executor.submit(get_model)
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")


if __name__ == "__main__":
    main()

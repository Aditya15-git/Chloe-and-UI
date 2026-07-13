"""
telephony/stt.py – Deepgram streaming STT.

Two modes:

  Twilio mode (default)
    encoding=mulaw, sample_rate=8000
    Feed raw µ-law bytes from Twilio <Stream> via send_audio().

  Local mode  (local=True)
    encoding=linear16, sample_rate=16000
    Feed int16 PCM chunks from sounddevice microphone via send_audio().

Key settings:
  endpointing=900      Wait 900 ms of silence before treating utterance as
                       complete.  Keeps full names / dates in one transcript.
  smart_format=true    Capitalises names, formats dates, adds punctuation.
  interim_results=false  Only confirmed final transcripts — no partials.
                         (utterance_end_ms requires interim_results=true and
                          causes a 400 error when used with false — omit it.)
"""
from __future__ import annotations
import asyncio
import json
import websockets
from src.config import get_settings

_cfg = get_settings()

_BASE = (
    f"wss://api.deepgram.com/v1/listen"
    f"?model={_cfg.deepgram_model}"
    f"&language={_cfg.deepgram_language}"
    f"&channels=1"
    f"&punctuate=true"
    f"&smart_format=true"
    f"&endpointing=900"
    f"&interim_results=false"
)

DEEPGRAM_WS_URL = _BASE + "&encoding=mulaw&sample_rate=8000"
DEEPGRAM_WS_URL_LOCAL = _BASE + "&encoding=linear16&sample_rate=16000"


class DeepgramSTT:
    """
    Persistent WebSocket to Deepgram.
    Feed raw audio via send_audio().
    Read final transcripts from the async `transcripts` queue.
    """

    def __init__(self, local: bool = False):
        self._local           = local
        self._ws              = None
        self.transcripts:     asyncio.Queue[str] = asyncio.Queue()
        self._receiver_task:  asyncio.Task | None = None

    async def connect(self):
        url = DEEPGRAM_WS_URL_LOCAL if self._local else DEEPGRAM_WS_URL
        self._ws = await websockets.connect(
            url,
            extra_headers={"Authorization": f"Token {_cfg.deepgram_api_key}"},
            ping_interval=10,
        )
        self._receiver_task = asyncio.create_task(self._receive_loop())

    async def send_audio(self, audio_bytes: bytes):
        if self._ws and not self._ws.closed:
            await self._ws.send(audio_bytes)

    async def _receive_loop(self):
        try:
            async for raw in self._ws:
                msg = json.loads(raw)
                if msg.get("type") != "Results":
                    continue
                is_final     = msg.get("is_final", False)
                speech_final = msg.get("speech_final", False)
                alts         = msg.get("channel", {}).get("alternatives", [])
                if (is_final or speech_final) and alts:
                    transcript = alts[0].get("transcript", "").strip()
                    if transcript:
                        await self.transcripts.put(transcript)
        except websockets.exceptions.ConnectionClosed:
            pass

    async def close(self):
        if self._ws:
            await self._ws.close()
        if self._receiver_task:
            self._receiver_task.cancel()

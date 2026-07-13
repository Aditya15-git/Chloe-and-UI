"""
telephony/twilio_ws.py
Bridges Twilio <Stream> ↔ Deepgram STT ↔ agent orchestrator ↔ Cartesia TTS.

Barge-in design
───────────────
Detection: RMS energy of incoming µ-law audio must exceed _BARGE_RMS_THRESHOLD
for _BARGE_MIN_FRAMES consecutive 20 ms frames (default = 200 ms of sustained
speech).  This filters out brief coughs, paper shuffling, and background noise
which don't sustain long enough.

After detection:
  1. Twilio "clear" event sent → audio stops within ~200 ms.
  2. speak_fn waits up to 3 s for the transcript that caused the interrupt.
  3. If transcript is MEANINGFUL (≥ 2 words, or 1 known intent word):
       → put transcript back into input_queue for the agent to process.
  4. If transcript is NOISE (empty / cough / single filler "hmm"):
       → re-speak the same message from the start (TTS is cached, instant).
  5. Loop — repeat until normal completion or real speech interrupts.

Speaking lock + post-speak drain  (unchanged from before)
"""
from __future__ import annotations
import asyncio
import audioop
import base64
import collections
import json

import time

from fastapi                    import WebSocket, WebSocketDisconnect
from src.telephony.stt          import DeepgramSTT
from src.telephony.tts          import synthesise
from src.telephony.transfer     import transfer_to_receptionist
from src.agents.orchestrator    import run_call
from src.services.cost_tracker  import make_tracker
import structlog

log = structlog.get_logger()

# ── Barge-in VAD tuning ───────────────────────────────────────────
# Raise these if background noise / coughs still trigger false positives.
# Lower _BARGE_RMS_THRESHOLD if the bot is too hard to interrupt.
_BARGE_RMS_THRESHOLD = 1500   # RMS on 16-bit scale (0–32767)
                               # ~600 = very sensitive, ~2000 = only loud speech
_BARGE_MIN_FRAMES    = 10     # 10 × 20 ms = 200 ms of sustained speech required
                               # coughs are typically < 100 ms so they won't fire


def _rms(mulaw_bytes: bytes) -> float:
    """RMS energy of a µ-law chunk, returned on 0–32767 scale."""
    if not mulaw_bytes:
        return 0.0
    try:
        pcm = audioop.ulaw2lin(mulaw_bytes, 2)
        return audioop.rms(pcm, 2)
    except audioop.error:
        return 0.0


def _is_meaningful(transcript: str) -> bool:
    """
    True if the transcript looks like intentional speech rather than noise.
    • 2+ words  → always meaningful
    • 1 word    → meaningful only if it's a recognisable intent word
    • empty / 1 filler syllable → noise
    """
    if not transcript:
        return False
    words = transcript.lower().split()
    if len(words) >= 2:
        return True
    if len(words) == 1 and words[0].rstrip(".,!?") in {
        "yes", "no", "yeah", "nope", "yep", "yup", "stop", "wait", "hold",
        "okay", "ok", "sure", "hello", "hi", "pardon", "sorry", "what",
        "change", "cancel", "reschedule", "book", "morning", "afternoon",
        "evening", "correct", "wrong", "right", "different",
    }:
        return True
    return False


class _BargeinSignal(Exception):
    """Raised inside _send_audio to interrupt a speak call."""


async def handle_twilio_stream(websocket: WebSocket):
    await websocket.accept()

    stt = DeepgramSTT(local=False)
    await stt.connect()

    tracker = make_tracker()

    stream_sid:     str | None = None
    call_sid:       str        = "unknown"
    caller_phone:   str        = ""
    stream_start_t: float      = 0.0

    input_queue:   asyncio.Queue[str]  = asyncio.Queue()
    _bot_speaking  = asyncio.Event()
    _barge_in      = asyncio.Event()
    _speech_frames: collections.deque = collections.deque(maxlen=_BARGE_MIN_FRAMES)

    # ── Low-level audio send ─────────────────────────────────────

    async def _send_audio(audio: bytes):
        """Send µ-law bytes; raise _BargeinSignal if caller interrupts."""
        if not stream_sid:
            return
        payload = base64.b64encode(audio).decode("utf-8")
        await websocket.send_json({
            "event":     "media",
            "streamSid": stream_sid,
            "media":     {"payload": payload},
        })
        play_secs = len(audio) / 8_000.0
        try:
            await asyncio.wait_for(_barge_in.wait(), timeout=play_secs + 0.8)
            # Barge-in fired — clear Twilio's buffer
            await websocket.send_json({"event": "clear", "streamSid": stream_sid})
            raise _BargeinSignal()
        except asyncio.TimeoutError:
            pass  # normal playback completion

    # ── speak_fn (injected into agents) ──────────────────────────

    async def speak_fn(text: str):
        """
        Synthesise and play text.  Handles barge-in with auto-resume:
          • real speech interruption → stop, let agent process it
          • noise / cough           → re-speak same text (TTS cached = instant)
        """
        if not stream_sid or not text:
            return

        # Synthesise once; TTS cache in tts.py makes repeats instant
        audio = await synthesise(text)

        while True:
            _barge_in.clear()
            _speech_frames.clear()
            _bot_speaking.set()
            interrupted = False

            try:
                await _send_audio(audio)
            except _BargeinSignal:
                interrupted = True
                log.info("barge_in_detected", call_sid=call_sid)
            finally:
                _bot_speaking.clear()
                _barge_in.clear()
                _speech_frames.clear()

            if not interrupted:
                # Normal completion — post-speak drain
                await asyncio.sleep(0.15)
                drained = 0
                while not input_queue.empty():
                    input_queue.get_nowait()
                    drained += 1
                if drained:
                    log.info("post_speak_drain", count=drained, call_sid=call_sid)
                return   # ← normal exit

            # ── Barge-in occurred ──────────────────────────────
            # Wait for Deepgram to return the transcript for what the
            # caller said (900 ms endpointing + processing = up to ~3 s).
            try:
                transcript = await asyncio.wait_for(
                    input_queue.get(), timeout=3.0
                )
            except asyncio.TimeoutError:
                transcript = ""

            if _is_meaningful(transcript):
                # Real speech — put transcript back for the agent to handle
                log.info("barge_in_real_speech",
                         transcript=transcript, call_sid=call_sid)
                await input_queue.put(transcript)
                return   # ← interrupted exit, agent gets the transcript

            # Noise / cough — log and loop to re-speak from the beginning
            log.info("barge_in_noise_resume",
                     transcript=transcript, call_sid=call_sid)
            # (audio bytes are already synthesised; TTS cache makes this free)

    # ── listen_fn (injected into agents) ─────────────────────────

    async def listen_fn() -> str:
        return await input_queue.get()

    # ── Transcript forwarder ─────────────────────────────────────

    async def forward_transcripts():
        while True:
            transcript = await stt.transcripts.get()
            if _bot_speaking.is_set():
                log.debug("transcript_dropped_during_playback", text=transcript)
                continue
            log.info("transcript", call_sid=call_sid, text=transcript)
            await input_queue.put(transcript)

    transcript_task   = asyncio.create_task(forward_transcripts())
    orchestrator_task = None

    # ── Twilio WebSocket event loop ──────────────────────────────

    try:
        async for raw in websocket.iter_text():
            msg   = json.loads(raw)
            event = msg.get("event")

            if event == "start":
                start_data   = msg.get("start", {})
                stream_sid   = start_data.get("streamSid", "")
                call_sid     = start_data.get("callSid", "unknown")
                custom       = start_data.get("customParameters", {})
                caller_phone = custom.get("caller_phone", "")

                stream_account_sid = start_data.get("accountSid", "")
                stream_start_t     = time.monotonic()
                log.info("stream_started",
                         stream_sid=stream_sid,
                         call_sid=call_sid,
                         caller_phone=caller_phone,
                         stream_account_sid=stream_account_sid)

                orchestrator_task = asyncio.create_task(
                    run_call(
                        speak_fn     = speak_fn,
                        listen_fn    = listen_fn,
                        call_sid     = call_sid,
                        caller_phone = caller_phone,
                        transfer_fn  = transfer_to_receptionist,
                        tracker      = tracker,
                    )
                )

            elif event == "media":
                audio_bytes = base64.b64decode(msg["media"]["payload"])
                await stt.send_audio(audio_bytes)

                # Barge-in detection: only while bot is speaking
                if _bot_speaking.is_set() and not _barge_in.is_set():
                    _speech_frames.append(_rms(audio_bytes))
                    if (len(_speech_frames) == _BARGE_MIN_FRAMES
                            and all(r > _BARGE_RMS_THRESHOLD
                                    for r in _speech_frames)):
                        _barge_in.set()

            elif event == "stop":
                if stream_start_t:
                    tracker.add_twilio_seconds(time.monotonic() - stream_start_t)
                log.info("stream_stopped", call_sid=call_sid)
                break

    except WebSocketDisconnect:
        if stream_start_t and not tracker.twilio_call_seconds:
            tracker.add_twilio_seconds(time.monotonic() - stream_start_t)
    finally:
        if orchestrator_task:
            orchestrator_task.cancel()
        transcript_task.cancel()
        await stt.close()
        log.info("call_ended", call_sid=call_sid)

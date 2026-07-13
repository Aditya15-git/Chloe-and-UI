"""
local_test.py – Run the voice agent on your laptop using mic + speakers.

No Twilio required.  Uses the same agents, LLM, STT (Deepgram), and TTS
(Cartesia) as the production system.

Usage
─────
  python local_test.py
  python local_test.py --phone +61412345678   # simulate a specific caller

Requirements
────────────
  pip install sounddevice
  .env file must be present (same variables as production)

How it works
────────────
  Microphone → sounddevice → 16 kHz int16 PCM → Deepgram (linear16)
  Deepgram → transcript queue → agent orchestrator
  Agent orchestrator → TTS text → Cartesia → 24 kHz PCM → sounddevice speaker
  (Speaking lock prevents mic audio being sent to Deepgram during playback)
"""
from __future__ import annotations
import argparse
import asyncio
import sys

# ── Lazy import check ─────────────────────────────────────────────
try:
    import sounddevice as sd
    import numpy as np
except ImportError:
    print("ERROR: sounddevice is required for local testing.")
    print("  pip install sounddevice")
    sys.exit(1)

from src.agents.orchestrator import run_call
from src.telephony.stt       import DeepgramSTT
from src.telephony.tts       import synthesise_for_speakers
import structlog

log = structlog.get_logger()

# Microphone capture settings
MIC_SAMPLE_RATE = 16_000   # Deepgram linear16 expects 16 kHz
MIC_CHANNELS    = 1        # mono
MIC_BLOCKSIZE   = 1_600    # 100 ms chunks at 16 kHz
MIC_DTYPE       = "int16"


async def main(caller_phone: str) -> None:
    stt = DeepgramSTT(local=True)
    await stt.connect()
    log.info("local_test.stt_connected")

    input_queue:  asyncio.Queue[str] = asyncio.Queue()
    _bot_speaking = asyncio.Event()
    loop          = asyncio.get_running_loop()

    # ── Mic capture → Deepgram ────────────────────────────────────
    def _mic_callback(indata: np.ndarray, frames: int, time, status):
        """sounddevice callback — runs in a C thread; must be non-blocking."""
        if status:
            print(f"[mic] {status}", flush=True)
        if not _bot_speaking.is_set():
            audio_bytes = indata.tobytes()
            # Schedule coroutine from non-async thread
            asyncio.run_coroutine_threadsafe(stt.send_audio(audio_bytes), loop)

    # ── Transcript forwarder ──────────────────────────────────────
    async def forward_transcripts():
        while True:
            transcript = await stt.transcripts.get()
            if _bot_speaking.is_set():
                log.debug("local.transcript_dropped", text=transcript)
                continue
            log.info("local.transcript", text=transcript)
            print(f"\n[You] {transcript}", flush=True)
            await input_queue.put(transcript)

    # ── Speak function ────────────────────────────────────────────
    async def speak_fn(text: str):
        """TTS → sounddevice playback; holds speaking lock during playback."""
        if not text:
            return
        _bot_speaking.set()
        try:
            print(f"\n[Bot] {text}", flush=True)
            audio_np, sr = await synthesise_for_speakers(text)
            # Play blocking via executor (sd.play + sd.wait are thread-blocking)
            await loop.run_in_executor(None, _play_audio, audio_np, sr)
        finally:
            _bot_speaking.clear()
            # Short drain to discard any mic leakage during playback
            await asyncio.sleep(0.15)
            while not input_queue.empty():
                stale = input_queue.get_nowait()
                log.debug("local.drained_stale", text=stale)

    def _play_audio(audio_np: np.ndarray, sr: int):
        sd.play(audio_np, samplerate=sr)
        sd.wait()

    # ── Listen function ───────────────────────────────────────────
    async def listen_fn() -> str:
        return await input_queue.get()

    # ── Run everything ────────────────────────────────────────────
    transcript_task = asyncio.create_task(forward_transcripts())

    print("\n─────────────────────────────────────────")
    print(" Voice Agent – Local Test Mode")
    print(f" Caller phone: {caller_phone}")
    print(" Speak into your microphone. Press Ctrl-C to quit.")
    print("─────────────────────────────────────────\n")

    with sd.InputStream(
        samplerate = MIC_SAMPLE_RATE,
        channels   = MIC_CHANNELS,
        dtype      = MIC_DTYPE,
        blocksize  = MIC_BLOCKSIZE,
        callback   = _mic_callback,
    ):
        try:
            await run_call(
                speak_fn     = speak_fn,
                listen_fn    = listen_fn,
                call_sid     = "local-test",
                caller_phone = caller_phone,
            )
            print("\n[call ended]")
        except KeyboardInterrupt:
            print("\n[interrupted by user]")
        finally:
            transcript_task.cancel()
            await stt.close()


def cli():
    parser = argparse.ArgumentParser(
        description="Run the voice agent locally with mic + speakers."
    )
    parser.add_argument(
        "--phone",
        default="",
        help="Simulated caller phone number in E.164 format (default: +61400000000)",
    )
    args = parser.parse_args()
    asyncio.run(main(caller_phone=args.phone))


if __name__ == "__main__":
    cli()

"""
telephony/tts.py – Text-to-speech abstraction.

Four providers (switch via TTS_PROVIDER in .env):
  cartesia      → Cartesia Sonic     (highest quality, recommended)
  polly         → Amazon Polly       (uses AWS credentials)
  elevenlabs    → ElevenLabs TTS     (requests ulaw_8000 directly from API)
  deepgram_aura → Deepgram Aura TTS  (reuses deepgram_api_key)

Two output formats:
  synthesise()              → µ-law 8 kHz bytes  (Twilio <Stream>)
  synthesise_for_speakers() → (numpy float32 array, sample_rate) for sounddevice

TTS cache
─────────
Short repeated phrases (filler, greetings) are cached in memory so the second
call is instant.  The cache is per-process and cleared on restart.
"""
from __future__ import annotations
import asyncio
import audioop
from typing import Tuple

import httpx
import numpy as np
import boto3
from src.config import get_settings
from src.services.cost_tracker import get_tracker

_cfg = get_settings()

# Native sample rates per provider
_CARTESIA_SAMPLE_RATE  = 24_000
_DEEPGRAM_SAMPLE_RATE  = 24_000
_ELEVENLABS_PCM_RATE   = 22_050   # pcm_22050 for local speaker playback
_TWILIO_SAMPLE_RATE    = 8_000    # Twilio µ-law target

# ── In-memory TTS cache (keyed by text) ───────────────────────────
# Stores µ-law 8 kHz bytes (Twilio format).  Shared across all calls.
_mulaw_cache: dict[str, bytes] = {}


# ─────────────────────────────────────────────────────────────────
# Public API
# ─────────────────────────────────────────────────────────────────

async def synthesise(text: str) -> bytes:
    """Return µ-law 8 kHz audio bytes ready for Twilio <Stream>."""
    if text in _mulaw_cache:
        return _mulaw_cache[text]

    # Count chars only on actual synthesis; cache hits were already counted on first call
    tracker = get_tracker()
    if tracker:
        tracker.add_tts_chars(len(text))

    provider = _cfg.tts_provider.lower()
    if provider == "cartesia":
        result = await _cartesia_tts(text)
    elif provider == "elevenlabs":
        result = await _elevenlabs_tts(text)
    elif provider == "deepgram_aura":
        result = await _deepgram_aura_tts(text)
    else:  # polly (default fallback)
        result = await _polly_tts(text)

    _mulaw_cache[text] = result
    return result


async def synthesise_for_speakers(text: str) -> Tuple[np.ndarray, int]:
    """
    Return (float32 ndarray, sample_rate) suitable for sounddevice.play().
    Used by local_test.py for laptop speaker output.
    """
    provider = _cfg.tts_provider.lower()

    if provider == "cartesia":
        pcm_bytes = await _cartesia_tts_raw(text)      # 24 kHz s16le
        audio     = _pcm_to_float32(pcm_bytes)
        return audio, _CARTESIA_SAMPLE_RATE

    elif provider == "elevenlabs":
        pcm_bytes = await _elevenlabs_tts_raw(text)    # 22050 Hz s16le
        audio     = _pcm_to_float32(pcm_bytes)
        return audio, _ELEVENLABS_PCM_RATE

    elif provider == "deepgram_aura":
        pcm_bytes = await _deepgram_aura_tts_raw(text) # 24 kHz s16le
        audio     = _pcm_to_float32(pcm_bytes)
        return audio, _DEEPGRAM_SAMPLE_RATE

    else:  # polly
        pcm_bytes = await _polly_tts_raw(text)         # 8 kHz s16le
        audio     = _pcm_to_float32(pcm_bytes)
        return audio, _TWILIO_SAMPLE_RATE


# ─────────────────────────────────────────────────────────────────
# Shared helpers
# ─────────────────────────────────────────────────────────────────

def _pcm_to_float32(pcm_s16: bytes) -> np.ndarray:
    """Convert raw s16le bytes → float32 ndarray in [-1, 1]."""
    return np.frombuffer(pcm_s16, dtype=np.int16).astype(np.float32) / 32768.0


def _pcm_to_mulaw(pcm_s16: bytes, source_rate: int) -> bytes:
    """
    Convert 16-bit signed PCM at source_rate → µ-law at 8 kHz.
    If source_rate already equals 8 kHz, skips the resample step.
    """
    if source_rate != _TWILIO_SAMPLE_RATE:
        pcm_s16, _ = audioop.ratecv(
            pcm_s16, 2, 1,
            source_rate,
            _TWILIO_SAMPLE_RATE,
            None,
        )
    return audioop.lin2ulaw(pcm_s16, 2)


# Backward-compat alias kept for any direct callers
def _to_twilio_mulaw(pcm_s16_24k: bytes) -> bytes:
    return _pcm_to_mulaw(pcm_s16_24k, _CARTESIA_SAMPLE_RATE)


# ─────────────────────────────────────────────────────────────────
# Cartesia
# ─────────────────────────────────────────────────────────────────

async def _cartesia_tts(text: str) -> bytes:
    """Fetch 24 kHz PCM from Cartesia and downsample to µ-law 8 kHz."""
    return _pcm_to_mulaw(await _cartesia_tts_raw(text), _CARTESIA_SAMPLE_RATE)


async def _cartesia_tts_raw(text: str) -> bytes:
    """Fetch raw 24 kHz PCM s16le from Cartesia API."""
    url     = "https://api.cartesia.ai/tts/bytes"
    payload = {
        "model_id":   _cfg.cartesia_model_id,
        "transcript": text,
        "voice":      {"mode": "id", "id": _cfg.cartesia_voice_id},
        "output_format": {
            "container":   "raw",
            "encoding":    "pcm_s16le",
            "sample_rate": _CARTESIA_SAMPLE_RATE,
        },
    }
    headers = {
        "X-API-Key":        _cfg.cartesia_api_key,
        "Cartesia-Version": "2024-06-10",
        "Content-Type":     "application/json",
    }
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.post(url, json=payload, headers=headers)
        r.raise_for_status()
        return r.content


# ─────────────────────────────────────────────────────────────────
# ElevenLabs
# ─────────────────────────────────────────────────────────────────

async def _elevenlabs_tts(text: str) -> bytes:
    """
    Fetch MP3 from ElevenLabs (free-tier compatible) and convert to µ-law 8 kHz.
    Falls back to pcm_22050 if pydub is not installed (requires Starter plan).
    """
    mp3_bytes = await _elevenlabs_fetch_mp3(text)
    return _mp3_to_mulaw(mp3_bytes)


async def _elevenlabs_tts_raw(text: str) -> bytes:
    """
    Return raw PCM s16le at 22050 Hz for local speaker playback.
    Decodes the MP3 response to raw PCM.
    """
    mp3_bytes = await _elevenlabs_fetch_mp3(text)
    return _mp3_to_pcm_s16(mp3_bytes)


async def _elevenlabs_fetch_mp3(text: str) -> bytes:
    """
    Fetch MP3 128 kbps from ElevenLabs — works on all plans including free tier.
    """
    url = (
        f"https://api.elevenlabs.io/v1/text-to-speech"
        f"/{_cfg.elevenlabs_voice_id}"
        f"?output_format=mp3_44100_128"
    )
    payload = {
        "text":     text,
        "model_id": _cfg.elevenlabs_model_id,
        "voice_settings": {
            "stability":        0.5,
            "similarity_boost": 0.75,
        },
    }
    headers = {
        "xi-api-key":   _cfg.elevenlabs_api_key,
        "Content-Type": "application/json",
    }
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.post(url, json=payload, headers=headers)
        r.raise_for_status()
        return r.content


def _mp3_to_pcm_s16(mp3_bytes: bytes) -> bytes:
    """Decode MP3 bytes → raw s16le PCM at 22050 Hz using pydub."""
    try:
        from pydub import AudioSegment
    except ImportError:
        raise RuntimeError(
            "pydub is required for ElevenLabs MP3 decoding. "
            "Run: pip install pydub && brew install ffmpeg"
        )
    import io
    seg = AudioSegment.from_mp3(io.BytesIO(mp3_bytes))
    seg = seg.set_frame_rate(_ELEVENLABS_PCM_RATE).set_channels(1).set_sample_width(2)
    return seg.raw_data


def _mp3_to_mulaw(mp3_bytes: bytes) -> bytes:
    """Decode MP3 → PCM 22050 Hz → µ-law 8 kHz."""
    pcm = _mp3_to_pcm_s16(mp3_bytes)
    return _pcm_to_mulaw(pcm, _ELEVENLABS_PCM_RATE)


# ─────────────────────────────────────────────────────────────────
# Deepgram Aura TTS
# ─────────────────────────────────────────────────────────────────

async def _deepgram_aura_tts(text: str) -> bytes:
    """Fetch linear16 24 kHz from Deepgram Aura and convert to µ-law 8 kHz."""
    return _pcm_to_mulaw(await _deepgram_aura_tts_raw(text), _DEEPGRAM_SAMPLE_RATE)


async def _deepgram_aura_tts_raw(text: str) -> bytes:
    """Fetch raw linear16 PCM at 24 kHz from Deepgram Aura speak endpoint."""
    url     = "https://api.deepgram.com/v1/speak"
    params  = {
        "model":       _cfg.deepgram_tts_model,
        "encoding":    "linear16",
        "sample_rate": str(_DEEPGRAM_SAMPLE_RATE),
    }
    payload = {"text": text}
    headers = {
        "Authorization": f"Token {_cfg.deepgram_api_key}",
        "Content-Type":  "application/json",
    }
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.post(url, json=payload, headers=headers, params=params)
        r.raise_for_status()
        return r.content


# ─────────────────────────────────────────────────────────────────
# Amazon Polly
# ─────────────────────────────────────────────────────────────────

async def _polly_tts(text: str) -> bytes:
    pcm = await _polly_tts_raw(text)
    return audioop.lin2ulaw(pcm, 2)


async def _polly_tts_raw(text: str) -> bytes:
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _polly_sync, text)


def _polly_sync(text: str) -> bytes:
    polly = boto3.client(
        "polly",
        region_name           = _cfg.aws_region,
        aws_access_key_id     = _cfg.aws_access_key_id,
        aws_secret_access_key = _cfg.aws_secret_access_key,
    )
    resp = polly.synthesize_speech(
        Text         = text,
        OutputFormat = "pcm",
        SampleRate   = "8000",
        VoiceId      = _cfg.polly_voice_id,
        Engine       = _cfg.polly_engine,
        LanguageCode = _cfg.polly_language_code,
    )
    return resp["AudioStream"].read()

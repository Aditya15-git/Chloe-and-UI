"""
config.py – centralised settings loaded from .env

TTS_PROVIDER options : cartesia | polly | elevenlabs | deepgram_aura
STT_PROVIDER options : deepgram  (elevenlabs Scribe is batch-only, not real-time streaming)
"""
from pydantic_settings import BaseSettings
from functools import lru_cache


class Settings(BaseSettings):
    # ── Twilio ────────────────────────────────────────────────
    twilio_account_sid:        str
    twilio_auth_token:         str
    twilio_phone_number:       str
    twilio_human_receptionist: str = ""   # E.164 format; leave blank to disable transfer

    # ── AWS Bedrock (LLM) ─────────────────────────────────────
    aws_access_key_id:     str
    aws_secret_access_key: str
    aws_region:            str = "ap-southeast-2"
    bedrock_model_id:      str = "au.anthropic.claude-haiku-4-5-20251001-v1:0"

    # ── STT ───────────────────────────────────────────────────
    # deepgram is the only real-time streaming STT supported.
    # ElevenLabs Scribe is batch-only (not suitable for live calls).
    deepgram_api_key: str
    deepgram_model:   str = "nova-2"
    deepgram_language: str = "en-AU"

    # ── TTS (switch via TTS_PROVIDER) ─────────────────────────
    # cartesia      → Cartesia Sonic  (highest quality, recommended)
    # elevenlabs    → ElevenLabs TTS  (requests ulaw_8000 directly)
    # deepgram_aura → Deepgram Aura   (same API key as STT)
    # polly         → Amazon Polly    (uses AWS credentials above)
    tts_provider: str = "cartesia"

    # Cartesia
    cartesia_api_key:  str = ""
    cartesia_voice_id: str = "a4a16c5e-5902-4732-b9b6-2a48efd2e11b"
    cartesia_model_id: str = "sonic-3.5"

    # ElevenLabs
    elevenlabs_api_key:  str = ""
    elevenlabs_voice_id: str = "21m00Tcm4TlvDq8ikWAM"   # Rachel (default)
    elevenlabs_model_id: str = "eleven_multilingual_v2"

    # Deepgram Aura TTS (reuses deepgram_api_key above)
    deepgram_tts_model: str = "aura-asteria-en"

    # Amazon Polly
    polly_voice_id:      str = "Olivia"
    polly_engine:        str = "neural"
    polly_language_code: str = "en-AU"

    # ── Supabase ──────────────────────────────────────────────
    supabase_url:              str
    supabase_service_role_key: str

    # ── S3 Transcripts ────────────────────────────────────────
    # Leave blank to disable transcript uploads.
    s3_transcript_bucket: str = ""
    s3_transcript_prefix: str = "transcripts"

    # ── App ───────────────────────────────────────────────────
    app_host:        str = "0.0.0.0"
    app_port:        int = 8000
    app_base_url:    str = "https://localhost:8000"
    log_level:       str = "INFO"
    clinic_name:     str = "My Medical Clinic"
    emergency_number: str = "000"

    class Config:
        env_file          = ".env"
        env_file_encoding = "utf-8"
        extra             = "ignore"   # silently skip unrecognised .env keys


@lru_cache
def get_settings() -> Settings:
    return Settings()

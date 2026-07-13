"""
services/cost_tracker.py – Per-call API usage accumulator and cost calculator.

Rates are resolved once at call start from the active config (TTS_PROVIDER,
POLLY_ENGINE, BEDROCK_MODEL_ID, etc.) and stored in the tracker instance.
Switching a provider in .env automatically changes which rate is applied.

Usage:
    tracker = make_tracker()          # reads config, picks correct rates
    set_tracker(tracker)              # store in ContextVar for llm.py / tts.py

Rate tables — update here when vendors change pricing:
  Twilio inbound voice : $0.0085 / min
  Deepgram nova-2 STT  : $0.0043 / min
  Cartesia sonic-3.5   : $0.065  / 1 000 chars
  Cartesia sonic-2     : $0.030  / 1 000 chars
  Polly neural         : $0.016  / 1 000 chars
  Polly standard       : $0.004  / 1 000 chars
  ElevenLabs (v2/turbo): $0.180  / 1 000 chars  (varies by plan — verify in dashboard)
  Deepgram Aura TTS    : $0.015  / 1 000 chars
  Bedrock Haiku 4.5    : $0.80 in / $4.00 out  per M tokens
  Bedrock Haiku 3      : $0.25 in / $1.25 out  per M tokens
  Bedrock Sonnet 4/3.7 : $3.00 in / $15.00 out per M tokens
  Bedrock Opus 4       : $15.00 in / $75.00 out per M tokens
"""
from __future__ import annotations
from contextvars import ContextVar
from dataclasses import dataclass, field

# ── Twilio / Deepgram STT rates (fixed — no env variation) ───────────────────
_TWILIO_PER_MIN       = 0.0085
_DEEPGRAM_STT_PER_MIN = 0.0043

# ── TTS rates per 1 000 characters, keyed by lookup string ───────────────────
# For Cartesia: keyed by cartesia_model_id
# For Polly:    keyed by "polly_<engine>"
# For others:   keyed by tts_provider name
_TTS_RATE_TABLE: dict[str, tuple[float, str]] = {
    # (rate_per_1k_chars, display_label)
    "sonic-3.5":       (0.065, "Cartesia (sonic-3.5)"),
    "sonic-3":         (0.065, "Cartesia (sonic-3)"),
    "sonic-2":         (0.030, "Cartesia (sonic-2)"),
    "polly_neural":    (0.016, "Polly (neural)"),
    "polly_standard":  (0.004, "Polly (standard)"),
    "elevenlabs":      (0.180, "ElevenLabs"),
    "deepgram_aura":   (0.015, "Deepgram Aura"),
}
_TTS_FALLBACK = (0.065, "TTS")  # used if the model/provider isn't in the table

# ── Bedrock LLM rates — matched by substring of bedrock_model_id ─────────────
# Checked in order; first match wins.
_LLM_RATE_TABLE: list[tuple[str, float, float, str]] = [
    # (id_substring, input_per_M, output_per_M, display_label)
    ("claude-haiku-4-5",  0.80,   4.00,  "Claude Haiku 4.5"),
    ("claude-haiku-3",    0.25,   1.25,  "Claude Haiku 3"),
    ("claude-sonnet-4",   3.00,  15.00,  "Claude Sonnet 4"),
    ("claude-sonnet-3-7", 3.00,  15.00,  "Claude Sonnet 3.7"),
    ("claude-sonnet-3-5", 3.00,  15.00,  "Claude Sonnet 3.5"),
    ("claude-opus-4",    15.00,  75.00,  "Claude Opus 4"),
    ("claude-opus-3",    15.00,  75.00,  "Claude Opus 3"),
]
_LLM_FALLBACK = (0.80, 4.00, "Bedrock LLM")


def _resolve_tts_rate(cfg) -> tuple[float, str]:
    provider = cfg.tts_provider.lower()
    if provider == "cartesia":
        key = cfg.cartesia_model_id.lower()  # e.g. "sonic-3.5"
    elif provider == "polly":
        key = f"polly_{cfg.polly_engine.lower()}"  # "polly_neural" / "polly_standard"
    else:
        key = provider  # "elevenlabs" / "deepgram_aura"
    return _TTS_RATE_TABLE.get(key, _TTS_FALLBACK)


def _resolve_llm_rate(cfg) -> tuple[float, float, str]:
    model_id = cfg.bedrock_model_id.lower()
    for substr, in_rate, out_rate, label in _LLM_RATE_TABLE:
        if substr in model_id:
            return in_rate, out_rate, label
    return _LLM_FALLBACK


# ── Tracker dataclass ─────────────────────────────────────────────────────────

@dataclass
class CallCostTracker:
    # Usage counters (accumulated during the call)
    llm_input_tokens:    int   = field(default=0)
    llm_output_tokens:   int   = field(default=0)
    tts_chars:           int   = field(default=0)
    twilio_call_seconds: float = field(default=0.0)

    # Resolved at creation from config — rates and display labels
    tts_rate_per_1k:  float = field(default=0.065)
    tts_label:        str   = field(default="TTS")
    llm_input_rate:   float = field(default=0.80)
    llm_output_rate:  float = field(default=4.00)
    llm_label:        str   = field(default="Bedrock LLM")

    # ── Accumulator methods ───────────────────────────────────────

    def add_llm_usage(self, input_tokens: int, output_tokens: int) -> None:
        self.llm_input_tokens  += input_tokens
        self.llm_output_tokens += output_tokens

    def add_tts_chars(self, chars: int) -> None:
        self.tts_chars += chars

    def add_twilio_seconds(self, seconds: float) -> None:
        """Call only from twilio_ws.py when the Twilio stream ends."""
        self.twilio_call_seconds += seconds

    # ── Cost calculation ──────────────────────────────────────────

    def breakdown(self, duration_s: int) -> dict:
        twilio   = round(self.twilio_call_seconds / 60.0 * _TWILIO_PER_MIN, 6)
        deepgram = round(duration_s / 60.0 * _DEEPGRAM_STT_PER_MIN, 6)
        tts      = round(self.tts_chars / 1000.0 * self.tts_rate_per_1k, 6)
        llm      = round(
            self.llm_input_tokens  / 1_000_000 * self.llm_input_rate +
            self.llm_output_tokens / 1_000_000 * self.llm_output_rate,
            6,
        )
        return {
            "twilio_usd":          twilio,
            "deepgram_stt_usd":    deepgram,
            "tts_usd":             tts,
            "llm_usd":             llm,
            "total_usd":           round(twilio + deepgram + tts + llm, 6),
            # Provider labels — rendered in the UI
            "tts_provider":        self.tts_label,
            "llm_provider":        self.llm_label,
            # Raw usage for transparency
            "llm_input_tokens":    self.llm_input_tokens,
            "llm_output_tokens":   self.llm_output_tokens,
            "tts_chars":           self.tts_chars,
            "twilio_call_seconds": round(self.twilio_call_seconds),
        }


# ── Factory — reads config and wires the right rates ─────────────────────────

def make_tracker() -> CallCostTracker:
    """Create a tracker with rates resolved from the current .env config."""
    from src.config import get_settings
    cfg = get_settings()
    tts_rate, tts_label       = _resolve_tts_rate(cfg)
    llm_in, llm_out, llm_label = _resolve_llm_rate(cfg)
    return CallCostTracker(
        tts_rate_per_1k = tts_rate,
        tts_label       = tts_label,
        llm_input_rate  = llm_in,
        llm_output_rate = llm_out,
        llm_label       = llm_label,
    )


# ── ContextVar — one tracker per asyncio task (= one per call) ────────────────
_current_tracker: ContextVar[CallCostTracker | None] = ContextVar(
    "_current_tracker", default=None
)


def get_tracker() -> CallCostTracker | None:
    return _current_tracker.get()


def set_tracker(tracker: CallCostTracker) -> None:
    _current_tracker.set(tracker)

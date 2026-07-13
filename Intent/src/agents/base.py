"""
agents/base.py – BaseAgent: shared speak / hear / extract utilities.

Extraction pipeline for every field:
  1. Fast keyword/regex check (zero latency, no LLM)
  2. LLM call with a tiny focused prompt (8-second timeout via llm.chat)
  3. Safety guard: discard verbose responses (> 60 chars or prose-like prefix)
  4. Return normalised value or sentinel ("UNKNOWN", None, etc.)

Speaking-lock integration
─────────────────────────
speak_fn is provided by the telephony layer (twilio_ws or local_test).
It sets a speaking lock while audio is in-flight so Deepgram transcripts
received during playback are automatically discarded upstream.
"""
from __future__ import annotations
import asyncio
import re
from datetime import datetime
from typing import Callable, Awaitable, Optional

from src.agents.llm import chat
from src.agents.prompts import (
    NAME_SYSTEM, LAST_NAME_SYSTEM, DOB_SYSTEM, DATETIME_SYSTEM,
    DOCTOR_SYSTEM, YESNO_FALLBACK, INTENT_FALLBACK, PATIENT_TYPE_FALLBACK,
)
from src.agents.context import CallContext
import structlog

log = structlog.get_logger()

# Type aliases for the injected I/O functions
SpeakFn  = Callable[[str], Awaitable[None]]
ListenFn = Callable[[], Awaitable[str]]


class TransferToHuman(Exception):
    """Raised by any agent to escalate the call to a live receptionist."""
    def __init__(self, reason: str = ""):
        self.reason = reason
        super().__init__(reason)


class BaseAgent:
    MAX_RETRIES = 3

    def __init__(
        self,
        ctx:       CallContext,
        speak_fn:  SpeakFn,
        listen_fn: ListenFn,
    ):
        self.ctx      = ctx
        self._speak   = speak_fn
        self._listen  = listen_fn

    # ── Core I/O ─────────────────────────────────────────────────

    async def say(self, text: str) -> None:
        """Synthesise and play text; blocks until audio playback finishes."""
        await self._speak(text)

    async def hear(self, timeout: float = 30.0) -> str:
        """Wait for the next caller transcript; returns "" on timeout."""
        try:
            return await asyncio.wait_for(self._listen(), timeout=timeout)
        except asyncio.TimeoutError:
            return ""

    async def ask(self, prompt: str, timeout: float = 30.0) -> str:
        """
        Say prompt, wait for a reply.
        • If caller is silent → "Are you still there?" + one more try.
        • If caller asks to repeat the question → re-say prompt (up to 2×).
        """
        await self.say(prompt)
        for _ in range(3):          # original + up to 2 repeat requests
            reply = await self.hear(timeout=timeout)
            if not reply:
                await self.say("Are you still there? I didn't catch that.")
                reply = await self.hear(timeout=20.0)
            if reply and self._wants_repeat(reply):
                await self.say(prompt)      # re-ask the exact same question
                continue
            return reply or ""
        return ""

    # ── Internal LLM helper ───────────────────────────────────────

    @staticmethod
    async def _llm(system: str, text: str, max_tokens: int = 30) -> str:
        """
        Single-turn LLM call with safety guard.
        Returns first non-empty line; discards verbose / prose responses.
        """
        reply = await chat(
            [{"role": "user", "content": text}],
            system=system,
            max_tokens=max_tokens,
        )
        first = next(
            (l.strip() for l in reply.splitlines() if l.strip()), ""
        ).rstrip(".")
        if len(first) > 60 or first.lower().startswith(
            ("i ", "the ", "to ", "you ", "this ", "sorry", "cannot",
             "unable", "based ", "let me", "here is", "of course")
        ):
            return "UNKNOWN"
        return first

    # ── Extraction methods ────────────────────────────────────────

    async def extract_name(self, text: str) -> str:
        """Returns 'FIRST_ONLY:John', 'John Smith', or 'UNKNOWN'."""
        return await self._llm(NAME_SYSTEM, text, max_tokens=30)

    async def extract_last_name(self, text: str) -> str:
        """Returns surname in Title Case or 'UNKNOWN'."""
        return await self._llm(LAST_NAME_SYSTEM, text, max_tokens=15)

    async def extract_dob(self, text: str) -> str:
        """
        Returns DD/MM/YYYY or 'UNKNOWN'.
        Regex fast path catches numeric dates (03/03/1993, 3-3-93, etc.)
        instantly without an LLM call.
        """
        fast = self._quick_dob(text)
        if fast:
            return fast
        return await self._llm(DOB_SYSTEM, text, max_tokens=15)

    async def extract_doctor(self, text: str) -> str:
        """Returns 'Dr Mitchell' or 'UNKNOWN'."""
        return await self._llm(DOCTOR_SYSTEM, text, max_tokens=20)

    async def extract_datetime(self, text: str) -> str:
        """Returns ISO timestamp 'YYYY-MM-DDTHH:MM:SS' or 'UNKNOWN'."""
        today  = datetime.now().strftime("%Y-%m-%d")
        now    = datetime.now().strftime("%H:%M")
        system = DATETIME_SYSTEM.format(today=today, now=now)
        reply  = await chat(
            [{"role": "user", "content": text}],
            system=system,
            max_tokens=60,
        )
        # Direct ISO timestamp in first line
        clean = reply.strip().rstrip(".")
        if re.match(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}', clean):
            return clean[:19]
        # Regex fallback — LLM sometimes explains before giving the timestamp
        m = re.search(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?', reply)
        return m.group(0)[:19] if m else "UNKNOWN"

    async def extract_yesno(self, text: str) -> Optional[bool]:
        """Returns True/False/None.  Fast keyword path, LLM fallback."""
        fast = self._quick_yesno(text)
        if fast is not None:
            return fast
        result = await self._llm(YESNO_FALLBACK, text, max_tokens=5)
        r = result.upper()
        if r.startswith("YES"):
            return True
        if r.startswith("NO"):
            return False
        return None

    async def extract_intent(self, text: str) -> Optional[str]:
        """Returns 'new_booking' | 'reschedule' | 'cancellation' | None."""
        fast = self._quick_intent(text)
        if fast:
            return fast
        result = await self._llm(INTENT_FALLBACK, text, max_tokens=10)
        r = result.lower().strip()
        if "new_booking" in r or "book" in r:
            return "new_booking"
        if "reschedule" in r:
            return "reschedule"
        if "cancel" in r:
            return "cancellation"
        return None

    async def extract_patient_type(self, text: str) -> Optional[str]:
        """Returns 'new' | 'existing' | None."""
        fast = self._quick_patient_type(text)
        if fast:
            return fast
        result = await self._llm(PATIENT_TYPE_FALLBACK, text, max_tokens=5)
        r = result.lower().strip()
        if r.startswith("new"):
            return "new"
        if r.startswith("exist"):
            return "existing"
        return None

    # ── Keyword / regex helpers ───────────────────────────────────

    @staticmethod
    def _kw(text: str, *words: str) -> bool:
        lo = f" {text.lower()} "
        return any(f" {w} " in lo for w in words)

    def _quick_yesno(self, text: str) -> Optional[bool]:
        lo = text.lower()
        YES = (
            "yes", "yeah", "yep", "yup", "sure", "correct", "right", "ok",
            "okay", "sounds good", "perfect", "great", "confirm", "absolutely",
            "definitely", "go ahead", "exactly", "of course", "that works",
            "book it", "that's right", "that is right", "thats right",
        )
        NO = (
            "no", "nope", "nah", "don't", "dont", "not that", "cancel",
            "different", "change", "wrong", "incorrect", "neither",
        )
        for phrase in YES:
            if phrase in lo:
                return True
        for phrase in NO:
            if phrase in lo:
                return False
        return None

    def _quick_intent(self, text: str) -> Optional[str]:
        lo = text.lower()
        if any(w in lo for w in ("reschedule", "change my appointment",
                                   "move my appointment", "different time",
                                   "different day")):
            return "reschedule"
        if any(w in lo for w in ("cancel", "cancellation", "don't need",
                                   "dont need", "remove")):
            return "cancellation"
        if any(w in lo for w in ("book", "appointment", "schedule",
                                   "make an appointment", "new appointment")):
            return "new_booking"
        return None

    def _quick_patient_type(self, text: str) -> Optional[str]:
        lo = text.lower()
        if any(w in lo for w in ("new patient", "first time", "never been",
                                   "never visited", "haven't been", "havent been",
                                   "first visit", "new here")):
            return "new"
        if any(w in lo for w in ("existing", "been before", "returning",
                                   "already a patient", "previous", "regular",
                                   "come before", "been here")):
            return "existing"
        return None

    @staticmethod
    def _wants_repeat(text: str) -> bool:
        """True if the caller is asking to hear the question again."""
        lo = text.lower()
        return any(phrase in lo for phrase in (
            "repeat", "say again", "say that again", "could you say",
            "what did you say", "pardon", "sorry what", "come again",
            "didn't catch", "can't hear", "can you repeat",
            "what was that", "once more", "say it again",
            "didn't understand", "not sure what", "what were you",
            "say that once", "didn't get that", "missed that",
        ))

    @staticmethod
    def _quick_dob(text: str) -> Optional[str]:
        """
        Regex fast path for numeric dates: 03/03/1993, 3-3-93, 3.3.1993
        Returns DD/MM/YYYY or None.
        Deepgram smart_format sometimes strips leading zeros (3/3/1993) —
        this handles both padded and unpadded forms.
        """
        m = re.search(r'\b(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})\b', text)
        if not m:
            return None
        day, month, year = m.group(1), m.group(2), m.group(3)
        # Expand 2-digit year: 00–30 → 2000s, 31–99 → 1900s
        if len(year) == 2:
            y = int(year)
            year = str(2000 + y) if y <= 30 else str(1900 + y)
        # Basic sanity check
        if not (1 <= int(day) <= 31 and 1 <= int(month) <= 12
                and 1900 <= int(year) <= 2030):
            return None
        return f"{day.zfill(2)}/{month.zfill(2)}/{year}"

    def _has_time_mention(self, text: str) -> bool:
        """True if the text contains a time/day reference."""
        lo = text.lower()
        has_time = bool(re.search(r'\d+\s*(?:am|pm)', lo)) or any(
            w in lo for w in (
                "monday", "tuesday", "wednesday", "thursday", "friday",
                "saturday", "sunday", "tomorrow", "today", "morning",
                "afternoon", "evening", "next week", "o'clock", "oclock",
            )
        )
        has_clear_yes = any(w in lo for w in (
            "yes", "yeah", "correct", "confirm", "right", "perfect", "great",
        ))
        return has_time and not has_clear_yes

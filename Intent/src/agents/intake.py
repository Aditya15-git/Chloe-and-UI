"""
agents/intake.py – Agent 1: Greeting → intent → patient identity (booking path).

Booking path  : intent → new/existing → full name (with spelling confirmation)
                → DOB → confirm with caller
Reschedule    : intent only  (Agent 3 handles identity via phone + DOB lookup)
Cancellation  : intent only  (Agent 4 handles identity via phone + DOB lookup)

Name spelling confirmation
──────────────────────────
After extracting a first or last name, the bot spells it out letter by letter
("Your first name is A, D, I, T, Y, A — is that correct?").  If the caller
says no, they can say or spell the corrected version and we re-confirm.
This eliminates silent typos in the database and makes the interaction feel
careful and professional.
"""
from __future__ import annotations
import calendar
from typing import Optional

from src.agents.base    import BaseAgent, TransferToHuman
from src.agents.context import CallContext
from src.config         import get_settings
import structlog

log = structlog.get_logger()
_cfg = get_settings()


def _spell(word: str) -> str:
    """
    Return a TTS-friendly letter-by-letter spelling.
    'Smith'  → 'S, M, I, T, H'
    "O'Brien" → 'O, B, R, I, E, N'  (punctuation skipped)
    """
    letters = [c.upper() for c in word if c.isalpha()]
    return ", ".join(letters)


def _spoken_dob(dob: str) -> str:
    """
    Convert DD/MM/YYYY to a TTS-safe spoken form so the engine never
    mis-reads it as MM/DD.  '05/11/1980' → 'the 5th of November 1980'
    """
    try:
        day, month, year = dob.split("/")
        d = int(day)
        n = d % 100
        if 11 <= n <= 13:
            suffix = "th"
        else:
            suffix = {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
        month_name = calendar.month_name[int(month)]
        return f"the {d}{suffix} of {month_name} {year}"
    except Exception:
        return dob


class IntakeAgent(BaseAgent):

    async def run(self) -> None:
        await self._collect_intent()
        if self.ctx.intent == "new_booking":
            await self._collect_identity()

    # ─────────────────────────────────────────────────────────────
    # Step 1 — Greet and detect intent
    # ─────────────────────────────────────────────────────────────

    async def _collect_intent(self) -> None:
        first_prompt = (
            f"Thank you for calling {_cfg.clinic_name}. I am Chloe, your virtual receptionist. "
            "In case of medical emergencies, call 000 immediately or go to your nearest emergency department. "
            "Please tell me How can I help you today? Are you looking to book a new appointment, "
            "reschedule, confirm, cancel your appointment or assist with anything else?" 
        )
        retry_prompt = (
            "I'm sorry, I didn't quite catch that. "
            "Could you tell me — are you calling to book, reschedule, or cancel?"
        )

        for attempt in range(self.MAX_RETRIES):
            text   = await self.ask(first_prompt if attempt == 0 else retry_prompt)
            intent = await self.extract_intent(text)
            if intent:
                self.ctx.intent = intent
                log.info("intake.intent", intent=intent, call_sid=self.ctx.call_sid)
                return

        raise TransferToHuman("Could not determine caller intent after 3 attempts")

    # ─────────────────────────────────────────────────────────────
    # Step 2 — Identity collection (booking only)
    # ─────────────────────────────────────────────────────────────

    async def _collect_identity(self) -> None:
        await self._collect_patient_type()
        await self._collect_name()
        await self._collect_dob()
        await self._confirm_identity()

    # ── New vs Existing ───────────────────────────────────────────

    async def _collect_patient_type(self) -> None:
        for attempt in range(self.MAX_RETRIES):
            text = await self.ask(
                "Are you a new patient or an existing patient?"
                if attempt == 0
                else "Sorry — are you a new patient or an existing patient with us?"
            )
            pt = await self.extract_patient_type(text)
            if pt:
                self.ctx.is_new_patient = pt == "new"
                log.info("intake.patient_type", type=pt, call_sid=self.ctx.call_sid)
                return

        raise TransferToHuman("Could not determine new/existing patient type")

    # ── Full name (with letter-by-letter spelling confirmation) ───

    async def _collect_name(self) -> None:
        for attempt in range(self.MAX_RETRIES):
            text = await self.ask(
                "Could I please get your full name?"
                if attempt == 0
                else "I'm sorry, could you please say your full name again?"
            )
            raw = await self.extract_name(text)

            if raw == "UNKNOWN":
                await self.say("I'm sorry, I didn't catch that.")
                continue

            # ── Got first name only ───────────────────────────────
            if raw.startswith("FIRST_ONLY:"):
                first = raw[len("FIRST_ONLY:"):].strip()
                if self.ctx.is_new_patient:
                    last = await self._collect_last_name(first)
                    if last == "UNKNOWN":
                        continue
                    self.ctx.full_name = f"{first} {last}"
                else:
                    confirmed_first = await self._confirm_spelling(first, "first")
                    if not confirmed_first:
                        continue
                    last = await self._collect_last_name(confirmed_first)
                    if last == "UNKNOWN":
                        continue
                    confirmed_last = await self._confirm_spelling(last, "last")
                    if not confirmed_last:
                        continue
                    self.ctx.full_name = f"{confirmed_first} {confirmed_last}"
                log.info("intake.name", name=self.ctx.full_name, call_sid=self.ctx.call_sid)
                return

            # ── Got full name ─────────────────────────────────────
            parts = raw.strip().split(None, 1)

            if len(parts) == 2:
                first, last = parts
            else:
                # Only one word — treat as first name, ask for last
                first = parts[0]
                last  = None

            if self.ctx.is_new_patient:
                if last is None:
                    last = await self._collect_last_name(first)
                    if last == "UNKNOWN":
                        continue
                self.ctx.full_name = f"{first} {last}"
            else:
                confirmed_first = await self._confirm_spelling(first, "first")
                if not confirmed_first:
                    continue

                if last is None:
                    last = await self._collect_last_name(confirmed_first)
                    if last == "UNKNOWN":
                        continue

                confirmed_last = await self._confirm_spelling(last, "last")
                if not confirmed_last:
                    continue

                self.ctx.full_name = f"{confirmed_first} {confirmed_last}"

            log.info("intake.name", name=self.ctx.full_name, call_sid=self.ctx.call_sid)
            return

        raise TransferToHuman("Could not collect and confirm patient name")

    async def _collect_last_name(self, first_name: str) -> str:
        for attempt in range(2):
            text = await self.ask(
                f"Thank you, {first_name}. And could I get your last name please?"
                if attempt == 0
                else "Sorry, could you repeat your last name?"
            )
            last = await self.extract_last_name(text)
            if last and last != "UNKNOWN":
                return last
        return "UNKNOWN"

    async def _confirm_spelling(self, name: str, which: str) -> Optional[str]:
        """
        Spell `name` letter by letter and ask the caller to confirm.
        Returns the confirmed name (possibly corrected), or None on failure.

        which: "first" | "last"
        """
        current = name
        for attempt in range(3):
            spelled = _spell(current)
            if attempt == 0:
                prompt = f"Your {which} name is {spelled}. Is that correct?"
            else:
                prompt = f"So your {which} name is {spelled} — is that right?"

            reply = await self.ask(prompt)
            yn    = await self.extract_yesno(reply)

            if yn is True:
                log.info("intake.name_confirmed",
                         which=which, name=current, call_sid=self.ctx.call_sid)
                return current

            if yn is False:
                # Ask caller to say or spell the correction
                correction_text = await self.ask(
                    f"I'm sorry about that. "
                    f"Could you please say your {which} name clearly, "
                    f"or spell it out for me?"
                )
                # Extract the corrected name
                if which == "last":
                    corrected = await self.extract_last_name(correction_text)
                else:
                    raw = await self.extract_name(correction_text)
                    if raw.startswith("FIRST_ONLY:"):
                        corrected = raw[len("FIRST_ONLY:"):].strip()
                    elif raw != "UNKNOWN" and " " in raw:
                        corrected = raw.split()[0]   # take just first word
                    else:
                        corrected = raw

                if corrected and corrected != "UNKNOWN":
                    current = corrected   # re-confirm with corrected spelling
                    continue
                # Couldn't extract a correction — give up on this attempt
                return None

        return None   # 3 attempts exhausted

    # ── Date of birth ─────────────────────────────────────────────

    async def _collect_dob(self) -> None:
        for attempt in range(self.MAX_RETRIES):
            text = await self.ask(
                "And could I please get your date of birth?"
                if attempt == 0
                else "I'm sorry, could you say your date of birth again?"
            )
            dob = await self.extract_dob(text)
            if dob and dob != "UNKNOWN":
                self.ctx.dob = dob
                log.info("intake.dob", dob=dob, call_sid=self.ctx.call_sid)
                return

        raise TransferToHuman("Could not collect date of birth")

    # ── Final identity confirmation ───────────────────────────────

    async def _confirm_identity(self) -> None:
        for attempt in range(self.MAX_RETRIES):
            text = await self.ask(
                f"Just to confirm — your name is {self.ctx.full_name}, "
                f"and your date of birth is {_spoken_dob(self.ctx.dob)}. Is that correct?"
            )
            confirmed = await self.extract_yesno(text)

            if confirmed is True:
                await self.say("One moment, let me take care of that for you.")
                return

            if confirmed is False:
                await self.say("No problem, let's go through that again.")
                await self._collect_name()
                await self._collect_dob()
                continue

        raise TransferToHuman("Could not confirm patient identity")

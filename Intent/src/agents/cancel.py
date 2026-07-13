"""
agents/cancel.py – Agent 4: Cancel an existing appointment.

Flow
────
1. Ask for date of birth  (phone already known from Twilio caller ID)
2. Look up patient by phone + DOB → confirm identity
3. If not found by phone: ask full name → find by name + DOB
4. Find current confirmed booking → read it back to the caller
5. Ask for explicit cancellation confirmation
6. Cancel in DB → confirmation message
"""
from __future__ import annotations
from typing import Optional

from src.agents.base    import BaseAgent, TransferToHuman
from src.agents.context import CallContext
from src.agents.booking import _fmt_slot_with_doctor   # reuse formatter
from src.db.client import (
    find_patient_by_phone_dob, find_patient,
    find_booking, cancel_booking,
)
import structlog

log = structlog.get_logger()


class CancelAgent(BaseAgent):

    async def run(self) -> None:
        await self._identify_patient()
        await self._confirm_and_cancel()

    # ── Step 1: Identify patient ──────────────────────────────────

    async def _identify_patient(self) -> None:
        for attempt in range(self.MAX_RETRIES):
            text = await self.ask(
                "I can help you cancel your appointment. "
                "Could I please get your date of birth?"
                if attempt == 0
                else "I'm sorry, could you repeat your date of birth?"
            )
            await self.say("One moment.")
            dob = await self.extract_dob(text)
            if dob == "UNKNOWN":
                continue

            self.ctx.dob = dob

            # Try phone + DOB first
            patient = find_patient_by_phone_dob(self.ctx.caller_phone, dob)
            if patient:
                self.ctx.patient_id = patient["id"]
                self.ctx.full_name  = patient["full_name"]
                log.info("cancel.patient_found_by_phone",
                         patient_id=patient["id"], call_sid=self.ctx.call_sid)
                return

            # Fallback to name + DOB
            patient = await self._find_by_name_and_dob(dob)
            if patient:
                self.ctx.patient_id = patient["id"]
                self.ctx.full_name  = patient["full_name"]
                return

            await self.say("I'm sorry, I couldn't find a record with those details.")

        raise TransferToHuman("Could not identify patient for cancellation")

    async def _find_by_name_and_dob(self, dob: str) -> Optional[dict]:
        """Fallback: ask for name and look up by name + DOB."""
        await self.say(
            "I couldn't find your record by phone number. "
            "Could I get your full name please?"
        )
        for attempt in range(2):
            text = await self.hear(timeout=30.0)
            if not text:
                text = await self.ask("Could you say your full name?")
            await self.say("One moment.")
            name_raw = await self.extract_name(text)

            if name_raw.startswith("FIRST_ONLY:"):
                first = name_raw[len("FIRST_ONLY:"):].strip()
                last_text = await self.ask(f"Thank you, {first}. And your last name?")
                last = await self.extract_last_name(last_text)
                if last != "UNKNOWN":
                    name_raw = f"{first} {last}"
                else:
                    continue

            if name_raw == "UNKNOWN":
                continue

            patient = find_patient(name_raw, dob)
            if patient:
                return patient
            await self.say(
                f"I couldn't find a patient named {name_raw} with that date of birth."
            )
        return None

    # ── Step 2: Confirm cancellation ─────────────────────────────

    async def _confirm_and_cancel(self) -> None:
        booking = find_booking(self.ctx.patient_id)
        if not booking:
            await self.say(
                f"I'm sorry, I couldn't find an upcoming booking for {self.ctx.full_name}. "
                "Let me transfer you to our reception team."
            )
            raise TransferToHuman("No booking found for patient")

        self.ctx.booking = booking
        slot     = booking.get("doctor_calendar") or {}
        slot_str = _fmt_slot_with_doctor(slot)

        for attempt in range(self.MAX_RETRIES):
            text = await self.ask(
                f"I have your appointment {slot_str}. "
                f"Are you sure you'd like to cancel this appointment?"
                if attempt == 0
                else f"Just to confirm — cancel the appointment {slot_str}. Is that right?"
            )
            yn = await self.extract_yesno(text)

            if yn is True:
                await self.say("One moment while I process that.")
                cancel_booking(booking_id=booking["id"])
                log.info("cancel.done", booking_id=booking["id"],
                         call_sid=self.ctx.call_sid)
                await self.say(
                    "Your appointment has been successfully cancelled. "
                    "If you'd like to book again in future, please don't hesitate to call us. "
                    "Is there anything else I can help you with?"
                )
                return

            if yn is False:
                await self.say(
                    "No problem — your appointment remains booked. "
                    "Is there anything else I can help you with?"
                )
                return

        raise TransferToHuman("Could not confirm cancellation intent")

"""
agents/reschedule.py – Agent 3: Reschedule an existing appointment.

Flow
────
1. Ask for date of birth  (phone is already known from Twilio caller ID)
2. Look up patient by phone + DOB → confirm identity
3. If not found by phone: ask full name → find by name + DOB
4. Find current confirmed booking → read back to caller
5. Ask for new preferred date/time
6. Find nearest available slot (same ±15-min window logic as BookingAgent)
7. Confirm new slot → reschedule in DB → confirmation message
"""
from __future__ import annotations
from datetime import datetime
from typing import Optional

from src.agents.base    import BaseAgent, TransferToHuman
from src.agents.context import CallContext
from src.agents.booking import _fmt_slot_with_doctor   # reuse formatter
from src.db.client import (
    find_patient_by_phone_dob, find_patient,
    find_booking,
    find_slot_near, find_nearest_free_slot, get_next_available_slots,
    reschedule_booking,
)
import structlog

log = structlog.get_logger()


class RescheduleAgent(BaseAgent):

    async def run(self) -> None:
        await self._identify_patient()
        await self._load_and_confirm_booking()
        await self._collect_new_slot()
        await self._confirm_and_reschedule()

    # ── Step 1: Identify the patient ─────────────────────────────

    async def _identify_patient(self) -> None:
        # Ask for DOB first; use caller phone as the second factor
        for attempt in range(self.MAX_RETRIES):
            text = await self.ask(
                "I can help you reschedule. "
                "Could I please get your date of birth to look up your booking?"
                if attempt == 0
                else "I'm sorry, could you say your date of birth again?"
            )
            await self.say("One moment.")
            dob = await self.extract_dob(text)
            if dob == "UNKNOWN":
                continue

            self.ctx.dob = dob

            # Try phone + DOB first (fastest path)
            patient = find_patient_by_phone_dob(self.ctx.caller_phone, dob)
            if patient:
                self.ctx.patient_id = patient["id"]
                self.ctx.full_name  = patient["full_name"]
                log.info("reschedule.patient_found_by_phone",
                         patient_id=patient["id"], call_sid=self.ctx.call_sid)
                return

            # Phone not on file (e.g. calling from a different number) → ask name
            patient = await self._find_by_name_and_dob(dob)
            if patient:
                self.ctx.patient_id = patient["id"]
                self.ctx.full_name  = patient["full_name"]
                return

            await self.say("I'm sorry, I couldn't find a record with those details.")
            # Loop to try DOB again

        raise TransferToHuman("Could not identify patient for reschedule")

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
                last_text = await self.ask(
                    f"Thank you, {first}. And your last name?"
                )
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
            await self.say(f"I couldn't find a patient named {name_raw} with that date of birth.")
        return None

    # ── Step 2: Load current booking ─────────────────────────────

    async def _load_and_confirm_booking(self) -> None:
        booking = find_booking(self.ctx.patient_id)
        if not booking:
            await self.say(
                f"I'm sorry, I couldn't find an upcoming booking for {self.ctx.full_name}. "
                "Let me transfer you to our reception team."
            )
            raise TransferToHuman("No booking found for patient")

        self.ctx.booking = booking

        # Read back the current booking details
        slot     = booking.get("doctor_calendar") or {}
        slot_str = _fmt_slot_with_doctor(slot)
        text = await self.ask(
            f"I have {self.ctx.full_name}'s appointment {slot_str}. "
            f"Is that the one you'd like to reschedule?"
        )
        yn = await self.extract_yesno(text)
        if yn is False:
            await self.say(
                "I'm sorry I couldn't find the right booking. "
                "Let me transfer you to our reception team."
            )
            raise TransferToHuman("Caller did not confirm booking to reschedule")

    # ── Step 3: New slot selection ────────────────────────────────

    async def _collect_new_slot(self) -> None:
        # Preserve the same doctor from the original booking if possible
        booking      = self.ctx.booking or {}
        cal_slot     = booking.get("doctor_calendar") or {}
        doctor_id    = cal_slot.get("doctor_id")

        for attempt in range(2):
            text = await self.ask(
                "When would you like to reschedule to? "
                "Please say the day and time."
                if attempt == 0
                else "I'm sorry, that slot wasn't available. When else could you come?"
            )

            if any(w in text.lower() for w in (
                "next available", "any", "first available",
                "don't mind", "dont mind", "earliest", "soonest",
            )):
                slot = self._fetch_next(doctor_id)
                if slot:
                    self.ctx.calendar_slot = slot
                    return
                await self.say("There are no available slots at the moment.")
                raise TransferToHuman("No available slots for reschedule")

            await self.say("One moment.")
            dt_str = await self.extract_datetime(text)
            if dt_str == "UNKNOWN":
                await self.say("I'm sorry, I didn't catch the time. Could you say it again?")
                continue

            dt   = datetime.fromisoformat(dt_str)
            slot = find_slot_near(doctor_id, dt, window_minutes=15)

            if slot:
                self.ctx.calendar_slot = slot
                return

            # Offer genuinely nearest slot to requested time
            nearest = find_nearest_free_slot(doctor_id, dt, within_hours=72) \
                      or self._fetch_next(doctor_id)
            if not nearest:
                await self.say("There are no available slots at the moment.")
                raise TransferToHuman("No available slots for reschedule")

            nearest_str = _fmt_slot_with_doctor(nearest)
            offer = await self.ask(
                f"I'm sorry, that exact time isn't available. "
                f"The nearest I have is {nearest_str}. "
                f"Would that work for you?"
            )
            if await self.extract_yesno(offer) is True:
                self.ctx.calendar_slot = nearest
                return

        raise TransferToHuman("Could not find acceptable slot for reschedule")

    @staticmethod
    def _fetch_next(doctor_id: Optional[str]) -> Optional[dict]:
        slots = get_next_available_slots(doctor_id, limit=1)
        return slots[0] if slots else None

    # ── Step 4: Confirm and write ─────────────────────────────────

    async def _confirm_and_reschedule(self) -> None:
        slot_str = _fmt_slot_with_doctor(self.ctx.calendar_slot)
        for attempt in range(self.MAX_RETRIES):
            text = await self.ask(
                f"Just to confirm — I'll move your appointment to {slot_str}. "
                f"Is that correct?"
            )
            yn = await self.extract_yesno(text)
            if yn is True:
                await self.say("One moment while I update your booking.")
                reschedule_booking(
                    booking_id=self.ctx.booking["id"],
                    new_calendar_slot_id=self.ctx.calendar_slot["id"],
                )
                log.info("reschedule.done", booking_id=self.ctx.booking["id"],
                         new_slot=self.ctx.calendar_slot["slot_start"],
                         call_sid=self.ctx.call_sid)
                await self.say(
                    f"Done! Your appointment has been rescheduled to {slot_str}. "
                    "Is there anything else I can help you with?"
                )
                return

            if yn is False:
                await self.say("No problem, let me find you another time.")
                await self._collect_new_slot()
                slot_str = _fmt_slot_with_doctor(self.ctx.calendar_slot)
                continue

        raise TransferToHuman("Could not confirm reschedule")

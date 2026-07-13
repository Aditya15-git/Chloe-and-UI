"""
agents/booking.py – Agent 2: Appointment type → doctor → slot → confirm → book.

Flow
────
1. Teleclinic or in-clinic?
2. Preferred doctor or next available?
   → If preferred: ask which doctor; fuzzy-match in DB
3. Preferred slot or next available?
   → If preferred: extract datetime; find nearest free slot (±15 min window)
   → If that slot is taken: offer the very next available slot
   → 2 failed slot attempts → transfer to human
4. Confirm the slot with the caller
5. Upsert patient record (create if new; phone always stored)
6. Create booking → confirmation message

DB constraint: appointment_type must be 'in_clinic' or 'telehealth'.
We say "teleclinic" to the caller but store "telehealth" in the DB.
"""
from __future__ import annotations
import re
from datetime import datetime
from typing import Optional

from src.agents.base    import BaseAgent, TransferToHuman
from src.agents.context import CallContext
from src.db.client import (
    find_patient, create_patient,
    find_doctor_by_name,
    find_slot_near, find_nearest_free_slot, get_next_available_slots,
    create_booking,
)
import structlog

log = structlog.get_logger()


# ── Slot formatting helpers ───────────────────────────────────────

def _parse_slot_dt(slot: dict) -> datetime:
    raw = slot["slot_start"]
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    return datetime.fromisoformat(raw)


def _fmt_dt(dt: datetime) -> str:
    """e.g. '3 June at 2:30 pm'"""
    day   = str(dt.day)
    month = dt.strftime("%B")
    hour  = dt.strftime("%I").lstrip("0") or "12"
    ampm  = dt.strftime("%p").lower()
    mins  = dt.strftime("%M")
    if mins == "00":
        return f"{day} {month} at {hour} {ampm}"
    return f"{day} {month} at {hour}:{mins} {ampm}"


def _fmt_slot(slot: dict) -> str:
    return _fmt_dt(_parse_slot_dt(slot))


def _fmt_slot_with_doctor(slot: dict) -> str:
    doctor_name = (slot.get("doctors") or {}).get("name", "")
    time_str    = _fmt_slot(slot)
    if doctor_name:
        return f"with {doctor_name} on {time_str}"
    return f"on {time_str}"


# ─────────────────────────────────────────────────────────────────

class BookingAgent(BaseAgent):

    async def run(self) -> None:
        await self._collect_appt_type()
        await self._collect_doctor()
        await self._collect_slot()
        await self._confirm_and_book()

    # ── Step 1: Appointment type ──────────────────────────────────

    async def _collect_appt_type(self) -> None:
        for attempt in range(self.MAX_RETRIES):
            text = await self.ask(
                "Would you prefer a teleclinic appointment — that's a video or phone consult — "
                "or would you like to come in to the clinic?"
                if attempt == 0
                else "Sorry, would you like a teleclinic appointment or an in-clinic visit?"
            )
            appt_type = self._parse_appt_type(text)
            if appt_type:
                self.ctx.appointment_type = appt_type
                log.info("booking.appt_type", type=appt_type, call_sid=self.ctx.call_sid)
                return

        raise TransferToHuman("Could not determine appointment type")

    @staticmethod
    def _parse_appt_type(text: str) -> Optional[str]:
        lo = text.lower()
        if any(w in lo for w in ("tele", "video", "phone call", "online",
                                   "remote", "virtual", "call")):
            return "telehealth"
        if any(w in lo for w in ("clinic", "in person", "in-person", "come in",
                                   "visit", "face to face", "in clinic", "in-clinic")):
            return "in_clinic"
        return None

    # ── Step 2: Doctor preference ─────────────────────────────────

    async def _collect_doctor(self) -> None:
        for attempt in range(self.MAX_RETRIES):
            text = await self.ask(
                "Do you have a preferred doctor?"
                if attempt == 0
                else "Sorry — would you like a specific doctor?"
            )
            lo = text.lower()

            # Explicit "next available / any / no preference"
            if any(w in lo for w in ("any", "next available", "first available",
                                      "no preference", "don't mind", "dont mind",
                                      "whoever", "available")):
                self.ctx.preferred_doctor = None
                log.info("booking.doctor_any", call_sid=self.ctx.call_sid)
                return

            # Explicit preference or doctor name mentioned
            yn = await self.extract_yesno(text)
            if yn is True:
                await self._collect_doctor_name()
                return
            if yn is False:
                self.ctx.preferred_doctor = None
                return

        raise TransferToHuman("Could not determine doctor preference")

    async def _collect_doctor_name(self) -> None:
        for attempt in range(self.MAX_RETRIES):
            text = await self.ask(
                "Which doctor would you like to see?"
                if attempt == 0
                else "Sorry, which doctor would you like?"
            )
            await self.say("One moment.")
            dr_raw = await self.extract_doctor(text)
            if dr_raw == "UNKNOWN":
                continue

            # Strip "Dr" prefix for DB search
            search_name = re.sub(r'^Dr\.?\s+', '', dr_raw, flags=re.IGNORECASE).strip()
            doctor = find_doctor_by_name(search_name)
            if doctor:
                self.ctx.preferred_doctor = {"id": doctor["id"], "name": doctor["name"]}
                log.info("booking.doctor_found", name=doctor["name"], call_sid=self.ctx.call_sid)
                return

            await self.say(
                f"I'm sorry, I couldn't find {dr_raw} in our system. "
                "I'll check who else is available."
            )
            self.ctx.preferred_doctor = None
            return

        self.ctx.preferred_doctor = None

    # ── Step 3: Slot selection ────────────────────────────────────

    async def _collect_slot(self) -> None:
        doctor_id = (self.ctx.preferred_doctor or {}).get("id")

        for attempt in range(2):
            text = await self.ask(
                "Do you have a preferred date and time, or would you like the next available slot?"
                if attempt == 0
                else "I'm sorry, that wasn't available. Would you like to try another time?"
            )

            # ── Next available? ──────────────────────────────────
            if self._wants_next_available(text):
                slot = self._fetch_next_available(doctor_id)
                if slot:
                    self.ctx.calendar_slot = slot
                    log.info("booking.slot_next_avail", slot=slot["slot_start"],
                             call_sid=self.ctx.call_sid)
                    return
                await self.say("I'm sorry, there are no available slots at the moment.")
                raise TransferToHuman("No available slots")

            # ── Preferred time mentioned ─────────────────────────
            await self.say("One moment.")
            dt_str = await self.extract_datetime(text)

            if dt_str == "UNKNOWN":
                await self.say(
                    "I'm sorry, I didn't catch the time. "
                    "Could you say the day and time again?"
                )
                continue

            dt   = datetime.fromisoformat(dt_str)

            # 1. Exact match: slot within ±15 min of requested time
            slot = find_slot_near(doctor_id, dt, window_minutes=15)
            if slot:
                self.ctx.calendar_slot = slot
                log.info("booking.slot_exact", slot=slot["slot_start"],
                         call_sid=self.ctx.call_sid)
                return

            # 2. No exact match → find the genuinely nearest free slot
            #    (searches ±72 h, returns whichever is closer before or after)
            nearest = find_nearest_free_slot(doctor_id, dt, within_hours=72)
            if not nearest:
                # Nothing nearby → fall back to globally next available
                nearest = self._fetch_next_available(doctor_id)
            if not nearest:
                await self.say("I'm sorry, there are no available slots at the moment.")
                raise TransferToHuman("No available slots")

            nearest_str = _fmt_slot_with_doctor(nearest)
            offer_text  = await self.ask(
                f"I'm sorry, that exact time isn't available. "
                f"The nearest I have is {nearest_str}. "
                f"Would that work for you?"
            )
            if await self.extract_yesno(offer_text) is True:
                self.ctx.calendar_slot = nearest
                log.info("booking.slot_nearest", slot=nearest["slot_start"],
                         call_sid=self.ctx.call_sid)
                return
            # Caller declined → loop for 2nd attempt

        raise TransferToHuman("Could not find an acceptable slot after 2 attempts")

    @staticmethod
    def _wants_next_available(text: str) -> bool:
        lo = text.lower()
        return any(w in lo for w in (
            "next available", "any", "whatever", "first available",
            "don't mind", "dont mind", "no preference", "whenever",
            "earliest", "soonest", "don't care", "dont care",
        ))

    @staticmethod
    def _fetch_next_available(doctor_id: Optional[str]) -> Optional[dict]:
        slots = get_next_available_slots(doctor_id, limit=1)
        return slots[0] if slots else None

    # ── Step 4: Confirm and write to DB ──────────────────────────

    async def _confirm_and_book(self) -> None:
        for attempt in range(self.MAX_RETRIES):
            slot_str     = _fmt_slot_with_doctor(self.ctx.calendar_slot)
            appt_display = "teleclinic" if self.ctx.appointment_type == "telehealth" else "in-clinic"

            text = await self.ask(
                f"Perfect. I have a {appt_display} appointment {slot_str}. "
                f"Shall I confirm that for you?"
                if attempt == 0
                else f"Would you like me to confirm the {appt_display} appointment {slot_str}?"
            )
            yn = await self.extract_yesno(text)

            if yn is True:
                await self.say("One moment while I confirm your booking.")
                await self._do_book()
                return

            if yn is False:
                # Let them pick a different slot
                await self.say("No problem, let me find you another time.")
                await self._collect_slot()
                continue  # re-confirm with new slot

        raise TransferToHuman("Could not obtain booking confirmation")

    async def _do_book(self) -> None:
        # Upsert patient record
        patient = find_patient(self.ctx.full_name, self.ctx.dob)
        if not patient:
            patient = create_patient(
                full_name=self.ctx.full_name,
                dob=self.ctx.dob,
                phone=self.ctx.caller_phone,
            )
            log.info("booking.patient_created", id=patient["id"],
                     call_sid=self.ctx.call_sid)
        self.ctx.patient_id = patient["id"]

        booking = create_booking(
            patient_id=self.ctx.patient_id,
            calendar_slot_id=self.ctx.calendar_slot["id"],
            appointment_type=self.ctx.appointment_type,
        )
        self.ctx.booking = booking
        log.info("booking.created", booking_id=booking["id"], call_sid=self.ctx.call_sid)

        slot_str     = _fmt_slot_with_doctor(self.ctx.calendar_slot)
        appt_display = "teleclinic" if self.ctx.appointment_type == "telehealth" else "in-clinic"
        await self.say(
            f"Your {appt_display} appointment {slot_str} has been confirmed. "
            "We look forward to seeing you then. "
            "Is there anything else I can help you with today?"
        )

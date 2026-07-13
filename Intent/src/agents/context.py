"""
agents/context.py – Shared mutable state that flows between agents during a call.

Created once per call by the orchestrator and passed into every agent.
Agents read and write fields as the conversation progresses.
"""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class CallContext:
    # ── Call identity ────────────────────────────────────────────
    call_sid:     str
    caller_phone: str   # E.164 from Twilio, e.g. "+61412345678"

    # ── Intent (set by IntakeAgent) ──────────────────────────────
    intent: str = ""   # "new_booking" | "reschedule" | "cancellation"

    # ── Patient identity ─────────────────────────────────────────
    # For new_booking: set by IntakeAgent from caller's spoken input
    # For reschedule/cancel: set by respective agents via phone+DOB lookup
    is_new_patient: bool  = False
    full_name:      str   = ""
    dob:            str   = ""   # DD/MM/YYYY (display format)
    patient_id:     str   = ""   # Supabase patients.id (UUID)

    # ── Booking details (set by BookingAgent) ────────────────────
    appointment_type: str            = ""    # "in_clinic" | "telehealth"
    preferred_doctor: Optional[dict] = None  # {"id": ..., "name": ...}
    calendar_slot:    Optional[dict] = None  # {"id", "slot_start", "doctors":{"name":...}}
    booking:          Optional[dict] = None  # bookings row from DB

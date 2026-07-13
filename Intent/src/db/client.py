"""
db/client.py – Supabase queries for patients, doctors, bookings, and slots.
"""
from __future__ import annotations
from datetime import datetime, timedelta
from typing import Optional
from supabase import create_client, Client
from src.config import get_settings
import structlog

log = structlog.get_logger()
_cfg = get_settings()

_supabase: Client = create_client(_cfg.supabase_url, _cfg.supabase_service_role_key)


# ──────────────────────────────────────────────────────────────
# Patient helpers
# ──────────────────────────────────────────────────────────────

def find_patient_by_phone_dob(phone: str, dob: str) -> Optional[dict]:
    """
    Look up a patient by their phone number and date of birth.
    Used by reschedule/cancel agents when caller ID is available.
    """
    if not phone or not dob:
        return None
    dob_norm = _normalise_dob(dob)
    # Normalise phone: strip spaces; try both with and without leading +
    phone = phone.strip()
    resp = (
        _supabase.table("patients")
        .select("*")
        .eq("phone", phone)
        .eq("date_of_birth", dob_norm)
        .limit(1)
        .execute()
    )
    return resp.data[0] if resp.data else None


def find_patient(full_name: str, dob: str) -> Optional[dict]:
    if not full_name or not dob:
        return None
    dob_norm = _normalise_dob(dob)
    resp = (
        _supabase.table("patients")
        .select("*")
        .ilike("full_name", full_name.strip())
        .eq("date_of_birth", dob_norm)
        .limit(1)
        .execute()
    )
    return resp.data[0] if resp.data else None


def create_patient(full_name: str, dob: str, phone: str = "") -> dict:
    dob_norm = _normalise_dob(dob)
    resp = (
        _supabase.table("patients")
        .insert({"full_name": full_name.strip(), "date_of_birth": dob_norm, "phone": phone})
        .execute()
    )
    return resp.data[0]


# ──────────────────────────────────────────────────────────────
# Doctor helpers
# ──────────────────────────────────────────────────────────────

def list_doctors() -> list[dict]:
    resp = _supabase.table("doctors").select("id, name").order("name").execute()
    return resp.data or []


def find_doctor_by_name(name: str) -> Optional[dict]:
    resp = (
        _supabase.table("doctors")
        .select("*")
        .ilike("name", f"%{name.strip()}%")
        .limit(1)
        .execute()
    )
    return resp.data[0] if resp.data else None


# ──────────────────────────────────────────────────────────────
# Slot / calendar helpers
# ──────────────────────────────────────────────────────────────

def find_slot_near(doctor_id: Optional[str], target_dt: datetime,
                   window_minutes: int = 15) -> Optional[dict]:
    """
    Return a free slot within ±window_minutes of target_dt for the given
    doctor (or any doctor if doctor_id is None).

    This lets a caller say "Tuesday at 2pm" and still match a slot at
    1:50pm or 2:10pm rather than requiring an exact timestamp match.
    """
    low  = (target_dt - timedelta(minutes=window_minutes)).isoformat()
    high = (target_dt + timedelta(minutes=window_minutes)).isoformat()

    query = (
        _supabase.table("doctor_calendar")
        .select("id, doctor_id, slot_start, doctors(name)")
        .eq("is_booked", False)
        .gte("slot_start", low)
        .lte("slot_start", high)
        .order("slot_start")
        .limit(1)
    )
    if doctor_id:
        query = query.eq("doctor_id", doctor_id)

    data = query.execute().data
    return data[0] if data else None


def find_nearest_free_slot(
    doctor_id: Optional[str],
    target_dt: datetime,
    within_hours: int = 72,
) -> Optional[dict]:
    """
    Return the free slot closest in time to target_dt, searching within
    ±within_hours on either side.  Searches both before and after the target
    and returns whichever is nearer.

    Used when the exact requested time has no slot: this gives the caller
    the genuinely nearest alternative rather than a random "next available".
    """
    now_iso    = datetime.utcnow().isoformat()
    target_iso = target_dt.isoformat()
    low_iso    = (target_dt - timedelta(hours=within_hours)).isoformat()
    high_iso   = (target_dt + timedelta(hours=within_hours)).isoformat()

    def _base():
        q = (
            _supabase.table("doctor_calendar")
            .select("id, doctor_id, slot_start, doctors(name)")
            .eq("is_booked", False)
            .gte("slot_start", now_iso)     # future only
        )
        if doctor_id:
            q = q.eq("doctor_id", doctor_id)
        return q

    # Closest free slot at or before the target (but still in future)
    before = (
        _base()
        .lte("slot_start", target_iso)
        .gte("slot_start", max(low_iso, now_iso))
        .order("slot_start", desc=True)
        .limit(1)
        .execute()
        .data
    )

    # Closest free slot at or after the target
    after = (
        _base()
        .gte("slot_start", target_iso)
        .lte("slot_start", high_iso)
        .order("slot_start")
        .limit(1)
        .execute()
        .data
    )

    before_slot = before[0] if before else None
    after_slot  = after[0]  if after  else None

    if not before_slot and not after_slot:
        return None
    if not before_slot:
        return after_slot
    if not after_slot:
        return before_slot

    # Return whichever is closer to target_dt (naive string → datetime comparison)
    def _naive_dt(slot: dict) -> datetime:
        raw = slot["slot_start"]
        # Strip timezone suffix for naive comparison
        raw = raw.replace("Z", "").split("+")[0]
        return datetime.fromisoformat(raw)

    target_naive = target_dt.replace(tzinfo=None)
    before_diff  = abs((_naive_dt(before_slot) - target_naive).total_seconds())
    after_diff   = abs((_naive_dt(after_slot)  - target_naive).total_seconds())

    return before_slot if before_diff <= after_diff else after_slot


def get_next_available_slots(doctor_id: Optional[str], limit: int = 3) -> list[dict]:
    """Return the next `limit` free slots (any doctor if doctor_id is None)."""
    query = (
        _supabase.table("doctor_calendar")
        .select("id, doctor_id, slot_start, doctors(name)")
        .eq("is_booked", False)
        .gte("slot_start", datetime.utcnow().isoformat())
        .order("slot_start")
        .limit(limit)
    )
    if doctor_id:
        query = query.eq("doctor_id", doctor_id)
    return query.execute().data or []


# ──────────────────────────────────────────────────────────────
# Booking helpers
# ──────────────────────────────────────────────────────────────

def find_booking(patient_id: str, dob: str = "", full_name: str = "") -> Optional[dict]:
    """Find the most-recent upcoming confirmed booking for a patient."""
    resp = (
        _supabase.table("bookings")
        .select("*, doctor_calendar(slot_start, doctor_id, doctors(name))")
        .eq("patient_id", patient_id)
        .eq("status", "confirmed")
        .order("created_at", desc=True)
        .limit(1)
        .execute()
    )
    return resp.data[0] if resp.data else None


def find_booking_by_identity(full_name: str, dob: str) -> Optional[dict]:
    """Look up a booking when we only have name + DOB."""
    patient = find_patient(full_name, dob)
    if not patient:
        return None
    return find_booking(patient["id"])


def create_booking(
    patient_id: str,
    calendar_slot_id: str,
    appointment_type: str = "in_clinic",
    reason: str = "General consultation",
) -> dict:
    # Mark slot as booked
    _supabase.table("doctor_calendar") \
        .update({"is_booked": True}) \
        .eq("id", calendar_slot_id) \
        .execute()

    resp = (
        _supabase.table("bookings")
        .insert({
            "patient_id":        patient_id,
            "calendar_slot_id":  calendar_slot_id,
            "reason":            reason,
            "appointment_type":  appointment_type,
            "status":            "confirmed",
        })
        .execute()
    )
    return resp.data[0]


def reschedule_booking(booking_id: str, new_calendar_slot_id: str) -> dict:
    """
    Move a booking to a new calendar slot.

    We NULL out calendar_slot_id before setting the new one so that if the
    new slot was previously used by a cancelled booking, the unique constraint
    on bookings.calendar_slot_id isn't violated.
    """
    # 1. Read the current slot
    old = _supabase.table("bookings") \
        .select("calendar_slot_id") \
        .eq("id", booking_id) \
        .single() \
        .execute()

    # 2. Temporarily clear the slot reference (releases the old slot from
    #    the unique constraint so it can be reused by someone else)
    _supabase.table("bookings") \
        .update({"calendar_slot_id": None}) \
        .eq("id", booking_id) \
        .execute()

    # 3. Free the old slot in the calendar
    if old.data and old.data.get("calendar_slot_id"):
        _supabase.table("doctor_calendar") \
            .update({"is_booked": False}) \
            .eq("id", old.data["calendar_slot_id"]) \
            .execute()

    # 4. Mark the new slot as booked
    _supabase.table("doctor_calendar") \
        .update({"is_booked": True}) \
        .eq("id", new_calendar_slot_id) \
        .execute()

    # 5. Point the booking at the new slot
    resp = (
        _supabase.table("bookings")
        .update({"calendar_slot_id": new_calendar_slot_id, "status": "confirmed"})
        .eq("id", booking_id)
        .execute()
    )
    return resp.data[0]


def cancel_booking(booking_id: str) -> dict:
    """
    Cancel a booking and free its calendar slot.

    We also NULL out calendar_slot_id in the cancelled row so the slot is
    fully released from the unique constraint on bookings.calendar_slot_id.
    Without this, a later reschedule/booking to the same slot would hit a
    duplicate-key error even though the slot shows as is_booked=False.
    """
    old = _supabase.table("bookings") \
        .select("calendar_slot_id") \
        .eq("id", booking_id) \
        .single() \
        .execute()
    if old.data and old.data.get("calendar_slot_id"):
        # Mark the slot as free in the calendar
        _supabase.table("doctor_calendar") \
            .update({"is_booked": False}) \
            .eq("id", old.data["calendar_slot_id"]) \
            .execute()

    # Cancel the booking AND clear the slot reference so the slot can be reused
    resp = (
        _supabase.table("bookings")
        .update({"status": "cancelled", "calendar_slot_id": None})
        .eq("id", booking_id)
        .execute()
    )
    return resp.data[0] if resp.data else {}


# ──────────────────────────────────────────────────────────────
# Call log helpers
# ──────────────────────────────────────────────────────────────

def upsert_call_log(record: dict) -> None:
    """
    Insert or update a call_logs row for call_sid, then back-link the
    booking row (if any) with call_log_id so the UI can navigate to the
    transcript from the Bookings page.

    Requires this migration to be run once in Supabase:
      ALTER TABLE public.call_logs
        ADD COLUMN IF NOT EXISTS doctor_name      TEXT,
        ADD COLUMN IF NOT EXISTS appointment_time TIMESTAMPTZ,
        ADD CONSTRAINT call_logs_call_sid_key UNIQUE (call_sid);
      ALTER TABLE public.bookings
        ADD COLUMN IF NOT EXISTS call_log_id UUID
          REFERENCES public.call_logs(id) ON DELETE SET NULL;
    """
    call_sid   = record.get("call_sid")
    booking_id = record.get("booking_id") or None

    row: dict = {
        "call_sid":         call_sid,
        "outcome":          record.get("outcome"),
        "duration_s":       record.get("duration_s"),
        "created_at":       record.get("created_at"),
        "patient_id":       record.get("patient_id") or None,
        "booking_id":       booking_id,
        "doctor_name":      record.get("doctor_name"),
        "appointment_time": record.get("appointment_time"),
        "transcript":       record.get("transcript"),
        "cost_usd":         record.get("cost_usd"),
        "cost_breakdown":   record.get("cost_breakdown"),
    }
    row = {k: v for k, v in row.items() if v is not None}

    try:
        existing = (
            _supabase.table("call_logs")
            .select("id")
            .eq("call_sid", call_sid)
            .limit(1)
            .execute()
        )
        if existing.data:
            call_log_id = existing.data[0]["id"]
            _supabase.table("call_logs") \
                .update(row) \
                .eq("call_sid", call_sid) \
                .execute()
        else:
            result = (
                _supabase.table("call_logs")
                .insert(row)
                .execute()
            )
            call_log_id = result.data[0]["id"] if result.data else None

        # Back-link the booking so "View call transcription" works in the UI
        if call_log_id and booking_id:
            _supabase.table("bookings") \
                .update({"call_log_id": call_log_id}) \
                .eq("id", booking_id) \
                .execute()

        log.info("call_log.saved", call_sid=call_sid, call_log_id=call_log_id)
    except Exception as exc:
        log.error("call_log.upsert_failed", error=str(exc), call_sid=call_sid)


# ──────────────────────────────────────────────────────────────
# Utility
# ──────────────────────────────────────────────────────────────

def _normalise_dob(dob: str) -> str:
    """Convert DD/MM/YYYY → YYYY-MM-DD.  Pass through if already ISO."""
    dob = dob.strip()
    if "/" in dob:
        parts = dob.split("/")
        if len(parts) == 3:
            return f"{parts[2]}-{parts[1].zfill(2)}-{parts[0].zfill(2)}"
    return dob

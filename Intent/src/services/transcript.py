"""
services/transcript.py – Records every call turn and uploads to S3.

File naming:  {patient_name}_{clinic_name}_{call_sid}.json
S3 path:      {S3_TRANSCRIPT_PREFIX}/{YYYY/MM/DD}/{filename}
              e.g.  transcripts/2026/05/30/Emily_Thornton_My_Medical_Clinic_CA123.json

Format:
    {
        "_meta":   { "version": "1.0", "call_sid": "...", "clinic": "..." },
        "records": [ { ...one record per call... } ]
    }
"""
from __future__ import annotations
import asyncio
import json
import re
import time
from datetime import datetime, timezone
from typing import Optional

import boto3
import structlog

from src.config import get_settings
from src.services.cost_tracker import CallCostTracker

log = structlog.get_logger()
_cfg = get_settings()


class TranscriptLogger:
    """
    Drop-in wrapper: call log_assistant() / log_patient() during the call,
    then await save(ctx, outcome) at the end.
    """

    def __init__(self, call_sid: str):
        self.call_sid   = call_sid
        self._t0        = time.monotonic()
        self._wall_start = datetime.now(timezone.utc)
        self.turns: list[dict] = []

    # ── Turn recording ───────────────────────────────────────────

    def log_assistant(self, text: str) -> None:
        if text:
            self.turns.append({"role": "assistant", "text": text, "time": self._elapsed()})

    def log_patient(self, text: str) -> None:
        if text:
            self.turns.append({"role": "patient", "text": text, "time": self._elapsed()})

    def _elapsed(self) -> int:
        return round(time.monotonic() - self._t0)

    # ── Record builder ───────────────────────────────────────────

    def build_record(self, ctx, outcome: str, tracker: CallCostTracker | None = None) -> dict:
        """Build the full record dict from CallContext + outcome."""
        duration = self._elapsed()

        # Extract doctor name + appointment time from context
        doctor_name      = None
        appointment_time = None

        # calendar_slot is set during booking / reschedule
        slot = ctx.calendar_slot
        # Fall back to the nested slot inside the booking row
        if not slot and ctx.booking:
            slot = ctx.booking.get("doctor_calendar")

        if slot:
            doctors     = slot.get("doctors") or {}
            raw_name    = doctors.get("name", "")
            if raw_name:
                doctor_name = raw_name if raw_name.lower().startswith("dr") \
                              else f"Dr. {raw_name}"
            raw_start = slot.get("slot_start", "")
            if raw_start:
                # Normalise to Z suffix
                appointment_time = (
                    raw_start[:-1] + "Z" if raw_start.endswith("+00:00")
                    else raw_start if raw_start.endswith("Z")
                    else raw_start + "Z"
                )

        cost_breakdown = tracker.breakdown(duration) if tracker else None

        return {
            "id":               self.call_sid,
            "call_sid":         self.call_sid,
            "patient_id":       ctx.patient_id or None,
            "booking_id":       (ctx.booking or {}).get("id") or None,
            "outcome":          outcome,
            "duration_s":       duration,
            "created_at":       self._wall_start.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "patient_name":     ctx.full_name or "Unknown",
            "doctor_name":      doctor_name,
            "appointment_time": appointment_time,
            "transcript":       self.turns,
            "cost_usd":         cost_breakdown["total_usd"] if cost_breakdown else None,
            "cost_breakdown":   cost_breakdown,
        }

    # ── Save to S3 ───────────────────────────────────────────────

    async def save(self, ctx, outcome: str, tracker: CallCostTracker | None = None) -> None:
        """Build the record, upload to S3, and upsert to Supabase call_logs."""
        record = self.build_record(ctx, outcome, tracker)

        payload = {
            "_meta": {
                "version":  "1.0",
                "call_sid": self.call_sid,
                "clinic":   _cfg.clinic_name,
            },
            "records": [record],
        }

        # ── Supabase call_logs (always attempted) ────────────────────
        loop = asyncio.get_event_loop()
        try:
            from src.db.client import upsert_call_log
            await loop.run_in_executor(None, upsert_call_log, record)
        except Exception as exc:
            log.error("transcript.supabase_failed", error=str(exc), call_sid=self.call_sid)

        # ── S3 (only if bucket is configured) ───────────────────────
        if not _cfg.s3_transcript_bucket:
            log.info("transcript.s3_skipped",
                     reason="S3_TRANSCRIPT_BUCKET not configured",
                     call_sid=self.call_sid)
            return

        try:
            await loop.run_in_executor(None, _upload_sync, payload, record)
        except Exception as exc:
            # Never let a transcript failure break the call flow
            log.error("transcript.upload_failed", error=str(exc), call_sid=self.call_sid)


# ── S3 upload (blocking, runs in executor) ────────────────────────

def _upload_sync(payload: dict, record: dict) -> None:
    date_prefix  = datetime.utcnow().strftime("%Y/%m/%d")
    patient_slug = _slugify(record["patient_name"])
    clinic_slug  = _slugify(_cfg.clinic_name)
    call_slug    = record["call_sid"]
    filename     = f"{patient_slug}_{clinic_slug}_{call_slug}.json"
    prefix       = _cfg.s3_transcript_prefix.strip("/")
    s3_key       = f"{prefix}/{date_prefix}/{filename}"

    s3 = boto3.client(
        "s3",
        region_name           = _cfg.aws_region,
        aws_access_key_id     = _cfg.aws_access_key_id,
        aws_secret_access_key = _cfg.aws_secret_access_key,
    )
    s3.put_object(
        Bucket      = _cfg.s3_transcript_bucket,
        Key         = s3_key,
        Body        = json.dumps(payload, indent=2, ensure_ascii=False).encode("utf-8"),
        ContentType = "application/json",
    )
    log.info("transcript.saved",
             s3_key   = s3_key,
             outcome  = record["outcome"],
             patient  = record["patient_name"],
             duration = record["duration_s"],
             call_sid = record["call_sid"])


def _slugify(text: str) -> str:
    """'Emily Thornton' → 'Emily_Thornton'  (safe for S3 keys)"""
    return re.sub(r"[^\w]", "_", text.strip()).strip("_")

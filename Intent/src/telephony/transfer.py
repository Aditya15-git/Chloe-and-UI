"""
telephony/transfer.py
Uses the Twilio REST API to redirect a live call to the /twilio/transfer
endpoint, which returns <Dial> TwiML to connect the caller to the receptionist.

asyncio.to_thread is used because the Twilio SDK is synchronous.
"""
from __future__ import annotations
import asyncio
import structlog
from twilio.rest import Client as TwilioRestClient

from src.config import get_settings

log = structlog.get_logger()


async def transfer_to_receptionist(call_sid: str) -> None:
    cfg = get_settings()
    if not cfg.twilio_human_receptionist:
        log.warning("transfer_skipped_no_receptionist_phone", call_sid=call_sid)
        return

    transfer_url = f"{cfg.app_base_url}/twilio/transfer"
    log.info("transferring_to_receptionist",
             call_sid=call_sid, transfer_url=transfer_url)

    try:
        client = TwilioRestClient(cfg.twilio_account_sid, cfg.twilio_auth_token)
        await asyncio.to_thread(
            client.calls(call_sid).update,
            url=transfer_url,
            method="POST",
        )
        log.info("transfer_initiated", call_sid=call_sid)
    except Exception as exc:
        log.error("transfer_failed", call_sid=call_sid, error=str(exc))

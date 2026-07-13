"""
agents/orchestrator.py – Entry point for every call.

Called by:
  • src/telephony/twilio_ws.py  (live Twilio calls)
  • local_test.py               (laptop mic/speaker testing)

Usage:
    from src.agents.orchestrator import run_call

    await run_call(
        speak_fn    = async_fn_that_plays_text,
        listen_fn   = async_fn_that_returns_transcript,
        call_sid    = "CA...",
        caller_phone= "+61412345678",
        transfer_fn = optional_async_fn_that_dials_receptionist,
    )

The orchestrator:
  1. Creates a CallContext shared across all agents
  2. Wraps speak_fn / listen_fn to record every turn for the transcript
  3. Runs IntakeAgent to greet caller and detect intent (+identity for booking)
  4. Dispatches to BookingAgent / RescheduleAgent / CancelAgent
  5. Catches TransferToHuman → plays hand-off message → calls transfer_fn
  6. Catches any unexpected exception → plays apology + hand-off → calls transfer_fn
  7. Always saves the transcript to S3 on exit (even on error)
  8. Returns the outcome string
"""
from __future__ import annotations
from typing import Awaitable, Callable, Optional
import structlog

from src.agents.base       import TransferToHuman, SpeakFn, ListenFn
from src.agents.context    import CallContext
from src.agents.intake     import IntakeAgent
from src.agents.booking    import BookingAgent
from src.agents.reschedule import RescheduleAgent
from src.agents.cancel     import CancelAgent
from src.services.transcript import TranscriptLogger
from src.services.cost_tracker import CallCostTracker, make_tracker, set_tracker

log = structlog.get_logger()

TransferFn = Optional[Callable[[str], Awaitable[None]]]


async def run_call(
    speak_fn:     SpeakFn,
    listen_fn:    ListenFn,
    call_sid:     str,
    caller_phone: str,
    transfer_fn:  TransferFn = None,
    tracker:      Optional[CallCostTracker] = None,
) -> str:
    """
    Top-level coroutine that runs one complete call.
    Returns the outcome string when the conversation is finished (or transferred).

    tracker — pass a pre-created CallCostTracker from twilio_ws.py so that the
              caller can add Twilio seconds after the stream ends.  When None
              (local_test.py), a fresh tracker is created and Twilio cost stays $0.
    """
    if tracker is None:
        tracker = make_tracker()
    set_tracker(tracker)

    ctx    = CallContext(call_sid=call_sid, caller_phone=caller_phone)
    logger = TranscriptLogger(call_sid)
    log.info("call.start", call_sid=call_sid, caller_phone=caller_phone)

    # ── Wrap speak/listen to record every turn ───────────────────
    async def logged_speak(text: str) -> None:
        logger.log_assistant(text)
        await speak_fn(text)

    async def logged_listen() -> str:
        text = await listen_fn()
        logger.log_patient(text)
        return text

    # ── Speak hold message then hand off ────────────────────────
    async def _handoff(text: str) -> None:
        await logged_speak(text)
        if transfer_fn:
            await transfer_fn(call_sid)

    outcome = "no_appointment"

    try:
        # ── Agent 1: Greet + intent + identity (booking path) ────
        intake = IntakeAgent(ctx, logged_speak, logged_listen)
        await intake.run()

        # ── Dispatch to specialist agent ─────────────────────────
        if ctx.intent == "new_booking":
            log.info("call.dispatch_booking", call_sid=call_sid)
            await BookingAgent(ctx, logged_speak, logged_listen).run()
            outcome = "appointment_booked"

        elif ctx.intent == "reschedule":
            log.info("call.dispatch_reschedule", call_sid=call_sid)
            await RescheduleAgent(ctx, logged_speak, logged_listen).run()
            outcome = "appointment_rescheduled"

        elif ctx.intent == "cancellation":
            log.info("call.dispatch_cancel", call_sid=call_sid)
            await CancelAgent(ctx, logged_speak, logged_listen).run()
            outcome = "appointment_cancelled"

        else:
            # Should not happen — IntakeAgent raises TransferToHuman first
            outcome = "transferred_to_human"
            await _handoff(
                "I'm sorry, I wasn't sure how to help with that. "
                "Let me transfer you to our reception team."
            )

        log.info("call.end_normal", call_sid=call_sid, intent=ctx.intent)

    except TransferToHuman as exc:
        log.info("call.transfer_to_human", reason=exc.reason, call_sid=call_sid)
        outcome = "transferred_to_human"
        await _handoff(
            "I'm sorry I wasn't able to complete that for you. "
            "Let me transfer you to our reception team now. "
            "Please hold."
        )

    except Exception as exc:
        log.exception("call.unexpected_error", call_sid=call_sid, error=str(exc))
        outcome = "error"
        await _handoff(
            "I'm very sorry, I encountered a technical issue. "
            "Let me transfer you to our reception team right away."
        )

    finally:
        # Always save transcript — even if the call errored
        await logger.save(ctx, outcome, tracker)

    return outcome

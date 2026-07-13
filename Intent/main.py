"""
main.py – FastAPI application.

POST /twilio/incoming  – Twilio webhook (returns TwiML with Stream)
WS   /twilio/stream    – Twilio media stream WebSocket
GET  /health           – health check

caller_phone is passed via TwiML <Parameter> (not URL query string).
Twilio delivers it inside the "start" WebSocket event → customParameters.
This is more reliable than URL query params, which Twilio sometimes strips.
"""
from fastapi import FastAPI, Request, WebSocket
from fastapi.responses import Response
import structlog
import logging

from src.config import get_settings
from src.telephony.twilio_ws import handle_twilio_stream

_cfg = get_settings()

logging.basicConfig(level=_cfg.log_level)
log = structlog.get_logger()

app = FastAPI(title="AI Receptionist", version="4.0.0")


@app.get("/health")
async def health():
    return {"status": "ok", "clinic": _cfg.clinic_name}


@app.post("/twilio/incoming")
async def twilio_incoming(request: Request):
    form         = await request.form()
    call_sid     = form.get("CallSid", "unknown")
    caller_phone = form.get("From", "")
    log.info("incoming_call", call_sid=call_sid, caller=caller_phone)

    ws_base = (
        _cfg.app_base_url
        .replace("https://", "wss://")
        .replace("http://", "ws://")
    )
    ws_url = f"{ws_base}/twilio/stream"

    # Escape XML special chars in the phone value (+ is fine; & < " need escaping)
    caller_phone_xml = (
        caller_phone
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace('"', "&quot;")
    )

    # Pass caller_phone as a TwiML <Parameter> — arrives in the start event's
    # customParameters dict, which is far more reliable than URL query params.
    twiml = f"""<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="{ws_url}">
      <Parameter name="caller_phone" value="{caller_phone_xml}"/>
    </Stream>
  </Connect>
</Response>"""
    return Response(content=twiml, media_type="text/xml")


@app.post("/twilio/transfer")
async def twilio_transfer():
    """
    Called by Twilio when the agent redirects a call to the receptionist.
    Returns <Dial> TwiML to connect the caller to the receptionist number.
    """
    twiml = f"""<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial>{_cfg.twilio_human_receptionist}</Dial>
</Response>"""
    return Response(content=twiml, media_type="text/xml")


@app.websocket("/twilio/stream")
async def twilio_stream(websocket: WebSocket):
    await handle_twilio_stream(websocket)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "main:app",
        host=_cfg.app_host,
        port=_cfg.app_port,
        reload=True,
        log_level=_cfg.log_level.lower(),
    )

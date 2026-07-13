# AI Medical Receptionist — Voice Agent

An AI-powered phone receptionist for medical clinics built on Twilio, AWS Bedrock (Claude Haiku), Deepgram STT, and Cartesia TTS.

## What it does

Handles inbound calls and completes three workflows end-to-end:
- **Book** a new appointment
- **Reschedule** an existing appointment
- **Cancel** an existing appointment

Every call is transcribed and uploaded to S3 automatically.

---

## Architecture

```
Twilio (µ-law 8kHz) ──► twilio_ws.py ──► Deepgram STT ──► transcript queue
                                                                    │
                                                          orchestrator.py
                                                         /     |        \
                                                    Intake  Booking  Reschedule/Cancel
                                                         \     |        /
                                                       AWS Bedrock (LLM)
                                                       Supabase (DB)
                                                       Cartesia TTS ──► Twilio
                                                       S3 (transcripts)
```

| Agent | File | Responsibility |
|---|---|---|
| Intake | `src/agents/intake.py` | Greet, detect intent, collect name + DOB |
| Booking | `src/agents/booking.py` | Appointment type → doctor → slot → confirm → create |
| Reschedule | `src/agents/reschedule.py` | Verify identity → find booking → new slot → update |
| Cancel | `src/agents/cancel.py` | Verify identity → find booking → confirm → cancel |

---

## Project Structure

```
.
├── main.py                        # FastAPI app (Twilio webhook + WebSocket)
├── local_test.py                  # Local mic/speaker test (no Twilio needed)
├── requirements.txt
├── Dockerfile
├── docker-compose.yml
├── supabase_schema.sql
├── .env.example
└── src/
    ├── config.py                  # All settings loaded from .env
    ├── agents/
    │   ├── orchestrator.py        # Call entry point; routes to specialist agents
    │   ├── intake.py              # Agent 1: greeting + intent + identity
    │   ├── booking.py             # Agent 2: new appointment booking
    │   ├── reschedule.py          # Agent 3: reschedule existing appointment
    │   ├── cancel.py              # Agent 4: cancel existing appointment
    │   ├── base.py                # Shared speak/listen/extract utilities
    │   ├── context.py             # CallContext dataclass (shared state)
    │   ├── llm.py                 # AWS Bedrock Claude client
    │   └── prompts.py             # LLM system prompts (one per extraction type)
    ├── telephony/
    │   ├── twilio_ws.py           # Twilio WebSocket handler + barge-in VAD
    │   ├── stt.py                 # Deepgram STT (streaming WebSocket)
    │   └── tts.py                 # TTS abstraction (Cartesia/Polly/ElevenLabs/Deepgram)
    ├── db/
    │   └── client.py              # Supabase queries (patients, doctors, slots, bookings)
    └── services/
        └── transcript.py          # Call transcript recorder + S3 uploader
```

---

## Setup

### 1. Install dependencies
```bash
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

### 2. Configure environment
```bash
cp .env.example .env
# Fill in all values in .env
```

### 3. Run
```bash
uvicorn main:app --host 0.0.0.0 --port 8000
```

### 4. Expose to Twilio (development)
```bash
ngrok http 8000
```
Set your Twilio phone number's **Voice webhook** to:
```
https://<your-ngrok-url>/twilio/incoming
```

---

## Environment Variables

| Variable | Description |
|---|---|
| `TWILIO_ACCOUNT_SID` | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | Twilio auth token |
| `TWILIO_PHONE_NUMBER` | Your Twilio phone number (E.164) |
| `AWS_ACCESS_KEY_ID` | AWS credentials (Bedrock LLM + S3) |
| `AWS_SECRET_ACCESS_KEY` | AWS secret |
| `AWS_REGION` | AWS region (default: `ap-southeast-2`) |
| `BEDROCK_MODEL_ID` | Claude model ID on Bedrock |
| `DEEPGRAM_API_KEY` | Deepgram API key (STT) |
| `TTS_PROVIDER` | `cartesia` \| `polly` \| `elevenlabs` \| `deepgram_aura` |
| `CARTESIA_API_KEY` | Cartesia API key |
| `CARTESIA_VOICE_ID` | Cartesia voice ID |
| `CARTESIA_MODEL_ID` | Cartesia model (e.g. `sonic-3.5`) |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key |
| `S3_TRANSCRIPT_BUCKET` | S3 bucket name for transcripts (leave blank to disable) |
| `APP_BASE_URL` | Public HTTPS URL Twilio uses to reach this server |
| `CLINIC_NAME` | Clinic name the bot speaks aloud |

See `.env.example` for the complete list with defaults.

---

## Local Testing (no Twilio)

Test the full agent using your laptop mic and speakers:
```bash
python local_test.py
python local_test.py --phone +61412345678
```

---

## Database

Run `supabase_schema.sql` against your Supabase project. Tables:
- `patients` — patient records (name, DOB, phone)
- `doctors` — doctor records
- `doctor_calendar` — available appointment slots (`is_booked` flag)
- `bookings` — confirmed/cancelled bookings

---

## Call Transcripts

Saved to S3 after every call:
```
s3://<bucket>/transcripts/<YYYY>/<MM>/<DD>/<PatientName>_<ClinicName>_<CallSID>.json
```

---

## Docker

```bash
docker-compose up --build
```

# Receptionist UI

React web app for the GP clinic human receptionist. Built with **Vite + React 18 + Tailwind CSS**.

## Getting Started

```bash
cd receptionist-ui
npm install
cp .env.example .env
npm run dev
```

App runs at **http://localhost:5173**

### Demo credentials
| Username | Password | Role |
|----------|----------|------|
| `reception1` | `clinic2026` | Senior Receptionist |
| `reception2` | `clinic2026` | Receptionist |
| `admin` | `admin2026` | Admin |

## Features

- **Login** — session-based auth
- **Dashboard** — today's appointments, upcoming bookings, available slots, recent calls
- **Doctor Schedule** — weekly calendar grid, add single/recurring slots, delete free slots
- **Bookings** — searchable list, status updates, detail panel, transcription link
- **Transcriptions** — all AI call transcripts with chat-bubble viewer and S3-ready abstraction

## Transcription Storage

Set in `.env`:
- `VITE_TRANSCRIPTION_STORAGE=local` (default) — reads `src/data/transcriptions.json`
- `VITE_TRANSCRIPTION_STORAGE=s3` — implement stub in `src/services/transcriptionService.js`

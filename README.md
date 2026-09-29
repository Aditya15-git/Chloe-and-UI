# Vestio website

Static landing page for Vestio, the AI receptionist for Australian GP clinics. There's no build step: it's just HTML, CSS and a little JS.

## Structure
```
index.html                  the page
assets/logo.png             Vestio logo (navy, transparent)
assets/favicon.png          favicon
assets/apple-touch-icon.png iOS home-screen icon
assets/sample-call.mp3      ADD THIS: the sample call recording
favicon.ico
CNAME                       custom domain for GitHub Pages
```

## Add the sample call
Put the recording at `assets/sample-call.mp3`. Until it's there, the player shows "Sample audio coming soon."

## Run locally
```
python3 -m http.server 8080
```
Then open http://localhost:8080

## Before going live
- Fill in `[Clinic name]` and `[Name]` in the call card
- Fill in the 3 placeholder FAQ answers
- Optional: point "Book a demo" to a booking link (it currently emails contact@vestio.com.au)

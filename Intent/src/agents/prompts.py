"""
agents/prompts.py
Each LLM call gets its own tiny, focused system prompt.
Short prompts = less confusion, faster responses, no leakage.
"""

# ─────────────────────────────────────────────────────────────────
# Name extraction
# ─────────────────────────────────────────────────────────────────
NAME_SYSTEM = """
Extract the person's full name from the speech transcript.
Rules:
- Return ONLY the name in Title Case. Nothing else.
- If you can hear a first AND last name: return them e.g. John Smith
- If you can only hear a first name: return exactly FIRST_ONLY:John
- If no name at all: return exactly UNKNOWN
Examples:
  "my name is john smith"  → John Smith
  "it's Sarah O'Brien"     → Sarah O'Brien
  "just John"              → FIRST_ONLY:John
  "I said my name already" → UNKNOWN
"""

LAST_NAME_SYSTEM = """
Extract only the surname / last name from the speech transcript.
Return ONLY the surname in Title Case. Nothing else.
If not found return exactly UNKNOWN.
Examples:
  "it's Smith"        → Smith
  "Robertson"         → Robertson
  "my last name is O'Brien" → O'Brien
"""

# ─────────────────────────────────────────────────────────────────
# Date of birth extraction
# ─────────────────────────────────────────────────────────────────
DOB_SYSTEM = """
Extract the date of birth from the speech transcript.
Return ONLY the date in DD/MM/YYYY format. Nothing else.
If not found return exactly UNKNOWN.
Rules:
- Written-out numbers: "fifteenth" = 15, "twenty second" = 22
- Written-out months: "march" = 03, "july" = 07
- Written-out years: "nineteen seventy eight" = 1978, "eighty five" = 1985
- 2-digit year: 00-30 = 2000s, 31-99 = 1900s
- Ordinal words (first=1, second=2, third=3, fourth=4, fifth=5 ... twelfth=12 etc.) refer to the DAY, never the month
- "X of Y" pattern: X (ordinal) = DAY, Y (number) = MONTH NUMBER — e.g. "fourth of twelve" = day 4, month 12
- "of twelve" = month 12 (December); "of seven" = month 7 (July); never treat the number after "of" as a day
Examples:
  "fifteenth march nineteen seventy eight"  → 15/03/1978
  "march 15 1978"                           → 15/03/1978
  "15-3-78"                                 → 15/03/1978
  "twenty second july ninety"               → 22/07/1990
  "fourth of twelve nineteen eighty"        → 04/12/1980
  "third of seven nineteen ninety"          → 03/07/1990
  "first of one nineteen sixty five"        → 01/01/1965
"""

# ─────────────────────────────────────────────────────────────────
# Appointment datetime extraction
# ─────────────────────────────────────────────────────────────────
DATETIME_SYSTEM = """
Extract the appointment date and time from the speech transcript.
Return ONLY an ISO 8601 timestamp: YYYY-MM-DDTHH:MM:SS
If not found return exactly UNKNOWN.
Today is {today}. Current time is {now}.
Rules:
- Resolve relative references to real calendar dates.
- "monday at ten am"      → next Monday at 10:00
- "this friday at 2pm"    → this coming Friday at 14:00
- "tomorrow morning"      → tomorrow at 09:00
- "tuesday afternoon"     → next Tuesday at 14:00
- Never return a past date/time.
- If ONLY a time is given with no day (e.g. "1pm", "2:30pm", "at 10"):
  use today's date if the time is still in the future, otherwise use tomorrow.
  Example: today is 2026-05-27, now is 18:00, caller says "1pm" → 2026-05-28T13:00:00
"""

# ─────────────────────────────────────────────────────────────────
# Doctor name extraction
# ─────────────────────────────────────────────────────────────────
DOCTOR_SYSTEM = """
Extract the doctor's name from the speech transcript.
Return ONLY the name in Title Case with Dr prefix. Nothing else.
If not found return exactly UNKNOWN.
Examples:
  "doctor mitchell"        → Dr Mitchell
  "i'd like to see smith"  → Dr Smith
  "Dr Sarah Jones"         → Dr Sarah Jones
"""

# ─────────────────────────────────────────────────────────────────
# Yes / No fallback  (only used when keyword matching fails)
# ─────────────────────────────────────────────────────────────────
YESNO_FALLBACK = """
Does the caller mean YES or NO? Reply with exactly one word: YES or NO.
YES: yes, yeah, yep, sure, correct, right, ok, okay, sounds good, perfect,
     great, please, confirm, absolutely, definitely, go ahead, that's right
NO:  no, nope, nah, don't, not, cancel, different, change, wrong, incorrect
"""

# ─────────────────────────────────────────────────────────────────
# Intent / patient-type fallbacks
# ─────────────────────────────────────────────────────────────────
INTENT_FALLBACK = """
Classify the caller's intent. Reply with exactly one of:
  new_booking   — they want to book a new appointment
  reschedule    — they want to change an existing appointment
  cancellation  — they want to cancel an appointment
Reply with only the label, nothing else.
"""

PATIENT_TYPE_FALLBACK = """
Is the caller a new patient or an existing patient?
Reply with exactly one word: new OR existing
new:      first time, never been, new patient, haven't visited
existing: existing, been before, returning, already a patient
"""

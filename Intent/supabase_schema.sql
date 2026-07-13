-- ============================================================
--  AI Receptionist – Supabase Schema
--  Run this entire file in the Supabase SQL editor.
-- ============================================================

-- ── Extensions ──────────────────────────────────────────────
create extension if not exists "uuid-ossp";
create extension if not exists "pg_cron";   -- optional: for slot generation jobs


-- ============================================================
--  1. PATIENTS
-- ============================================================
create table if not exists patients (
  id               uuid primary key default uuid_generate_v4(),
  full_name        text        not null,
  date_of_birth    date        not null,
  phone            text,
  email            text,
  medicare_number  text,
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- Unique constraint: same name + DOB = same person
  unique (full_name, date_of_birth)
);

-- Index for fast lookup during call
create index if not exists idx_patients_name_dob
  on patients (lower(full_name), date_of_birth);

-- Auto-update updated_at
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger trg_patients_updated_at
  before update on patients
  for each row execute function set_updated_at();


-- ============================================================
--  2. DOCTORS
-- ============================================================
create table if not exists doctors (
  id               uuid primary key default uuid_generate_v4(),
  name             text        not null unique,
  specialty        text,
  is_active        boolean     not null default true,
  created_at       timestamptz not null default now()
);

-- ── Sample doctors ──────────────────────────────────────────
insert into doctors (name, specialty) values
  ('Dr Sarah Mitchell',  'General Practice'),
  ('Dr James Wong',      'General Practice'),
  ('Dr Priya Sharma',    'General Practice')
on conflict (name) do nothing;


-- ============================================================
--  3. DOCTOR CALENDAR (available slots)
-- ============================================================
create table if not exists doctor_calendar (
  id           uuid primary key default uuid_generate_v4(),
  doctor_id    uuid        not null references doctors(id) on delete cascade,
  slot_start   timestamptz not null,
  slot_end     timestamptz not null generated always as (slot_start + interval '30 minutes') stored,
  is_booked    boolean     not null default false,
  created_at   timestamptz not null default now(),

  unique (doctor_id, slot_start)
);

create index if not exists idx_calendar_doctor_start
  on doctor_calendar (doctor_id, slot_start)
  where not is_booked;

create index if not exists idx_calendar_available
  on doctor_calendar (slot_start)
  where not is_booked;


-- ── Generate ~2 weeks of 30-min slots for each doctor ───────
-- Mon–Fri 09:00–17:00 AEST (UTC+10).  Adjust timezone as needed.
-- Run once, then set up pg_cron to extend weekly.

do $$
declare
  d         date;
  t         time;
  doc       record;
  slot_ts   timestamptz;
begin
  for d in
    select generate_series(
      current_date,
      current_date + interval '14 days',
      interval '1 day'
    )::date
  loop
    -- Skip weekends
    if extract(dow from d) in (0, 6) then
      continue;
    end if;

    for t in
      select generate_series(
        '09:00'::time,
        '16:30'::time,
        interval '30 minutes'
      )
    loop
      -- Slots are stored in UTC; convert from AEST (UTC+10)
      slot_ts := (d || ' ' || t)::timestamp at time zone 'Australia/Sydney';

      for doc in select id from doctors where is_active = true loop
        insert into doctor_calendar (doctor_id, slot_start)
        values (doc.id, slot_ts)
        on conflict (doctor_id, slot_start) do nothing;
      end loop;
    end loop;
  end loop;
end;
$$;


-- ============================================================
--  4. BOOKINGS
-- ============================================================
create table if not exists bookings (
  id                 uuid primary key default uuid_generate_v4(),
  patient_id         uuid        not null references patients(id),
  calendar_slot_id   uuid        not null references doctor_calendar(id),
  reason             text,
  appointment_type   text        not null default 'in_clinic'
                       check (appointment_type in ('in_clinic', 'telehealth')),
  status             text        not null default 'confirmed'
                       check (status in ('confirmed', 'cancelled', 'completed', 'no_show')),
  confirmation_sent  boolean     not null default false,
  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  unique (calendar_slot_id)   -- one booking per slot
);

create index if not exists idx_bookings_patient
  on bookings (patient_id, status);

create trigger trg_bookings_updated_at
  before update on bookings
  for each row execute function set_updated_at();


-- ============================================================
--  5. CALL LOGS (audit trail)
-- ============================================================
create table if not exists call_logs (
  id          uuid primary key default uuid_generate_v4(),
  call_sid    text        not null,
  patient_id  uuid        references patients(id),
  booking_id  uuid        references bookings(id),
  outcome     text,           -- booked | rescheduled | transferred | emergency | abandoned
  duration_s  integer,
  transcript  jsonb,          -- full turn-by-turn transcript
  created_at  timestamptz not null default now()
);

create index if not exists idx_call_logs_sid on call_logs(call_sid);


-- ============================================================
--  6. ROW-LEVEL SECURITY
--  The AI backend uses the service-role key (bypasses RLS).
--  Enable RLS anyway so the anon key is locked down.
-- ============================================================
alter table patients       enable row level security;
alter table doctors        enable row level security;
alter table doctor_calendar enable row level security;
alter table bookings       enable row level security;
alter table call_logs      enable row level security;

-- Block all anon / authenticated access by default.
-- The backend uses the service_role key which bypasses RLS.
create policy "deny_all_anon_patients"
  on patients for all to anon using (false);
create policy "deny_all_anon_doctors"
  on doctors for all to anon using (false);
create policy "deny_all_anon_calendar"
  on doctor_calendar for all to anon using (false);
create policy "deny_all_anon_bookings"
  on bookings for all to anon using (false);
create policy "deny_all_anon_call_logs"
  on call_logs for all to anon using (false);


-- ============================================================
--  7. HELPER VIEWS (useful for the dashboard / admin portal)
-- ============================================================
create or replace view upcoming_appointments as
select
  b.id              as booking_id,
  p.full_name       as patient_name,
  p.date_of_birth,
  p.phone,
  d.name            as doctor_name,
  dc.slot_start,
  dc.slot_end,
  b.reason,
  b.appointment_type,
  b.status
from bookings b
join patients p         on b.patient_id       = p.id
join doctor_calendar dc on b.calendar_slot_id  = dc.id
join doctors d          on dc.doctor_id        = d.id
where dc.slot_start >= now()
  and b.status = 'confirmed'
order by dc.slot_start;


-- ============================================================
--  8. OPTIONAL: pg_cron job to generate slots weekly
--  Requires pg_cron extension enabled in Supabase dashboard.
-- ============================================================
-- select cron.schedule(
--   'generate-weekly-slots',
--   '0 0 * * 1',     -- every Monday midnight
--   $$
--     insert into doctor_calendar (doctor_id, slot_start)
--     select
--       d.id,
--       s.slot at time zone 'Australia/Sydney'
--     from doctors d,
--     lateral (
--       select generate_series(
--         date_trunc('week', now()) + interval '14 days' + '09:00'::time,
--         date_trunc('week', now()) + interval '21 days' - interval '30 minutes',
--         interval '30 minutes'
--       ) as slot
--     ) s
--     where d.is_active = true
--       and extract(dow from s.slot at time zone 'Australia/Sydney') not in (0,6)
--       and s.slot::time between '09:00' and '16:30'
--     on conflict (doctor_id, slot_start) do nothing;
--   $$
-- );


-- ============================================================
--  Done ✓
-- ============================================================
select 'Schema created successfully' as result;

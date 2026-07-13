/**
 * Dashboard Service
 *
 * All queries needed by the Dashboard page, using the real Supabase DB.
 *
 * Join chain used for bookings:
 *   bookings
 *     → patients          (via patient_id       → patients.id)
 *     → doctor_calendar   (via calendar_slot_id → doctor_calendar.id)
 *         → doctors       (via doctor_id        → doctors.id)
 */

import { supabase } from '../lib/supabase';
import { isToday, isFuture, parseISO, startOfDay, endOfDay } from 'date-fns';

// ─── Shape raw Supabase row into a flat booking object ─────────────────────

function normalizeBooking(row) {
  const cal = row.doctor_calendar ?? {};
  const doc = cal.doctors ?? {};
  const pat = row.patients ?? {};

  return {
    id:                 row.id,
    status:             row.status,
    reason:             row.reason,
    appointment_type:   row.appointment_type,
    confirmation_sent:  row.confirmation_sent,
    notes:              row.notes,
    created_at:         row.created_at,
    patient_name:       pat.full_name  ?? 'Unknown Patient',
    doctor_name:        doc.name       ?? 'Unknown Doctor',
    slot_start:         cal.slot_start ?? null,
    slot_end:           cal.slot_end   ?? null,
  };
}

// ─── Queries ───────────────────────────────────────────────────────────────

/**
 * Fetch all bookings with denormalised patient name, doctor name, and slot times.
 * Filtering (today / upcoming) is done in JS so one round-trip serves all stats.
 */
export async function fetchAllBookings() {
  const { data, error } = await supabase
    .from('bookings')
    .select(`
      id,
      status,
      reason,
      appointment_type,
      confirmation_sent,
      notes,
      created_at,
      patients ( full_name ),
      doctor_calendar (
        slot_start,
        slot_end,
        doctors ( name )
      )
    `)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return (data ?? []).map(normalizeBooking);
}

/**
 * Count of doctor_calendar slots that are still free and haven't started yet.
 */
export async function fetchFreeSlotCount() {
  const now = new Date().toISOString();
  const { count, error } = await supabase
    .from('doctor_calendar')
    .select('id', { count: 'exact', head: true })
    .eq('is_booked', false)
    .gte('slot_start', now);

  if (error) throw error;
  return count ?? 0;
}

/**
 * All active doctors.
 */
export async function fetchActiveDoctors() {
  const { data, error } = await supabase
    .from('doctors')
    .select('id, name, specialty, is_active')
    .eq('is_active', true)
    .order('name');

  if (error) throw error;
  return data ?? [];
}

/**
 * Total count of call_log records.
 */
export async function fetchCallLogCount() {
  const { count, error } = await supabase
    .from('call_logs')
    .select('id', { count: 'exact', head: true });

  if (error) return 0;
  return count ?? 0;
}

/**
 * Count of call_log records with outcome = 'appointment_booked'.
 */
export async function fetchBookedCallCount() {
  const { count, error } = await supabase
    .from('call_logs')
    .select('id', { count: 'exact', head: true })
    .eq('outcome', 'appointment_booked');

  if (error) return 0;
  return count ?? 0;
}

/**
 * Count of call_log records with outcome = 'transferred_to_human'.
 */
export async function fetchTransferredCallCount() {
  const { count, error } = await supabase
    .from('call_logs')
    .select('id', { count: 'exact', head: true })
    .eq('outcome', 'transferred_to_human');

  if (error) return 0;
  return count ?? 0;
}

/**
 * Most-recent call log rows (for the "Recent Calls" feed).
 */
export async function fetchRecentCallLogs(limit = 5) {
  const { data, error } = await supabase
    .from('call_logs')
    .select('id, call_sid, outcome, duration_s, created_at, cost_usd, patients ( full_name )')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) return [];
  return (data ?? []).map((row) => ({
    id:           row.id,
    call_sid:     row.call_sid,
    outcome:      row.outcome,
    duration_s:   row.duration_s,
    created_at:   row.created_at,
    cost_usd:     row.cost_usd ?? null,
    patient_name: row.patients?.full_name ?? 'Unknown Caller',
  }));
}

// ─── Derived helpers (all run in JS after fetching) ────────────────────────

/** Bookings whose slot_start falls on today (local time). */
export function filterToday(bookings) {
  return bookings.filter(
    (bk) => bk.slot_start && isToday(parseISO(bk.slot_start))
  );
}

/** Bookings whose slot_start is in the future (local time), sorted soonest first. */
export function filterUpcoming(bookings) {
  return bookings
    .filter((bk) => bk.slot_start && isFuture(parseISO(bk.slot_start)))
    .sort((a, b) => a.slot_start.localeCompare(b.slot_start));
}

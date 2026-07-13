/**
 * Data Service — Supabase-backed
 *
 * All operations hit the live Supabase database.
 * Schema assumptions (see SQL migration below if tables are missing):
 *   doctors              (id, name, specialty, is_active, created_at)
 *   doctor_calendar      (id, doctor_id, slot_start, slot_end, is_booked, created_at)
 *   doctor_master_schedule (id, doctor_id, days jsonb, slot_duration_mins, notes, updated_at)
 *   bookings             (id, patient_id, calendar_slot_id, call_log_id, status,
 *                          reason, appointment_type, confirmation_sent, notes, created_at)
 *   patients             (id, full_name, ...)
 */

import { supabase } from '../lib/supabase';

// ─── Booking row normaliser ────────────────────────────────────────────────────
// Flattens the joined Supabase row into the shape the UI expects.

function normalizeBooking(row) {
  const cal = row.doctor_calendar ?? {};
  const doc = cal.doctors ?? {};
  const pat = row.patients ?? {};
  return {
    id:                row.id,
    status:            row.status,
    reason:            row.reason,
    appointment_type:  row.appointment_type,
    confirmation_sent: row.confirmation_sent,
    notes:             row.notes,
    created_at:        row.created_at,
    call_log_id:       row.call_log_id ?? null,
    calendar_slot_id:  row.calendar_slot_id ?? null,
    patient_name:      pat.full_name ?? 'Unknown Patient',
    doctor_name:       doc.name ?? 'Unknown Doctor',
    slot_start:        cal.slot_start ?? null,
    slot_end:          cal.slot_end ?? null,
  };
}

// Matches the confirmed-working dashboardService select exactly.
// doctor_id is NOT embedded here — listing a FK column alongside its referenced
// table embed causes a PostgREST ambiguity error. Fetch doctor_id separately via
// scheduleService.getById() when needed (e.g. reschedule flow).
const BOOKING_SELECT = `
  id, status, reason, appointment_type, confirmation_sent,
  notes, created_at, calendar_slot_id, call_log_id,
  patients ( full_name ),
  doctor_calendar ( slot_start, slot_end, doctors ( name ) )
`;

// ─── Doctors ──────────────────────────────────────────────────────────────────

export const doctorService = {
  getAll: async () => {
    const { data, error } = await supabase
      .from('doctors')
      .select('*')
      .order('name');
    if (error) throw error;
    return data ?? [];
  },

  getActive: async () => {
    const { data, error } = await supabase
      .from('doctors')
      .select('*')
      .eq('is_active', true)
      .order('name');
    if (error) throw error;
    return data ?? [];
  },

  getById: async (id) => {
    const { data, error } = await supabase
      .from('doctors')
      .select('*')
      .eq('id', id)
      .single();
    if (error) return null;
    return data;
  },

  update: async (id, patch) => {
    const { data, error } = await supabase
      .from('doctors')
      .update(patch)
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    return data;
  },
};

// ─── Doctor Calendar / Schedules ──────────────────────────────────────────────

export const scheduleService = {
  getAll: async () => {
    const { data, error } = await supabase
      .from('doctor_calendar')
      .select('*')
      .order('slot_start');
    if (error) throw error;
    return data ?? [];
  },

  getById: async (id) => {
    const { data, error } = await supabase
      .from('doctor_calendar')
      .select('*')
      .eq('id', id)
      .single();
    if (error) return null;
    return data;
  },

  getByDoctor: async (doctorId) => {
    const { data, error } = await supabase
      .from('doctor_calendar')
      .select('*')
      .eq('doctor_id', doctorId)
      .order('slot_start');
    if (error) throw error;
    return data ?? [];
  },

  getFreeByDoctorAndDate: async (doctorId, dateStr) => {
    const { data, error } = await supabase
      .from('doctor_calendar')
      .select('*')
      .eq('doctor_id', doctorId)
      .eq('is_booked', false)
      .gte('slot_start', `${dateStr}T00:00:00Z`)
      .lte('slot_start', `${dateStr}T23:59:59Z`)
      .order('slot_start');
    if (error) throw error;
    return data ?? [];
  },

  getByDoctorAndDate: async (doctorId, dateStr) => {
    const { data, error } = await supabase
      .from('doctor_calendar')
      .select('*')
      .eq('doctor_id', doctorId)
      .gte('slot_start', `${dateStr}T00:00:00Z`)
      .lte('slot_start', `${dateStr}T23:59:59Z`)
      .order('slot_start');
    if (error) throw error;
    return data ?? [];
  },

  getByDateRange: async (startISO, endISO) => {
    const { data, error } = await supabase
      .from('doctor_calendar')
      .select('*')
      .gte('slot_start', startISO)
      .lte('slot_start', endISO)
      .order('slot_start');
    if (error) throw error;
    return data ?? [];
  },

  add: async (slot) => {
    const { data, error } = await supabase
      .from('doctor_calendar')
      .insert({ is_booked: false, ...slot })
      .select()
      .single();
    if (error) throw error;
    return data;
  },

  update: async (id, patch) => {
    const { data, error } = await supabase
      .from('doctor_calendar')
      .update(patch)
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    return data;
  },

  delete: async (id) => {
    // Read first to give a meaningful error on booked slots
    const { data: slot, error: fetchErr } = await supabase
      .from('doctor_calendar')
      .select('is_booked')
      .eq('id', id)
      .single();
    if (fetchErr || !slot) throw new Error('Slot not found');
    if (slot.is_booked)    throw new Error('Cannot delete a booked slot');
    const { error } = await supabase
      .from('doctor_calendar')
      .delete()
      .eq('id', id);
    if (error) throw error;
    return true;
  },

  addRecurring: async ({ doctorId, dates, startTime, endTime, slotDurationMins }) => {
    const slots = [];
    for (const date of dates) {
      let cursor = new Date(`${date}T${startTime}:00Z`);
      const end   = new Date(`${date}T${endTime}:00Z`);
      while (cursor < end) {
        const slotEnd = new Date(cursor.getTime() + slotDurationMins * 60000);
        slots.push({
          doctor_id:  doctorId,
          slot_start: cursor.toISOString(),
          slot_end:   slotEnd.toISOString(),
          is_booked:  false,
        });
        cursor = slotEnd;
      }
    }
    if (slots.length === 0) return [];
    const { data, error } = await supabase
      .from('doctor_calendar')
      .insert(slots)
      .select();
    if (error) throw error;
    return data ?? [];
  },
};

// ─── Master Schedule (weekly working template per doctor) ─────────────────────

export const masterScheduleService = {
  getByDoctor: async (doctorId) => {
    const { data, error } = await supabase
      .from('doctor_master_schedule')
      .select('*')
      .eq('doctor_id', doctorId)
      .maybeSingle();
    if (error) throw error;
    return data;
  },

  save: async ({ doctor_id, days, slot_duration_mins, notes }) => {
    const payload = {
      doctor_id,
      days,
      slot_duration_mins,
      notes,
      updated_at: new Date().toISOString(),
    };
    const { data, error } = await supabase
      .from('doctor_master_schedule')
      .upsert(payload, { onConflict: 'doctor_id' })
      .select()
      .single();
    if (error) throw error;
    return data;
  },
};

// ─── Bookings ─────────────────────────────────────────────────────────────────

export const bookingService = {
  getAll: async () => {
    const { data, error } = await supabase
      .from('bookings')
      .select(BOOKING_SELECT)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return (data ?? []).map(normalizeBooking);
  },

  getUpcoming: async () => {
    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from('bookings')
      .select(BOOKING_SELECT)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return (data ?? [])
      .map(normalizeBooking)
      .filter((b) => b.slot_start && b.slot_start >= now)
      .sort((a, b) => a.slot_start.localeCompare(b.slot_start));
  },

  getToday: async () => {
    const today = new Date().toISOString().split('T')[0];
    const { data, error } = await supabase
      .from('bookings')
      .select(BOOKING_SELECT);
    if (error) throw error;
    return (data ?? [])
      .map(normalizeBooking)
      .filter((b) => b.slot_start?.startsWith(today));
  },

  getById: async (id) => {
    const { data, error } = await supabase
      .from('bookings')
      .select(BOOKING_SELECT)
      .eq('id', id)
      .single();
    if (error) return null;
    return normalizeBooking(data);
  },

  update: async (id, patch) => {
    const { data, error } = await supabase
      .from('bookings')
      .update(patch)
      .eq('id', id)
      .select(BOOKING_SELECT)
      .single();
    if (error) throw error;
    return normalizeBooking(data);
  },

  /** Move a booking to a different calendar slot. */
  reschedule: async (bookingId, oldSlotId, newSlotId) => {
    const { error: e1 } = await supabase
      .from('doctor_calendar').update({ is_booked: false }).eq('id', oldSlotId);
    if (e1) throw new Error(`Could not release old slot: ${e1.message}`);

    const { error: e2 } = await supabase
      .from('doctor_calendar').update({ is_booked: true }).eq('id', newSlotId);
    if (e2) throw new Error(`Could not claim new slot: ${e2.message}`);

    const { data, error } = await supabase
      .from('bookings')
      .update({ calendar_slot_id: newSlotId })
      .eq('id', bookingId)
      .select(BOOKING_SELECT)
      .single();
    if (error) throw error;
    return normalizeBooking(data);
  },

  /**
   * Manually book an appointment.
   * Finds-or-creates a patient by full_name, inserts the booking,
   * and marks the calendar slot as booked — all in one call.
   */
  book: async ({ slotId, patientName, dateOfBirth, reason, appointmentType, notes }) => {
    // 1. Find existing patient (case-insensitive match on name) or create a new one
    let patientId;
    const { data: existing } = await supabase
      .from('patients')
      .select('id')
      .ilike('full_name', patientName.trim())
      .limit(1)
      .maybeSingle();

    if (existing) {
      patientId = existing.id;
    } else {
      const { data: newPat, error: patErr } = await supabase
        .from('patients')
        .insert({ full_name: patientName.trim(), date_of_birth: dateOfBirth })
        .select('id')
        .single();
      if (patErr) throw new Error(`Could not create patient: ${patErr.message}`);
      patientId = newPat.id;
    }

    // 2. Insert the booking
    const { data: booking, error: bookErr } = await supabase
      .from('bookings')
      .insert({
        patient_id:       patientId,
        calendar_slot_id: slotId,
        reason:           reason.trim(),
        appointment_type: appointmentType,
        status:           'confirmed',
        confirmation_sent: false,
        notes:            notes.trim(),
      })
      .select(BOOKING_SELECT)
      .single();
    if (bookErr) throw new Error(`Could not create booking: ${bookErr.message}`);

    // 3. Mark the slot as booked
    const { error: calErr } = await supabase
      .from('doctor_calendar')
      .update({ is_booked: true })
      .eq('id', slotId);
    if (calErr) throw new Error(`Booking saved but could not mark slot: ${calErr.message}`);

    return normalizeBooking(booking);
  },
};

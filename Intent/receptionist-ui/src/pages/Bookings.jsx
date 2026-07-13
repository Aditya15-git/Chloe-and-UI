import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Search, FileText, CheckCircle2, Edit2,
  Clock, XCircle, User, Stethoscope, AlertCircle, X, Calendar,
} from 'lucide-react';
import { format, isToday, isTomorrow, parseISO } from 'date-fns';
import { bookingService, scheduleService } from '../services/dataService';

const STATUS_CONFIG = {
  confirmed: { label: 'Confirmed', icon: CheckCircle2, color: 'bg-green-100 text-green-700 border-green-200' },
  pending:   { label: 'Pending',   icon: Clock,        color: 'bg-amber-100 text-amber-700 border-amber-200' },
  cancelled: { label: 'Cancelled', icon: XCircle,      color: 'bg-red-100 text-red-600 border-red-200'   },
};

const TYPE_CONFIG = {
  in_clinic:  { label: 'In Clinic',  color: 'bg-blue-50 text-blue-700' },
  telehealth: { label: 'Telehealth', color: 'bg-violet-50 text-violet-700' },
  phone:      { label: 'Phone',      color: 'bg-amber-50 text-amber-700' },
};

// Slot times are stored as UTC ISO strings representing clinic-local time.
// Read UTC parts directly so client timezone doesn't shift the display.
function fmtUTC(iso) {
  const d = new Date(iso);
  const h24 = d.getUTCHours();
  const h   = h24 % 12 || 12;
  const m   = d.getUTCMinutes().toString().padStart(2, '0');
  return `${h}:${m} ${h24 >= 12 ? 'PM' : 'AM'}`;
}

function formatSlotDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  // Build a local-midnight Date from UTC parts so isToday/isTomorrow work correctly
  const utcDate = new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  if (isToday(utcDate))    return `Today, ${fmtUTC(iso)}`;
  if (isTomorrow(utcDate)) return `Tomorrow, ${fmtUTC(iso)}`;
  return `${format(utcDate, 'EEE d MMM yyyy')}, ${fmtUTC(iso)}`;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtSlotTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const h24 = d.getUTCHours(), h = h24 % 12 || 12;
  const m = d.getUTCMinutes().toString().padStart(2, '0');
  return `${h}:${m} ${h24 >= 12 ? 'PM' : 'AM'}`;
}

// Returns the UTC date string "YYYY-MM-DD" from an ISO timestamp
function utcDateKey(iso) {
  return iso ? iso.slice(0, 10) : 'no-date';
}

// Format a date group header label from a "YYYY-MM-DD" key
function fmtGroupDate(key) {
  if (!key || key === 'no-date') return 'Date Unknown';
  const [y, mo, d] = key.split('-').map(Number);
  const local = new Date(y, mo - 1, d); // local midnight — matches UTC clinic date
  if (isToday(local))    return `Today · ${format(local, 'EEEE, d MMMM yyyy')}`;
  if (isTomorrow(local)) return `Tomorrow · ${format(local, 'EEEE, d MMMM yyyy')}`;
  return format(local, 'EEEE, d MMMM yyyy');
}

// Groups a sorted booking list into date buckets, newest date first.
// Within each bucket bookings are ordered ascending by time (chronological).
function groupBookings(list) {
  const map = {};
  for (const bk of list) {
    const key = utcDateKey(bk.slot_start);
    if (!map[key]) map[key] = [];
    map[key].push(bk);
  }
  const keys = Object.keys(map).sort((a, b) => {
    if (a === 'no-date') return 1;
    if (b === 'no-date') return -1;
    return b.localeCompare(a); // descending — latest date first
  });
  return keys.map((key) => ({
    key,
    items: map[key].sort((a, b) =>
      (a.slot_start ?? '').localeCompare(b.slot_start ?? '') // asc within a day
    ),
  }));
}

// ─── Edit Booking Modal ────────────────────────────────────────────────────────

const APPT_TYPES = [
  { value: 'in_clinic',  label: 'In Clinic' },
  { value: 'telehealth', label: 'Telehealth' },
];

function EditBookingModal({ booking, onClose, onSave }) {
  const [tab, setTab] = useState('details');

  // Details form
  const [form, setForm] = useState({
    reason:          booking.reason ?? '',
    appointmentType: booking.appointment_type ?? 'in_clinic',
    notes:           booking.notes ?? '',
  });

  // Reschedule form
  const [rescheduleDate, setRescheduleDate]   = useState(
    booking.slot_start ? booking.slot_start.slice(0, 10) : format(new Date(), 'yyyy-MM-dd')
  );
  const [freeSlots,      setFreeSlots]        = useState([]);
  const [selectedSlotId, setSelectedSlotId]   = useState(null);
  const [loadingSlots,   setLoadingSlots]     = useState(false);
  // doctor_id fetched lazily from the calendar slot (not on the booking row directly)
  const [doctorId, setDoctorId] = useState(null);

  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState('');

  // When reschedule tab opens, resolve doctor_id from the current slot
  useEffect(() => {
    if (tab !== 'reschedule' || !booking.calendar_slot_id) return;
    scheduleService.getById(booking.calendar_slot_id)
      .then((slot) => { if (slot?.doctor_id) setDoctorId(slot.doctor_id); })
      .catch(() => {});
  }, [tab, booking.calendar_slot_id]);

  // Load free slots whenever the reschedule tab is open and date / doctorId changes
  useEffect(() => {
    if (tab !== 'reschedule' || !doctorId) return;
    setLoadingSlots(true);
    setFreeSlots([]);
    setSelectedSlotId(null);
    scheduleService.getFreeByDoctorAndDate(doctorId, rescheduleDate)
      .then(setFreeSlots)
      .catch(() => setFreeSlots([]))
      .finally(() => setLoadingSlots(false));
  }, [tab, rescheduleDate, doctorId]);

  const handleSaveDetails = async () => {
    if (!form.reason.trim()) return setError('Reason is required.');
    setSaving(true);
    setError('');
    try {
      await bookingService.update(booking.id, {
        reason:           form.reason.trim(),
        appointment_type: form.appointmentType,
        notes:            form.notes.trim(),
      });
      onSave();
    } catch (e) { setError(e.message); }
    setSaving(false);
  };

  const handleReschedule = async () => {
    if (!selectedSlotId) return setError('Please select a new time slot.');
    setSaving(true);
    setError('');
    try {
      await bookingService.reschedule(booking.id, booking.calendar_slot_id, selectedSlotId);
      onSave();
    } catch (e) { setError(e.message); }
    setSaving(false);
  };

  const tabCls = (t) =>
    `px-4 py-2 text-sm font-medium border-b-2 transition ${
      tab === t
        ? 'border-primary-600 text-primary-600'
        : 'border-transparent text-slate-500 hover:text-slate-700'
    }`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 flex-shrink-0">
          <h3 className="font-semibold text-slate-800 flex items-center gap-2">
            <Edit2 size={16} className="text-primary-600" /> Edit Booking
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 transition">
            <X size={20} />
          </button>
        </div>

        {/* Patient + current slot summary */}
        <div className="px-6 py-3 bg-slate-50 border-b border-slate-100 flex-shrink-0">
          <p className="text-sm font-semibold text-slate-800">{booking.patient_name}</p>
          <p className="text-xs text-slate-500 mt-0.5">
            {booking.doctor_name} · {booking.slot_start ? `${format(new Date(new Date(booking.slot_start).getUTCFullYear(), new Date(booking.slot_start).getUTCMonth(), new Date(booking.slot_start).getUTCDate()), 'd MMM yyyy')} · ${fmtSlotTime(booking.slot_start)}–${fmtSlotTime(booking.slot_end)}` : 'No slot'}
          </p>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-slate-100 flex-shrink-0 px-6">
          <button className={tabCls('details')}   onClick={() => { setTab('details');    setError(''); }}>Details</button>
          <button className={tabCls('reschedule')} onClick={() => { setTab('reschedule'); setError(''); }}>Reschedule</button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {error && (
            <div className="text-red-600 text-sm bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>
          )}

          {tab === 'details' && (
            <>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Appointment Type</label>
                <div className="flex gap-2">
                  {APPT_TYPES.map(({ value, label }) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setForm({ ...form, appointmentType: value })}
                      className={`flex-1 py-2 rounded-lg text-sm font-medium border transition ${
                        form.appointmentType === value
                          ? 'bg-primary-600 text-white border-primary-600'
                          : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Reason for Visit</label>
                <input
                  type="text"
                  value={form.reason}
                  onChange={(e) => setForm({ ...form, reason: e.target.value })}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Notes <span className="text-slate-400 font-normal">(optional)</span>
                </label>
                <textarea
                  rows={3}
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 resize-none"
                />
              </div>
            </>
          )}

          {tab === 'reschedule' && (
            <>
              {tab === 'reschedule' && !doctorId && !loadingSlots && (
                <p className="text-sm text-slate-400 text-center py-4">Resolving doctor…</p>
              )}
              {doctorId && (
                <>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Select New Date</label>
                    <input
                      type="date"
                      value={rescheduleDate}
                      onChange={(e) => setRescheduleDate(e.target.value)}
                      className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-2">Available Slots</label>
                    {loadingSlots ? (
                      <div className="flex justify-center py-4">
                        <span className="w-5 h-5 border-2 border-primary-600 border-t-transparent rounded-full animate-spin" />
                      </div>
                    ) : freeSlots.length === 0 ? (
                      <p className="text-sm text-slate-400 text-center py-4">No free slots on this date.</p>
                    ) : (
                      <div className="grid grid-cols-3 gap-2">
                        {freeSlots.map((slot) => (
                          <button
                            key={slot.id}
                            type="button"
                            onClick={() => setSelectedSlotId(slot.id)}
                            className={`py-2 px-1 rounded-lg text-xs font-medium border transition ${
                              selectedSlotId === slot.id
                                ? 'bg-primary-600 text-white border-primary-600'
                                : 'bg-white text-slate-700 border-slate-200 hover:border-primary-400'
                            }`}
                          >
                            {fmtSlotTime(slot.slot_start)}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex gap-3 px-6 py-4 border-t border-slate-100 flex-shrink-0">
          <button onClick={onClose} className="flex-1 border border-slate-200 text-slate-600 rounded-lg py-2 text-sm font-medium hover:bg-slate-50 transition">
            Cancel
          </button>
          <button
            onClick={tab === 'details' ? handleSaveDetails : handleReschedule}
            disabled={saving}
            className="flex-1 bg-primary-600 hover:bg-primary-700 text-white rounded-lg py-2 text-sm font-semibold transition disabled:opacity-60 flex items-center justify-center gap-2"
          >
            {saving
              ? <><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Saving…</>
              : tab === 'details' ? 'Save Changes' : 'Confirm Reschedule'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main Page ─────────────────────────────────────────────────────────────────

export default function Bookings() {
  const [bookings, setBookings] = useState([]);
  const [filtered, setFiltered] = useState([]);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [loading, setLoading]       = useState(true);
  const [loadError, setLoadError]   = useState('');
  const [selected, setSelected]     = useState(null);
  const [editBooking, setEditBooking] = useState(null);

  useEffect(() => {
    bookingService.getAll()
      .then((data) => {
        // Primary sort: slot_start descending (latest date at top)
        // Ties (same date) will be resolved by the within-group ascending sort in groupBookings
        const sorted = [...data].sort((a, b) =>
          (b.slot_start ?? '').localeCompare(a.slot_start ?? '')
        );
        setBookings(sorted);
        setFiltered(sorted);
      })
      .catch((err) => setLoadError(err.message ?? 'Failed to load bookings.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    let result = bookings;
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(
        (b) =>
          b.patient_name.toLowerCase().includes(q) ||
          b.doctor_name.toLowerCase().includes(q) ||
          b.reason.toLowerCase().includes(q)
      );
    }
    if (statusFilter !== 'all') {
      result = result.filter((b) => b.status === statusFilter);
    }
    setFiltered(result);
  }, [search, statusFilter, bookings]);

  const updateStatus = async (id, status) => {
    await bookingService.update(id, { status });
    setBookings((prev) => prev.map((b) => b.id === id ? { ...b, status } : b));
    if (selected?.id === id) setSelected((s) => ({ ...s, status }));
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full min-h-screen">
        <div className="animate-spin rounded-full h-10 w-10 border-4 border-primary-600 border-t-transparent" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="p-6 max-w-6xl mx-auto">
        <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-3 text-sm">
          <AlertCircle size={16} className="flex-shrink-0" />
          <span>Failed to load bookings: {loadError}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {editBooking && (
        <EditBookingModal
          booking={editBooking}
          onClose={() => setEditBooking(null)}
          onSave={() => {
            setEditBooking(null);
            setSelected(null);
            bookingService.getAll()
              .then((data) => {
                const sorted = [...data].sort((a, b) =>
                  (a.slot_start ?? '').localeCompare(b.slot_start ?? '')
                );
                setBookings(sorted);
                setFiltered(sorted);
              })
              .catch(() => {});
          }}
        />
      )}

      {/* Header */}
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-slate-800">Bookings</h1>
        <p className="text-slate-500 text-sm mt-0.5">All patient appointment bookings</p>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 mb-5">
        <div className="relative flex-1 min-w-48">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search patient, doctor or reason…"
            className="w-full pl-9 pr-4 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 bg-white"
          />
        </div>
        <div className="flex items-center gap-1">
          {['all', 'confirmed', 'pending', 'cancelled'].map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium capitalize transition border ${
                statusFilter === s
                  ? 'bg-primary-600 text-white border-primary-600'
                  : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'
              }`}
            >
              {s === 'all' ? 'All' : s}
            </button>
          ))}
        </div>
        <span className="text-xs text-slate-400 ml-auto">{filtered.length} booking{filtered.length !== 1 ? 's' : ''}</span>
      </div>

      <div className="flex gap-5">
        {/* Table */}
        <div className="flex-1 bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-slate-400">
              <FileText size={36} className="mb-3 opacity-40" />
              <p className="text-sm">No bookings found</p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-100 text-left">
                  <th className="px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Patient</th>
                  <th className="px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Doctor</th>
                  <th className="px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Time</th>
                  <th className="px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Type</th>
                  <th className="px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Status</th>
                  <th className="px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">SMS</th>
                </tr>
              </thead>
              <tbody>
                {groupBookings(filtered).map(({ key, items }) => (
                  <>
                    {/* Date group header */}
                    <tr key={`hdr-${key}`}>
                      <td colSpan={6} className="px-4 py-2 bg-slate-50 border-y border-slate-100 first:border-t-0">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-semibold text-slate-600 tracking-wide">
                            {fmtGroupDate(key)}
                          </span>
                          <span className="text-[11px] text-slate-400">
                            {items.length} appointment{items.length !== 1 ? 's' : ''}
                          </span>
                        </div>
                      </td>
                    </tr>

                    {/* Booking rows for this date */}
                    {items.map((bk) => {
                      const sc = STATUS_CONFIG[bk.status] || STATUS_CONFIG.confirmed;
                      const tc = TYPE_CONFIG[bk.appointment_type] || TYPE_CONFIG.in_clinic;
                      const isSelected = selected?.id === bk.id;
                      return (
                        <tr
                          key={bk.id}
                          onClick={() => setSelected(isSelected ? null : bk)}
                          className={`cursor-pointer border-b border-slate-50 last:border-b-0 transition ${isSelected ? 'bg-primary-50' : 'hover:bg-slate-50'}`}
                        >
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2.5">
                              <div className="w-8 h-8 rounded-full bg-primary-100 flex items-center justify-center text-primary-700 font-semibold text-xs flex-shrink-0">
                                {bk.patient_name.split(' ').map((n) => n[0]).join('').slice(0, 2)}
                              </div>
                              <div>
                                <p className="font-medium text-slate-800">{bk.patient_name}</p>
                                <p className="text-xs text-slate-400 truncate max-w-32">{bk.reason}</p>
                              </div>
                            </div>
                          </td>
                          <td className="px-4 py-3 text-slate-600">{bk.doctor_name}</td>
                          <td className="px-4 py-3">
                            <p className="text-slate-700 font-medium whitespace-nowrap">{fmtUTC(bk.slot_start)}</p>
                            {bk.slot_end && (
                              <p className="text-xs text-slate-400">until {fmtUTC(bk.slot_end)}</p>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${tc.color}`}>{tc.label}</span>
                          </td>
                          <td className="px-4 py-3">
                            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${sc.color}`}>
                              <sc.icon size={10} />{sc.label}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${bk.confirmation_sent ? 'bg-green-50 text-green-700' : 'bg-slate-100 text-slate-500'}`}>
                              {bk.confirmation_sent ? 'Sent' : 'Not sent'}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Detail panel */}
        {selected && (
          <div className="w-72 flex-shrink-0 bg-white rounded-xl border border-slate-200 shadow-sm p-5 self-start">
            <div className="flex items-start justify-between mb-4">
              <h3 className="font-semibold text-slate-800">Booking Details</h3>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setEditBooking(selected)}
                  className="text-slate-400 hover:text-primary-600 transition"
                  title="Edit booking"
                >
                  <Edit2 size={15} />
                </button>
                <button onClick={() => setSelected(null)} className="text-slate-400 hover:text-slate-600 transition">
                  <XCircle size={15} />
                </button>
              </div>
            </div>

            <div className="space-y-3 text-sm">
              <div className="flex items-start gap-2">
                <User size={14} className="text-slate-400 mt-0.5 flex-shrink-0" />
                <div>
                  <p className="font-medium text-slate-800">{selected.patient_name}</p>
                  <p className="text-slate-400 text-xs">Patient</p>
                </div>
              </div>
              <div className="flex items-start gap-2">
                <Stethoscope size={14} className="text-slate-400 mt-0.5 flex-shrink-0" />
                <div>
                  <p className="font-medium text-slate-700">{selected.doctor_name}</p>
                  <p className="text-slate-400 text-xs">Attending doctor</p>
                </div>
              </div>
              <div className="flex items-start gap-2">
                <Clock size={14} className="text-slate-400 mt-0.5 flex-shrink-0" />
                <div>
                  <p className="font-medium text-slate-700">{formatSlotDate(selected.slot_start)}</p>
                  <p className="text-slate-400 text-xs">
                    Until {fmtUTC(selected.slot_end)}
                  </p>
                </div>
              </div>

              {selected.reason && (
                <div className="bg-slate-50 rounded-lg p-3">
                  <p className="text-xs font-medium text-slate-500 mb-1">Reason</p>
                  <p className="text-slate-700">{selected.reason}</p>
                </div>
              )}

              {selected.notes && (
                <div className="bg-amber-50 rounded-lg p-3">
                  <p className="text-xs font-medium text-amber-700 mb-1">Notes</p>
                  <p className="text-slate-700 text-xs">{selected.notes}</p>
                </div>
              )}

              {/* Status actions */}
              <div>
                <p className="text-xs font-medium text-slate-500 mb-2">Change Status</p>
                <div className="flex gap-2 flex-wrap">
                  {['confirmed', 'pending', 'cancelled'].map((s) => (
                    <button
                      key={s}
                      onClick={() => updateStatus(selected.id, s)}
                      className={`px-3 py-1 rounded-lg text-xs font-medium capitalize transition border ${
                        selected.status === s
                          ? 'bg-primary-600 text-white border-primary-600'
                          : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                      }`}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>

              {/* Transcription link */}
              {selected.call_log_id && (
                <Link
                  to={`/transcriptions?id=${selected.call_log_id}`}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg bg-primary-50 text-primary-700 text-xs font-medium hover:bg-primary-100 transition"
                >
                  <FileText size={13} /> View call transcription
                </Link>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

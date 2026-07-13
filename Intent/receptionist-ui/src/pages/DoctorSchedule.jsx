import { useEffect, useState, useCallback } from 'react';
import {
  ChevronLeft, ChevronRight, Trash2, Calendar,
  CheckCircle2, RefreshCw, X, Edit2, User, CalendarPlus,
  ClipboardList, Info, Save, Plus,
} from 'lucide-react';
import {
  format, addDays, startOfWeek, endOfWeek, eachDayOfInterval,
  isToday, parseISO, addWeeks, subWeeks,
} from 'date-fns';
import {
  doctorService, scheduleService, bookingService, masterScheduleService,
} from '../services/dataService';

// ─── Calendar helpers ──────────────────────────────────────────────────────────

// 10 rows: labels 7 am → 4 pm, grid ends at the 5 pm boundary (no trailing empty row)
const HOURS = Array.from({ length: 10 }, (_, i) => i + 7);
const ROW_REM = 3.5; // matches h-14 in Tailwind

function fmtTimeShort(iso) {
  const d = parseISO(iso);
  const h = d.getUTCHours() % 12 || 12;
  const m = d.getUTCMinutes().toString().padStart(2, '0');
  return `${h}:${m}`;
}

function fmtTimeFull(iso) {
  const d = parseISO(iso);
  const h24 = d.getUTCHours();
  const h = h24 % 12 || 12;
  const m = d.getUTCMinutes().toString().padStart(2, '0');
  return `${h}:${m} ${h24 >= 12 ? 'PM' : 'AM'}`;
}

function fmtUTCDate(iso, fmtStr) {
  const d = parseISO(iso);
  return format(new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()), fmtStr);
}

function slotTopRem(isoString) {
  const d = parseISO(isoString);
  const minsFromStart = d.getUTCHours() * 60 + d.getUTCMinutes() - 7 * 60;
  return (minsFromStart / 60) * ROW_REM;
}

function slotHeightRem(startISO, endISO) {
  const durationMins = (parseISO(endISO) - parseISO(startISO)) / 60000;
  return (durationMins / 60) * ROW_REM;
}

function addMins(timeStr, mins) {
  const [h, m] = timeStr.split(':').map(Number);
  const total = h * 60 + m + mins;
  return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

// ─── Master schedule constants & helpers ───────────────────────────────────────

const MASTER_DAYS = [
  { key: '1', label: 'Monday' },
  { key: '2', label: 'Tuesday' },
  { key: '3', label: 'Wednesday' },
  { key: '4', label: 'Thursday' },
  { key: '5', label: 'Friday' },
  { key: '6', label: 'Saturday' },
  { key: '0', label: 'Sunday' },
];

const CONSULT_TYPES = [
  { value: 'in_clinic',  label: 'In Clinic' },
  { value: 'telehealth', label: 'Telehealth' },
];

const SLOT_DURATIONS = [10, 15, 20, 30, 45, 60];

function emptyWindow() {
  return { start: '09:00', end: '17:00', consultation_types: ['in_clinic'] };
}
function emptyDay() {
  return { active: false, windows: [emptyWindow()] };
}
function emptyDays() {
  return Object.fromEntries(MASTER_DAYS.map(({ key }) => [key, emptyDay()]));
}

// Forward-compatible migration: v1 (flat start/end), v2 (day-level types), v3 (per-window types)
function migrateDay(raw) {
  if (!raw) return emptyDay();
  const dayTypes = raw.consultation_types ?? ['in_clinic'];
  let windows;
  if (raw.windows?.length) {
    windows = raw.windows.map((w) => ({
      start: w.start, end: w.end,
      consultation_types: w.consultation_types ?? dayTypes,
    }));
  } else if (raw.start && raw.end) {
    windows = [{ start: raw.start, end: raw.end, consultation_types: dayTypes }];
  } else {
    windows = [emptyWindow()];
  }
  return { active: raw.active ?? false, windows };
}

function getWindows(dayConfig) {
  if (!dayConfig) return [];
  return dayConfig.windows?.length
    ? dayConfig.windows
    : dayConfig.start && dayConfig.end
      ? [{ start: dayConfig.start, end: dayConfig.end, consultation_types: ['in_clinic'] }]
      : [];
}

// ─── Toggle ────────────────────────────────────────────────────────────────────

function Toggle({ value, onChange }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      onClick={() => onChange(!value)}
      className={`relative inline-flex h-5 w-10 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-1 ${value ? 'bg-primary-600' : 'bg-slate-200'}`}
    >
      <span
        aria-hidden="true"
        className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${value ? 'translate-x-5' : 'translate-x-0'}`}
      />
    </button>
  );
}

// ─── Master Schedule Modal ─────────────────────────────────────────────────────

function MasterScheduleModal({ doctor, onClose, onSave }) {
  const [form, setForm] = useState({
    days:               emptyDays(),
    slot_duration_mins: 20,
    notes:              '',
  });
  const [validTill,  setValidTill]  = useState('');
  const [updatedAt,  setUpdatedAt]  = useState(null);
  const [loading,    setLoading]    = useState(true);
  const [saving,     setSaving]     = useState(false);
  const [saved,      setSaved]      = useState(false);
  const [error,      setError]      = useState('');

  useEffect(() => {
    masterScheduleService.getByDoctor(doctor.id)
      .then((ms) => {
        if (ms) {
          const days = {};
          for (const { key } of MASTER_DAYS) days[key] = migrateDay(ms.days?.[key]);
          setForm({ days, slot_duration_mins: ms.slot_duration_mins ?? 20, notes: ms.notes ?? '' });
          setUpdatedAt(ms.updated_at);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [doctor.id]);

  const setDay = (key, updater) =>
    setForm((prev) => ({ ...prev, days: { ...prev.days, [key]: updater(prev.days[key]) } }));

  const handleToggle  = (key, active)         => setDay(key, (d) => ({ ...d, active }));
  const handleAddWin  = (key)                 => setDay(key, (d) => ({ ...d, windows: [...d.windows, emptyWindow()] }));
  const handleRemWin  = (key, idx)            => setDay(key, (d) => ({ ...d, windows: d.windows.filter((_, i) => i !== idx) }));
  const handleWinChg  = (key, idx, fld, val)  => setDay(key, (d) => ({
    ...d,
    windows: d.windows.map((w, i) => i === idx ? { ...w, [fld]: val } : w),
  }));
  const handleConsult = (key, idx, type)      => setDay(key, (d) => ({
    ...d,
    windows: d.windows.map((w, i) => {
      if (i !== idx) return w;
      const curr = w.consultation_types ?? ['in_clinic'];
      const next = curr.includes(type) ? curr.filter((t) => t !== type) : [...curr, type];
      return next.length === 0 ? w : { ...w, consultation_types: next };
    }),
  }));

  const validate = () => {
    for (const { key, label } of MASTER_DAYS) {
      const d = form.days[key];
      if (!d.active) continue;
      for (const [i, win] of d.windows.entries()) {
        const n = d.windows.length > 1 ? ` (window ${i + 1})` : '';
        if (!win.start || !win.end)  { setError(`${label}${n}: fill in start and end time.`); return false; }
        if (win.start >= win.end)    { setError(`${label}${n}: end time must be after start time.`); return false; }
        if (!win.consultation_types?.length) { setError(`${label}${n}: select at least one consultation type.`); return false; }
      }
    }
    return true;
  };

  const persistTemplate = async () => {
    const result = await masterScheduleService.save({
      doctor_id:          doctor.id,
      days:               form.days,
      slot_duration_mins: form.slot_duration_mins,
      notes:              form.notes,
    });
    setUpdatedAt(result.updated_at);
    return result;
  };

  const handleSave = async () => {
    if (!validate()) return;
    setSaving(true); setError(''); setSaved(false);
    try {
      await persistTemplate();
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e) { setError(e.message); }
    setSaving(false);
  };

  const handleSaveAndGenerate = async () => {
    if (!validTill) return setError('Please select a Valid Till date.');
    const endDate = new Date(validTill);
    endDate.setHours(23, 59, 59, 999);
    if (endDate < new Date()) return setError('Valid Till date must be in the future.');
    if (!validate()) return;

    const activeDays = MASTER_DAYS.filter(({ key }) => form.days[key]?.active && getWindows(form.days[key]).length > 0);
    if (activeDays.length === 0) return setError('No active working days in the template.');

    setSaving(true); setError(''); setSaved(false);
    try {
      await persistTemplate();

      // Collect dates grouped by day-of-week
      const datesByDow = {};
      let cursor = new Date();
      cursor.setHours(0, 0, 0, 0);
      while (cursor <= endDate) {
        const dow = cursor.getDay().toString();
        const dayConfig = form.days[dow];
        if (dayConfig?.active && getWindows(dayConfig).length > 0) {
          const dateStr = format(cursor, 'yyyy-MM-dd');
          if (!datesByDow[dow]) datesByDow[dow] = [];
          datesByDow[dow].push(dateStr);
        }
        cursor = addDays(cursor, 1);
      }

      for (const [dow, dates] of Object.entries(datesByDow)) {
        for (const win of getWindows(form.days[dow])) {
          await scheduleService.addRecurring({
            doctorId:        doctor.id,
            dates,
            startTime:       win.start,
            endTime:         win.end,
            slotDurationMins: form.slot_duration_mins,
          });
        }
      }

      onSave();
    } catch (e) { setError(e.message); }
    setSaving(false);
  };

  const activeDayCount = MASTER_DAYS.filter(({ key }) => form.days[key]?.active).length;
  const minDate = format(addDays(new Date(), 1), 'yyyy-MM-dd');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl flex flex-col max-h-[90vh]">

        {/* Header */}
        <div className="flex items-start justify-between px-6 py-4 border-b border-slate-100 flex-shrink-0">
          <div>
            <h3 className="font-semibold text-slate-800 flex items-center gap-2">
              <ClipboardList size={18} className="text-primary-600" /> Master Schedule
            </h3>
            <p className="text-sm text-slate-500 mt-0.5">{doctor.name}</p>
          </div>
          <div className="flex items-center gap-3">
            {updatedAt && (
              <span className="text-xs text-slate-400">
                Updated {format(parseISO(updatedAt), 'd MMM yyyy')}
              </span>
            )}
            <button onClick={onClose} className="text-slate-400 hover:text-slate-600 transition">
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {loading ? (
            <div className="flex justify-center py-10">
              <span className="w-8 h-8 border-2 border-primary-600 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : (
            <>
              <div className="flex items-start gap-2.5 bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 text-sm text-blue-800">
                <Info size={15} className="flex-shrink-0 mt-0.5 text-blue-500" />
                <span>
                  Set the doctor's regular working hours and consultation types for each day.
                  Choose a <strong>Valid Till</strong> date and click <strong>Save &amp; Generate Slots</strong> to
                  automatically populate the calendar from today up to that date.
                </span>
              </div>

              {/* Day cards */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-sm font-semibold text-slate-700">Weekly Availability</h4>
                  <span className="text-xs text-slate-400">{activeDayCount} day{activeDayCount !== 1 ? 's' : ''} active</span>
                </div>

                <div className="space-y-2">
                  {MASTER_DAYS.map(({ key, label }) => {
                    const day = form.days[key];
                    return (
                      <div
                        key={key}
                        className={`rounded-xl border transition-all ${day.active ? 'border-primary-200 bg-primary-50/40' : 'border-slate-100 bg-slate-50/60'}`}
                      >
                        <div className="flex items-center gap-3 px-4 py-3">
                          <span className={`flex-1 text-sm font-semibold ${day.active ? 'text-slate-800' : 'text-slate-400'}`}>
                            {label}
                          </span>
                          {day.active
                            ? <span className="text-[11px] text-primary-600 font-medium mr-1">{day.windows.length} window{day.windows.length !== 1 ? 's' : ''}</span>
                            : <span className="text-[11px] text-slate-400 mr-1">Off</span>}
                          <Toggle value={day.active} onChange={(v) => handleToggle(key, v)} />
                        </div>

                        {day.active && (
                          <div className="px-4 pb-4 space-y-2 border-t border-primary-100 pt-3">
                            <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Time Windows</p>
                            {day.windows.map((win, idx) => (
                              <div key={idx} className="bg-white border border-slate-200 rounded-lg p-2.5 space-y-2">
                                <div className="flex items-center gap-2">
                                  <input type="time" value={win.start}
                                    onChange={(e) => handleWinChg(key, idx, 'start', e.target.value)}
                                    className="flex-1 border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                                  />
                                  <span className="text-slate-400 text-sm font-medium flex-shrink-0">—</span>
                                  <input type="time" value={win.end}
                                    onChange={(e) => handleWinChg(key, idx, 'end', e.target.value)}
                                    className="flex-1 border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                                  />
                                  {day.windows.length > 1 && (
                                    <button type="button" onClick={() => handleRemWin(key, idx)}
                                      className="w-7 h-7 flex items-center justify-center rounded-lg text-slate-400 hover:text-red-500 hover:bg-red-50 transition flex-shrink-0"
                                    ><X size={14} /></button>
                                  )}
                                </div>
                                <div className="flex gap-1.5">
                                  {CONSULT_TYPES.map(({ value, label: cLabel }) => {
                                    const on = win.consultation_types?.includes(value);
                                    return (
                                      <button key={value} type="button"
                                        onClick={() => handleConsult(key, idx, value)}
                                        className={`px-2.5 py-1 rounded-md text-[11px] font-medium border transition ${on ? 'bg-primary-600 text-white border-primary-600' : 'bg-slate-50 text-slate-500 border-slate-200 hover:border-slate-300'}`}
                                      >{cLabel}</button>
                                    );
                                  })}
                                </div>
                              </div>
                            ))}
                            {day.windows.length < 4 && (
                              <button type="button" onClick={() => handleAddWin(key)}
                                className="flex items-center gap-1.5 text-xs text-primary-600 hover:text-primary-800 font-medium transition"
                              ><Plus size={13} /> Add time window</button>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Slot duration + Notes */}
              <div className="space-y-4">
                <div className="flex items-center gap-4">
                  <label className="text-sm font-medium text-slate-700 w-32 flex-shrink-0">Slot Duration</label>
                  <select
                    value={form.slot_duration_mins}
                    onChange={(e) => setForm((p) => ({ ...p, slot_duration_mins: +e.target.value }))}
                    className="border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 bg-white"
                  >
                    {SLOT_DURATIONS.map((m) => <option key={m} value={m}>{m} minutes</option>)}
                  </select>
                  <span className="text-xs text-slate-400">Per appointment slot</span>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Notes</label>
                  <textarea
                    value={form.notes}
                    onChange={(e) => setForm((p) => ({ ...p, notes: e.target.value }))}
                    rows={2}
                    placeholder="Any exceptions, preferences, or notes from the doctor…"
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 resize-none"
                  />
                </div>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        {!loading && (
          <div className="border-t border-slate-100 px-6 py-4 flex-shrink-0 space-y-3">
            {error && <p className="text-red-600 text-sm">{error}</p>}
            {saved && (
              <p className="text-green-600 text-sm flex items-center gap-1.5">
                <CheckCircle2 size={14} /> Template saved successfully
              </p>
            )}

            {/* Valid Till row */}
            <div className="flex flex-wrap items-center gap-3">
              <label className="text-sm font-semibold text-slate-700 flex-shrink-0">Valid Till</label>
              <input
                type="date"
                value={validTill}
                min={minDate}
                onChange={(e) => { setValidTill(e.target.value); setError(''); }}
                className="border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
              <span className="text-xs text-slate-400">Slots generated from today up to this date</span>
            </div>

            {/* Buttons */}
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => {
                  masterScheduleService.getByDoctor(doctor.id)
                    .then((ms) => {
                      if (ms) {
                        const days = {};
                        for (const { key } of MASTER_DAYS) days[key] = migrateDay(ms.days?.[key]);
                        setForm({ days, slot_duration_mins: ms.slot_duration_mins ?? 20, notes: ms.notes ?? '' });
                      } else {
                        setForm({ days: emptyDays(), slot_duration_mins: 20, notes: '' });
                      }
                      setError(''); setSaved(false);
                    })
                    .catch(() => {});
                }}
                className="flex items-center gap-1.5 px-3 py-2 text-sm text-slate-500 hover:text-slate-700 border border-slate-200 rounded-lg hover:bg-slate-50 transition"
              >
                <RefreshCw size={13} /> Reset
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex items-center gap-2 border border-slate-200 text-slate-700 hover:bg-slate-50 px-4 py-2 rounded-lg text-sm font-medium transition disabled:opacity-60"
              >
                {saving
                  ? <span className="w-4 h-4 border-2 border-slate-400 border-t-transparent rounded-full animate-spin" />
                  : <Save size={14} />}
                Save Template
              </button>
              <button
                onClick={handleSaveAndGenerate}
                disabled={saving || !validTill}
                className="flex items-center gap-2 bg-primary-600 hover:bg-primary-700 text-white px-4 py-2 rounded-lg text-sm font-semibold shadow transition disabled:opacity-60"
              >
                {saving
                  ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  : <ClipboardList size={14} />}
                Save &amp; Generate Slots
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Edit / View Slot Modal ────────────────────────────────────────────────────

function EditSlotModal({ slot, booking, onClose, onSave }) {
  const isBooked = slot.is_booked;
  const [form, setForm] = useState({
    startTime: slot.slot_start.slice(11, 16),
    endTime:   slot.slot_end.slice(11, 16),
  });
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState('');

  const handleSave = async () => {
    if (form.startTime >= form.endTime) return setError('End time must be after start time.');
    setSaving(true); setError('');
    try {
      const date = slot.slot_start.slice(0, 10);
      await scheduleService.update(slot.id, {
        slot_start: `${date}T${form.startTime}:00Z`,
        slot_end:   `${date}T${form.endTime}:00Z`,
      });
      onSave();
    } catch (e) { setError(e.message); }
    setSaving(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
          <h3 className="font-semibold text-slate-800 flex items-center gap-2">
            {isBooked
              ? <><CheckCircle2 size={18} className="text-primary-600" /> Booked Slot</>
              : <><Edit2 size={18} className="text-slate-500" /> Edit Slot</>}
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 transition"><X size={20} /></button>
        </div>

        <div className="p-6 space-y-4">
          <div>
            <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-0.5">Date</p>
            <p className="text-sm font-medium text-slate-800">{fmtUTCDate(slot.slot_start, 'EEEE, d MMMM yyyy')}</p>
          </div>

          {isBooked ? (
            <>
              <div>
                <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-0.5">Time</p>
                <p className="text-sm font-medium text-slate-800">{fmtTimeFull(slot.slot_start)} – {fmtTimeFull(slot.slot_end)}</p>
              </div>
              {booking ? (
                <>
                  <div className="flex items-start gap-2.5 bg-primary-50 rounded-xl p-3.5">
                    <div className="w-8 h-8 rounded-full bg-primary-200 flex items-center justify-center text-primary-700 font-semibold text-xs flex-shrink-0">
                      {booking.patient_name.split(' ').map((n) => n[0]).join('').slice(0, 2)}
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-slate-800">{booking.patient_name}</p>
                      <p className="text-xs text-slate-500 mt-0.5">{booking.reason || 'No reason specified'}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <div>
                      <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-0.5">Status</p>
                      <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${booking.status === 'confirmed' ? 'bg-green-100 text-green-700' : booking.status === 'cancelled' ? 'bg-red-100 text-red-600' : 'bg-amber-100 text-amber-700'}`}>
                        {booking.status}
                      </span>
                    </div>
                    <div>
                      <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-0.5">SMS</p>
                      <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${booking.confirmation_sent ? 'bg-green-50 text-green-700' : 'bg-slate-100 text-slate-500'}`}>
                        {booking.confirmation_sent ? 'Sent' : 'Not sent'}
                      </span>
                    </div>
                  </div>
                  {booking.notes && (
                    <div className="bg-amber-50 rounded-lg p-3">
                      <p className="text-[11px] font-semibold text-amber-700 uppercase tracking-wider mb-1">Notes</p>
                      <p className="text-xs text-slate-700">{booking.notes}</p>
                    </div>
                  )}
                </>
              ) : (
                <p className="text-xs text-slate-400">Booking details not available.</p>
              )}
            </>
          ) : (
            <>
              {error && <div className="text-red-600 text-sm bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Start Time</label>
                  <input type="time" value={form.startTime}
                    onChange={(e) => setForm((p) => ({ ...p, startTime: e.target.value }))}
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">End Time</label>
                  <input type="time" value={form.endTime}
                    onChange={(e) => setForm((p) => ({ ...p, endTime: e.target.value }))}
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                  />
                </div>
              </div>
            </>
          )}
        </div>

        <div className="flex gap-3 px-6 pb-5">
          <button onClick={onClose} className="flex-1 border border-slate-200 text-slate-600 rounded-lg py-2 text-sm font-medium hover:bg-slate-50 transition">
            {isBooked ? 'Close' : 'Cancel'}
          </button>
          {!isBooked && (
            <button onClick={handleSave} disabled={saving}
              className="flex-1 bg-primary-600 hover:bg-primary-700 text-white rounded-lg py-2 text-sm font-semibold transition disabled:opacity-60 flex items-center justify-center gap-2"
            >
              {saving ? <><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Saving…</> : 'Save Changes'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Book Appointment Modal ────────────────────────────────────────────────────

const APPT_TYPES = [
  { value: 'in_clinic',  label: 'In Clinic' },
  { value: 'telehealth', label: 'Telehealth' },
];

function BookAppointmentModal({ slot, doctor, onClose, onSave }) {
  const [form, setForm] = useState({
    patientName:     '',
    dateOfBirth:     '',
    reason:          '',
    appointmentType: 'in_clinic',
    notes:           '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState('');

  const handleBook = async () => {
    if (!form.patientName.trim()) return setError('Please enter the patient name.');
    if (!form.dateOfBirth)        return setError('Please enter the patient date of birth.');
    if (!form.reason.trim())      return setError('Please enter a reason for the visit.');
    setSaving(true); setError('');
    try {
      await bookingService.book({
        slotId:          slot.id,
        patientName:     form.patientName,
        dateOfBirth:     form.dateOfBirth,
        reason:          form.reason,
        appointmentType: form.appointmentType,
        notes:           form.notes,
      });
      onSave();
    } catch (e) { setError(e.message); }
    setSaving(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
          <h3 className="font-semibold text-slate-800 flex items-center gap-2">
            <CalendarPlus size={18} className="text-primary-600" /> Book Appointment
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 transition"><X size={20} /></button>
        </div>

        <div className="p-6 space-y-4">
          <div className="flex items-center gap-3 bg-slate-50 rounded-xl p-3.5">
            <div className="w-9 h-9 rounded-lg bg-primary-100 flex items-center justify-center flex-shrink-0">
              <Calendar size={16} className="text-primary-600" />
            </div>
            <div>
              <p className="text-sm font-semibold text-slate-800">{fmtUTCDate(slot.slot_start, 'EEEE, d MMMM yyyy')}</p>
              <p className="text-xs text-slate-500">{doctor.name} · {fmtTimeFull(slot.slot_start)} – {fmtTimeFull(slot.slot_end)}</p>
            </div>
          </div>

          {error && <div className="text-red-600 text-sm bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}

          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-1">Patient Name</label>
              <input type="text" placeholder="Full name" value={form.patientName} autoFocus
                onChange={(e) => setForm((p) => ({ ...p, patientName: e.target.value }))}
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
              <p className="text-xs text-slate-400 mt-1">Matched to an existing patient by name, or a new record is created.</p>
            </div>
            <div className="col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-1">Date of Birth</label>
              <input type="date" value={form.dateOfBirth}
                onChange={(e) => setForm((p) => ({ ...p, dateOfBirth: e.target.value }))}
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Reason for Visit</label>
            <input type="text" placeholder="e.g. Chest pain, annual check-up, vaccination"
              value={form.reason}
              onChange={(e) => setForm((p) => ({ ...p, reason: e.target.value }))}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Appointment Type</label>
            <div className="flex gap-2">
              {APPT_TYPES.map(({ value, label }) => (
                <button key={value} type="button"
                  onClick={() => setForm((p) => ({ ...p, appointmentType: value }))}
                  className={`flex-1 py-2 rounded-lg text-sm font-medium border transition ${form.appointmentType === value ? 'bg-primary-600 text-white border-primary-600' : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'}`}
                >{label}</button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Notes <span className="text-slate-400 font-normal">(optional)</span>
            </label>
            <textarea rows={2} placeholder="Any additional notes for the doctor…"
              value={form.notes}
              onChange={(e) => setForm((p) => ({ ...p, notes: e.target.value }))}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 resize-none"
            />
          </div>
        </div>

        <div className="flex gap-3 px-6 pb-5">
          <button onClick={onClose} className="flex-1 border border-slate-200 text-slate-600 rounded-lg py-2 text-sm font-medium hover:bg-slate-50 transition">Cancel</button>
          <button onClick={handleBook} disabled={saving}
            className="flex-1 bg-primary-600 hover:bg-primary-700 text-white rounded-lg py-2 text-sm font-semibold transition disabled:opacity-60 flex items-center justify-center gap-2"
          >
            {saving ? <><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Booking…</> : <><CheckCircle2 size={14} /> Confirm Booking</>}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Slot Chip ─────────────────────────────────────────────────────────────────

function SlotChip({ slot, onDelete, onEdit, onBook }) {
  const top    = slotTopRem(slot.slot_start);
  const height = slotHeightRem(slot.slot_start, slot.slot_end);

  return (
    <div
      style={{ top: `${top}rem`, height: `${Math.max(height, 0.875)}rem`, left: 2, right: 2 }}
      className={`absolute rounded-md px-1.5 py-0.5 overflow-hidden group transition-all ${
        slot.is_booked
          ? 'bg-primary-100 border border-primary-300 text-primary-800'
          : 'bg-green-50 border border-green-300 text-green-800 hover:bg-green-100'
      }`}
    >
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold leading-tight truncate">
          {fmtTimeShort(slot.slot_start)}–{fmtTimeFull(slot.slot_end)}
        </span>
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity ml-1 flex-shrink-0">
          {slot.is_booked ? (
            <button onClick={() => onEdit(slot)} title="View booking"
              className="text-primary-500 hover:text-primary-700 transition-colors"
            ><User size={10} /></button>
          ) : (
            <>
              <button onClick={() => onBook(slot)} title="Book appointment"
                className="text-primary-500 hover:text-primary-700 transition-colors"
              ><CalendarPlus size={10} /></button>
              <button onClick={() => onEdit(slot)} title="Edit slot time"
                className="text-slate-400 hover:text-slate-600 transition-colors"
              ><Edit2 size={10} /></button>
              <button onClick={() => onDelete(slot.id)} title="Delete slot"
                className="text-red-400 hover:text-red-600 transition-colors"
              ><Trash2 size={10} /></button>
            </>
          )}
        </div>
      </div>
      {slot.is_booked && (
        <span className="text-[9px] font-medium bg-primary-200 text-primary-700 px-1 rounded-full">Booked</span>
      )}
    </div>
  );
}

// ─── Main Page ─────────────────────────────────────────────────────────────────

export default function DoctorSchedule() {
  const [doctors, setDoctors]               = useState([]);
  const [selectedDoctor, setSelectedDoctor] = useState(null);
  const [weekStart, setWeekStart]           = useState(startOfWeek(new Date(), { weekStartsOn: 1 }));
  const [slots, setSlots]                   = useState([]);
  const [bookings, setBookings]             = useState([]);
  const [showMasterSchedule, setShowMasterSchedule] = useState(false);
  const [editSlot, setEditSlot]             = useState(null);
  const [bookSlot, setBookSlot]             = useState(null);
  const [loading, setLoading]               = useState(true);

  const weekDays = eachDayOfInterval({
    start: weekStart,
    end: endOfWeek(weekStart, { weekStartsOn: 1 }),
  });

  useEffect(() => {
    doctorService.getActive().then((docs) => {
      setDoctors(docs);
      setSelectedDoctor(docs[0] || null);
      setLoading(false);
    });
  }, []);

  const loadSlots = useCallback(async () => {
    if (!selectedDoctor) return;
    const [all, allBookings] = await Promise.all([
      scheduleService.getByDoctor(selectedDoctor.id),
      bookingService.getAll(),
    ]);
    const weekStartStr = format(weekStart, 'yyyy-MM-dd');
    const weekEndStr   = format(addDays(weekStart, 6), 'yyyy-MM-dd');
    setSlots(all.filter((s) => {
      const dateStr = s.slot_start.slice(0, 10);
      return dateStr >= weekStartStr && dateStr <= weekEndStr;
    }));
    setBookings(allBookings);
  }, [selectedDoctor, weekStart]);

  useEffect(() => { loadSlots(); }, [loadSlots]);

  const handleDelete = async (id) => {
    try {
      await scheduleService.delete(id);
      setSlots((prev) => prev.filter((s) => s.id !== id));
    } catch (e) { alert(e.message); }
  };

  const slotsForDay = (day) =>
    slots.filter((s) => {
      const d = parseISO(s.slot_start);
      return (
        d.getUTCFullYear() === day.getFullYear() &&
        d.getUTCMonth()    === day.getMonth() &&
        d.getUTCDate()     === day.getDate()
      );
    });

  const bookingForSlot = (slot) => bookings.find((b) => b.calendar_slot_id === slot.id) || null;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full min-h-screen">
        <div className="animate-spin rounded-full h-10 w-10 border-4 border-primary-600 border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="p-6 h-full flex flex-col">
      {showMasterSchedule && selectedDoctor && (
        <MasterScheduleModal
          doctor={selectedDoctor}
          onClose={() => setShowMasterSchedule(false)}
          onSave={() => { setShowMasterSchedule(false); loadSlots(); }}
        />
      )}
      {editSlot && (
        <EditSlotModal
          slot={editSlot}
          booking={bookingForSlot(editSlot)}
          onClose={() => setEditSlot(null)}
          onSave={() => { setEditSlot(null); loadSlots(); }}
        />
      )}
      {bookSlot && selectedDoctor && (
        <BookAppointmentModal
          slot={bookSlot}
          doctor={selectedDoctor}
          onClose={() => setBookSlot(null)}
          onSave={() => { setBookSlot(null); loadSlots(); }}
        />
      )}

      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Doctor Schedule</h1>
          <p className="text-slate-500 text-sm mt-0.5">Manage availability slots for each doctor</p>
        </div>
        <button
          onClick={() => setShowMasterSchedule(true)}
          className="flex items-center gap-2 bg-primary-600 hover:bg-primary-700 text-white px-4 py-2 rounded-lg text-sm font-semibold shadow transition"
        >
          <ClipboardList size={16} /> Master Schedule
        </button>
      </div>

      {/* Doctor selector + Refresh on the same row */}
      <div className="flex flex-wrap items-center gap-2 mb-5">
        {doctors.map((doc) => (
          <button
            key={doc.id}
            onClick={() => setSelectedDoctor(doc)}
            className={`px-4 py-1.5 rounded-full text-sm font-medium transition border ${
              selectedDoctor?.id === doc.id
                ? 'bg-primary-600 text-white border-primary-600 shadow'
                : 'bg-white text-slate-600 border-slate-200 hover:border-primary-400 hover:text-primary-600'
            }`}
          >{doc.name}</button>
        ))}
        <button
          onClick={loadSlots}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 text-slate-500 hover:text-slate-700 hover:bg-slate-50 text-sm transition ml-auto"
        >
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {selectedDoctor && (
        <div className="flex flex-col flex-1 min-h-0">

          {/* Week navigation */}
          <div className="flex items-center gap-3 mb-3">
            <button onClick={() => setWeekStart(subWeeks(weekStart, 1))}
              className="p-1.5 rounded-lg border border-slate-200 hover:bg-slate-50 transition"
            ><ChevronLeft size={16} /></button>
            <span className="text-sm font-semibold text-slate-700">
              {format(weekStart, 'd MMM')} – {format(addDays(weekStart, 6), 'd MMM yyyy')}
            </span>
            <button onClick={() => setWeekStart(addWeeks(weekStart, 1))}
              className="p-1.5 rounded-lg border border-slate-200 hover:bg-slate-50 transition"
            ><ChevronRight size={16} /></button>
            <button
              onClick={() => setWeekStart(startOfWeek(new Date(), { weekStartsOn: 1 }))}
              className="text-xs text-primary-600 hover:underline ml-1"
            >This week</button>
          </div>

          {/* Calendar grid — flex-1 fills all remaining vertical space */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden flex flex-col flex-1 min-h-0">
            <div className="grid border-b border-slate-100" style={{ gridTemplateColumns: '56px repeat(7, 1fr)' }}>
              <div className="py-3 border-r border-slate-100" />
              {weekDays.map((day) => (
                <div key={day.toISOString()}
                  className={`py-3 text-center border-r border-slate-100 last:border-r-0 ${isToday(day) ? 'bg-primary-50' : ''}`}
                >
                  <p className={`text-xs font-medium uppercase tracking-wide ${isToday(day) ? 'text-primary-600' : 'text-slate-400'}`}>
                    {format(day, 'EEE')}
                  </p>
                  <p className={`text-base font-bold mt-0.5 ${isToday(day) ? 'text-primary-700' : 'text-slate-700'}`}>
                    {format(day, 'd')}
                  </p>
                </div>
              ))}
            </div>

            <div className="flex flex-1 min-h-0 overflow-y-auto">
              <div className="w-14 flex-shrink-0 border-r border-slate-100">
                {HOURS.map((h) => (
                  <div key={h} className="h-14 border-b border-slate-50 flex items-start justify-end pr-2 pt-1">
                    <span className="text-[10px] text-slate-400 font-medium">
                      {h === 12 ? '12pm' : h > 12 ? `${h - 12}pm` : `${h}am`}
                    </span>
                  </div>
                ))}
              </div>

              {weekDays.map((day) => {
                const daySlots = slotsForDay(day);
                return (
                  <div key={day.toISOString()}
                    className={`flex-1 relative border-r border-slate-100 last:border-r-0 ${isToday(day) ? 'bg-primary-50/40' : ''}`}
                    style={{ minWidth: 0 }}
                  >
                    {HOURS.map((h) => <div key={h} className="h-14 border-b border-slate-50" />)}
                    <div className="absolute inset-0">
                      {daySlots.map((slot) => (
                        <SlotChip
                          key={slot.id}
                          slot={slot}
                          onDelete={handleDelete}
                          onEdit={setEditSlot}
                          onBook={setBookSlot}
                        />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <p className="text-xs text-slate-400 mt-2 flex-shrink-0">
            Hover over a slot to book, edit, or delete it. Booked slots show patient details.
          </p>
        </div>
      )}
    </div>
  );
}

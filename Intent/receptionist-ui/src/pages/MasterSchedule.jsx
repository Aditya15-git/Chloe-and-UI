import { useEffect, useState, useCallback } from 'react';
import { ClipboardList, Save, CheckCircle2, Info, RefreshCw, Plus, X } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { doctorService, masterScheduleService } from '../services/dataService';

// ─── Config ───────────────────────────────────────────────────────────────────

const DAYS = [
  { key: '1', label: 'Monday' },
  { key: '2', label: 'Tuesday' },
  { key: '3', label: 'Wednesday' },
  { key: '4', label: 'Thursday' },
  { key: '5', label: 'Friday' },
  { key: '6', label: 'Saturday' },
  { key: '0', label: 'Sunday' },
];

const SLOT_DURATIONS = [15, 20, 30, 45, 60];

const CONSULT_TYPES = [
  { value: 'in_clinic',  label: 'In Clinic' },
  { value: 'telehealth', label: 'Telehealth' },
];

// Each window carries its own consultation_types so the doctor can do
// e.g. In Clinic 9–11 AM and Telehealth 4–6 PM on the same day.
function emptyWindow() {
  return { start: '09:00', end: '17:00', consultation_types: ['in_clinic'] };
}

function emptyDay() {
  return { active: false, windows: [emptyWindow()] };
}

function emptyDays() {
  return Object.fromEntries(DAYS.map(({ key }) => [key, emptyDay()]));
}

// Migrate from older formats:
//   v1: flat start/end + day-level consultation_types
//   v2: windows[] without per-window consultation_types (day-level only)
//   v3 (current): windows[] each with their own consultation_types
function migrateDay(raw) {
  if (!raw) return emptyDay();
  const dayTypes = raw.consultation_types ?? ['in_clinic']; // v1/v2 fallback
  let windows;
  if (raw.windows?.length) {
    windows = raw.windows.map((w) => ({
      start:              w.start,
      end:                w.end,
      consultation_types: w.consultation_types ?? dayTypes,
    }));
  } else if (raw.start && raw.end) {
    windows = [{ start: raw.start, end: raw.end, consultation_types: dayTypes }];
  } else {
    windows = [emptyWindow()];
  }
  return { active: raw.active ?? false, windows };
}

// ─── Toggle switch ─────────────────────────────────────────────────────────────

function Toggle({ value, onChange, size = 'md' }) {
  const w = size === 'sm' ? 'w-8 h-4' : 'w-10 h-5';
  const thumb = size === 'sm' ? 'h-3 w-3' : 'h-4 w-4';
  const translate = size === 'sm' ? 'translate-x-4' : 'translate-x-5';
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      onClick={() => onChange(!value)}
      className={`relative inline-flex flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-1 ${w} ${value ? 'bg-primary-600' : 'bg-slate-200'}`}
    >
      <span
        aria-hidden="true"
        className={`pointer-events-none inline-block transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${thumb} ${value ? translate : 'translate-x-0'}`}
      />
    </button>
  );
}

// ─── Main Page ─────────────────────────────────────────────────────────────────

export default function MasterSchedule() {
  const [doctors, setDoctors]               = useState([]);
  const [selectedDoctor, setSelectedDoctor] = useState(null);
  const [form, setForm] = useState({
    days:               emptyDays(),
    slot_duration_mins: 30,
    notes:              '',
  });
  const [updatedAt, setUpdatedAt] = useState(null);
  const [loading, setLoading]     = useState(true);
  const [saving, setSaving]       = useState(false);
  const [saved, setSaved]         = useState(false);
  const [error, setError]         = useState('');

  useEffect(() => {
    doctorService.getActive().then((docs) => {
      setDoctors(docs);
      setSelectedDoctor(docs[0] || null);
      setLoading(false);
    });
  }, []);

  const loadTemplate = useCallback(async () => {
    if (!selectedDoctor) return;
    setError('');
    setSaved(false);
    try {
      const ms = await masterScheduleService.getByDoctor(selectedDoctor.id);
      if (ms) {
        const migratedDays = {};
        for (const { key } of DAYS) {
          migratedDays[key] = migrateDay(ms.days?.[key]);
        }
        setForm({
          days:               migratedDays,
          slot_duration_mins: ms.slot_duration_mins ?? 30,
          notes:              ms.notes ?? '',
        });
        setUpdatedAt(ms.updated_at);
      } else {
        setForm({ days: emptyDays(), slot_duration_mins: 30, notes: '' });
        setUpdatedAt(null);
      }
    } catch {
      setForm({ days: emptyDays(), slot_duration_mins: 30, notes: '' });
      setUpdatedAt(null);
    }
  }, [selectedDoctor]);

  useEffect(() => { loadTemplate(); }, [loadTemplate]);

  // ── Day handlers ──────────────────────────────────────────────────────────

  const setDay = (key, updater) =>
    setForm((prev) => ({
      ...prev,
      days: { ...prev.days, [key]: updater(prev.days[key]) },
    }));

  const handleToggle = (key, active) =>
    setDay(key, (d) => ({ ...d, active }));

  const handleWindowConsultType = (key, idx, type) =>
    setDay(key, (d) => {
      const windows = d.windows.map((w, i) => {
        if (i !== idx) return w;
        const curr = w.consultation_types ?? ['in_clinic'];
        const next = curr.includes(type) ? curr.filter((t) => t !== type) : [...curr, type];
        return next.length === 0 ? w : { ...w, consultation_types: next };
      });
      return { ...d, windows };
    });

  const handleWindowChange = (key, idx, field, value) =>
    setDay(key, (d) => {
      const windows = d.windows.map((w, i) => i === idx ? { ...w, [field]: value } : w);
      return { ...d, windows };
    });

  const handleAddWindow = (key) =>
    setDay(key, (d) => ({
      ...d,
      windows: [...d.windows, emptyWindow()],
    }));

  const handleRemoveWindow = (key, idx) =>
    setDay(key, (d) => ({
      ...d,
      windows: d.windows.filter((_, i) => i !== idx),
    }));

  // ── Save ──────────────────────────────────────────────────────────────────

  const handleSave = async () => {
    if (!selectedDoctor) return;
    setError('');

    for (const { key, label } of DAYS) {
      const d = form.days[key];
      if (!d.active) continue;
      for (const [i, win] of d.windows.entries()) {
        const n = d.windows.length > 1 ? ` (window ${i + 1})` : '';
        if (!win.start || !win.end) {
          setError(`${label}${n}: fill in start and end time.`);
          return;
        }
        if (win.start >= win.end) {
          setError(`${label}${n}: end time must be after start time.`);
          return;
        }
        if (!win.consultation_types?.length) {
          setError(`${label}${n}: select at least one consultation type.`);
          return;
        }
      }
    }

    setSaving(true);
    setSaved(false);
    try {
      const result = await masterScheduleService.save({
        doctor_id:          selectedDoctor.id,
        days:               form.days,
        slot_duration_mins: form.slot_duration_mins,
        notes:              form.notes,
      });
      setUpdatedAt(result.updated_at);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      setError(e.message);
    }
    setSaving(false);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full min-h-screen">
        <div className="animate-spin rounded-full h-10 w-10 border-4 border-primary-600 border-t-transparent" />
      </div>
    );
  }

  const activeDayCount = DAYS.filter(({ key }) => form.days[key]?.active).length;

  return (
    <div className="p-6 max-w-3xl mx-auto">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
            <ClipboardList size={22} className="text-primary-600" />
            Master Schedule
          </h1>
          <p className="text-slate-500 text-sm mt-0.5">
            Weekly working template for each doctor — set consultation types and hours
          </p>
        </div>
        {updatedAt && (
          <span className="text-xs text-slate-400 bg-slate-50 border border-slate-100 px-3 py-1.5 rounded-lg">
            Last updated: {format(parseISO(updatedAt), 'd MMM yyyy')}
          </span>
        )}
      </div>

      {/* Doctor tabs */}
      <div className="flex flex-wrap gap-2 mb-6">
        {doctors.map((doc) => (
          <button
            key={doc.id}
            onClick={() => setSelectedDoctor(doc)}
            className={`px-4 py-1.5 rounded-full text-sm font-medium transition border ${
              selectedDoctor?.id === doc.id
                ? 'bg-primary-600 text-white border-primary-600 shadow'
                : 'bg-white text-slate-600 border-slate-200 hover:border-primary-400 hover:text-primary-600'
            }`}
          >
            {doc.name}
          </button>
        ))}
      </div>

      {selectedDoctor && (
        <>
          <div className="flex items-start gap-2.5 bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 mb-5 text-sm text-blue-800">
            <Info size={15} className="flex-shrink-0 mt-0.5 text-blue-500" />
            <span>
              Provided by the doctor. Set which days they work, their consultation types, and any
              number of time windows per day. Use <strong>Doctor Schedule → Generate Slots</strong> to
              create actual booking slots from this template.
            </span>
          </div>

          <div className="bg-white rounded-xl border border-slate-200 shadow-sm">
            <div className="px-6 pt-5 pb-2">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-sm font-semibold text-slate-700">Weekly Availability</h2>
                <span className="text-xs text-slate-400">{activeDayCount} day{activeDayCount !== 1 ? 's' : ''} active</span>
              </div>

              <div className="space-y-2">
                {DAYS.map(({ key, label }) => {
                  const day = form.days[key];
                  return (
                    <div
                      key={key}
                      className={`rounded-xl border transition-all ${
                        day.active
                          ? 'border-primary-200 bg-primary-50/40'
                          : 'border-slate-100 bg-slate-50/60'
                      }`}
                    >
                      {/* Day header row */}
                      <div className="flex items-center gap-3 px-4 py-3">
                        <span className={`flex-1 text-sm font-semibold ${day.active ? 'text-slate-800' : 'text-slate-400'}`}>
                          {label}
                        </span>
                        {day.active && (
                          <span className="text-[11px] text-primary-600 font-medium mr-1">
                            {day.windows.length} window{day.windows.length !== 1 ? 's' : ''}
                          </span>
                        )}
                        {!day.active && (
                          <span className="text-[11px] text-slate-400 mr-1">Off</span>
                        )}
                        <Toggle value={day.active} onChange={(v) => handleToggle(key, v)} />
                      </div>

                      {/* Expanded content */}
                      {day.active && (
                        <div className="px-4 pb-4 space-y-4 border-t border-primary-100 pt-3">

                            {/* Time windows — each with its own consultation type */}
                          <div>
                            <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-2">
                              Time Windows
                            </p>
                            <div className="space-y-2">
                              {day.windows.map((win, idx) => (
                                <div key={idx} className="bg-white border border-slate-200 rounded-lg p-2.5 space-y-2">
                                  {/* Time range + remove */}
                                  <div className="flex items-center gap-2">
                                    <input
                                      type="time"
                                      value={win.start}
                                      onChange={(e) => handleWindowChange(key, idx, 'start', e.target.value)}
                                      className="flex-1 border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                                    />
                                    <span className="text-slate-400 text-sm font-medium flex-shrink-0">—</span>
                                    <input
                                      type="time"
                                      value={win.end}
                                      onChange={(e) => handleWindowChange(key, idx, 'end', e.target.value)}
                                      className="flex-1 border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                                    />
                                    {day.windows.length > 1 && (
                                      <button
                                        type="button"
                                        onClick={() => handleRemoveWindow(key, idx)}
                                        className="w-7 h-7 flex items-center justify-center rounded-lg text-slate-400 hover:text-red-500 hover:bg-red-50 transition flex-shrink-0"
                                      >
                                        <X size={14} />
                                      </button>
                                    )}
                                  </div>
                                  {/* Consultation type chips */}
                                  <div className="flex gap-1.5">
                                    {CONSULT_TYPES.map(({ value, label: cLabel }) => {
                                      const on = win.consultation_types?.includes(value);
                                      return (
                                        <button
                                          key={value}
                                          type="button"
                                          onClick={() => handleWindowConsultType(key, idx, value)}
                                          className={`px-2.5 py-1 rounded-md text-[11px] font-medium border transition ${
                                            on
                                              ? 'bg-primary-600 text-white border-primary-600'
                                              : 'bg-slate-50 text-slate-500 border-slate-200 hover:border-slate-300'
                                          }`}
                                        >
                                          {cLabel}
                                        </button>
                                      );
                                    })}
                                  </div>
                                </div>
                              ))}
                              {day.windows.length < 4 && (
                                <button
                                  type="button"
                                  onClick={() => handleAddWindow(key)}
                                  className="flex items-center gap-1.5 text-xs text-primary-600 hover:text-primary-800 font-medium mt-1 transition"
                                >
                                  <Plus size={13} /> Add time window
                                </button>
                              )}
                            </div>
                          </div>

                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Slot duration + notes */}
            <div className="border-t border-slate-100 px-6 py-4 space-y-4 mt-3">
              <div className="flex items-center gap-4">
                <label className="text-sm font-medium text-slate-700 w-36 flex-shrink-0">
                  Default Slot Duration
                </label>
                <select
                  value={form.slot_duration_mins}
                  onChange={(e) => setForm({ ...form, slot_duration_mins: +e.target.value })}
                  className="border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 bg-white"
                >
                  {SLOT_DURATIONS.map((m) => (
                    <option key={m} value={m}>{m} minutes</option>
                  ))}
                </select>
                <span className="text-xs text-slate-400">Used when generating slots from this template</span>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">Notes</label>
                <textarea
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  rows={2}
                  placeholder="Any exceptions, preferences, or notes from the doctor…"
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 resize-none"
                />
              </div>
            </div>

            {/* Footer */}
            <div className="border-t border-slate-100 px-6 py-4 flex items-center justify-between">
              <div>
                {error && <p className="text-red-600 text-sm">{error}</p>}
                {saved && (
                  <p className="text-green-600 text-sm flex items-center gap-1.5">
                    <CheckCircle2 size={14} /> Template saved
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={loadTemplate}
                  className="flex items-center gap-1.5 px-3 py-2 text-sm text-slate-500 hover:text-slate-700 border border-slate-200 rounded-lg hover:bg-slate-50 transition"
                >
                  <RefreshCw size={13} /> Reset
                </button>
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="flex items-center gap-2 bg-primary-600 hover:bg-primary-700 text-white px-5 py-2 rounded-lg text-sm font-semibold shadow transition disabled:opacity-60"
                >
                  {saving
                    ? <><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Saving…</>
                    : <><Save size={14} /> Save Template</>}
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

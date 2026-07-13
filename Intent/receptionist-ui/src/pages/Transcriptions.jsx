import { useEffect, useState, Component } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Phone, CheckCircle2, XCircle, Clock, Search,
  ChevronRight, FileText, User, Stethoscope, Calendar, AlertCircle, ArrowRightLeft,
  DollarSign,
} from 'lucide-react';
import { format, parseISO, isValid } from 'date-fns';
import { transcriptionService } from '../services/transcriptionService';

// ─── Outcome config ────────────────────────────────────────────────────────────

const OUTCOMES = {
  appointment_booked:   {
    label:    'Appointment booked',
    badge:    'bg-green-50 text-green-700 border-green-200',
    iconBg:   'bg-green-100',
    Icon:     CheckCircle2,
    iconCls:  'text-green-600',
  },
  transferred_to_human: {
    label:    'Transferred to staff',
    badge:    'bg-blue-50 text-blue-700 border-blue-200',
    iconBg:   'bg-blue-100',
    Icon:     ArrowRightLeft,
    iconCls:  'text-blue-600',
  },
  no_appointment:       {
    label:    'No appointment',
    badge:    'bg-slate-50 text-slate-500 border-slate-200',
    iconBg:   'bg-slate-100',
    Icon:     Phone,
    iconCls:  'text-slate-400',
  },
};

function outcomeConfig(outcome) {
  return OUTCOMES[outcome] ?? OUTCOMES.no_appointment;
}

// ─── Cost formatter ───────────────────────────────────────────────────────────

function fmtCost(usd) {
  if (usd == null) return null;
  if (usd < 0.001) return '< $0.001';
  return `$${usd.toFixed(4)}`;
}

// ─── Safe date formatter — never throws ───────────────────────────────────────

function safeFmt(value, fmt) {
  if (!value) return '—';
  try {
    const d = typeof value === 'string' ? parseISO(value) : new Date(value);
    return isValid(d) ? format(d, fmt) : '—';
  } catch {
    return '—';
  }
}

// ─── Error boundary — prevents blank white page on render crash ───────────────

class ErrorBoundary extends Component {
  state = { error: null };
  static getDerivedStateFromError(err) { return { error: err }; }
  render() {
    if (this.state.error) {
      return (
        <div className="p-6 max-w-5xl mx-auto">
          <div className="flex items-start gap-3 bg-red-50 border border-red-200 text-red-800 rounded-xl px-4 py-4 text-sm">
            <AlertCircle size={16} className="flex-shrink-0 mt-0.5 text-red-500" />
            <div>
              <p className="font-semibold mb-1">Transcriptions page crashed</p>
              <p className="text-red-700 text-xs font-mono">{this.state.error.message}</p>
              <button
                onClick={() => this.setState({ error: null })}
                className="mt-2 text-xs underline text-red-600"
              >
                Try again
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// ─── Transcript bubble ────────────────────────────────────────────────────────

function TranscriptBubble({ turn }) {
  const isAssistant = (turn?.role ?? '') === 'assistant';
  return (
    <div className={`flex gap-2.5 ${isAssistant ? 'justify-start' : 'justify-end'}`}>
      {isAssistant && (
        <div className="w-7 h-7 rounded-full bg-primary-100 flex items-center justify-center flex-shrink-0 mt-0.5">
          <Phone size={13} className="text-primary-600" />
        </div>
      )}
      <div className={`max-w-[80%] px-3.5 py-2.5 rounded-2xl text-sm leading-relaxed ${
        isAssistant
          ? 'bg-white border border-slate-200 text-slate-700 rounded-tl-sm shadow-sm'
          : 'bg-primary-600 text-white rounded-tr-sm'
      }`}>
        <p>{turn?.text ?? ''}</p>
        {turn?.time != null && (
          <p className={`text-xs mt-1 ${isAssistant ? 'text-slate-400' : 'text-primary-200'}`}>
            {turn.time}s
          </p>
        )}
      </div>
      {!isAssistant && (
        <div className="w-7 h-7 rounded-full bg-slate-200 flex items-center justify-center flex-shrink-0 mt-0.5">
          <User size={13} className="text-slate-600" />
        </div>
      )}
    </div>
  );
}

// ─── Transcript panel (modal) ─────────────────────────────────────────────────

function TranscriptPanel({ record, onClose }) {
  const turns = Array.isArray(record?.transcript) ? record.transcript : [];
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-xl max-h-[90vh] flex flex-col">
        <div className="flex items-start justify-between px-6 py-4 border-b border-slate-100 flex-shrink-0">
          <div>
            <h3 className="font-semibold text-slate-800 flex items-center gap-2">
              <FileText size={16} className="text-primary-600" /> Call Transcript
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              {safeFmt(record?.created_at, 'd MMMM yyyy, h:mm a')}
              {record?.duration_s ? ` · ${record.duration_s}s` : ''}
            </p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 transition">
            <XCircle size={20} />
          </button>
        </div>

        <div className="px-6 py-3 bg-slate-50 border-b border-slate-100 flex flex-wrap gap-3 text-xs flex-shrink-0">
          {record?.patient_name && (
            <span className="flex items-center gap-1 text-slate-600">
              <User size={12} className="text-slate-400" /> {record.patient_name}
            </span>
          )}
          {record?.doctor_name && (
            <span className="flex items-center gap-1 text-slate-600">
              <Stethoscope size={12} className="text-slate-400" /> {record.doctor_name}
            </span>
          )}
          {record?.appointment_time && (
            <span className="flex items-center gap-1 text-slate-600">
              <Calendar size={12} className="text-slate-400" />
              {safeFmt(record.appointment_time, 'd MMM, h:mm a')}
            </span>
          )}
          {(() => {
            const oc = outcomeConfig(record?.outcome);
            const OcIcon = oc.Icon;
            return (
              <span className={`flex items-center gap-1 font-medium ml-auto text-xs px-2 py-0.5 rounded-full border ${oc.badge}`}>
                <OcIcon size={11} /> {oc.label}
              </span>
            );
          })()}
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5 bg-slate-50/50 space-y-3">
          {turns.length === 0 ? (
            <p className="text-sm text-slate-400 text-center py-8">No transcript available for this call.</p>
          ) : (
            turns.map((turn, i) => <TranscriptBubble key={i} turn={turn} />)
          )}
        </div>

        {/* Cost breakdown */}
        {record?.cost_breakdown && (
          <div className="px-6 py-3 border-t border-slate-100 bg-slate-50 flex-shrink-0">
            <p className="text-xs font-semibold text-slate-500 mb-2 flex items-center gap-1">
              <DollarSign size={11} /> API Cost Breakdown
            </p>
            <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-slate-500">
              {record.cost_breakdown.twilio_usd > 0 && <>
                <span>Twilio (voice)</span>
                <span className="text-right text-slate-700">{fmtCost(record.cost_breakdown.twilio_usd)}</span>
              </>}
              <span>Deepgram (STT)</span>
              <span className="text-right text-slate-700">{fmtCost(record.cost_breakdown.deepgram_stt_usd)}</span>
              <span>{record.cost_breakdown.tts_provider ?? 'TTS'}</span>
              <span className="text-right text-slate-700">{fmtCost(record.cost_breakdown.tts_usd)}</span>
              <span>{record.cost_breakdown.llm_provider ?? 'LLM'}</span>
              <span className="text-right text-slate-700">{fmtCost(record.cost_breakdown.llm_usd)}</span>
              <span className="font-semibold text-slate-700 pt-1 border-t border-slate-200">Total</span>
              <span className="text-right font-semibold text-slate-800 pt-1 border-t border-slate-200">
                {fmtCost(record.cost_breakdown.total_usd)}
              </span>
            </div>
            <p className="text-[10px] text-slate-400 mt-2">
              {record.cost_breakdown.llm_input_tokens} in / {record.cost_breakdown.llm_output_tokens} out tokens
              · {record.cost_breakdown.tts_chars} TTS chars
            </p>
          </div>
        )}

        <div className="px-6 py-3 border-t border-slate-100 flex justify-between items-center flex-shrink-0">
          <span className="text-xs text-slate-400">SID: {record?.call_sid ?? '—'}</span>
          <span className="text-xs text-slate-400">{turns.length} turns{record?.duration_s ? ` · ${record.duration_s}s` : ''}</span>
        </div>
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

function TranscriptionsInner() {
  const [searchParams] = useSearchParams();
  const [records, setRecords]               = useState([]);
  const [filtered, setFiltered]             = useState([]);
  const [search, setSearch]                 = useState('');
  const [outcomeFilter, setOutcomeFilter]   = useState('all');
  const [selected, setSelected]             = useState(null);
  const [loading, setLoading]               = useState(true);
  const [loadError, setLoadError]           = useState('');

  useEffect(() => {
    transcriptionService.getAll()
      .then((data) => {
        const safe = (data ?? []).filter(Boolean);
        const sorted = [...safe].sort((a, b) => {
          const da = a?.created_at ? new Date(a.created_at).getTime() : 0;
          const db = b?.created_at ? new Date(b.created_at).getTime() : 0;
          return db - da;
        });
        setRecords(sorted);
        setFiltered(sorted);

        const targetId = searchParams.get('id');
        if (targetId) {
          const target = sorted.find((r) => r?.id === targetId || r?.call_sid === targetId);
          if (target) setSelected(target);
        }
      })
      .catch((err) => setLoadError(err?.message ?? 'Failed to load transcriptions.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    let result = records;
    if (search) {
      const q = search.toLowerCase();
      result = result.filter((r) => {
        const name = (r?.patient_name ?? '').toLowerCase();
        const sid  = (r?.call_sid ?? '').toLowerCase();
        const doc  = (r?.doctor_name ?? '').toLowerCase();
        return name.includes(q) || sid.includes(q) || doc.includes(q);
      });
    }
    if (outcomeFilter !== 'all') {
      result = result.filter((r) => r?.outcome === outcomeFilter);
    }
    setFiltered(result);
  }, [search, outcomeFilter, records]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full min-h-screen">
        <div className="animate-spin rounded-full h-10 w-10 border-4 border-primary-600 border-t-transparent" />
      </div>
    );
  }

  if (loadError) {
    const isCORS = loadError.includes('CORS') || loadError.includes('Failed to fetch');
    return (
      <div className="p-6 max-w-5xl mx-auto space-y-3">
        <div className="flex items-start gap-3 bg-red-50 border border-red-200 text-red-800 rounded-xl px-4 py-4 text-sm">
          <XCircle size={16} className="flex-shrink-0 mt-0.5 text-red-500" />
          <div className="space-y-1">
            <p className="font-semibold">Failed to load transcriptions</p>
            <p className="text-red-700 text-xs">{loadError}</p>
          </div>
        </div>
        {isCORS && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-4 text-sm text-amber-900 space-y-2">
            <p className="font-semibold">Fix: add a CORS rule to the S3 bucket</p>
            <pre className="bg-amber-100 rounded-lg p-3 text-xs overflow-x-auto text-amber-900 whitespace-pre-wrap">
{`aws s3api put-bucket-cors \\
  --bucket transcripts-bot \\
  --region ap-southeast-2 \\
  --cors-configuration '{"CORSRules":[{"AllowedOrigins":["*"],"AllowedMethods":["GET"],"AllowedHeaders":["*"],"MaxAgeSeconds":3600}]}'`}
            </pre>
            <p className="text-amber-700 text-xs">Then hard-refresh (Ctrl+Shift+R).</p>
          </div>
        )}
      </div>
    );
  }

  const bookedCount     = records.filter((r) => r?.outcome === 'appointment_booked').length;
  const transferCount   = records.filter((r) => r?.outcome === 'transferred_to_human').length;
  const noApptCount     = records.filter((r) => !r?.outcome || r.outcome === 'no_appointment').length;

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {selected && (
        <TranscriptPanel record={selected} onClose={() => setSelected(null)} />
      )}

      <div className="mb-5">
        <h1 className="text-2xl font-bold text-slate-800">Call Transcriptions</h1>
        <p className="text-slate-500 text-sm mt-0.5">All inbound calls handled by the AI voice agent</p>
      </div>

      {/* Summary chips */}
      <div className="flex flex-wrap gap-3 mb-5">
        <div className="flex items-center gap-2 px-4 py-2 bg-white rounded-lg border border-slate-200 text-sm shadow-sm">
          <Phone size={15} className="text-slate-400" />
          <span className="font-semibold text-slate-700">{records.length}</span>
          <span className="text-slate-500">Total calls</span>
        </div>
        <div className="flex items-center gap-2 px-4 py-2 bg-green-50 rounded-lg border border-green-200 text-sm">
          <CheckCircle2 size={15} className="text-green-600" />
          <span className="font-semibold text-green-700">{bookedCount}</span>
          <span className="text-green-600">Appointments booked</span>
        </div>
        <div className="flex items-center gap-2 px-4 py-2 bg-blue-50 rounded-lg border border-blue-200 text-sm">
          <ArrowRightLeft size={15} className="text-blue-600" />
          <span className="font-semibold text-blue-700">{transferCount}</span>
          <span className="text-blue-600">Transferred to staff</span>
        </div>
        <div className="flex items-center gap-2 px-4 py-2 bg-slate-50 rounded-lg border border-slate-200 text-sm">
          <XCircle size={15} className="text-slate-400" />
          <span className="font-semibold text-slate-600">{noApptCount}</span>
          <span className="text-slate-500">No appointment</span>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="relative flex-1 min-w-48">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search patient, doctor, or call SID…"
            className="w-full pl-9 pr-4 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 bg-white"
          />
        </div>
        <div className="flex gap-1">
          {[
            { key: 'all',                  label: 'All' },
            { key: 'appointment_booked',   label: 'Booked' },
            { key: 'transferred_to_human', label: 'Transferred' },
            { key: 'no_appointment',       label: 'No booking' },
          ].map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setOutcomeFilter(key)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition border ${
                outcomeFilter === key
                  ? 'bg-primary-600 text-white border-primary-600'
                  : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* List */}
      <div className="space-y-3">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 bg-white rounded-xl border border-slate-200 text-slate-400">
            <FileText size={36} className="mb-3 opacity-40" />
            <p className="text-sm">No transcriptions found</p>
          </div>
        ) : (
          filtered.map((rec, idx) => {
            const turns = Array.isArray(rec?.transcript) ? rec.transcript : [];
            const oc    = outcomeConfig(rec?.outcome);
            const OcIcon = oc.Icon;
            return (
              <div
                key={rec?.id ?? rec?.call_sid ?? idx}
                className="bg-white rounded-xl border border-slate-200 shadow-sm hover:shadow-md transition overflow-hidden"
              >
                <div className="flex items-center gap-4 p-4 cursor-pointer" onClick={() => setSelected(rec)}>
                  <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${oc.iconBg}`}>
                    <OcIcon size={20} className={oc.iconCls} />
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-semibold text-slate-800">{rec?.patient_name ?? 'Unknown Caller'}</p>
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium border ${oc.badge}`}>
                        {oc.label}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-3 mt-1 text-xs text-slate-400">
                      {rec?.doctor_name && (
                        <span className="flex items-center gap-1">
                          <Stethoscope size={11} /> {rec.doctor_name}
                        </span>
                      )}
                      {rec?.appointment_time && (
                        <span className="flex items-center gap-1">
                          <Calendar size={11} /> {safeFmt(rec.appointment_time, 'd MMM, h:mm a')}
                        </span>
                      )}
                      {(rec?.duration_s ?? 0) > 0 && (
                        <span className="flex items-center gap-1">
                          <Clock size={11} /> {rec.duration_s}s
                        </span>
                      )}
                      {rec?.cost_usd != null && (
                        <span className="flex items-center gap-1 text-emerald-600">
                          <DollarSign size={11} /> {fmtCost(rec.cost_usd)}
                        </span>
                      )}
                      <span>{safeFmt(rec?.created_at, 'd MMM yyyy, h:mm a')}</span>
                    </div>
                  </div>

                  <div className="flex items-center gap-3 flex-shrink-0">
                    {turns.length > 0 && (
                      <span className="text-xs text-slate-400 hidden sm:block">{turns.length} turns</span>
                    )}
                    <span className="flex items-center gap-1 text-primary-600 text-xs font-medium">
                      View <ChevronRight size={13} />
                    </span>
                  </div>
                </div>

                {turns.length > 0 && (
                  <div className="border-t border-slate-50 px-4 pb-3 pt-2 bg-slate-50/50">
                    {turns.slice(0, 2).map((turn, i) => (
                      <div key={i} className="flex items-start gap-2 py-1">
                        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded flex-shrink-0 mt-0.5 ${turn?.role === 'assistant' ? 'bg-primary-100 text-primary-600' : 'bg-slate-200 text-slate-600'}`}>
                          {turn?.role === 'assistant' ? 'AI' : 'Patient'}
                        </span>
                        <p className="text-xs text-slate-600 line-clamp-1">{turn?.text ?? ''}</p>
                      </div>
                    ))}
                    {turns.length > 2 && (
                      <button
                        onClick={() => setSelected(rec)}
                        className="text-xs text-primary-500 hover:underline mt-1"
                      >
                        +{turns.length - 2} more turns — view full transcript
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      <p className="text-xs text-slate-400 mt-4 text-center">
        Transcriptions stored in S3 · bucket: transcripts-bot · prefix: transcripts/
      </p>
    </div>
  );
}

export default function Transcriptions() {
  return (
    <ErrorBoundary>
      <TranscriptionsInner />
    </ErrorBoundary>
  );
}

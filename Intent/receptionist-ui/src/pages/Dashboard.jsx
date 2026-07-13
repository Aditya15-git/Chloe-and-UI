import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  BookOpen, Phone, Calendar,
  CheckCircle2, ChevronRight, RefreshCw, AlertCircle, DollarSign,
} from 'lucide-react';
import { format, isToday, isTomorrow, parseISO } from 'date-fns';
import {
  fetchAllBookings,
  fetchActiveDoctors,
  fetchCallLogCount,
  fetchBookedCallCount,
  fetchTransferredCallCount,
  fetchRecentCallLogs,
  filterUpcoming,
} from '../services/dashboardService';
import { useAuth } from '../context/AuthContext';

// ─── Small reusable components ────────────────────────────────────────────────

function StatCard({ icon: Icon, label, value, sub, color, loading }) {
  return (
    <div className="bg-white rounded-xl p-5 shadow-sm border border-slate-100 flex items-start gap-4">
      <div className={`w-11 h-11 rounded-lg flex items-center justify-center flex-shrink-0 ${color}`}>
        <Icon size={22} className="text-white" />
      </div>
      <div>
        {loading ? (
          <div className="w-8 h-7 bg-slate-100 rounded animate-pulse mb-1" />
        ) : (
          <p className="text-2xl font-bold text-slate-800">{value}</p>
        )}
        <p className="text-sm font-medium text-slate-600">{label}</p>
        {sub && <p className="text-xs text-slate-400 mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

function formatSlotLabel(isoString) {
  if (!isoString) return '—';
  const d = new Date(isoString);
  const utcDate = new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const h24 = d.getUTCHours(), h = h24 % 12 || 12;
  const m = d.getUTCMinutes().toString().padStart(2, '0');
  const time = `${h}:${m} ${h24 >= 12 ? 'PM' : 'AM'}`;
  if (isToday(utcDate))    return `Today ${time}`;
  if (isTomorrow(utcDate)) return `Tomorrow ${time}`;
  return `${format(utcDate, 'EEE d MMM')}, ${time}`;
}

const TYPE_LABELS = {
  in_clinic:  { label: 'In Clinic',  cls: 'bg-blue-50 text-blue-700' },
  telehealth: { label: 'Telehealth', cls: 'bg-violet-50 text-violet-700' },
  phone:      { label: 'Phone',      cls: 'bg-amber-50 text-amber-700' },
};

const STATUS_BADGE = {
  confirmed: 'bg-green-100 text-green-700',
  pending:   'bg-amber-100 text-amber-700',
  cancelled: 'bg-red-100 text-red-600',
};

// ─── Dashboard ────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const { user } = useAuth();

  const [statsLoading, setStatsLoading]   = useState(true);
  const [listLoading,  setListLoading]    = useState(true);
  const [error,        setError]          = useState(null);

  const [stats,       setStats]       = useState({ totalCalls: 0, bookedCalls: 0, transferredCalls: 0 });
  const [upcomingBks, setUpcomingBks] = useState([]);
  const [recentCalls, setRecentCalls] = useState([]);
  const [doctors,     setDoctors]     = useState([]);

  const load = useCallback(async () => {
    setError(null);
    setStatsLoading(true);
    setListLoading(true);

    try {
      const [allBookings, activeDocs, totalCalls, bookedCalls, transferredCalls, recentLogs] =
        await Promise.all([
          fetchAllBookings(),
          fetchActiveDoctors(),
          fetchCallLogCount(),
          fetchBookedCallCount(),
          fetchTransferredCallCount(),
          fetchRecentCallLogs(5),
        ]);

      setStats({ totalCalls, bookedCalls, transferredCalls });
      setUpcomingBks(filterUpcoming(allBookings).slice(0, 5));
      setDoctors(activeDocs);
      setRecentCalls(recentLogs);
    } catch (err) {
      console.error('Dashboard load error:', err);
      setError(err.message ?? 'Failed to load dashboard data.');
    } finally {
      setStatsLoading(false);
      setListLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const greeting = () => {
    const h = new Date().getHours();
    if (h < 12) return 'Good morning';
    if (h < 17) return 'Good afternoon';
    return 'Good evening';
  };

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">
            {greeting()}, {user?.name?.split(' ')[0]} 👋
          </h1>
          <p className="text-slate-500 text-sm mt-1">
            {format(new Date(), 'EEEE, d MMMM yyyy')} · Here's your clinic overview.
          </p>
        </div>
        <button
          onClick={load}
          disabled={statsLoading}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 text-slate-500 hover:text-slate-700 hover:bg-slate-50 text-xs font-medium transition disabled:opacity-40"
        >
          <RefreshCw size={13} className={statsLoading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {/* Error banner */}
      {error && (
        <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-3 mb-5 text-sm">
          <AlertCircle size={16} className="flex-shrink-0" />
          <span>{error}</span>
          <button onClick={load} className="ml-auto text-red-600 hover:underline font-medium">
            Retry
          </button>
        </div>
      )}

      {/* Stat cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        <StatCard
          icon={Phone}        label="Total Calls Logged"     value={stats.totalCalls}
          color="bg-violet-500" sub="All AI-handled calls"   loading={statsLoading}
        />
        <StatCard
          icon={CheckCircle2} label="Appointments Booked"    value={stats.bookedCalls}
          color="bg-primary-500" sub="Calls resulting in a booking" loading={statsLoading}
        />
        <StatCard
          icon={BookOpen}     label="Transferred to Human"   value={stats.transferredCalls}
          color="bg-clinic-teal" sub="Calls handed to reception" loading={statsLoading}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Upcoming appointments list */}
        <div className="lg:col-span-2 bg-white rounded-xl shadow-sm border border-slate-100 p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-slate-800">Upcoming Appointments</h2>
            <Link
              to="/bookings"
              className="text-xs text-primary-600 hover:underline flex items-center gap-1"
            >
              View all <ChevronRight size={13} />
            </Link>
          </div>

          {listLoading ? (
            <div className="space-y-3">
              {[...Array(4)].map((_, i) => (
                <div key={i} className="flex items-center gap-3 p-3 rounded-lg bg-slate-50">
                  <div className="w-9 h-9 rounded-full bg-slate-200 animate-pulse flex-shrink-0" />
                  <div className="flex-1 space-y-1.5">
                    <div className="h-3 bg-slate-200 rounded animate-pulse w-1/3" />
                    <div className="h-2.5 bg-slate-100 rounded animate-pulse w-2/3" />
                  </div>
                  <div className="h-3 bg-slate-200 rounded animate-pulse w-20" />
                </div>
              ))}
            </div>
          ) : upcomingBks.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 text-slate-400">
              <Calendar size={32} className="mb-2 opacity-30" />
              <p className="text-sm">No upcoming appointments</p>
            </div>
          ) : (
            <div className="space-y-2">
              {upcomingBks.map((bk) => {
                const type = TYPE_LABELS[bk.appointment_type] ?? TYPE_LABELS.in_clinic;
                const initials = bk.patient_name
                  .split(' ')
                  .map((n) => n[0])
                  .join('')
                  .slice(0, 2)
                  .toUpperCase();
                return (
                  <div
                    key={bk.id}
                    className="flex items-center gap-3 p-3 rounded-lg bg-slate-50 hover:bg-slate-100 transition"
                  >
                    {/* Avatar */}
                    <div className="w-9 h-9 rounded-full bg-primary-100 flex items-center justify-center text-primary-700 font-semibold text-xs flex-shrink-0">
                      {initials}
                    </div>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-slate-800 truncate">
                        {bk.patient_name}
                      </p>
                      <p className="text-xs text-slate-400 truncate">
                        {bk.doctor_name}
                        {bk.reason ? ` · ${bk.reason}` : ''}
                      </p>
                    </div>

                    {/* Time + badges */}
                    <div className="text-right flex-shrink-0 space-y-1">
                      <p className="text-xs font-medium text-slate-600 whitespace-nowrap">
                        {formatSlotLabel(bk.slot_start)}
                      </p>
                      <div className="flex items-center gap-1 justify-end">
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${type.cls}`}>
                          {type.label}
                        </span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${STATUS_BADGE[bk.status] ?? 'bg-slate-100 text-slate-600'}`}>
                          {bk.status}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Right column */}
        <div className="space-y-5">
          {/* Active doctors */}
          <div className="bg-white rounded-xl shadow-sm border border-slate-100 p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-semibold text-slate-800">Active Doctors</h2>
              <Link
                to="/schedule"
                className="text-xs text-primary-600 hover:underline flex items-center gap-1"
              >
                Manage <ChevronRight size={13} />
              </Link>
            </div>

            {listLoading ? (
              <div className="space-y-2.5">
                {[...Array(3)].map((_, i) => (
                  <div key={i} className="flex items-center gap-2.5">
                    <div className="w-7 h-7 rounded-full bg-slate-200 animate-pulse flex-shrink-0" />
                    <div className="flex-1 space-y-1">
                      <div className="h-3 bg-slate-200 rounded animate-pulse w-3/4" />
                      <div className="h-2.5 bg-slate-100 rounded animate-pulse w-1/2" />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="space-y-2">
                {doctors.map((doc) => {
                  // Skip "Dr." prefix to get meaningful initials
                  const initial = doc.name
                    .split(' ')
                    .filter((p) => !/^Dr\.?$/i.test(p))
                    .map((p) => p[0])
                    .join('')
                    .slice(0, 2)
                    .toUpperCase();
                  return (
                    <div key={doc.id} className="flex items-center gap-2.5">
                      <div className="w-7 h-7 rounded-full bg-clinic-teal/15 flex items-center justify-center text-clinic-teal text-xs font-bold flex-shrink-0">
                        {initial}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-slate-700 truncate">{doc.name}</p>
                        <p className="text-xs text-slate-400">{doc.specialty}</p>
                      </div>
                      <CheckCircle2 size={14} className="text-green-500 flex-shrink-0" />
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Recent calls */}
          <div className="bg-white rounded-xl shadow-sm border border-slate-100 p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-semibold text-slate-800">Recent Calls</h2>
              <Link
                to="/transcriptions"
                className="text-xs text-primary-600 hover:underline flex items-center gap-1"
              >
                View all <ChevronRight size={13} />
              </Link>
            </div>

            {listLoading ? (
              <div className="space-y-2.5">
                {[...Array(3)].map((_, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <div className="w-7 h-7 rounded-full bg-slate-200 animate-pulse flex-shrink-0" />
                    <div className="flex-1 space-y-1">
                      <div className="h-3 bg-slate-200 rounded animate-pulse w-2/3" />
                      <div className="h-2.5 bg-slate-100 rounded animate-pulse w-1/3" />
                    </div>
                  </div>
                ))}
              </div>
            ) : recentCalls.length === 0 ? (
              <div className="flex flex-col items-center py-6 text-slate-400">
                <Phone size={24} className="mb-1.5 opacity-30" />
                <p className="text-xs">No calls logged yet</p>
              </div>
            ) : (
              <div className="space-y-2.5">
                {recentCalls.map((call) => {
                  const booked      = call.outcome === 'appointment_booked';
                  const transferred = call.outcome === 'transferred_to_human';
                  const iconBg  = booked ? 'bg-green-100' : transferred ? 'bg-blue-100' : 'bg-slate-100';
                  const badgeCls = booked
                    ? 'bg-green-100 text-green-700'
                    : transferred
                    ? 'bg-blue-100 text-blue-700'
                    : 'bg-slate-100 text-slate-500';
                  const badgeLabel = booked ? 'Booked' : transferred ? 'Transferred' : 'No booking';
                  return (
                    <div key={call.id} className="flex items-center gap-2.5">
                      <div className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 ${iconBg}`}>
                        {booked
                          ? <CheckCircle2 size={13} className="text-green-600" />
                          : <Phone size={13} className={transferred ? 'text-blue-500' : 'text-slate-400'} />}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-slate-700 truncate">{call.patient_name}</p>
                        <p className="text-xs text-slate-400">
                          {format(parseISO(call.created_at), 'd MMM, h:mm a')}
                        </p>
                      </div>
                      <div className="flex flex-col items-end gap-1 flex-shrink-0">
                        <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${badgeCls}`}>
                          {badgeLabel}
                        </span>
                        {call.cost_usd != null && (
                          <span className="text-[10px] text-emerald-600 flex items-center gap-0.5">
                            <DollarSign size={9} />{Number(call.cost_usd).toFixed(4)}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

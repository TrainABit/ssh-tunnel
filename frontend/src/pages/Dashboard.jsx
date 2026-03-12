import { useEffect, useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Globe,
  Network,
  HardDrive,
  Clock,
  Plus,
  Key,
  Radio,
  Inbox,
  RefreshCw,
} from 'lucide-react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { getStats, getSessions } from '../services/api';


function StatCard({ icon: Icon, label, value, accent }) {
  return (
    <div className="group relative overflow-hidden rounded-xl border border-gray-800/60 bg-gray-900 p-5  transition-all duration-300 hover:border-gray-700/80 hover:bg-gray-900">
      <div className="absolute inset-0 bg-gradient-to-br from-emerald-500/[0.03] to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
      <div className="relative">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-sm text-gray-400">{label}</span>
          <div className={`rounded-lg p-2 ${accent || 'bg-gray-800/80 text-gray-400'}`}>
            <Icon size={16} />
          </div>
        </div>
        <p className="text-2xl font-bold tracking-tight text-white">{value}</p>
      </div>
    </div>
  );
}

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-gray-700 bg-gray-900/95 px-3 py-2 shadow-xl ">
      <p className="font-mono text-xs text-gray-400">{label}</p>
      <p className="text-sm font-semibold text-emerald-400">
        {payload[0].value} connections
      </p>
    </div>
  );
}

function formatTimestamp(ts) {
  if (!ts || typeof ts !== 'string') return '\u2013';
  const d = new Date(ts.endsWith('Z') ? ts : ts + 'Z');
  return d.toLocaleString('en-US', {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDuration(start) {
  if (!start || typeof start !== 'string') return '\u2013';
  const s = new Date(start.endsWith('Z') ? start : start + 'Z');
  const now = new Date();
  const sec = Math.floor((now - s) / 1000);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h ${m}m`;
}

export default function Dashboard() {
  const [stats, setStats] = useState(null);
  const [sshSessions, setSshSessions] = useState([]);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);
  const navigate = useNavigate();
  const intervalRef = useRef(null);

  const load = useCallback(async (showSpinner) => {
    if (showSpinner) setRefreshing(true);
    const [statsData, sessionsData] = await Promise.all([
      getStats(),
      getSessions(),
    ]);
    setStats(statsData);
    setSshSessions(sessionsData.slice(0, 5));
    setLastUpdated(new Date());
    if (showSpinner) setTimeout(() => setRefreshing(false), 300);
  }, []);

  useEffect(() => {
    load(false);
    intervalRef.current = setInterval(() => load(false), 10000);
    return () => clearInterval(intervalRef.current);
  }, [load]);

  if (!stats) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Dashboard</h1>
          <p className="text-sm text-gray-400">
            Overview of your tunnel infrastructure{' '}
            <span className="text-gray-600">(auto-refreshes every 10s)</span>
          </p>
          {lastUpdated && (
            <p className="mt-0.5 text-xs text-gray-600">
              Last updated: {lastUpdated.toLocaleTimeString()}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => load(true)}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-700 bg-gray-800/50 px-4 py-2.5 text-sm text-gray-300 transition-colors hover:border-gray-600 hover:text-white"
          >
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
            Refresh
          </button>
          <button
            onClick={() => navigate('/tunnels')}
            className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white shadow-lg shadow-emerald-500/20 transition-all duration-200 hover:bg-emerald-500 hover:shadow-emerald-500/30"
          >
            <Plus size={16} />
            New Tunnel
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard
          icon={Globe}
          label="Active Tunnels"
          value={stats.activeTunnels}
          accent="bg-emerald-500/10 text-emerald-400"
        />
        <StatCard
          icon={Network}
          label="Total Connections"
          value={stats.totalConnections}
          accent="bg-blue-500/10 text-blue-400"
        />
        <StatCard
          icon={HardDrive}
          label="Data Transferred"
          value={stats.dataTransferred}
          accent="bg-purple-500/10 text-purple-400"
        />
        <StatCard
          icon={Clock}
          label="Uptime"
          value={stats.uptime}
          accent="bg-amber-500/10 text-amber-400"
        />
        <StatCard
          icon={Key}
          label="Active Tokens"
          value={stats.activeTokens}
          accent="bg-cyan-500/10 text-cyan-400"
        />
        <StatCard
          icon={Radio}
          label="Live SSH Sessions"
          value={stats.liveSshSessions}
          accent="bg-orange-500/10 text-orange-400"
        />
      </div>

      {/* Chart + Activity */}
      <div className="grid gap-6 xl:grid-cols-3">
        {/* Chart */}
        <div className="xl:col-span-2 rounded-xl border border-gray-800/60 bg-gray-900 p-5 ">
          <h2 className="mb-4 text-sm font-medium text-gray-300">
            Connections Over Time
          </h2>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={stats.chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                <XAxis
                  dataKey="time"
                  stroke="#6b7280"
                  tick={{ fontSize: 11 }}
                />
                <YAxis stroke="#6b7280" tick={{ fontSize: 11 }} />
                <Tooltip content={<CustomTooltip />} />
                <Line
                  type="monotone"
                  dataKey="connections"
                  stroke="#10b981"
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4, fill: '#10b981', stroke: '#0a0a0f', strokeWidth: 2 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Activity */}
        <div className="rounded-xl border border-gray-800/60 bg-gray-900 p-5 ">
          <h2 className="mb-4 text-sm font-medium text-gray-300">
            Recent Activity
          </h2>
          {stats.recentActivity?.length > 0 ? (
            <div className="space-y-3">
              {stats.recentActivity.map((event, idx) => (
                <div
                  key={event.id || idx}
                  className="flex items-center gap-3 rounded-lg p-2 transition-colors hover:bg-gray-800/40"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-gray-200">
                      {event.message || event.type}
                    </p>
                    <p className="text-xs text-gray-500">{event.time}</p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-10">
              <Inbox size={28} className="mb-2 text-gray-600" />
              <p className="text-sm text-gray-500">No recent activity</p>
            </div>
          )}
        </div>
      </div>

      {/* Recent SSH Sessions */}
      {sshSessions.length > 0 && (
        <div className="rounded-xl border border-gray-800/60 bg-gray-900 p-5 ">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-medium text-gray-300">
              Recent SSH Sessions
            </h2>
            <button
              onClick={() => navigate('/sessions')}
              className="text-xs text-emerald-400 transition-colors hover:text-emerald-300"
            >
              View all
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-800/60">
                  <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                    Token
                  </th>
                  <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                    Client IP
                  </th>
                  <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                    Target
                  </th>
                  <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                    Connected
                  </th>
                  <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/40">
                {sshSessions.map((s) => {
                  const isLive = s.disconnected_at === null;
                  return (
                    <tr
                      key={s.id}
                      className="transition-colors hover:bg-gray-800/30"
                    >
                      <td className="whitespace-nowrap px-4 py-2.5">
                        <span className="font-mono text-xs text-[#38b6ff]">
                          {(s.token || '').length > 12 ? s.token.slice(0, 12) + '\u2026' : (s.token || '\u2013')}
                        </span>
                        {s.token_label && (
                          <p className="text-[10px] text-gray-600">{s.token_label}</p>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-gray-400">
                        {s.client_ip || '\u2013'}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-gray-500">
                        {s.target_ip}:{s.target_port}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-xs text-gray-500">
                        {formatTimestamp(s.connected_at)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5">
                        {isLive ? (
                          <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-400">
                            <span className="h-1.5 w-1.5 rounded-full bg-amber-500 pulse-amber" />
                            live &middot; {formatDuration(s.connected_at)}
                          </span>
                        ) : (
                          <span className="inline-block rounded-full bg-gray-700/30 px-2 py-0.5 text-[10px] font-medium text-gray-500">
                            ended
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

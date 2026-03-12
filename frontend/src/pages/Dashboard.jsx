import { useEffect, useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { RefreshCw, Plus } from 'lucide-react';
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

function StatCard({ label, value, sub, live }) {
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', position: 'relative', overflow: 'hidden' }}>
      {/* Top accent bar */}
      <div
        className={live ? 'stat-bar-live' : ''}
        style={{
          position: 'absolute', top: 0, left: 0, right: 0, height: '2px',
          background: 'var(--green)', opacity: live ? 1 : 0.25,
        }}
      />
      <div className="p-4 pt-5">
        <div className="mb-2 text-[8.5px] uppercase tracking-[0.22em]" style={{ color: 'var(--text-dim)' }}>
          {label}
        </div>
        <div className="text-3xl font-light leading-none" style={{ color: 'var(--green)' }}>
          {value}
        </div>
        {sub && (
          <div className="mt-1.5 text-[9.5px]" style={{ color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>
            {sub}
          </div>
        )}
      </div>
    </div>
  );
}

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: 'var(--surface2)', border: '1px solid var(--border2)', padding: '8px 12px', fontSize: '11px' }}>
      <p style={{ color: 'var(--text-dim)' }}>{label}</p>
      <p style={{ color: 'var(--green)', fontWeight: 600 }}>{payload[0].value} connections</p>
    </div>
  );
}

function formatTimestamp(ts) {
  if (!ts || typeof ts !== 'string') return '–';
  const d = new Date(ts.endsWith('Z') ? ts : ts + 'Z');
  return d.toLocaleString('en-US', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function formatDuration(start) {
  if (!start || typeof start !== 'string') return '–';
  const s = new Date(start.endsWith('Z') ? start : start + 'Z');
  const sec = Math.floor((new Date() - s) / 1000);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

export default function Dashboard() {
  const [stats, setStats] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);
  const navigate = useNavigate();
  const intervalRef = useRef(null);

  const load = useCallback(async (showSpinner) => {
    if (showSpinner) setRefreshing(true);
    const [statsData, sessionsData] = await Promise.all([getStats(), getSessions()]);
    setStats(statsData);
    setSessions(sessionsData.slice(0, 8));
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
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-t-transparent" style={{ borderColor: 'var(--green)', borderTopColor: 'transparent' }} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-[16px] font-normal tracking-[0.06em]" style={{ color: 'var(--text)' }}>
            Dashboard <span style={{ color: 'var(--green)' }}>//</span> Overview
          </h1>
          <p className="mt-0.5 text-[10.5px]" style={{ color: 'var(--text-dim)' }}>
            Live status of your tunnel infrastructure
            {lastUpdated && (
              <span className="ml-2">— updated {lastUpdated.toLocaleTimeString()}</span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => load(true)}
            className="flex items-center gap-1.5 border px-3 py-1.5 text-[10.5px] uppercase tracking-[0.09em] transition-colors"
            style={{ borderColor: 'var(--border2)', color: 'var(--text-mid)', background: 'transparent' }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--green-dim)'; e.currentTarget.style.color = 'var(--text)'; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border2)'; e.currentTarget.style.color = 'var(--text-mid)'; }}
          >
            <RefreshCw size={11} className={refreshing ? 'animate-spin' : ''} />
            Refresh
          </button>
          <button
            onClick={() => navigate('/tunnels')}
            className="flex items-center gap-1.5 border px-3 py-1.5 text-[10.5px] uppercase tracking-[0.09em] font-semibold transition-colors"
            style={{ background: 'var(--green)', borderColor: 'var(--green)', color: '#040d0a' }}
            onMouseEnter={e => { e.currentTarget.style.background = '#00f599'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'var(--green)'; }}
          >
            <Plus size={11} />
            New Tunnel
          </button>
        </div>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-3">
        <StatCard label="Active Tunnels" value={stats.activeTunnels} sub="Registered endpoints" />
        <StatCard label="Active Connections" value={stats.activeConnections} sub="Current TCP sessions" live />
        <StatCard label="Data Transferred" value={stats.dataTransferred} sub="All time" />
        <StatCard label="Uptime" value={stats.uptime} sub="Server runtime" />
        <StatCard label="Active Tokens" value={stats.activeTokens} sub="Authorized clients" />
        <StatCard label="Live Sessions" value={stats.liveSessions} sub="Open tunnels" live />
      </div>

      {/* Chart + Activity */}
      <div className="grid gap-4 xl:grid-cols-3">
        {/* Chart */}
        <div className="xl:col-span-2" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
          <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: '1px solid var(--border)' }}>
            <span className="text-[10px] uppercase tracking-[0.15em]" style={{ color: 'var(--text-mid)' }}>
              Connections Over Time
            </span>
          </div>
          <div className="p-4 h-52">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={stats.chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1a2426" />
                <XAxis dataKey="time" stroke="#44605a" tick={{ fontSize: 10, fill: '#44605a', fontFamily: 'IBM Plex Mono' }} />
                <YAxis stroke="#44605a" tick={{ fontSize: 10, fill: '#44605a', fontFamily: 'IBM Plex Mono' }} />
                <Tooltip content={<CustomTooltip />} />
                <Line
                  type="monotone"
                  dataKey="connections"
                  stroke="#00d47e"
                  strokeWidth={1.5}
                  dot={false}
                  activeDot={{ r: 3, fill: '#00d47e', stroke: '#080c0d', strokeWidth: 2 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Recent activity */}
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
          <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: '1px solid var(--border)' }}>
            <span className="text-[10px] uppercase tracking-[0.15em]" style={{ color: 'var(--text-mid)' }}>
              Recent Activity
            </span>
          </div>
          <div className="divide-y" style={{ '--tw-divide-opacity': 1 }}>
            {stats.recentActivity?.length > 0 ? (
              stats.recentActivity.map((event, idx) => (
                <div
                  key={event.id || idx}
                  className="px-4 py-2.5"
                  style={{ borderBottom: '1px solid var(--border)' }}
                >
                  <p className="truncate text-[11px]" style={{ color: 'var(--text)' }}>
                    {event.message || event.type}
                  </p>
                  <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-dim)' }}>{event.time}</p>
                </div>
              ))
            ) : (
              <div className="flex flex-col items-center justify-center py-10">
                <p className="text-[11px]" style={{ color: 'var(--text-dim)' }}>No recent activity</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Recent Sessions */}
      {sessions.length > 0 && (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
          <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: '1px solid var(--border)' }}>
            <span className="text-[10px] uppercase tracking-[0.15em]" style={{ color: 'var(--text-mid)' }}>
              Recent Sessions
            </span>
            <button
              onClick={() => navigate('/sessions')}
              className="text-[10px] uppercase tracking-[0.09em] transition-colors"
              style={{ color: 'var(--green)' }}
            >
              View all →
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full" style={{ borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  {['Client', 'From IP', 'Connected', 'Status'].map(h => (
                    <th key={h} className="px-4 py-2 text-left text-[9px] uppercase tracking-[0.18em] font-normal whitespace-nowrap" style={{ color: 'var(--text-dim)' }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => {
                  const isLive = s.disconnected_at === null;
                  return (
                    <tr
                      key={s.id}
                      style={{ borderBottom: '1px solid var(--border)' }}
                      onMouseEnter={e => e.currentTarget.style.background = 'var(--green-bg)'}
                      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                    >
                      <td className="px-4 py-2.5 text-[11px]" style={{ color: 'var(--text)' }}>
                        {s.token_label || (
                          <span style={{ color: 'var(--blue)' }}>
                            {(s.token || '').length > 12 ? s.token.slice(0, 12) + '…' : s.token || '–'}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-[11px] whitespace-nowrap" style={{ color: 'var(--text-mid)' }}>
                        {s.client_ip || '–'}
                      </td>
                      <td className="px-4 py-2.5 text-[10.5px] whitespace-nowrap" style={{ color: 'var(--text-dim)' }}>
                        {formatTimestamp(s.connected_at)}
                      </td>
                      <td className="px-4 py-2.5 whitespace-nowrap">
                        {isLive ? (
                          <span className="text-[9.5px] border px-2 py-0.5" style={{ color: 'var(--amber)', borderColor: '#4a3000', background: 'rgba(240,165,0,0.07)' }}>
                            ● live · {formatDuration(s.connected_at)}
                          </span>
                        ) : (
                          <span className="text-[9.5px] border px-2 py-0.5" style={{ color: 'var(--text-dim)', borderColor: 'var(--border2)' }}>
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

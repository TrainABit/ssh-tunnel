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
    <div style={{
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: '10px',
      boxShadow: 'var(--shadow-sm)',
      position: 'relative',
      overflow: 'hidden',
    }}>
      <div
        className={live ? 'stat-bar-live' : ''}
        style={{
          position: 'absolute', top: 0, left: 0, right: 0, height: '3px',
          background: 'linear-gradient(90deg, #0632A0 0%, #1EB4E6 100%)',
          opacity: live ? 1 : 0.3,
        }}
      />
      <div className="p-5 pt-6">
        <div className="mb-3 text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-dim)' }}>
          {label}
        </div>
        <div className="text-3xl font-light" style={{ color: 'var(--accent)', lineHeight: 1 }}>
          {value}
        </div>
        {sub && (
          <div className="mt-2 text-xs" style={{ color: 'var(--text-dim)' }}>
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
    <div style={{
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: '8px',
      padding: '10px 14px',
      fontSize: '12px',
      boxShadow: 'var(--shadow-md)',
    }}>
      <p style={{ color: 'var(--text-dim)', marginBottom: '4px' }}>{label}</p>
      <p style={{ color: 'var(--accent)', fontWeight: 600 }}>{payload[0].value} connections</p>
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

const btnBase = {
  display: 'inline-flex', alignItems: 'center', gap: '6px',
  padding: '7px 16px', fontFamily: 'inherit', fontSize: '13px',
  fontWeight: 500, borderRadius: '8px', border: '1px solid',
  cursor: 'pointer', transition: 'all .15s',
};

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
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-t-transparent" style={{ borderColor: 'var(--accent)', borderTopColor: 'transparent' }} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold" style={{ color: 'var(--text)' }}>Dashboard</h1>
          <p className="mt-1 text-sm" style={{ color: 'var(--text-dim)' }}>
            Live status of your tunnel infrastructure
            {lastUpdated && (
              <span className="ml-2">· updated {lastUpdated.toLocaleTimeString()}</span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => load(true)}
            style={{ ...btnBase, borderColor: 'var(--border)', color: 'var(--text-mid)', background: 'transparent' }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--accent-dim)'; e.currentTarget.style.color = 'var(--text)'; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-mid)'; }}
          >
            <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
            Refresh
          </button>
          <button
            onClick={() => navigate('/tunnels')}
            style={{ ...btnBase, background: 'linear-gradient(90deg, #0632A0 0%, #1EB4E6 100%)', borderColor: 'transparent', color: '#ffffff', fontWeight: 600 }}
            onMouseEnter={e => e.currentTarget.style.opacity = '0.88'}
            onMouseLeave={e => e.currentTarget.style.opacity = '1'}
          >
            <Plus size={13} />
            New Tunnel
          </button>
        </div>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-3">
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
        <div className="xl:col-span-2" style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: '10px',
          boxShadow: 'var(--shadow-sm)',
        }}>
          <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: '1px solid var(--border)' }}>
            <span className="text-sm font-semibold" style={{ color: 'var(--text)' }}>Connections Over Time</span>
          </div>
          <div className="p-5">
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={stats.chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="time" stroke="var(--border2)" tick={{ fontSize: 11, fill: 'var(--text-dim)', fontFamily: 'Inter, sans-serif' }} />
                <YAxis stroke="var(--border2)" tick={{ fontSize: 11, fill: 'var(--text-dim)', fontFamily: 'Inter, sans-serif' }} />
                <Tooltip content={<CustomTooltip />} />
                <Line
                  type="monotone"
                  dataKey="connections"
                  stroke="#1EB4E6"
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4, fill: '#1EB4E6', stroke: 'var(--surface)', strokeWidth: 2 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Recent activity */}
        <div style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: '10px',
          boxShadow: 'var(--shadow-sm)',
        }}>
          <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: '1px solid var(--border)' }}>
            <span className="text-sm font-semibold" style={{ color: 'var(--text)' }}>Recent Activity</span>
          </div>
          <div>
            {stats.recentActivity?.length > 0 ? (
              stats.recentActivity.map((event, idx) => (
                <div
                  key={event.id || idx}
                  className="px-5 py-3"
                  style={{ borderBottom: '1px solid var(--border)' }}
                >
                  <p className="truncate text-sm" style={{ color: 'var(--text)' }}>
                    {event.message || event.type}
                  </p>
                  <p className="text-xs mt-0.5" style={{ color: 'var(--text-dim)' }}>{event.time}</p>
                </div>
              ))
            ) : (
              <div className="flex flex-col items-center justify-center py-10">
                <p className="text-sm" style={{ color: 'var(--text-dim)' }}>No recent activity</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Recent Sessions */}
      {sessions.length > 0 && (
        <div style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: '10px',
          boxShadow: 'var(--shadow-sm)',
        }}>
          <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: '1px solid var(--border)' }}>
            <span className="text-sm font-semibold" style={{ color: 'var(--text)' }}>Recent Sessions</span>
            <button
              onClick={() => navigate('/sessions')}
              className="text-sm transition-colors"
              style={{ color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}
            >
              View all →
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full" style={{ borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  {['Client', 'From IP', 'Connected', 'Status'].map(h => (
                    <th key={h} className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide whitespace-nowrap" style={{ color: 'var(--text-dim)' }}>
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
                      onMouseEnter={e => e.currentTarget.style.background = 'var(--accent-bg)'}
                      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                    >
                      <td className="px-5 py-3 text-sm" style={{ color: 'var(--text)' }}>
                        {s.token_label || (
                          <span style={{ color: 'var(--blue)', fontFamily: 'var(--font-mono)', fontSize: '12px' }}>
                            {(s.token || '').length > 12 ? s.token.slice(0, 12) + '…' : s.token || '–'}
                          </span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-sm whitespace-nowrap" style={{ color: 'var(--text-mid)' }}>
                        {s.client_ip || '–'}
                      </td>
                      <td className="px-5 py-3 text-xs whitespace-nowrap" style={{ color: 'var(--text-dim)' }}>
                        {formatTimestamp(s.connected_at)}
                      </td>
                      <td className="px-5 py-3 whitespace-nowrap">
                        {isLive ? (
                          <span style={{
                            display: 'inline-flex', alignItems: 'center', gap: '5px',
                            fontSize: '11px', fontWeight: 500,
                            padding: '2px 10px', borderRadius: '9999px',
                            color: 'var(--amber)',
                            background: 'rgba(240,165,0,0.1)',
                          }}>
                            <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'var(--amber)', display: 'inline-block' }} />
                            live · {formatDuration(s.connected_at)}
                          </span>
                        ) : (
                          <span style={{
                            display: 'inline-flex', alignItems: 'center',
                            fontSize: '11px', padding: '2px 10px', borderRadius: '9999px',
                            color: 'var(--text-dim)', background: 'var(--surface2)',
                          }}>
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

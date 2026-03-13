import { useEffect, useState, useCallback, useRef } from 'react';
import { RefreshCw } from 'lucide-react';
import { getConnections, getTunnels } from '../services/api';
import { formatGeo } from '../utils/geo';

function formatDuration(startTime) {
  if (!startTime) return '--';
  const start = new Date(startTime.endsWith?.('Z') ? startTime : startTime + 'Z');
  const sec = Math.floor((new Date() - start) / 1000);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

function formatBytes(bytes) {
  if (bytes == null || bytes === 0) return '0 B';
  if (bytes > 1e9) return (bytes / 1e9).toFixed(2) + ' GB';
  if (bytes > 1e6) return (bytes / 1e6).toFixed(1) + ' MB';
  if (bytes > 1e3) return (bytes / 1e3).toFixed(0) + ' KB';
  return bytes + ' B';
}

export default function Connections() {
  const [connections, setConnections] = useState([]);
  const [tunnels, setTunnels] = useState([]);
  const [filter, setFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const intervalRef = useRef(null);

  const load = useCallback(async (showSpinner) => {
    if (showSpinner) setRefreshing(true);
    const [connData, tunnelData] = await Promise.all([getConnections(), getTunnels()]);
    setConnections(connData);
    setTunnels(tunnelData);
    setLoading(false);
    if (showSpinner) setTimeout(() => setRefreshing(false), 300);
  }, []);

  useEffect(() => {
    load(false);
    intervalRef.current = setInterval(() => load(false), 5000);
    return () => clearInterval(intervalRef.current);
  }, [load]);

  const tunnelNameMap = {};
  tunnels.forEach((t) => { tunnelNameMap[t.id] = t.name; });

  const filtered = filter === 'all' ? connections : connections.filter(c => c.tunnelId === filter);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-t-transparent" style={{ borderColor: 'var(--accent)', borderTopColor: 'transparent' }} />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold" style={{ color: 'var(--text)' }}>Connections</h1>
          <p className="mt-1 text-sm" style={{ color: 'var(--text-dim)' }}>
            Active TCP connections · auto-refreshes every 5s
          </p>
        </div>
        <button
          onClick={() => load(true)}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: '6px',
            padding: '7px 16px', fontFamily: 'inherit', fontSize: '13px',
            fontWeight: 500, borderRadius: '8px', border: '1px solid var(--border)',
            color: 'var(--text-mid)', background: 'transparent', cursor: 'pointer', transition: 'all .15s',
          }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--accent-dim)'; e.currentTarget.style.color = 'var(--text)'; }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-mid)'; }}
        >
          <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {/* Filter chips */}
      <div className="flex flex-wrap gap-2">
        {['all', ...tunnels.filter(t => t.status === 'active').map(t => t.id)].map(id => (
          <button
            key={id}
            onClick={() => setFilter(id)}
            style={{
              padding: '5px 14px', fontFamily: 'inherit', fontSize: '12px',
              fontWeight: 500, borderRadius: '9999px', border: '1px solid',
              cursor: 'pointer', transition: 'all .15s',
              borderColor: filter === id ? 'var(--accent-dim)' : 'var(--border)',
              color: filter === id ? 'var(--accent)' : 'var(--text-mid)',
              background: filter === id ? 'var(--accent-bg)' : 'transparent',
            }}
          >
            {id === 'all' ? 'All tunnels' : (tunnelNameMap[id] || id)}
          </button>
        ))}
      </div>

      {/* Table */}
      <div style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: '10px',
        boxShadow: 'var(--shadow-sm)',
        overflow: 'hidden',
      }}>
        <div className="overflow-x-auto">
          <table className="w-full" style={{ borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--surface2)' }}>
                {['Source IP', 'Location', 'Tunnel', 'Duration', 'Bytes'].map(h => (
                  <th key={h} className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide whitespace-nowrap" style={{ color: 'var(--text-dim)' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-5 py-14 text-center text-sm" style={{ color: 'var(--text-dim)' }}>
                    No active connections
                  </td>
                </tr>
              ) : filtered.map((conn) => {
                const geo = formatGeo(conn.country_code, conn.city);
                return (
                <tr
                  key={conn.connectionId}
                  style={{ borderBottom: '1px solid var(--border)' }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--accent-bg)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                >
                  <td className="px-5 py-3 text-sm" style={{ color: 'var(--text)', fontFamily: 'var(--font-mono)' }}>{conn.sourceIp}</td>
                  <td className="px-5 py-3 text-sm whitespace-nowrap" style={{ color: 'var(--text-dim)' }}>
                    {geo || <span style={{ color: 'var(--border2)' }}>–</span>}
                  </td>
                  <td className="px-5 py-3">
                    <span style={{
                      display: 'inline-flex', alignItems: 'center', gap: '5px',
                      fontSize: '12px', fontWeight: 500, padding: '2px 10px', borderRadius: '9999px',
                      color: 'var(--accent)', background: 'var(--accent-bg)',
                    }}>
                      <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'var(--accent)', display: 'inline-block' }} />
                      {tunnelNameMap[conn.tunnelId] || conn.tunnelId}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-sm" style={{ color: 'var(--text-mid)' }}>{formatDuration(conn.startTime)}</td>
                  <td className="px-5 py-3 text-sm" style={{ color: 'var(--text-mid)' }}>{formatBytes((conn.bytesIn || 0) + (conn.bytesOut || 0))}</td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

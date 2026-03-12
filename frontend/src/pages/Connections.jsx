import { useEffect, useState, useCallback, useRef } from 'react';
import { RefreshCw } from 'lucide-react';
import { getConnections, getTunnels } from '../services/api';

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

const btnStyle = {
  borderColor: 'var(--border2)', color: 'var(--text-mid)', background: 'transparent',
  border: '1px solid', cursor: 'pointer', padding: '5px 12px', fontFamily: 'inherit',
  fontSize: '10px', letterSpacing: '.09em', textTransform: 'uppercase',
  display: 'inline-flex', alignItems: 'center', gap: '6px', transition: 'all .15s',
};

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
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-t-transparent" style={{ borderColor: 'var(--green)', borderTopColor: 'transparent' }} />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-[16px] font-normal tracking-[0.06em]" style={{ color: 'var(--text)' }}>
            Connections <span style={{ color: 'var(--green)' }}>//</span> Live
          </h1>
          <p className="mt-0.5 text-[10.5px]" style={{ color: 'var(--text-dim)' }}>
            Active TCP connections — auto-refreshes every 5s
          </p>
        </div>
        <button
          onClick={() => load(true)}
          style={btnStyle}
          onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--green-dim)'; e.currentTarget.style.color = 'var(--text)'; }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border2)'; e.currentTarget.style.color = 'var(--text-mid)'; }}
        >
          <RefreshCw size={11} className={refreshing ? 'animate-spin' : ''} />
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
              border: '1px solid', cursor: 'pointer', padding: '3px 10px',
              fontFamily: 'inherit', fontSize: '9.5px', letterSpacing: '.08em',
              textTransform: 'uppercase', background: 'transparent', transition: 'all .15s',
              borderColor: filter === id ? 'var(--green-dim)' : 'var(--border2)',
              color: filter === id ? 'var(--green)' : 'var(--text-mid)',
              background: filter === id ? 'var(--green-bg)' : 'transparent',
            }}
          >
            {id === 'all' ? 'All' : (tunnelNameMap[id] || id)}
          </button>
        ))}
      </div>

      {/* Table */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
        <div className="overflow-x-auto">
          <table className="w-full" style={{ borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                {['Source IP', 'Tunnel', 'Duration', 'Bytes'].map(h => (
                  <th key={h} className="px-4 py-2.5 text-left text-[9px] uppercase tracking-[0.18em] font-normal whitespace-nowrap" style={{ color: 'var(--text-dim)' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-12 text-center text-[11px]" style={{ color: 'var(--text-dim)' }}>
                    No active connections
                  </td>
                </tr>
              ) : filtered.map((conn) => (
                <tr
                  key={conn.connectionId}
                  style={{ borderBottom: '1px solid var(--border)' }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--green-bg)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                >
                  <td className="px-4 py-2.5 text-[11.5px]" style={{ color: 'var(--text)' }}>{conn.sourceIp}</td>
                  <td className="px-4 py-2.5">
                    <span className="border px-2 py-0.5 text-[9.5px]" style={{ color: 'var(--green)', borderColor: 'var(--green-dim)', background: 'var(--green-bg)' }}>
                      ● {tunnelNameMap[conn.tunnelId] || conn.tunnelId}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-[11.5px]" style={{ color: 'var(--text-mid)' }}>{formatDuration(conn.startTime)}</td>
                  <td className="px-4 py-2.5 text-[11.5px]" style={{ color: 'var(--text-mid)' }}>{formatBytes((conn.bytesIn || 0) + (conn.bytesOut || 0))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

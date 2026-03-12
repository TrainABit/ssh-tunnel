import { useEffect, useState, useCallback, useRef } from 'react';
import { RefreshCw } from 'lucide-react';
import { getSessions } from '../services/api';

function formatTimestamp(ts) {
  if (!ts || typeof ts !== 'string') return '–';
  const d = new Date(ts.endsWith('Z') ? ts : ts + 'Z');
  return d.toLocaleString('en-US', { month: 'short', day: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function formatDuration(start) {
  if (!start || typeof start !== 'string') return '–';
  const s = new Date(start.endsWith('Z') ? start : start + 'Z');
  const sec = Math.floor((new Date() - s) / 1000);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

const btnStyle = {
  borderColor: 'var(--border2)', color: 'var(--text-mid)', background: 'transparent',
  border: '1px solid', cursor: 'pointer', padding: '5px 12px', fontFamily: 'inherit',
  fontSize: '10px', letterSpacing: '.09em', textTransform: 'uppercase',
  display: 'inline-flex', alignItems: 'center', gap: '6px', transition: 'all .15s',
};

export default function Sessions() {
  const [sessions, setSessions] = useState([]);
  const [filter, setFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const intervalRef = useRef(null);

  const load = useCallback(async (showSpinner) => {
    if (showSpinner) setRefreshing(true);
    const data = await getSessions(filter === 'active');
    setSessions(data);
    setLoading(false);
    if (showSpinner) setTimeout(() => setRefreshing(false), 300);
  }, [filter]);

  useEffect(() => {
    load(false);
    intervalRef.current = setInterval(() => load(false), 10000);
    return () => clearInterval(intervalRef.current);
  }, [load]);

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
            Sessions <span style={{ color: 'var(--green)' }}>//</span> Log
          </h1>
          <p className="mt-0.5 text-[10.5px]" style={{ color: 'var(--text-dim)' }}>
            TCP tunnel connection history — auto-refreshes every 10s
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setFilter('active')}
            style={{ ...btnStyle, color: filter === 'active' ? 'var(--amber)' : 'var(--text-mid)', borderColor: filter === 'active' ? '#4a3000' : 'var(--border2)' }}
          >
            Active Only
          </button>
          <button
            onClick={() => setFilter('all')}
            style={{ ...btnStyle, color: filter === 'all' ? 'var(--green)' : 'var(--text-mid)', borderColor: filter === 'all' ? 'var(--green-dim)' : 'var(--border2)' }}
          >
            All
          </button>
          <button
            onClick={() => load(true)}
            style={btnStyle}
            onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--green-dim)'; e.currentTarget.style.color = 'var(--text)'; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border2)'; e.currentTarget.style.color = 'var(--text-mid)'; }}
          >
            <RefreshCw size={11} className={refreshing ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
        <div className="overflow-x-auto">
          <table className="w-full" style={{ borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                {['Client', 'From IP', 'Port', 'Connected', 'Disconnected', 'Status'].map(h => (
                  <th key={h} className="px-4 py-2.5 text-left text-[9px] uppercase tracking-[0.18em] font-normal whitespace-nowrap" style={{ color: 'var(--text-dim)' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sessions.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-[11px]" style={{ color: 'var(--text-dim)' }}>
                    No sessions found
                  </td>
                </tr>
              ) : sessions.map((s) => {
                const isLive = s.disconnected_at === null;
                return (
                  <tr
                    key={s.id}
                    style={{ borderBottom: '1px solid var(--border)' }}
                    onMouseEnter={e => e.currentTarget.style.background = 'var(--green-bg)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                  >
                    <td className="px-4 py-2.5">
                      <div className="text-[11.5px]" style={{ color: 'var(--text)' }}>
                        {s.token_label || (
                          <span style={{ color: 'var(--blue)' }}>
                            {(s.token || '').length > 12 ? s.token.slice(0, 12) + '…' : s.token || '–'}
                          </span>
                        )}
                      </div>
                      {s.token_label && s.token && (
                        <div className="text-[10px] mt-0.5" style={{ color: 'var(--text-dim)' }}>
                          {s.token.length > 12 ? s.token.slice(0, 12) + '…' : s.token}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-[11.5px] whitespace-nowrap" style={{ color: 'var(--text-mid)' }}>
                      {s.client_ip || '–'}
                    </td>
                    <td className="px-4 py-2.5 text-[11.5px] whitespace-nowrap" style={{ color: 'var(--text-mid)' }}>
                      {s.target_port ? `:${s.target_port}` : '–'}
                    </td>
                    <td className="px-4 py-2.5 text-[10.5px] whitespace-nowrap" style={{ color: 'var(--text-dim)' }}>
                      {formatTimestamp(s.connected_at)}
                    </td>
                    <td className="px-4 py-2.5 text-[10.5px] whitespace-nowrap" style={{ color: 'var(--text-dim)' }}>
                      {s.disconnected_at ? formatTimestamp(s.disconnected_at) : <span style={{ color: 'var(--text-dim)' }}>still running</span>}
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      {isLive ? (
                        <span className="border px-2 py-0.5 text-[9.5px]" style={{ color: 'var(--amber)', borderColor: '#4a3000', background: 'rgba(240,165,0,0.07)' }}>
                          ● live · {formatDuration(s.connected_at)}
                        </span>
                      ) : (
                        <span className="border px-2 py-0.5 text-[9.5px]" style={{ color: 'var(--text-dim)', borderColor: 'var(--border2)' }}>
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
    </div>
  );
}

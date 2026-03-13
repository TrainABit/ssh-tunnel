import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { RefreshCw, Download, Search } from 'lucide-react';
import { getSessions } from '../services/api';

function formatTimestamp(ts) {
  if (!ts || typeof ts !== 'string') return '–';
  const d = new Date(ts.endsWith('Z') ? ts : ts + 'Z');
  return d.toLocaleString('en-US', { month: 'short', day: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function formatDuration(start, end) {
  if (!start || typeof start !== 'string') return '–';
  const s = new Date(start.endsWith('Z') ? start : start + 'Z');
  const e = end ? new Date(end.endsWith('Z') ? end : end + 'Z') : new Date();
  const sec = Math.floor((e - s) / 1000);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

const PAGE_SIZE = 50;

const btnBase = {
  display: 'inline-flex', alignItems: 'center', gap: '6px',
  padding: '7px 14px', fontFamily: 'inherit', fontSize: '12px',
  fontWeight: 500, borderRadius: '8px', border: '1px solid var(--border)',
  color: 'var(--text-mid)', background: 'transparent', cursor: 'pointer', transition: 'all .15s',
};

function exportCsv(sessions) {
  const cols = ['id', 'token', 'token_label', 'client_ip', 'target_port', 'connected_at', 'disconnected_at'];
  const rows = sessions.map(s =>
    cols.map(k => {
      const v = s[k] ?? '';
      const safe = String(v).replace(/^[=+\-@\t\r]/, "'$&");
      return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
    }).join(',')
  );
  const csv = [cols.join(','), ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `tunnelvault-sessions-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function Sessions() {
  const [sessions, setSessions] = useState([]);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [dateRange, setDateRange] = useState('all');
  const [page, setPage] = useState(0);
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
    setPage(0);
    load(false);
    intervalRef.current = setInterval(() => load(false), 10000);
    return () => clearInterval(intervalRef.current);
  }, [load]);

  useEffect(() => { setPage(0); }, [search, dateRange, filter]);

  const filtered = useMemo(() => {
    let result = sessions;
    if (dateRange !== 'all') {
      const cutoff = Date.now() - (dateRange === '24h' ? 86400000 : 7 * 86400000);
      result = result.filter(s => {
        const t = s.connected_at ? new Date(s.connected_at.endsWith('Z') ? s.connected_at : s.connected_at + 'Z').getTime() : 0;
        return t >= cutoff;
      });
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      result = result.filter(s =>
        (s.client_ip || '').toLowerCase().includes(q) ||
        (s.token || '').toLowerCase().includes(q) ||
        (s.token_label || '').toLowerCase().includes(q)
      );
    }
    return result;
  }, [sessions, search, dateRange]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageSessions = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

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
          <h1 className="text-xl font-semibold" style={{ color: 'var(--text)' }}>Sessions</h1>
          <p className="mt-1 text-sm" style={{ color: 'var(--text-dim)' }}>
            TCP tunnel connection history · auto-refreshes every 10s
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Date range */}
          {['all', '7d', '24h'].map(d => (
            <button key={d} onClick={() => setDateRange(d)}
              style={{ ...btnBase, color: dateRange === d ? 'var(--accent)' : 'var(--text-mid)', borderColor: dateRange === d ? 'var(--accent-dim)' : 'var(--border)', background: dateRange === d ? 'var(--accent-bg)' : 'transparent' }}>
              {d === 'all' ? 'All time' : d === '7d' ? 'Last 7d' : 'Last 24h'}
            </button>
          ))}
          {/* Active filter */}
          <button onClick={() => setFilter(f => f === 'active' ? 'all' : 'active')}
            style={{ ...btnBase, color: filter === 'active' ? 'var(--amber)' : 'var(--text-mid)', borderColor: filter === 'active' ? 'rgba(240,165,0,0.4)' : 'var(--border)', background: filter === 'active' ? 'rgba(240,165,0,0.08)' : 'transparent' }}>
            Active only
          </button>
          {/* CSV export */}
          <button onClick={() => exportCsv(filtered)} title="Export as CSV" style={btnBase}
            onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--accent-dim)'; e.currentTarget.style.color = 'var(--text)'; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-mid)'; }}>
            <Download size={13} /> CSV
          </button>
          {/* Refresh */}
          <button onClick={() => load(true)} style={btnBase}
            onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--accent-dim)'; e.currentTarget.style.color = 'var(--text)'; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-mid)'; }}>
            <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* Search bar */}
      <div className="relative">
        <Search size={14} style={{ position: 'absolute', left: '14px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-dim)', pointerEvents: 'none' }} />
        <input
          type="text"
          placeholder="Search by IP, token, or label…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{
            width: '100%', background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: '8px', color: 'var(--text)', padding: '9px 14px 9px 38px',
            fontFamily: 'inherit', fontSize: '13px', outline: 'none', boxSizing: 'border-box',
          }}
          onFocus={e => e.target.style.borderColor = 'var(--accent)'}
          onBlur={e => e.target.style.borderColor = 'var(--border)'}
        />
      </div>

      {/* Count line */}
      <div className="text-sm" style={{ color: 'var(--text-dim)' }}>
        {filtered.length} session{filtered.length !== 1 ? 's' : ''}
        {(search || dateRange !== 'all' || filter !== 'all') ? ' (filtered)' : ''}
        {totalPages > 1 && ` · page ${page + 1} of ${totalPages}`}
      </div>

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
                {['Client', 'From IP', 'Port', 'Connected', 'Duration', 'Status'].map(h => (
                  <th key={h} className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide whitespace-nowrap" style={{ color: 'var(--text-dim)' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pageSessions.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-5 py-14 text-center text-sm" style={{ color: 'var(--text-dim)' }}>
                    No sessions found
                  </td>
                </tr>
              ) : pageSessions.map((s) => {
                const isLive = s.disconnected_at === null;
                return (
                  <tr
                    key={s.id}
                    style={{ borderBottom: '1px solid var(--border)' }}
                    onMouseEnter={e => e.currentTarget.style.background = 'var(--accent-bg)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                  >
                    <td className="px-5 py-3">
                      <div className="text-sm font-medium" style={{ color: 'var(--text)' }}>
                        {s.token_label || (
                          <span style={{ color: 'var(--blue)', fontFamily: 'var(--font-mono)', fontSize: '12px' }}>
                            {(s.token || '').length > 12 ? s.token.slice(0, 12) + '…' : s.token || '–'}
                          </span>
                        )}
                      </div>
                      {s.token_label && s.token && (
                        <div className="text-xs mt-0.5" style={{ color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>
                          {s.token.length > 12 ? s.token.slice(0, 12) + '…' : s.token}
                        </div>
                      )}
                    </td>
                    <td className="px-5 py-3 text-sm whitespace-nowrap" style={{ color: 'var(--text-mid)', fontFamily: 'var(--font-mono)' }}>
                      {s.client_ip || '–'}
                    </td>
                    <td className="px-5 py-3 text-sm whitespace-nowrap" style={{ color: 'var(--text-mid)', fontFamily: 'var(--font-mono)' }}>
                      {s.target_port ? `:${s.target_port}` : '–'}
                    </td>
                    <td className="px-5 py-3 text-xs whitespace-nowrap" style={{ color: 'var(--text-dim)' }}>
                      {formatTimestamp(s.connected_at)}
                    </td>
                    <td className="px-5 py-3 text-xs whitespace-nowrap" style={{ color: 'var(--text-dim)' }}>
                      {formatDuration(s.connected_at, s.disconnected_at)}
                    </td>
                    <td className="px-5 py-3 whitespace-nowrap">
                      {isLive ? (
                        <span style={{
                          display: 'inline-flex', alignItems: 'center', gap: '5px',
                          fontSize: '11px', fontWeight: 500, padding: '2px 10px', borderRadius: '9999px',
                          color: 'var(--amber)', background: 'rgba(240,165,0,0.1)',
                        }}>
                          <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'var(--amber)', display: 'inline-block' }} />
                          live
                        </span>
                      ) : (
                        <span style={{
                          display: 'inline-flex', alignItems: 'center', fontSize: '11px',
                          padding: '2px 10px', borderRadius: '9999px',
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

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-5 py-3" style={{ borderTop: '1px solid var(--border)' }}>
            <button
              onClick={() => setPage(p => Math.max(0, p - 1))}
              disabled={page === 0}
              style={{ ...btnBase, opacity: page === 0 ? 0.35 : 1, cursor: page === 0 ? 'default' : 'pointer' }}
            >
              ← Prev
            </button>
            <span className="text-sm" style={{ color: 'var(--text-dim)' }}>
              {page + 1} / {totalPages}
            </span>
            <button
              onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
              style={{ ...btnBase, opacity: page >= totalPages - 1 ? 0.35 : 1, cursor: page >= totalPages - 1 ? 'default' : 'pointer' }}
            >
              Next →
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

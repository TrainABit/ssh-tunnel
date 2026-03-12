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

const btnStyle = {
  borderColor: 'var(--border2)', color: 'var(--text-mid)', background: 'transparent',
  border: '1px solid', cursor: 'pointer', padding: '5px 12px', fontFamily: 'inherit',
  fontSize: '10px', letterSpacing: '.09em', textTransform: 'uppercase',
  display: 'inline-flex', alignItems: 'center', gap: '6px', transition: 'all .15s',
};

function exportCsv(sessions) {
  const cols = ['id', 'token', 'token_label', 'client_ip', 'target_port', 'connected_at', 'disconnected_at'];
  const rows = sessions.map(s =>
    cols.map(k => {
      const v = s[k] ?? '';
      // Sanitize: prevent formula injection, quote fields with commas/newlines
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

  // Reset page when filters change
  useEffect(() => { setPage(0); }, [search, dateRange, filter]);

  const filtered = useMemo(() => {
    let result = sessions;

    // Date range filter
    if (dateRange !== 'all') {
      const cutoff = Date.now() - (dateRange === '24h' ? 86400000 : 7 * 86400000);
      result = result.filter(s => {
        const t = s.connected_at ? new Date(s.connected_at.endsWith('Z') ? s.connected_at : s.connected_at + 'Z').getTime() : 0;
        return t >= cutoff;
      });
    }

    // Search filter (IP, token, label)
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
        <div className="flex items-center gap-2 flex-wrap">
          {/* Date range */}
          {['all', '7d', '24h'].map(d => (
            <button key={d} onClick={() => setDateRange(d)}
              style={{ ...btnStyle, color: dateRange === d ? 'var(--green)' : 'var(--text-mid)', borderColor: dateRange === d ? 'var(--green-dim)' : 'var(--border2)' }}>
              {d === 'all' ? 'All time' : d === '7d' ? 'Last 7d' : 'Last 24h'}
            </button>
          ))}
          {/* Active filter */}
          <button onClick={() => setFilter(f => f === 'active' ? 'all' : 'active')}
            style={{ ...btnStyle, color: filter === 'active' ? 'var(--amber)' : 'var(--text-mid)', borderColor: filter === 'active' ? '#4a3000' : 'var(--border2)' }}>
            Active only
          </button>
          {/* CSV export */}
          <button onClick={() => exportCsv(filtered)}
            title="Export filtered results as CSV"
            style={btnStyle}
            onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--green-dim)'; e.currentTarget.style.color = 'var(--text)'; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border2)'; e.currentTarget.style.color = 'var(--text-mid)'; }}>
            <Download size={11} /> CSV
          </button>
          {/* Refresh */}
          <button onClick={() => load(true)} style={btnStyle}
            onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--green-dim)'; e.currentTarget.style.color = 'var(--text)'; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border2)'; e.currentTarget.style.color = 'var(--text-mid)'; }}>
            <RefreshCw size={11} className={refreshing ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* Search bar */}
      <div className="relative">
        <Search size={12} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-dim)', pointerEvents: 'none' }} />
        <input
          type="text"
          placeholder="Search by IP, token, or label…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{
            width: '100%', background: 'var(--surface)', border: '1px solid var(--border)',
            color: 'var(--text)', padding: '7px 12px 7px 32px', fontFamily: 'inherit',
            fontSize: '11px', outline: 'none', boxSizing: 'border-box',
          }}
        />
      </div>

      {/* Count line */}
      <div className="text-[10.5px]" style={{ color: 'var(--text-dim)' }}>
        {filtered.length} session{filtered.length !== 1 ? 's' : ''}
        {(search || dateRange !== 'all' || filter !== 'all') ? ' (filtered)' : ''}
        {totalPages > 1 && ` — page ${page + 1} of ${totalPages}`}
      </div>

      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
        <div className="overflow-x-auto">
          <table className="w-full" style={{ borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                {['Client', 'From IP', 'Port', 'Connected', 'Duration', 'Status'].map(h => (
                  <th key={h} className="px-4 py-2.5 text-left text-[9px] uppercase tracking-[0.18em] font-normal whitespace-nowrap" style={{ color: 'var(--text-dim)' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pageSessions.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-[11px]" style={{ color: 'var(--text-dim)' }}>
                    No sessions found
                  </td>
                </tr>
              ) : pageSessions.map((s) => {
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
                      {formatDuration(s.connected_at, s.disconnected_at)}
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      {isLive ? (
                        <span className="border px-2 py-0.5 text-[9.5px]" style={{ color: 'var(--amber)', borderColor: '#4a3000', background: 'rgba(240,165,0,0.07)' }}>
                          ● live
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

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-2.5" style={{ borderTop: '1px solid var(--border)' }}>
            <button
              onClick={() => setPage(p => Math.max(0, p - 1))}
              disabled={page === 0}
              style={{ ...btnStyle, opacity: page === 0 ? 0.3 : 1, cursor: page === 0 ? 'default' : 'pointer' }}
            >
              ← Prev
            </button>
            <span className="text-[10.5px]" style={{ color: 'var(--text-dim)' }}>
              {page + 1} / {totalPages}
            </span>
            <button
              onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
              style={{ ...btnStyle, opacity: page >= totalPages - 1 ? 0.3 : 1, cursor: page >= totalPages - 1 ? 'default' : 'pointer' }}
            >
              Next →
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

import { useEffect, useState, useCallback, useRef } from 'react';
import { Radio, RefreshCw, Filter } from 'lucide-react';
import { getSessions } from '../services/api';

function formatTimestamp(ts) {
  if (!ts || typeof ts !== 'string') return '\u2013';
  const d = new Date(ts.endsWith('Z') ? ts : ts + 'Z');
  return d.toLocaleString('en-US', {
    month: 'short',
    day: '2-digit',
    year: '2-digit',
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

export default function Sessions() {
  const [sessions, setSessions] = useState([]);
  const [filter, setFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const intervalRef = useRef(null);

  const load = useCallback(
    async (showSpinner) => {
      if (showSpinner) setRefreshing(true);
      const data = await getSessions(filter === 'active');
      setSessions(data);
      setLoading(false);
      if (showSpinner) setTimeout(() => setRefreshing(false), 300);
    },
    [filter]
  );

  useEffect(() => {
    load(false);
    intervalRef.current = setInterval(() => load(false), 10000);
    return () => clearInterval(intervalRef.current);
  }, [load]);

  if (loading) {
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
          <h1 className="text-2xl font-bold text-white">SSH Sessions</h1>
          <p className="text-sm text-gray-400">
            Connection history and live sessions{' '}
            <span className="text-gray-600">(auto-refreshes every 10s)</span>
          </p>
        </div>
        <button
          onClick={() => load(true)}
          className="inline-flex items-center gap-2 rounded-lg border border-gray-700 bg-gray-800/50 px-4 py-2.5 text-sm text-gray-300 transition-colors hover:border-gray-600 hover:text-white"
        >
          <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {/* Filter */}
      <div className="flex items-center gap-3">
        <Filter size={14} className="text-gray-500" />
        <div className="flex gap-2">
          <button
            onClick={() => setFilter('all')}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
              filter === 'all'
                ? 'bg-emerald-500/10 text-emerald-400'
                : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
            }`}
          >
            All
          </button>
          <button
            onClick={() => setFilter('active')}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
              filter === 'active'
                ? 'bg-amber-500/10 text-amber-400'
                : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
            }`}
          >
            Active Only
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-xl border border-gray-800/60 bg-gray-900 ">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-800/60">
                <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                  Token / Label
                </th>
                <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                  Client IP
                </th>
                <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                  Target
                </th>
                <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                  Connected At
                </th>
                <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                  Disconnected At
                </th>
                <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                  Status
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/40">
              {sessions.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-5 py-12 text-center">
                    <Radio size={32} className="mx-auto mb-2 text-gray-600" />
                    <p className="text-sm text-gray-500">No sessions found</p>
                  </td>
                </tr>
              ) : (
                sessions.map((s) => {
                  const isLive = s.disconnected_at === null;
                  return (
                    <tr
                      key={s.id}
                      className="transition-colors hover:bg-gray-800/30"
                    >
                      <td className="whitespace-nowrap px-5 py-3.5">
                        <div>
                          <span className="font-mono text-sm text-[#38b6ff]">
                            {(s.token || '').length > 12 ? s.token.slice(0, 12) + '\u2026' : (s.token || '\u2013')}
                          </span>
                          {s.token_label && (
                            <p className="text-xs text-gray-500">{s.token_label}</p>
                          )}
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-5 py-3.5 font-mono text-sm text-gray-300">
                        {s.client_ip || '\u2013'}
                      </td>
                      <td className="whitespace-nowrap px-5 py-3.5 font-mono text-sm text-gray-400">
                        {s.target_ip}:{s.target_port}
                      </td>
                      <td className="whitespace-nowrap px-5 py-3.5 text-sm text-gray-400">
                        {formatTimestamp(s.connected_at)}
                      </td>
                      <td className="whitespace-nowrap px-5 py-3.5 text-sm text-gray-400">
                        {s.disconnected_at
                          ? formatTimestamp(s.disconnected_at)
                          : <span className="text-gray-600">still running</span>}
                      </td>
                      <td className="whitespace-nowrap px-5 py-3.5">
                        {isLive ? (
                          <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 px-2.5 py-0.5 text-xs font-medium text-amber-400">
                            <span className="h-1.5 w-1.5 rounded-full bg-amber-500 pulse-amber" />
                            live &middot; {formatDuration(s.connected_at)}
                          </span>
                        ) : (
                          <span className="inline-block rounded-full bg-gray-700/30 px-2.5 py-0.5 text-xs font-medium text-gray-500">
                            ended
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

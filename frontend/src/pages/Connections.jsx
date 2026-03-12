import { useEffect, useState, useCallback, useRef } from 'react';
import { Network, RefreshCw, Filter } from 'lucide-react';
import { getConnections, getTunnels } from '../services/api';

function formatDuration(startTime) {
  if (!startTime) return '--';
  const start = new Date(startTime.endsWith?.('Z') ? startTime : startTime + 'Z');
  const now = new Date();
  const sec = Math.floor((now - start) / 1000);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h ${m}m`;
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
    const [connData, tunnelData] = await Promise.all([
      getConnections(),
      getTunnels(),
    ]);
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

  const filtered =
    filter === 'all'
      ? connections
      : connections.filter((c) => c.tunnelId === filter);

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
          <h1 className="text-2xl font-bold text-white">Connections</h1>
          <p className="text-sm text-gray-400">
            Active connections across your tunnels{' '}
            <span className="text-gray-600">(auto-refreshes every 5s)</span>
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
        <div className="flex flex-wrap gap-2">
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
          {tunnels
            .filter((t) => t.status === 'active')
            .map((t) => (
              <button
                key={t.id}
                onClick={() => setFilter(t.id)}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                  filter === t.id
                    ? 'bg-emerald-500/10 text-emerald-400'
                    : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
                }`}
              >
                {t.name}
              </button>
            ))}
        </div>
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-xl border border-gray-800/60 bg-gray-900 ">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-800/60">
                <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                  Source IP
                </th>
                <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                  Tunnel
                </th>
                <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                  Duration
                </th>
                <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                  Bytes Transferred
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/40">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-5 py-12 text-center">
                    <Network size={32} className="mx-auto mb-2 text-gray-600" />
                    <p className="text-sm text-gray-500">No active connections</p>
                  </td>
                </tr>
              ) : (
                filtered.map((conn) => (
                  <tr
                    key={conn.connectionId}
                    className="transition-colors hover:bg-gray-800/30"
                  >
                    <td className="whitespace-nowrap px-5 py-3.5 font-mono text-sm text-gray-200">
                      {conn.sourceIp}
                    </td>
                    <td className="whitespace-nowrap px-5 py-3.5">
                      <span className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500/10 px-2 py-0.5 font-mono text-xs text-emerald-400">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                        {tunnelNameMap[conn.tunnelId] || conn.tunnelId}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-5 py-3.5 font-mono text-sm text-gray-400">
                      {formatDuration(conn.startTime)}
                    </td>
                    <td className="whitespace-nowrap px-5 py-3.5 font-mono text-sm text-gray-400">
                      {formatBytes((conn.bytesIn || 0) + (conn.bytesOut || 0))}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

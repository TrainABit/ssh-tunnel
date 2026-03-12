import { useEffect, useState, useCallback, useRef } from 'react';
import {
  Plus,
  Copy,
  Trash2,
  Power,
  X,
  Check,
  Globe,
  ArrowRight,
  RefreshCw,
} from 'lucide-react';
import { getTunnels, createTunnel, deleteTunnel, toggleTunnel } from '../services/api';

function CreateModal({ onClose, onCreate }) {
  const [form, setForm] = useState({ name: '', localPort: '', subdomain: '' });
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.name || !form.localPort) return;
    setSubmitting(true);
    await onCreate({ ...form, localPort: Number(form.localPort) });
    setSubmitting(false);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 " onClick={onClose} />
      <div className="relative w-full max-w-md rounded-2xl border border-gray-700/60 bg-[#0f0f18] p-6 shadow-2xl">
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-lg font-bold text-white">Create New Tunnel</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white">
            <X size={20} />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1.5 block text-sm text-gray-400">Tunnel Name</label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="my-service"
              className="w-full rounded-lg border border-gray-700 bg-gray-800/60 px-3 py-2.5 font-mono text-sm text-white placeholder-gray-500 outline-none transition-colors focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/20"
              required
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm text-gray-400">Local Port</label>
            <input
              type="number"
              value={form.localPort}
              onChange={(e) => setForm({ ...form, localPort: e.target.value })}
              placeholder="3000"
              className="w-full rounded-lg border border-gray-700 bg-gray-800/60 px-3 py-2.5 font-mono text-sm text-white placeholder-gray-500 outline-none transition-colors focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/20"
              required
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm text-gray-400">
              Subdomain <span className="text-gray-600">(optional)</span>
            </label>
            <input
              type="text"
              value={form.subdomain}
              onChange={(e) => setForm({ ...form, subdomain: e.target.value })}
              placeholder="custom-name"
              className="w-full rounded-lg border border-gray-700 bg-gray-800/60 px-3 py-2.5 font-mono text-sm text-white placeholder-gray-500 outline-none transition-colors focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/20"
            />
          </div>
          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-lg bg-emerald-600 py-2.5 text-sm font-medium text-white shadow-lg shadow-emerald-500/20 transition-all hover:bg-emerald-500 disabled:opacity-50"
          >
            {submitting ? 'Creating...' : 'Create Tunnel'}
          </button>
        </form>
      </div>
    </div>
  );
}

function TunnelCard({ tunnel, onDelete, onToggle, onCopy }) {
  const isActive = tunnel.status === 'active';

  return (
    <div className="group relative overflow-hidden rounded-xl border border-gray-800/60 bg-gray-900 p-5  transition-all duration-300 hover:border-gray-700/80 hover:bg-gray-900">
      <div className="absolute inset-0 bg-gradient-to-br from-emerald-500/[0.02] to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
      <div className="relative">
        {/* Header */}
        <div className="mb-4 flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div
              className={`h-2.5 w-2.5 rounded-full ${
                isActive ? 'bg-emerald-500 pulse-dot' : 'bg-red-500/80'
              }`}
            />
            <h3 className="font-semibold text-white">{tunnel.name}</h3>
          </div>
          <span
            className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
              isActive
                ? 'bg-emerald-500/10 text-emerald-400'
                : 'bg-red-500/10 text-red-400'
            }`}
          >
            {tunnel.status}
          </span>
        </div>

        {/* URL mapping */}
        {tunnel.protocol === 'tcp' ? (
          <div className="mb-4 space-y-2">
            <div className="flex items-center gap-2 rounded-lg bg-gray-800/50 px-3 py-2">
              <span className="font-mono text-xs text-emerald-400">SSH port {tunnel.allocatedPort ?? '—'}</span>
              <ArrowRight size={12} className="shrink-0 text-gray-500" />
              <span className="font-mono text-xs text-gray-400">localhost:{tunnel.localPort}</span>
            </div>
            {tunnel.allocatedPort && (
              <div className="rounded-lg bg-gray-800/30 px-3 py-2 font-mono text-xs text-gray-400">
                ssh user@{window.location.hostname} -p {tunnel.allocatedPort}
              </div>
            )}
          </div>
        ) : (
          <div className="mb-4 flex items-center gap-2 rounded-lg bg-gray-800/50 px-3 py-2">
            <span className="truncate font-mono text-xs text-emerald-400">{tunnel.publicUrl}</span>
            <ArrowRight size={12} className="shrink-0 text-gray-500" />
            <span className="truncate font-mono text-xs text-gray-400">localhost:{tunnel.localPort}</span>
          </div>
        )}

        {/* Stats */}
        <div className="mb-4 grid grid-cols-2 gap-3">
          <div>
            <p className="text-xs text-gray-500">Connections</p>
            <p className="font-mono text-sm text-gray-200">{tunnel.connections}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500">Data Transferred</p>
            <p className="font-mono text-sm text-gray-200">{tunnel.bytesTransferred != null ? (tunnel.bytesTransferred > 1e9 ? (tunnel.bytesTransferred / 1e9).toFixed(2) + ' GB' : tunnel.bytesTransferred > 1e6 ? (tunnel.bytesTransferred / 1e6).toFixed(1) + ' MB' : tunnel.bytesTransferred > 1e3 ? (tunnel.bytesTransferred / 1e3).toFixed(0) + ' KB' : tunnel.bytesTransferred + ' B') : '0 B'}</p>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => onCopy(
              tunnel.protocol === 'tcp' && tunnel.allocatedPort
                ? `ssh user@${window.location.hostname} -p ${tunnel.allocatedPort}`
                : tunnel.publicUrl
            )}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-700 bg-gray-800/50 px-3 py-1.5 text-xs text-gray-300 transition-colors hover:border-gray-600 hover:text-white"
          >
            <Copy size={12} /> {tunnel.protocol === 'tcp' ? 'Copy SSH' : 'Copy URL'}
          </button>
          <button
            onClick={() => onToggle(tunnel.id)}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs transition-colors ${
              isActive
                ? 'border-amber-500/30 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20'
                : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20'
            }`}
          >
            <Power size={12} /> {isActive ? 'Stop' : 'Start'}
          </button>
          <button
            onClick={() => onDelete(tunnel.id)}
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-1.5 text-xs text-red-400 transition-colors hover:bg-red-500/15"
          >
            <Trash2 size={12} /> Delete
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Tunnels() {
  const [tunnels, setTunnels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [copied, setCopied] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const intervalRef = useRef(null);

  const load = useCallback(async (showSpinner) => {
    if (showSpinner) setRefreshing(true);
    const data = await getTunnels();
    setTunnels(data);
    setLoading(false);
    if (showSpinner) setTimeout(() => setRefreshing(false), 300);
  }, []);

  useEffect(() => {
    load(false);
    intervalRef.current = setInterval(() => load(false), 5000);
    return () => clearInterval(intervalRef.current);
  }, [load]);

  const handleCreate = async (form) => {
    await createTunnel(form);
    await load();
  };

  const handleDelete = async (id) => {
    await deleteTunnel(id);
    await load();
  };

  const handleToggle = async (id) => {
    await toggleTunnel(id);
    await load();
  };

  const handleCopy = (url) => {
    navigator.clipboard?.writeText(url);
    setCopied(url);
    setTimeout(() => setCopied(null), 2000);
  };

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Tunnels</h1>
          <p className="text-sm text-gray-400">
            Manage your SSH tunnel endpoints{' '}
            <span className="text-gray-600">(auto-refreshes every 5s)</span>
          </p>
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
            onClick={() => setShowModal(true)}
            className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white shadow-lg shadow-emerald-500/20 transition-all hover:bg-emerald-500 hover:shadow-emerald-500/30"
          >
            <Plus size={16} />
            Create Tunnel
          </button>
        </div>
      </div>

      {/* Copied toast */}
      {copied && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-gray-900/95 px-4 py-2.5 text-sm text-emerald-400 shadow-xl ">
          <Check size={14} /> Copied to clipboard
        </div>
      )}

      {tunnels.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-gray-700 py-16">
          <Globe size={40} className="mb-3 text-gray-600" />
          <p className="text-gray-400">No tunnels yet</p>
          <button
            onClick={() => setShowModal(true)}
            className="mt-4 text-sm text-emerald-400 hover:text-emerald-300"
          >
            Create your first tunnel
          </button>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {tunnels.map((tunnel) => (
            <TunnelCard
              key={tunnel.id}
              tunnel={tunnel}
              onDelete={handleDelete}
              onToggle={handleToggle}
              onCopy={handleCopy}
            />
          ))}
        </div>
      )}

      {showModal && (
        <CreateModal onClose={() => setShowModal(false)} onCreate={handleCreate} />
      )}
    </div>
  );
}

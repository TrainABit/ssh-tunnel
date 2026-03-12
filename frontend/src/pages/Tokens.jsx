import { useEffect, useState, useCallback, useRef } from 'react';
import {
  Plus,
  Copy,
  Trash2,
  Power,
  X,
  Check,
  Key,
  Search,
  Eye,
  Radio,
  RefreshCw,
} from 'lucide-react';
import {
  getTokens,
  createToken,
  getTokenDetail,
  updateToken,
  deleteToken,
} from '../services/api';

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

function formatDuration(start, end) {
  if (!start || typeof start !== 'string') return '\u2013';
  const s = new Date(start.endsWith('Z') ? start : start + 'Z');
  const e = end && typeof end === 'string' ? new Date(end.endsWith('Z') ? end : end + 'Z') : new Date();
  const sec = Math.floor((e - s) / 1000);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

function SshConfigBlock({ token, gatewayHost }) {
  const [copied, setCopied] = useState(false);
  const config = `Host my-server\n    HostName ${gatewayHost}\n    User gw-${token}\n    IdentityFile ~/.ssh/id_rsa`;

  const handleCopy = () => {
    navigator.clipboard?.writeText(config);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative rounded-lg border border-gray-700/60 bg-[#08080d] p-4 font-mono text-[13px] leading-relaxed">
      <button
        onClick={handleCopy}
        className="absolute top-2 right-2 rounded-md border border-gray-700 bg-gray-800/60 p-1.5 text-gray-400 transition-colors hover:border-gray-600 hover:text-white"
      >
        {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
      </button>
      <div>
        <span className="text-[#38b6ff]">Host</span>{'          '}
        <span className="text-emerald-400">my-server</span>
      </div>
      <div>
        {'    '}<span className="text-[#38b6ff]">HostName</span>{'  '}
        <span className="text-emerald-400">{gatewayHost}</span>
      </div>
      <div>
        {'    '}<span className="text-[#38b6ff]">User</span>{'      '}
        <span className="text-emerald-400">gw-{token}</span>
      </div>
      <div>
        {'    '}<span className="text-[#38b6ff]">IdentityFile</span>{' '}
        <span className="text-emerald-400">~/.ssh/id_rsa</span>
      </div>
    </div>
  );
}

function CreateModal({ onClose, onCreate }) {
  const [form, setForm] = useState({
    token: '',
    label: '',
    target_ip: '',
    target_port: '22',
    public_key: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.target_ip || !form.public_key) return;
    setSubmitting(true);
    const created = await onCreate({
      ...form,
      target_port: Number(form.target_port),
    });
    setResult(created);
    setSubmitting(false);
  };

  const gatewayHost = window.location.hostname || 'gateway-ip';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 " onClick={onClose} />
      <div className="relative w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl border border-gray-700/60 bg-[#0f0f18] p-6 shadow-2xl">
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-lg font-bold text-white">
            {result ? 'Token Created' : 'Create New Token'}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white">
            <X size={20} />
          </button>
        </div>

        {result ? (
          <div className="space-y-4">
            <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
              <div className="flex items-center gap-2 text-sm text-emerald-400">
                <Check size={16} />
                Token <span className="font-mono text-[#38b6ff]">{result.token}</span> created successfully
              </div>
            </div>
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
                SSH Config for Client
              </p>
              <SshConfigBlock token={result.token} gatewayHost={gatewayHost} />
            </div>
            <button
              onClick={onClose}
              className="w-full rounded-lg border border-gray-700 bg-gray-800/50 py-2.5 text-sm text-gray-300 transition-colors hover:border-gray-600 hover:text-white"
            >
              Close
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="mb-1.5 block text-sm text-gray-400">
                Token <span className="text-gray-600">(optional)</span>
              </label>
              <input
                type="text"
                value={form.token}
                onChange={(e) => setForm({ ...form, token: e.target.value })}
                placeholder="auto-generated if empty"
                className="w-full rounded-lg border border-gray-700 bg-gray-800/60 px-3 py-2.5 font-mono text-sm text-white placeholder-gray-500 outline-none transition-colors focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/20"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-sm text-gray-400">Label</label>
              <input
                type="text"
                value={form.label}
                onChange={(e) => setForm({ ...form, label: e.target.value })}
                placeholder="Dev Server - Berlin"
                className="w-full rounded-lg border border-gray-700 bg-gray-800/60 px-3 py-2.5 font-mono text-sm text-white placeholder-gray-500 outline-none transition-colors focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/20"
              />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">
                <label className="mb-1.5 block text-sm text-gray-400">
                  Target IP <span className="text-red-400">*</span>
                </label>
                <input
                  type="text"
                  value={form.target_ip}
                  onChange={(e) => setForm({ ...form, target_ip: e.target.value })}
                  placeholder="10.0.1.42"
                  className="w-full rounded-lg border border-gray-700 bg-gray-800/60 px-3 py-2.5 font-mono text-sm text-white placeholder-gray-500 outline-none transition-colors focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/20"
                  required
                />
              </div>
              <div>
                <label className="mb-1.5 block text-sm text-gray-400">Port</label>
                <input
                  type="number"
                  value={form.target_port}
                  onChange={(e) => setForm({ ...form, target_port: e.target.value })}
                  className="w-full rounded-lg border border-gray-700 bg-gray-800/60 px-3 py-2.5 font-mono text-sm text-white placeholder-gray-500 outline-none transition-colors focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/20"
                />
              </div>
            </div>
            <div>
              <label className="mb-1.5 block text-sm text-gray-400">
                SSH Public Key <span className="text-red-400">*</span>
              </label>
              <textarea
                value={form.public_key}
                onChange={(e) => setForm({ ...form, public_key: e.target.value })}
                placeholder="ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAB... user@host"
                rows={4}
                className="w-full resize-y rounded-lg border border-gray-700 bg-gray-800/60 px-3 py-2.5 font-mono text-sm text-white placeholder-gray-500 outline-none transition-colors focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/20"
                required
              />
              <p className="mt-1 text-xs text-gray-600">
                Output of: <code className="text-[#38b6ff]">cat ~/.ssh/id_rsa.pub</code>
              </p>
            </div>
            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-lg bg-emerald-600 py-2.5 text-sm font-medium text-white shadow-lg shadow-emerald-500/20 transition-all hover:bg-emerald-500 disabled:opacity-50"
            >
              {submitting ? 'Creating...' : 'Create Token'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

function DetailModal({ token, onClose, onToggle, onDelete }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    getTokenDetail(token).then((d) => {
      setDetail(d);
      setLoading(false);
    });
  }, [token]);

  const gatewayHost = window.location.hostname || 'gateway-ip';

  if (loading || !detail) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="absolute inset-0 bg-black/70 " onClick={onClose} />
        <div className="relative rounded-2xl border border-gray-700/60 bg-[#0f0f18] p-8 shadow-2xl">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 " onClick={onClose} />
      <div className="relative w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-2xl border border-gray-700/60 bg-[#0f0f18] p-6 shadow-2xl">
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-lg font-bold text-white">Token Details</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white">
            <X size={20} />
          </button>
        </div>

        {/* Detail grid */}
        <div className="mb-5 grid grid-cols-2 gap-3">
          <div className="rounded-lg border border-gray-800/60 bg-gray-900 p-3">
            <p className="text-[9px] font-semibold uppercase tracking-widest text-gray-600">Token</p>
            <p className="mt-1 break-all font-mono text-sm text-[#38b6ff]">{detail.token}</p>
          </div>
          <div className="rounded-lg border border-gray-800/60 bg-gray-900 p-3">
            <p className="text-[9px] font-semibold uppercase tracking-widest text-gray-600">Linux User</p>
            <p className="mt-1 font-mono text-sm text-[#38b6ff]">{detail.linux_user}</p>
          </div>
          <div className="rounded-lg border border-gray-800/60 bg-gray-900 p-3">
            <p className="text-[9px] font-semibold uppercase tracking-widest text-gray-600">Label</p>
            <p className="mt-1 text-sm text-gray-200">{detail.label || '\u2013'}</p>
          </div>
          <div className="rounded-lg border border-gray-800/60 bg-gray-900 p-3">
            <p className="text-[9px] font-semibold uppercase tracking-widest text-gray-600">Status</p>
            <p className="mt-1">
              <span
                className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${
                  detail.active
                    ? 'bg-emerald-500/10 text-emerald-400'
                    : 'bg-gray-700/30 text-gray-500'
                }`}
              >
                {detail.active ? 'active' : 'inactive'}
              </span>
            </p>
          </div>
          <div className="rounded-lg border border-gray-800/60 bg-gray-900 p-3">
            <p className="text-[9px] font-semibold uppercase tracking-widest text-gray-600">Target</p>
            <p className="mt-1 font-mono text-sm text-[#38b6ff]">
              {detail.target_ip}:{detail.target_port}
            </p>
          </div>
          <div className="rounded-lg border border-gray-800/60 bg-gray-900 p-3">
            <p className="text-[9px] font-semibold uppercase tracking-widest text-gray-600">Last Seen</p>
            <p className="mt-1 text-sm text-gray-400">{formatTimestamp(detail.last_seen)}</p>
          </div>
        </div>

        {/* SSH Config */}
        <div className="mb-5">
          <p className="mb-2 text-[9px] font-semibold uppercase tracking-widest text-gray-600">
            ~/.ssh/config for Client
          </p>
          <SshConfigBlock token={detail.token} gatewayHost={gatewayHost} />
        </div>

        {/* Recent Sessions */}
        <div className="mb-5">
          <p className="mb-2 text-[9px] font-semibold uppercase tracking-widest text-gray-600">
            Recent Sessions ({detail.sessions?.length || 0})
          </p>
          <div className="overflow-hidden rounded-lg border border-gray-800/60 bg-gray-900">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-800/60">
                  <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                    Client IP
                  </th>
                  <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                    Connected
                  </th>
                  <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                    Disconnected
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/40">
                {detail.sessions && detail.sessions.length > 0 ? (
                  detail.sessions.map((s) => (
                    <tr key={s.id} className="transition-colors hover:bg-gray-800/30">
                      <td className="whitespace-nowrap px-4 py-2 font-mono text-xs text-gray-300">
                        {s.client_ip || '\u2013'}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2 text-xs text-gray-400">
                        {formatTimestamp(s.connected_at)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2 text-xs">
                        {s.disconnected_at ? (
                          <span className="text-gray-400">{formatTimestamp(s.disconnected_at)}</span>
                        ) : (
                          <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-amber-400">
                            <span className="h-1.5 w-1.5 rounded-full bg-amber-500 pulse-amber" />
                            live
                          </span>
                        )}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={3} className="px-4 py-6 text-center text-xs text-gray-600">
                      No sessions
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => {
              onToggle(detail.token, detail.active);
              onClose();
            }}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-4 py-2 text-xs font-medium transition-colors ${
              detail.active
                ? 'border-amber-500/30 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20'
                : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20'
            }`}
          >
            <Power size={12} />
            {detail.active ? 'Deactivate' : 'Activate'}
          </button>
          {confirmDelete ? (
            <div className="ml-auto flex items-center gap-2">
              <span className="text-xs text-red-400">Confirm delete?</span>
              <button
                onClick={() => {
                  onDelete(detail.token);
                  onClose();
                }}
                className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400 transition-colors hover:bg-red-500/20"
              >
                Yes, Delete
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                className="rounded-lg border border-gray-700 bg-gray-800/50 px-3 py-2 text-xs text-gray-400 transition-colors hover:text-white"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmDelete(true)}
              className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-2 text-xs text-red-400 transition-colors hover:bg-red-500/15"
            >
              <Trash2 size={12} />
              Delete Token
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function Tokens() {
  const [tokens, setTokens] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [detailToken, setDetailToken] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [copied, setCopied] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const intervalRef = useRef(null);

  const load = useCallback(async (showSpinner) => {
    if (showSpinner) setRefreshing(true);
    const data = await getTokens();
    setTokens(data);
    setLoading(false);
    if (showSpinner) setTimeout(() => setRefreshing(false), 300);
  }, []);

  useEffect(() => {
    load(false);
    intervalRef.current = setInterval(() => load(false), 15000);
    return () => clearInterval(intervalRef.current);
  }, [load]);

  const handleCreate = async (form) => {
    const result = await createToken(form);
    await load();
    return result;
  };

  const handleToggle = async (token, currentlyActive) => {
    await updateToken(token, { active: !currentlyActive });
    await load();
  };

  const handleDelete = async (token) => {
    await deleteToken(token);
    await load();
  };

  const handleCopyToken = (token) => {
    navigator.clipboard?.writeText(token);
    setCopied(token);
    setTimeout(() => setCopied(null), 2000);
  };

  const filtered = searchQuery
    ? tokens.filter(
        (t) =>
          (t.token + t.label + t.target_ip)
            .toLowerCase()
            .includes(searchQuery.toLowerCase())
      )
    : tokens;

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
          <h1 className="text-2xl font-bold text-white">Tokens</h1>
          <p className="text-sm text-gray-400">
            Manage SSH routing tokens{' '}
            <span className="text-gray-600">(auto-refreshes every 15s)</span>
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
            onClick={() => setShowCreate(true)}
            className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white shadow-lg shadow-emerald-500/20 transition-all hover:bg-emerald-500 hover:shadow-emerald-500/30"
          >
            <Plus size={16} />
            New Token
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="relative">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search tokens, labels, IPs..."
          className="w-full rounded-lg border border-gray-800/60 bg-gray-900 py-2.5 pl-9 pr-4 font-mono text-sm text-white placeholder-gray-600 outline-none transition-colors focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/20 sm:max-w-sm"
        />
      </div>

      {/* Copied toast */}
      {copied && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-gray-900/95 px-4 py-2.5 text-sm text-emerald-400 shadow-xl ">
          <Check size={14} /> Copied to clipboard
        </div>
      )}

      {/* Token Table */}
      <div className="overflow-hidden rounded-xl border border-gray-800/60 bg-gray-900 ">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-800/60">
                <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                  Token
                </th>
                <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                  Label
                </th>
                <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                  Target
                </th>
                <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                  Sessions
                </th>
                <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                  Last Seen
                </th>
                <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                  Status
                </th>
                <th className="px-5 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/40">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-5 py-12 text-center">
                    <Key size={32} className="mx-auto mb-2 text-gray-600" />
                    <p className="text-sm text-gray-500">
                      {searchQuery ? 'No matching tokens' : 'No tokens yet'}
                    </p>
                    {!searchQuery && (
                      <button
                        onClick={() => setShowCreate(true)}
                        className="mt-4 text-sm text-emerald-400 hover:text-emerald-300"
                      >
                        Create your first token
                      </button>
                    )}
                  </td>
                </tr>
              ) : (
                filtered.map((t) => (
                  <tr
                    key={t.token}
                    className="cursor-pointer transition-colors hover:bg-gray-800/30"
                    onClick={() => setDetailToken(t.token)}
                  >
                    <td className="whitespace-nowrap px-5 py-3.5">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm text-[#38b6ff]">
                          {t.token.length > 12 ? t.token.slice(0, 12) + '\u2026' : t.token}
                        </span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleCopyToken(t.token);
                          }}
                          className="text-gray-600 transition-colors hover:text-gray-300"
                        >
                          <Copy size={12} />
                        </button>
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-5 py-3.5 text-sm text-gray-300">
                      {t.label || <span className="text-gray-600">{'\u2013'}</span>}
                    </td>
                    <td className="whitespace-nowrap px-5 py-3.5 font-mono text-sm text-gray-400">
                      {t.target_ip}:{t.target_port}
                    </td>
                    <td className="whitespace-nowrap px-5 py-3.5">
                      <span className="inline-flex items-center gap-1.5 text-sm text-gray-400">
                        <Radio size={12} />
                        {t.session_count || 0}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-5 py-3.5 text-sm text-gray-500">
                      {formatTimestamp(t.last_seen)}
                    </td>
                    <td className="whitespace-nowrap px-5 py-3.5">
                      <span
                        className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${
                          t.active
                            ? 'bg-emerald-500/10 text-emerald-400'
                            : 'bg-gray-700/30 text-gray-500'
                        }`}
                      >
                        {t.active ? 'active' : 'inactive'}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-5 py-3.5 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleToggle(t.token, t.active);
                          }}
                          className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${
                            t.active
                              ? 'border-amber-500/30 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20'
                              : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20'
                          }`}
                        >
                          <Power size={11} />
                          {t.active ? 'Stop' : 'Start'}
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDelete(t.token);
                          }}
                          className="inline-flex items-center gap-1 rounded-lg border border-red-500/20 bg-red-500/5 px-2.5 py-1.5 text-xs text-red-400 transition-colors hover:bg-red-500/15"
                        >
                          <Trash2 size={11} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {showCreate && (
        <CreateModal
          onClose={() => setShowCreate(false)}
          onCreate={handleCreate}
        />
      )}

      {detailToken && (
        <DetailModal
          token={detailToken}
          onClose={() => setDetailToken(null)}
          onToggle={handleToggle}
          onDelete={handleDelete}
        />
      )}
    </div>
  );
}

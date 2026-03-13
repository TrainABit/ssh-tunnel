import { useEffect, useState, useCallback, useRef } from 'react';
import { Plus, Copy, Trash2, Power, Check, Search, RefreshCw } from 'lucide-react';
import { getTokens, createToken, getTokenDetail, updateToken, deleteToken } from '../services/api';
import { copyToClipboard } from '../utils/clipboard';

function formatTimestamp(ts) {
  if (!ts || typeof ts !== 'string') return '–';
  const d = new Date(ts.endsWith('Z') ? ts : ts + 'Z');
  return d.toLocaleString('en-US', { month: 'short', day: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

const btnBase = {
  display: 'inline-flex', alignItems: 'center', gap: '5px',
  padding: '7px 14px', fontFamily: 'inherit', fontSize: '12px',
  fontWeight: 500, borderRadius: '8px', border: '1px solid',
  cursor: 'pointer', transition: 'all .15s', background: 'transparent',
};

const btn = (variant = 'ghost') => ({
  ...btnBase,
  ...(variant === 'primary'
    ? { background: 'linear-gradient(90deg, #0632A0 0%, #1EB4E6 100%)', borderColor: 'transparent', color: '#ffffff', fontWeight: 600 }
    : variant === 'danger'
    ? { borderColor: 'rgba(200,32,32,0.3)', color: 'var(--red)' }
    : variant === 'amber'
    ? { borderColor: 'rgba(200,96,0,0.35)', color: 'var(--amber)' }
    : { borderColor: 'var(--border)', color: 'var(--text-mid)' }),
});

function InstallCommandBlock({ server, token }) {
  const [copied, setCopied] = useState(false);
  const cmd = `sudo bash install-client.sh --server ${server} --token ${token}`;

  return (
    <div style={{
      position: 'relative', background: 'var(--bg)', border: '1px solid var(--border)',
      borderRadius: '8px', padding: '12px 14px', fontFamily: 'var(--font-mono)',
      fontSize: '12px', wordBreak: 'break-all', lineHeight: 1.6,
    }}>
      <button
        onClick={() => { copyToClipboard(cmd); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
        style={{
          position: 'absolute', top: '8px', right: '8px', background: 'var(--surface)',
          border: '1px solid var(--border)', borderRadius: '6px', cursor: 'pointer',
          padding: '4px 8px', color: 'var(--text-dim)', display: 'flex', alignItems: 'center',
        }}
      >
        {copied ? <Check size={11} style={{ color: 'var(--accent)' }} /> : <Copy size={11} />}
      </button>
      <span style={{ color: 'var(--text-dim)' }}>$ </span>
      <span style={{ color: 'var(--accent)' }}>sudo bash install-client.sh</span>
      {' '}
      <span style={{ color: 'var(--blue)' }}>--server</span> <span style={{ color: 'var(--text)' }}>{server}</span>
      {' '}
      <span style={{ color: 'var(--blue)' }}>--token</span> <span style={{ color: 'var(--text)' }}>{token}</span>
    </div>
  );
}

function CreateModal({ onClose, onCreate }) {
  const [form, setForm] = useState({ token: '', label: '' });
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    const created = await onCreate({ token: form.token, label: form.label });
    setResult(created);
    setSubmitting(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.6)' }}>
      <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto" style={{
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: '12px', boxShadow: 'var(--shadow-md)',
      }}>
        <div className="flex items-center justify-between px-6 py-4" style={{ borderBottom: '1px solid var(--border)' }}>
          <span className="text-base font-semibold" style={{ color: 'var(--text)' }}>
            {result ? 'Token Created' : 'Create New Token'}
          </span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', fontSize: '20px', lineHeight: 1, padding: '0 4px' }}>×</button>
        </div>

        <div className="p-6">
          {result ? (
            <div className="space-y-4">
              <div className="flex items-center gap-2 px-4 py-3 text-sm" style={{
                borderRadius: '8px', borderLeft: '3px solid var(--accent)',
                background: 'var(--accent-bg)', color: 'var(--accent)',
              }}>
                <Check size={14} />
                Token <span style={{ fontFamily: 'var(--font-mono)', marginLeft: '4px' }}>{result.token}</span> created
              </div>
              <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-dim)' }}>Run on the client device</p>
                <InstallCommandBlock server={`ws://${window.location.hostname}:4000`} token={result.token} />
                <p className="mt-2 text-xs" style={{ color: 'var(--text-dim)' }}>Installs the client and starts it as a systemd service automatically.</p>
              </div>
              <button onClick={onClose} style={btn()}>Close</button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              {[
                { id: 'token', label: 'Token (optional)', placeholder: 'auto-generated if empty' },
                { id: 'label', label: 'Label', placeholder: 'e.g. Raspberry Pi Berlin' },
              ].map(f => (
                <div key={f.id}>
                  <label className="block text-xs font-semibold uppercase tracking-wide mb-1.5" style={{ color: 'var(--text-mid)' }}>{f.label}</label>
                  <input
                    type="text"
                    value={form[f.id]}
                    onChange={e => setForm({ ...form, [f.id]: e.target.value })}
                    placeholder={f.placeholder}
                    style={{
                      width: '100%', background: 'var(--bg)', border: '1px solid var(--border)',
                      borderRadius: '8px', color: 'var(--text)', fontFamily: 'inherit',
                      fontSize: '13px', padding: '9px 12px', outline: 'none', boxSizing: 'border-box',
                      transition: 'border-color .15s',
                    }}
                    onFocus={e => e.target.style.borderColor = 'var(--accent)'}
                    onBlur={e => e.target.style.borderColor = 'var(--border)'}
                  />
                </div>
              ))}
              <div className="flex justify-end gap-2 pt-1">
                <button type="button" onClick={onClose} style={btn()}>Cancel</button>
                <button type="submit" disabled={submitting} style={{ ...btn('primary'), opacity: submitting ? 0.6 : 1 }}>
                  {submitting ? 'Creating…' : 'Create Token'}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

function DetailModal({ token, onClose, onToggle, onDelete }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const gatewayHost = window.location.hostname;

  useEffect(() => {
    getTokenDetail(token).then(d => { setDetail(d); setLoading(false); });
  }, [token]);

  if (loading || !detail) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.6)' }}>
        <div style={{ width: '28px', height: '28px', borderRadius: '50%', border: '2px solid var(--accent)', borderTopColor: 'transparent', animation: 'spin 0.8s linear infinite' }} />
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.6)' }} onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto" style={{
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: '12px', boxShadow: 'var(--shadow-md)',
      }}>
        <div className="flex items-center justify-between px-6 py-4" style={{ borderBottom: '1px solid var(--border)' }}>
          <span className="text-base font-semibold" style={{ color: 'var(--text)' }}>Token Details</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', fontSize: '20px', lineHeight: 1, padding: '0 4px' }}>×</button>
        </div>

        <div className="p-6 space-y-5">
          {/* Detail grid */}
          <div className="grid grid-cols-2 gap-3">
            {[
              { label: 'Token', value: detail.token, mono: true, color: 'var(--blue)' },
              { label: 'Label', value: detail.label || '–' },
              { label: 'Status', value: detail.active ? 'active' : 'inactive', color: detail.active ? 'var(--accent)' : 'var(--text-dim)' },
              { label: 'Last Seen', value: formatTimestamp(detail.last_seen) },
              { label: 'Target', value: detail.target_ip ? `${detail.target_ip}:${detail.target_port}` : '–', mono: !!detail.target_ip },
              { label: 'Linux User', value: detail.linux_user, mono: true },
            ].map(({ label, value, mono, color }) => (
              <div key={label} style={{ background: 'var(--surface2)', borderRadius: '8px', padding: '12px' }}>
                <p className="text-xs font-semibold uppercase tracking-wide mb-1" style={{ color: 'var(--text-dim)' }}>{label}</p>
                <p className="text-sm break-all" style={{ color: color || 'var(--text)', fontFamily: mono ? 'var(--font-mono)' : 'inherit' }}>{value}</p>
              </div>
            ))}
          </div>

          {/* Install command */}
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-dim)' }}>Client Install Command</p>
            <InstallCommandBlock server={`ws://${gatewayHost}:4000`} token={detail.token} />
          </div>

          {/* Recent Sessions */}
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-dim)' }}>
              Recent Sessions ({detail.sessions?.length || 0})
            </p>
            <div style={{ border: '1px solid var(--border)', borderRadius: '8px', overflow: 'hidden' }}>
              <table className="w-full" style={{ borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--surface2)' }}>
                    {['From IP', 'Connected', 'Disconnected'].map(h => (
                      <th key={h} className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-dim)' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {detail.sessions?.length > 0 ? detail.sessions.map(s => (
                    <tr key={s.id} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td className="px-4 py-2.5 text-sm" style={{ color: 'var(--text-mid)', fontFamily: 'var(--font-mono)' }}>{s.client_ip || '–'}</td>
                      <td className="px-4 py-2.5 text-xs" style={{ color: 'var(--text-dim)' }}>{formatTimestamp(s.connected_at)}</td>
                      <td className="px-4 py-2.5 text-xs">
                        {s.disconnected_at ? (
                          <span style={{ color: 'var(--text-dim)' }}>{formatTimestamp(s.disconnected_at)}</span>
                        ) : (
                          <span style={{
                            display: 'inline-flex', alignItems: 'center', gap: '5px',
                            fontSize: '11px', fontWeight: 500, padding: '2px 10px', borderRadius: '9999px',
                            color: 'var(--amber)', background: 'rgba(240,165,0,0.1)',
                          }}>
                            <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'var(--amber)', display: 'inline-block' }} />
                            live
                          </span>
                        )}
                      </td>
                    </tr>
                  )) : (
                    <tr>
                      <td colSpan={3} className="px-4 py-6 text-center text-sm" style={{ color: 'var(--text-dim)' }}>No sessions</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => { onToggle(detail.token, detail.active); onClose(); }}
              style={detail.active ? btn('amber') : btn()}
            >
              <Power size={13} />
              {detail.active ? 'Deactivate' : 'Activate'}
            </button>

            {confirmDelete ? (
              <div className="ml-auto flex items-center gap-2">
                <span className="text-sm" style={{ color: 'var(--red)' }}>Confirm delete?</span>
                <button onClick={() => { onDelete(detail.token); onClose(); }} style={btn('danger')}>Yes, Delete</button>
                <button onClick={() => setConfirmDelete(false)} style={btn()}>Cancel</button>
              </div>
            ) : (
              <button onClick={() => setConfirmDelete(true)} className="ml-auto" style={btn('danger')}>
                <Trash2 size={13} /> Delete Token
              </button>
            )}
          </div>
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
    copyToClipboard(token);
    setCopied(token);
    setTimeout(() => setCopied(null), 2000);
  };

  const filtered = searchQuery
    ? tokens.filter(t => (t.token + t.label + t.target_ip).toLowerCase().includes(searchQuery.toLowerCase()))
    : tokens;

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
          <h1 className="text-xl font-semibold" style={{ color: 'var(--text)' }}>Tokens</h1>
          <p className="mt-1 text-sm" style={{ color: 'var(--text-dim)' }}>
            Manage client authentication tokens
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => load(true)}
            style={{ ...btnBase, borderColor: 'var(--border)', color: 'var(--text-mid)' }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--accent-dim)'; e.currentTarget.style.color = 'var(--text)'; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-mid)'; }}
          >
            <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={() => setShowCreate(true)}
            style={btn('primary')}
          >
            <Plus size={13} /> New Token
          </button>
        </div>
      </div>

      {/* Search */}
      <div style={{ position: 'relative', maxWidth: '300px' }}>
        <Search size={14} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-dim)', pointerEvents: 'none' }} />
        <input
          type="text"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          placeholder="Search tokens, labels…"
          style={{
            background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '8px',
            color: 'var(--text)', fontFamily: 'inherit', fontSize: '13px',
            padding: '8px 12px 8px 34px', outline: 'none', width: '100%', boxSizing: 'border-box',
            transition: 'border-color .15s',
          }}
          onFocus={e => e.target.style.borderColor = 'var(--accent)'}
          onBlur={e => e.target.style.borderColor = 'var(--border)'}
        />
      </div>

      {/* Copied toast */}
      {copied && (
        <div
          className="fixed bottom-5 right-5 z-50 flex items-center gap-2 px-4 py-2.5 text-sm"
          style={{
            background: 'var(--surface)', border: '1px solid var(--accent-dim)',
            borderRadius: '8px', color: 'var(--accent)', boxShadow: 'var(--shadow-md)',
          }}
        >
          <Check size={13} /> Copied to clipboard
        </div>
      )}

      {/* Table */}
      <div style={{
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: '10px', boxShadow: 'var(--shadow-sm)', overflow: 'hidden',
      }}>
        <div className="overflow-x-auto">
          <table className="w-full" style={{ borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--surface2)' }}>
                {['Token', 'Label', 'Sessions', 'Last Seen', 'Status', ''].map(h => (
                  <th key={h} className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide whitespace-nowrap" style={{ color: 'var(--text-dim)' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-5 py-14 text-center text-sm" style={{ color: 'var(--text-dim)' }}>
                    {searchQuery ? 'No matching tokens' : (
                      <>
                        No tokens yet.{' '}
                        <button
                          onClick={() => setShowCreate(true)}
                          style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontFamily: 'inherit', fontSize: 'inherit', fontWeight: 500 }}
                        >
                          Create one →
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ) : filtered.map(t => (
                <tr
                  key={t.token}
                  style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer' }}
                  onClick={() => setDetailToken(t.token)}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--accent-bg)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                >
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-2">
                      <span className="text-sm" style={{ color: 'var(--blue)', fontFamily: 'var(--font-mono)' }}>
                        {t.token.length > 12 ? t.token.slice(0, 12) + '…' : t.token}
                      </span>
                      <button
                        onClick={e => { e.stopPropagation(); handleCopyToken(t.token); }}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-dim)', display: 'flex', padding: 0 }}
                      >
                        <Copy size={12} />
                      </button>
                    </div>
                  </td>
                  <td className="px-5 py-3 text-sm" style={{ color: 'var(--text)' }}>
                    {t.label || <span style={{ color: 'var(--text-dim)' }}>–</span>}
                  </td>
                  <td className="px-5 py-3 text-sm" style={{ color: 'var(--text-mid)' }}>
                    {t.session_count || 0}
                  </td>
                  <td className="px-5 py-3 text-xs whitespace-nowrap" style={{ color: 'var(--text-dim)' }}>
                    {formatTimestamp(t.last_seen)}
                  </td>
                  <td className="px-5 py-3">
                    <span style={{
                      fontSize: '11px', fontWeight: 500, padding: '2px 10px', borderRadius: '9999px',
                      color: t.active ? 'var(--accent)' : 'var(--text-dim)',
                      background: t.active ? 'var(--accent-bg)' : 'var(--surface2)',
                    }}>
                      {t.active ? 'active' : 'inactive'}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-right whitespace-nowrap">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={e => { e.stopPropagation(); handleToggle(t.token, t.active); }}
                        style={t.active ? btn('amber') : btn()}
                      >
                        <Power size={11} />
                        {t.active ? 'Stop' : 'Start'}
                      </button>
                      <button
                        onClick={e => { e.stopPropagation(); handleDelete(t.token); }}
                        style={{ ...btn('danger'), padding: '7px 10px' }}
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {showCreate && <CreateModal onClose={() => setShowCreate(false)} onCreate={handleCreate} />}
      {detailToken && <DetailModal token={detailToken} onClose={() => setDetailToken(null)} onToggle={handleToggle} onDelete={handleDelete} />}
    </div>
  );
}

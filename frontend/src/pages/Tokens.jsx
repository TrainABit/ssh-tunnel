import { useEffect, useState, useCallback, useRef } from 'react';
import { Plus, Copy, Trash2, Power, X, Check, Search, RefreshCw } from 'lucide-react';
import { getTokens, createToken, getTokenDetail, updateToken, deleteToken } from '../services/api';
import { copyToClipboard } from '../utils/clipboard';

function formatTimestamp(ts) {
  if (!ts || typeof ts !== 'string') return '–';
  const d = new Date(ts.endsWith('Z') ? ts : ts + 'Z');
  return d.toLocaleString('en-US', { month: 'short', day: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

const btnStyle = (variant = 'ghost') => ({
  display: 'inline-flex', alignItems: 'center', gap: '5px',
  padding: '5px 12px', fontFamily: 'inherit', fontSize: '10px',
  letterSpacing: '.09em', textTransform: 'uppercase', border: '1px solid',
  cursor: 'pointer', transition: 'all .15s', background: 'transparent',
  ...(variant === 'primary'
    ? { background: 'var(--green)', borderColor: 'var(--green)', color: '#040d0a', fontWeight: 600 }
    : variant === 'danger'
    ? { borderColor: '#2a1212', color: 'var(--red)' }
    : variant === 'amber'
    ? { borderColor: '#3a2800', color: 'var(--amber)' }
    : { borderColor: 'var(--border2)', color: 'var(--text-mid)' }),
});

function InstallCommandBlock({ server, token }) {
  const [copied, setCopied] = useState(false);
  const cmd = `sudo bash install-client.sh --server ${server} --token ${token}`;

  return (
    <div style={{ position: 'relative', background: 'var(--bg)', border: '1px solid var(--border2)', padding: '12px 14px', fontFamily: 'inherit', fontSize: '11.5px', wordBreak: 'break-all' }}>
      <button
        onClick={() => { copyToClipboard(cmd); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
        style={{ position: 'absolute', top: '8px', right: '8px', background: 'var(--surface)', border: '1px solid var(--border2)', cursor: 'pointer', padding: '4px 6px', color: 'var(--text-dim)', display: 'flex', alignItems: 'center' }}
      >
        {copied ? <Check size={11} style={{ color: 'var(--green)' }} /> : <Copy size={11} />}
      </button>
      <span style={{ color: 'var(--text-dim)' }}>$ </span>
      <span style={{ color: 'var(--green)' }}>sudo bash install-client.sh</span>
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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.75)' }}>
      <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto" style={{ background: 'var(--surface)', border: '1px solid var(--border2)' }}>
        <div className="flex items-center justify-between px-5 py-3.5" style={{ borderBottom: '1px solid var(--border)' }}>
          <span className="text-[11px] uppercase tracking-[0.1em]" style={{ color: 'var(--text)' }}>
            {result ? 'Token Created' : 'Create New Token'}
          </span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', fontSize: '18px', lineHeight: 1 }}>×</button>
        </div>

        <div className="p-5">
          {result ? (
            <div className="space-y-4">
              <div className="flex items-center gap-2 border px-3 py-2.5 text-[11.5px]" style={{ borderColor: 'var(--green-dim)', background: 'var(--green-bg)', color: 'var(--green)' }}>
                <Check size={14} />
                Token <span style={{ color: 'var(--blue)' }}>{result.token}</span> created
              </div>
              <div>
                <p className="mb-2 text-[9.5px] uppercase tracking-[0.18em]" style={{ color: 'var(--text-dim)' }}>Run on the client device</p>
                <InstallCommandBlock server={`ws://${window.location.hostname}:4000`} token={result.token} />
                <p className="mt-2 text-[10px]" style={{ color: 'var(--text-dim)' }}>Installs the client and starts it as a systemd service automatically.</p>
              </div>
              <button onClick={onClose} style={btnStyle()}>Close</button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              {[
                { id: 'token', label: 'Token (optional)', placeholder: 'auto-generated if empty' },
                { id: 'label', label: 'Label', placeholder: 'e.g. Raspberry Pi Berlin' },
              ].map(f => (
                <div key={f.id}>
                  <label className="block text-[9.5px] uppercase tracking-[0.15em] mb-1.5" style={{ color: 'var(--text-dim)' }}>{f.label}</label>
                  <input
                    type="text"
                    value={form[f.id]}
                    onChange={e => setForm({ ...form, [f.id]: e.target.value })}
                    placeholder={f.placeholder}
                    style={{ width: '100%', background: 'var(--bg)', border: '1px solid var(--border2)', color: 'var(--text)', fontFamily: 'inherit', fontSize: '12px', padding: '8px 10px', outline: 'none', boxSizing: 'border-box' }}
                    onFocus={e => e.target.style.borderColor = 'var(--green-dim)'}
                    onBlur={e => e.target.style.borderColor = 'var(--border2)'}
                  />
                </div>
              ))}
              <div className="flex justify-end gap-2 pt-1">
                <button type="button" onClick={onClose} style={btnStyle()}>Cancel</button>
                <button type="submit" disabled={submitting} style={{ ...btnStyle('primary'), opacity: submitting ? 0.6 : 1 }}>
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
      <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.75)' }}>
        <div style={{ width: '24px', height: '24px', borderRadius: '50%', border: '2px solid var(--green)', borderTopColor: 'transparent', animation: 'spin 0.8s linear infinite' }} />
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.75)' }} onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto" style={{ background: 'var(--surface)', border: '1px solid var(--border2)' }}>
        <div className="flex items-center justify-between px-5 py-3.5" style={{ borderBottom: '1px solid var(--border)' }}>
          <span className="text-[11px] uppercase tracking-[0.1em]" style={{ color: 'var(--text)' }}>Token Details</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', fontSize: '18px', lineHeight: 1 }}>×</button>
        </div>

        <div className="p-5 space-y-5">
          {/* Detail grid */}
          <div className="grid grid-cols-2 gap-2.5">
            {[
              { label: 'Token', value: detail.token, blue: true },
              { label: 'Label', value: detail.label || '–' },
              { label: 'Status', value: detail.active ? 'active' : 'inactive', green: detail.active },
              { label: 'Last Seen', value: formatTimestamp(detail.last_seen) },
              { label: 'Target', value: detail.target_ip ? `${detail.target_ip}:${detail.target_port}` : '–', blue: !!detail.target_ip },
              { label: 'Linux User', value: detail.linux_user, blue: true },
            ].map(({ label, value, blue, green }) => (
              <div key={label} className="p-3" style={{ background: 'var(--surface2)', border: '1px solid var(--border)' }}>
                <p className="text-[9px] uppercase tracking-[0.18em] mb-1" style={{ color: 'var(--text-dim)' }}>{label}</p>
                <p className="text-[12px] break-all" style={{ color: blue ? 'var(--blue)' : green ? 'var(--green)' : 'var(--text)' }}>{value}</p>
              </div>
            ))}
          </div>

          {/* Install command */}
          <div>
            <p className="mb-2 text-[9.5px] uppercase tracking-[0.15em]" style={{ color: 'var(--text-dim)' }}>Client Install Command</p>
            <InstallCommandBlock server={`ws://${gatewayHost}:4000`} token={detail.token} />
          </div>

          {/* Recent Sessions */}
          <div>
            <p className="mb-2 text-[9.5px] uppercase tracking-[0.15em]" style={{ color: 'var(--text-dim)' }}>
              Recent Sessions ({detail.sessions?.length || 0})
            </p>
            <div style={{ border: '1px solid var(--border)' }}>
              <table className="w-full" style={{ borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    {['From IP', 'Connected', 'Disconnected'].map(h => (
                      <th key={h} className="px-3 py-2 text-left text-[9px] uppercase tracking-[0.18em] font-normal" style={{ color: 'var(--text-dim)' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {detail.sessions?.length > 0 ? detail.sessions.map(s => (
                    <tr key={s.id} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td className="px-3 py-2 text-[11px]" style={{ color: 'var(--text-mid)' }}>{s.client_ip || '–'}</td>
                      <td className="px-3 py-2 text-[10.5px]" style={{ color: 'var(--text-dim)' }}>{formatTimestamp(s.connected_at)}</td>
                      <td className="px-3 py-2 text-[10.5px]">
                        {s.disconnected_at ? (
                          <span style={{ color: 'var(--text-dim)' }}>{formatTimestamp(s.disconnected_at)}</span>
                        ) : (
                          <span className="border px-2 py-0.5 text-[9.5px]" style={{ color: 'var(--amber)', borderColor: '#4a3000', background: 'rgba(240,165,0,0.07)' }}>● live</span>
                        )}
                      </td>
                    </tr>
                  )) : (
                    <tr>
                      <td colSpan={3} className="px-3 py-5 text-center text-[11px]" style={{ color: 'var(--text-dim)' }}>No sessions</td>
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
              style={detail.active ? btnStyle('amber') : btnStyle('ghost')}
            >
              <Power size={11} />
              {detail.active ? 'Deactivate' : 'Activate'}
            </button>

            {confirmDelete ? (
              <div className="ml-auto flex items-center gap-2">
                <span className="text-[11px]" style={{ color: 'var(--red)' }}>Confirm delete?</span>
                <button onClick={() => { onDelete(detail.token); onClose(); }} style={btnStyle('danger')}>Yes, Delete</button>
                <button onClick={() => setConfirmDelete(false)} style={btnStyle()}>Cancel</button>
              </div>
            ) : (
              <button onClick={() => setConfirmDelete(true)} className="ml-auto" style={btnStyle('danger')}>
                <Trash2 size={11} /> Delete Token
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
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-t-transparent" style={{ borderColor: 'var(--green)', borderTopColor: 'transparent' }} />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-[16px] font-normal tracking-[0.06em]" style={{ color: 'var(--text)' }}>
            Tokens <span style={{ color: 'var(--green)' }}>//</span> Clients
          </h1>
          <p className="mt-0.5 text-[10.5px]" style={{ color: 'var(--text-dim)' }}>
            Manage client authentication tokens
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => load(true)}
            style={btnStyle()}
            onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--green-dim)'; e.currentTarget.style.color = 'var(--text)'; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border2)'; e.currentTarget.style.color = 'var(--text-mid)'; }}
          >
            <RefreshCw size={11} className={refreshing ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={() => setShowCreate(true)}
            style={btnStyle('primary')}
            onMouseEnter={e => e.currentTarget.style.background = '#00f599'}
            onMouseLeave={e => e.currentTarget.style.background = 'var(--green)'}
          >
            <Plus size={11} /> New Token
          </button>
        </div>
      </div>

      {/* Search */}
      <div style={{ position: 'relative' }}>
        <Search size={12} style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-dim)' }} />
        <input
          type="text"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          placeholder="Search tokens, labels..."
          style={{
            background: 'var(--surface)', border: '1px solid var(--border2)',
            color: 'var(--text)', fontFamily: 'inherit', fontSize: '11.5px',
            padding: '7px 10px 7px 30px', outline: 'none', width: '100%', maxWidth: '280px',
          }}
          onFocus={e => e.target.style.borderColor = 'var(--green-dim)'}
          onBlur={e => e.target.style.borderColor = 'var(--border2)'}
        />
      </div>

      {/* Copied toast */}
      {copied && (
        <div
          className="fixed bottom-5 right-5 z-50 flex items-center gap-2 px-4 py-2.5 text-[11.5px]"
          style={{ background: 'var(--surface2)', border: '1px solid var(--green-dim)', color: 'var(--green)' }}
        >
          <Check size={12} /> Copied to clipboard
        </div>
      )}

      {/* Table */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
        <div className="overflow-x-auto">
          <table className="w-full" style={{ borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                {['Token', 'Label', 'Sessions', 'Last Seen', 'Status', ''].map(h => (
                  <th key={h} className="px-4 py-2.5 text-left text-[9px] uppercase tracking-[0.18em] font-normal whitespace-nowrap" style={{ color: 'var(--text-dim)' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-[11px]" style={{ color: 'var(--text-dim)' }}>
                    {searchQuery ? 'No matching tokens' : (
                      <>
                        No tokens yet.{' '}
                        <button
                          onClick={() => setShowCreate(true)}
                          style={{ background: 'none', border: 'none', color: 'var(--green)', cursor: 'pointer', fontFamily: 'inherit', fontSize: 'inherit' }}
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
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--green-bg)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                >
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className="text-[11.5px]" style={{ color: 'var(--blue)' }}>
                        {t.token.length > 12 ? t.token.slice(0, 12) + '…' : t.token}
                      </span>
                      <button
                        onClick={e => { e.stopPropagation(); handleCopyToken(t.token); }}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-dim)', display: 'flex', padding: 0 }}
                      >
                        <Copy size={11} />
                      </button>
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-[11.5px]" style={{ color: 'var(--text)' }}>
                    {t.label || <span style={{ color: 'var(--text-dim)' }}>–</span>}
                  </td>
                  <td className="px-4 py-2.5 text-[11.5px]" style={{ color: 'var(--text-mid)' }}>
                    {t.session_count || 0}
                  </td>
                  <td className="px-4 py-2.5 text-[10.5px] whitespace-nowrap" style={{ color: 'var(--text-dim)' }}>
                    {formatTimestamp(t.last_seen)}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="border px-2 py-0.5 text-[9.5px]" style={{
                      color: t.active ? 'var(--green)' : 'var(--text-dim)',
                      borderColor: t.active ? 'var(--green-dim)' : 'var(--border2)',
                      background: t.active ? 'var(--green-bg)' : 'transparent',
                    }}>
                      {t.active ? 'active' : 'inactive'}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-right whitespace-nowrap">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={e => { e.stopPropagation(); handleToggle(t.token, t.active); }}
                        style={t.active ? btnStyle('amber') : btnStyle('ghost')}
                      >
                        <Power size={10} />
                        {t.active ? 'Stop' : 'Start'}
                      </button>
                      <button
                        onClick={e => { e.stopPropagation(); handleDelete(t.token); }}
                        style={{ ...btnStyle('danger'), padding: '5px 8px' }}
                      >
                        <Trash2 size={10} />
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

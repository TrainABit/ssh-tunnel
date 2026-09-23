import { useEffect, useState } from 'react';
import { Plus, Copy, Trash2, Power, Check, Search, RefreshCw, KeyRound } from 'lucide-react';
import { getTokens, createToken, getTokenDetail, updateToken, deleteToken, setTokenPrivateKey } from '../services/api';
import { copyToClipboard } from '../utils/clipboard';
import { deviceServerUrl, isInsecurePublicUrl, shellQuote } from '../utils/serverUrl';
import usePolling from '../hooks/usePolling';
import useServerConfig from '../hooks/useServerConfig';
import Banner from '../components/Banner';

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

const TOKEN_RE = /^[A-Za-z0-9]{1,64}$/;

const fieldStyle = {
  width: '100%', background: 'var(--bg)', border: '1px solid var(--border)',
  borderRadius: '8px', color: 'var(--text)', fontFamily: 'inherit',
  fontSize: '13px', padding: '9px 12px', outline: 'none', boxSizing: 'border-box',
  transition: 'border-color .15s',
};

function InstallCommandBlock({ server, token }) {
  const [copied, setCopied] = useState(false);
  const serverArg = shellQuote(server);
  const cmd = `sudo bash install-client.sh --server ${serverArg} --token ${token}`;
  const insecure = isInsecurePublicUrl(server);

  return (
    <div className="space-y-2">
      <div style={{
        position: 'relative', background: 'var(--bg)', border: '1px solid var(--border)',
        borderRadius: '8px', padding: '12px 44px 12px 14px', fontFamily: 'var(--font-mono)',
        fontSize: '12px', wordBreak: 'break-all', lineHeight: 1.6,
      }}>
        <button
          type="button"
          aria-label="Copy install command"
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
        <span style={{ color: 'var(--blue)' }}>--server</span> <span style={{ color: 'var(--text)' }}>{serverArg}</span>
        {' '}
        <span style={{ color: 'var(--blue)' }}>--token</span> <span style={{ color: 'var(--text)' }}>{token}</span>
      </div>
      {insecure && (
        <Banner tone="warning">
          This server URL is unencrypted (ws://). The device token would cross the network in plaintext.
          Reinstall the server with <code style={{ fontFamily: 'var(--font-mono)' }}>--tls</code> and use a wss:// URL.
        </Banner>
      )}
      <p className="text-xs" style={{ color: 'var(--text-dim)' }}>
        Run it on the device from an extracted TunnelVault release. The token is stored only in
        {' '}<code style={{ fontFamily: 'var(--font-mono)' }}>/etc/tunnelvault/client.env</code> (root-only), never on the service command line.
        Add <code style={{ fontFamily: 'var(--font-mono)' }}>--allow-reboot</code> to permit remote reboots from this dashboard.
      </p>
    </div>
  );
}

function CreateModal({ server, onClose, onCreate }) {
  const [form, setForm] = useState({ token: '', label: '' });
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    const token = form.token.trim();
    if (token && !TOKEN_RE.test(token)) {
      setError('A custom token must be 1–64 letters or digits (A–Z, a–z, 0–9). Leave it empty to generate a random one.');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const created = await onCreate({ ...(token ? { token } : {}), label: form.label.trim() });
      if (!created || typeof created.token !== 'string') throw new Error('Unexpected response from the server.');
      setResult(created);
    } catch (err) {
      setError(err?.message || 'Could not create the token.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.6)' }}>
      <div role="dialog" aria-modal="true" aria-label="Create token" className="w-full max-w-lg max-h-[90vh] overflow-y-auto" style={{
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: '12px', boxShadow: 'var(--shadow-md)',
      }}>
        <div className="flex items-center justify-between px-6 py-4" style={{ borderBottom: '1px solid var(--border)' }}>
          <span className="text-base font-semibold" style={{ color: 'var(--text)' }}>
            {result ? 'Token Created' : 'Create New Token'}
          </span>
          <button type="button" aria-label="Close" onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', fontSize: '20px', lineHeight: 1, padding: '0 4px' }}>×</button>
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
                <InstallCommandBlock server={server} token={result.token} />
              </div>
              <button type="button" onClick={onClose} style={btn()}>Close</button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4" noValidate>
              {[
                { id: 'token', label: 'Token (optional)', placeholder: 'auto-generated if empty', mono: true },
                { id: 'label', label: 'Label', placeholder: 'e.g. Raspberry Pi Berlin' },
              ].map(f => (
                <div key={f.id}>
                  <label htmlFor={`create-${f.id}`} className="block text-xs font-semibold uppercase tracking-wide mb-1.5" style={{ color: 'var(--text-mid)' }}>{f.label}</label>
                  <input
                    id={`create-${f.id}`}
                    type="text"
                    value={form[f.id]}
                    onChange={e => setForm({ ...form, [f.id]: e.target.value })}
                    placeholder={f.placeholder}
                    maxLength={f.id === 'token' ? 64 : 200}
                    autoComplete="off"
                    spellCheck={false}
                    style={{ ...fieldStyle, fontFamily: f.mono ? 'var(--font-mono)' : 'inherit' }}
                    onFocus={e => e.target.style.borderColor = 'var(--accent)'}
                    onBlur={e => e.target.style.borderColor = 'var(--border)'}
                  />
                </div>
              ))}
              {error && <Banner tone="error">{error}</Banner>}
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

/** Stored SSH private key (used by the web terminal's "Stored Key" option). */
function StoredKeySection({ token, hasKey, config, onChanged }) {
  const [pem, setPem] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null); // { tone, text }
  const [confirmClear, setConfirmClear] = useState(false);
  const disabled = config?.storedKeysEnabled === false;

  const save = async () => {
    const value = pem.trim();
    if (!value) { setMessage({ tone: 'error', text: 'Paste a private key first.' }); return; }
    if (!value.startsWith('-----BEGIN')) {
      setMessage({ tone: 'error', text: 'The key must be in OpenSSH or PEM format (starting with "-----BEGIN").' });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await setTokenPrivateKey(token, value + '\n');
      setPem('');
      setMessage({ tone: 'info', text: 'Private key stored (encrypted at rest). Use "Stored Key" in the web terminal.' });
      await onChanged();
    } catch (err) {
      setMessage({ tone: 'error', text: err?.message || 'Could not store the key.' });
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await setTokenPrivateKey(token, '');
      setConfirmClear(false);
      setMessage({ tone: 'info', text: 'Stored private key removed.' });
      await onChanged();
    } catch (err) {
      setMessage({ tone: 'error', text: err?.message || 'Could not remove the key.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide flex items-center gap-2" style={{ color: 'var(--text-dim)' }}>
        <KeyRound size={12} /> Stored SSH key (web terminal)
      </p>
      <div className="space-y-3" style={{ background: 'var(--surface2)', borderRadius: '8px', padding: '14px' }}>
        <div className="flex items-center gap-2 text-sm flex-wrap">
          <span style={{ color: 'var(--text-mid)' }}>Status:</span>
          <span data-testid="stored-key-status" style={{
            fontSize: '11px', fontWeight: 500, padding: '2px 10px', borderRadius: '9999px',
            color: hasKey ? 'var(--accent)' : 'var(--text-dim)',
            background: hasKey ? 'var(--accent-bg)' : 'var(--surface)',
          }}>
            {hasKey ? 'key stored' : 'no key stored'}
          </span>
          {hasKey && (
            confirmClear ? (
              <span className="ml-auto flex items-center gap-2">
                <button type="button" onClick={clear} disabled={busy} style={{ ...btn('danger'), padding: '4px 10px', opacity: busy ? 0.6 : 1 }}>
                  {busy ? 'Removing…' : 'Yes, remove key'}
                </button>
                <button type="button" onClick={() => setConfirmClear(false)} disabled={busy} style={{ ...btn(), padding: '4px 10px' }}>Cancel</button>
              </span>
            ) : (
              <button type="button" onClick={() => setConfirmClear(true)} disabled={busy} className="ml-auto" style={{ ...btn('danger'), padding: '4px 10px' }}>
                <Trash2 size={11} /> Clear
              </button>
            )
          )}
        </div>

        {disabled ? (
          <Banner tone="warning">
            Stored keys are disabled on this server because no data encryption key is configured, so private keys
            cannot be encrypted at rest. Set <code style={{ fontFamily: 'var(--font-mono)' }}>DATA_ENCRYPTION_KEY</code> (or
            {' '}<code style={{ fontFamily: 'var(--font-mono)' }}>DATA_ENCRYPTION_KEY_FILE</code>) in the server&apos;s .env — re-running
            {' '}<code style={{ fontFamily: 'var(--font-mono)' }}>install-server.sh --upgrade</code> generates one — and restart the service.
          </Banner>
        ) : (
          <>
            <textarea
              value={pem}
              onChange={e => setPem(e.target.value)}
              aria-label="SSH private key"
              placeholder={'-----BEGIN OPENSSH PRIVATE KEY-----\n…\n-----END OPENSSH PRIVATE KEY-----'}
              rows={5}
              spellCheck={false}
              autoComplete="off"
              style={{ ...fieldStyle, fontFamily: 'var(--font-mono)', fontSize: '11px', resize: 'vertical', lineHeight: 1.5 }}
              onFocus={e => e.target.style.borderColor = 'var(--accent)'}
              onBlur={e => e.target.style.borderColor = 'var(--border)'}
            />
            <div className="flex items-start gap-3 flex-wrap">
              <p className="text-xs flex-1" style={{ color: 'var(--text-dim)', minWidth: '200px' }}>
                Use a dedicated key without a passphrase (passphrase-protected keys are rejected). It is encrypted
                at rest on the server and never returned by the API. {hasKey ? 'Saving replaces the stored key.' : ''}
              </p>
              <button type="button" onClick={save} disabled={busy || !pem.trim()} style={{ ...btn('primary'), opacity: busy || !pem.trim() ? 0.5 : 1 }}>
                {busy ? 'Saving…' : hasKey ? 'Replace key' : 'Save key'}
              </button>
            </div>
          </>
        )}
        {message && <Banner tone={message.tone} onDismiss={() => setMessage(null)}>{message.text}</Banner>}
      </div>
    </div>
  );
}

function DetailModal({ token, server, config, onClose, onToggle, onDelete }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');

  useEffect(() => {
    let active = true;
    getTokenDetail(token).then(
      (d) => { if (active) { setDetail(d); setError(null); } },
      (err) => { if (active) setError(err); },
    );
    return () => { active = false; };
  }, [token]);

  const reload = async () => {
    try {
      setDetail(await getTokenDetail(token));
    } catch (err) {
      setActionError(err?.message || 'Could not reload the token.');
    }
  };

  const runAction = async (fn) => {
    setBusy(true);
    setActionError('');
    try {
      await fn();
      onClose();
    } catch (err) {
      setActionError(err?.message || 'Request failed');
      setBusy(false);
    }
  };

  if (!detail) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.6)' }} onClick={e => e.target === e.currentTarget && onClose()}>
        {error ? (
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '12px', padding: '20px', maxWidth: '420px', width: '100%' }} className="space-y-4">
            <Banner tone="error">Could not load the token: {error.message}</Banner>
            <button type="button" onClick={onClose} style={btn()}>Close</button>
          </div>
        ) : (
          <div role="status" aria-label="Loading" style={{ width: '28px', height: '28px', borderRadius: '50%', border: '2px solid var(--accent)', borderTopColor: 'transparent', animation: 'spin 0.8s linear infinite' }} />
        )}
      </div>
    );
  }

  const isActive = !!detail.active;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.6)' }} onClick={e => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="Token details" className="w-full max-w-2xl max-h-[90vh] overflow-y-auto" style={{
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: '12px', boxShadow: 'var(--shadow-md)',
      }}>
        <div className="flex items-center justify-between px-6 py-4" style={{ borderBottom: '1px solid var(--border)' }}>
          <span className="text-base font-semibold" style={{ color: 'var(--text)' }}>Token Details</span>
          <button type="button" aria-label="Close" onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', fontSize: '20px', lineHeight: 1, padding: '0 4px' }}>×</button>
        </div>

        <div className="p-6 space-y-5">
          {/* Detail grid */}
          <div className="grid grid-cols-2 gap-3">
            {[
              { label: 'Token', value: detail.token, mono: true, color: 'var(--blue)' },
              { label: 'Label', value: detail.label || '–' },
              { label: 'Status', value: isActive ? 'active' : 'inactive', color: isActive ? 'var(--accent)' : 'var(--text-dim)' },
              { label: 'Last Seen', value: formatTimestamp(detail.last_seen) },
              { label: 'Target', value: detail.target_ip ? `${detail.target_ip}:${detail.target_port}` : '–', mono: !!detail.target_ip },
              { label: 'Linux User', value: detail.linux_user || '–', mono: true },
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
            <InstallCommandBlock server={server} token={detail.token} />
          </div>

          <StoredKeySection
            token={detail.token}
            hasKey={detail.has_private_key === true || detail.has_private_key === 1}
            config={config}
            onChanged={reload}
          />

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
          {actionError && <Banner tone="error">{actionError}</Banner>}
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              disabled={busy}
              title={isActive ? 'Deactivating immediately disconnects devices using this token' : 'Allow devices to connect with this token again'}
              onClick={() => runAction(() => onToggle(detail.token, isActive))}
              style={isActive ? btn('amber') : btn()}
            >
              <Power size={13} />
              {isActive ? 'Deactivate' : 'Activate'}
            </button>

            {confirmDelete ? (
              <div className="ml-auto flex items-center gap-2 flex-wrap">
                <span className="text-sm" style={{ color: 'var(--red)' }}>Delete token, disconnect its devices and remove their tunnels?</span>
                <button type="button" disabled={busy} onClick={() => runAction(() => onDelete(detail.token))} style={btn('danger')}>Yes, Delete</button>
                <button type="button" disabled={busy} onClick={() => setConfirmDelete(false)} style={btn()}>Cancel</button>
              </div>
            ) : (
              <button type="button" onClick={() => setConfirmDelete(true)} className="ml-auto" style={btn('danger')}>
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
  const { data, error: loadError, loading, refreshing, refresh } = usePolling(getTokens, 15000);
  const tokens = data || [];
  const { config } = useServerConfig();
  const server = deviceServerUrl(config);
  const [showCreate, setShowCreate] = useState(false);
  const [detailToken, setDetailToken] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [copied, setCopied] = useState(null);
  const [notice, setNotice] = useState(null); // { tone, text }

  const handleCreate = async (form) => {
    try {
      return await createToken(form);
    } finally {
      refresh();
    }
  };

  // Used by the detail modal (errors are shown there).
  const handleToggle = async (token, currentlyActive) => {
    try {
      const res = await updateToken(token, { active: currentlyActive ? 0 : 1 });
      const closed = Number(res?.disconnected);
      const closedText = Number.isFinite(closed) && closed > 0
        ? ` ${closed} live device connection${closed === 1 ? ' was' : 's were'} closed.`
        : '';
      setNotice({
        tone: 'info',
        text: currentlyActive
          ? `Token deactivated.${closedText} Devices using it cannot reconnect until it is activated again.`
          : 'Token activated.',
      });
    } finally {
      refresh();
    }
  };

  const handleDelete = async (token) => {
    try {
      await deleteToken(token);
      setNotice({ tone: 'info', text: 'Token deleted. Its devices were disconnected and their tunnels removed.' });
    } finally {
      refresh();
    }
  };

  // Table row actions: report errors in the page banner.
  const rowAction = async (fn) => {
    try {
      await fn();
    } catch (err) {
      setNotice({ tone: 'error', text: err?.message || 'Request failed' });
    }
  };

  const confirmAndDelete = (token) => {
    const ok = window.confirm(
      `Delete token ${token.slice(0, 4)}…?\n\nDevices using it are disconnected immediately and their tunnels are removed. This cannot be undone.`,
    );
    if (ok) rowAction(() => handleDelete(token));
  };

  const handleCopyToken = (token) => {
    copyToClipboard(token);
    setCopied(token);
    setTimeout(() => setCopied(null), 2000);
  };

  const filtered = searchQuery
    ? tokens.filter(t => `${t.token || ''} ${t.label || ''} ${t.target_ip || ''}`.toLowerCase().includes(searchQuery.toLowerCase()))
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
            onClick={refresh}
            aria-label="Refresh"
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

      {loadError && <Banner tone="error">Could not refresh tokens: {loadError.message}</Banner>}
      {notice && <Banner tone={notice.tone} onDismiss={() => setNotice(null)}>{notice.text}</Banner>}

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
              {!data ? null : filtered.length === 0 ? (
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
                        onClick={e => { e.stopPropagation(); rowAction(() => handleToggle(t.token, !!t.active)); }}
                        title={t.active ? 'Deactivate: disconnects devices using this token' : 'Activate token'}
                        style={t.active ? btn('amber') : btn()}
                      >
                        <Power size={11} />
                        {t.active ? 'Stop' : 'Start'}
                      </button>
                      <button
                        onClick={e => { e.stopPropagation(); confirmAndDelete(t.token); }}
                        aria-label="Delete token"
                        title="Delete token"
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

      {showCreate && <CreateModal server={server} onClose={() => setShowCreate(false)} onCreate={handleCreate} />}
      {detailToken && (
        <DetailModal
          token={detailToken}
          server={server}
          config={config}
          onClose={() => { setDetailToken(null); refresh(); }}
          onToggle={handleToggle}
          onDelete={handleDelete}
        />
      )}
    </div>
  );
}

import { useEffect, useState, useCallback, useRef } from 'react';
import { Plus, Copy, Trash2, Power, X, Check, RefreshCw, ArrowRight } from 'lucide-react';
import { getTunnels, createTunnel, deleteTunnel, toggleTunnel } from '../services/api';
import { copyToClipboard } from '../utils/clipboard';

const btnStyle = {
  ghost: {
    display: 'inline-flex', alignItems: 'center', gap: '6px',
    padding: '5px 12px', fontFamily: 'inherit', fontSize: '10px',
    letterSpacing: '.09em', textTransform: 'uppercase', border: '1px solid',
    cursor: 'pointer', transition: 'all .15s', background: 'transparent',
    borderColor: 'var(--border2)', color: 'var(--text-mid)',
  },
  primary: {
    display: 'inline-flex', alignItems: 'center', gap: '6px',
    padding: '5px 12px', fontFamily: 'inherit', fontSize: '10px',
    letterSpacing: '.09em', textTransform: 'uppercase', border: '1px solid',
    cursor: 'pointer', transition: 'all .15s',
    background: 'var(--green)', borderColor: 'var(--green)', color: '#040d0a', fontWeight: 600,
  },
};

function CreateModal({ onClose, onCreate }) {
  const [form, setForm] = useState({ name: '', localPort: '', subdomain: '' });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.name || !form.localPort) return;
    setSubmitting(true);
    setError('');
    const result = await onCreate({ ...form, localPort: Number(form.localPort) });
    if (result?.error) setError(result.error);
    else onClose();
    setSubmitting(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.75)' }}>
      <div className="w-full max-w-md" style={{ background: 'var(--surface)', border: '1px solid var(--border2)' }}>
        <div className="flex items-center justify-between px-5 py-3.5" style={{ borderBottom: '1px solid var(--border)' }}>
          <span className="text-[11px] uppercase tracking-[0.1em]" style={{ color: 'var(--text)' }}>Create Tunnel</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', fontSize: '18px', lineHeight: 1 }}>×</button>
        </div>
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          {[
            { id: 'name', label: 'Tunnel Name', placeholder: 'my-raspi', required: true },
            { id: 'localPort', label: 'Local Port', placeholder: '22', required: true, type: 'number' },
            { id: 'subdomain', label: 'Subdomain (optional)', placeholder: 'my-raspi' },
          ].map(f => (
            <div key={f.id}>
              <label className="block text-[9.5px] uppercase tracking-[0.15em] mb-1.5" style={{ color: 'var(--text-dim)' }}>
                {f.label}
              </label>
              <input
                type={f.type || 'text'}
                value={form[f.id]}
                onChange={e => setForm({ ...form, [f.id]: e.target.value })}
                placeholder={f.placeholder}
                required={f.required}
                style={{
                  width: '100%', background: 'var(--bg)', border: '1px solid var(--border2)',
                  color: 'var(--text)', fontFamily: 'inherit', fontSize: '12px',
                  padding: '8px 10px', outline: 'none', boxSizing: 'border-box',
                }}
                onFocus={e => e.target.style.borderColor = 'var(--green-dim)'}
                onBlur={e => e.target.style.borderColor = 'var(--border2)'}
              />
            </div>
          ))}
          {error && <p className="text-[11px]" style={{ color: 'var(--red)' }}>{error}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} style={btnStyle.ghost}>Cancel</button>
            <button type="submit" disabled={submitting} style={{ ...btnStyle.primary, opacity: submitting ? 0.6 : 1 }}>
              {submitting ? 'Creating…' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function TunnelCard({ tunnel, onDelete, onToggle, onCopy }) {
  const isActive = tunnel.status === 'active';
  const isInactive = tunnel.status === 'inactive';
  const isPaused = tunnel.status === 'paused';

  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', position: 'relative', overflow: 'hidden' }}>
      {/* Status top bar */}
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0, height: '2px',
        background: isActive ? 'var(--green)' : isPaused ? 'var(--amber)' : isInactive ? 'var(--border2)' : 'var(--red)',
        opacity: isActive ? 1 : 0.5,
      }} />

      <div className="p-4 pt-5">
        {/* Header */}
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div
              className={`h-2 w-2 rounded-full ${isActive ? 'pulse-dot' : ''}`}
              style={{ background: isActive ? 'var(--green)' : isPaused ? 'var(--amber)' : isInactive ? 'var(--border2)' : '#e84040' }}
            />
            <span className="text-[12px] font-normal" style={{ color: 'var(--text)' }}>{tunnel.name}</span>
          </div>
          <span
            className="border px-2 py-0.5 text-[9px] uppercase tracking-[0.08em]"
            style={{
              color: isActive ? 'var(--green)' : isPaused ? 'var(--amber)' : 'var(--text-dim)',
              borderColor: isActive ? 'var(--green-dim)' : isPaused ? '#4a3000' : 'var(--border2)',
              background: isActive ? 'var(--green-bg)' : isPaused ? 'rgba(240,165,0,0.07)' : 'transparent',
            }}
          >
            {isInactive ? 'disconnected' : tunnel.status}
          </span>
        </div>

        {/* Routing */}
        {tunnel.protocol === 'tcp' ? (
          <div className="mb-3 space-y-1.5">
            <div className="flex items-center gap-2 px-3 py-2 text-[11px]" style={{ background: 'var(--bg)', border: '1px solid var(--border)' }}>
              <span style={{ color: 'var(--green)' }}>:{tunnel.allocatedPort ?? '—'}</span>
              <ArrowRight size={11} style={{ color: 'var(--text-dim)', flexShrink: 0 }} />
              <span style={{ color: 'var(--text-mid)' }}>localhost:{tunnel.localPort}</span>
            </div>
            {tunnel.allocatedPort && (
              <div className="px-3 py-1.5 text-[10.5px]" style={{ background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text-dim)' }}>
                ssh user@{window.location.hostname} -p {tunnel.allocatedPort}
              </div>
            )}
          </div>
        ) : (
          <div className="mb-3 flex items-center gap-2 px-3 py-2 text-[11px]" style={{ background: 'var(--bg)', border: '1px solid var(--border)' }}>
            <span className="truncate" style={{ color: 'var(--green)' }}>{tunnel.publicUrl}</span>
            <ArrowRight size={11} style={{ color: 'var(--text-dim)', flexShrink: 0 }} />
            <span style={{ color: 'var(--text-mid)' }}>:{tunnel.localPort}</span>
          </div>
        )}

        {/* Stats */}
        <div className="mb-3 grid grid-cols-2 gap-3">
          <div>
            <p className="text-[9px] uppercase tracking-[0.15em] mb-1" style={{ color: 'var(--text-dim)' }}>Connections</p>
            <p className="text-[13px]" style={{ color: 'var(--text)' }}>{tunnel.connections}</p>
          </div>
          <div>
            <p className="text-[9px] uppercase tracking-[0.15em] mb-1" style={{ color: 'var(--text-dim)' }}>Data</p>
            <p className="text-[13px]" style={{ color: 'var(--text)' }}>
              {tunnel.bytesTransferred != null
                ? tunnel.bytesTransferred > 1e9 ? (tunnel.bytesTransferred / 1e9).toFixed(2) + ' GB'
                : tunnel.bytesTransferred > 1e6 ? (tunnel.bytesTransferred / 1e6).toFixed(1) + ' MB'
                : tunnel.bytesTransferred > 1e3 ? (tunnel.bytesTransferred / 1e3).toFixed(0) + ' KB'
                : tunnel.bytesTransferred + ' B'
                : '0 B'}
            </p>
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
            style={{ ...btnStyle.ghost, padding: '4px 10px', fontSize: '9.5px' }}
          >
            <Copy size={10} /> {tunnel.protocol === 'tcp' ? 'Copy SSH' : 'Copy URL'}
          </button>

          {isActive ? (
            <button
              onClick={() => onToggle(tunnel.id)}
              style={{ ...btnStyle.ghost, borderColor: '#3a2800', color: 'var(--amber)', padding: '4px 10px', fontSize: '9.5px' }}
            >
              <Power size={10} /> Stop
            </button>
          ) : isInactive ? (
            <span className="flex items-center gap-1.5 border px-2.5 py-1 text-[9.5px]" style={{ borderColor: 'var(--border)', color: 'var(--text-dim)' }}>
              <span className="h-1.5 w-1.5 rounded-full animate-pulse" style={{ background: 'var(--text-dim)' }} />
              Reconnecting…
            </span>
          ) : (
            <button
              onClick={() => onToggle(tunnel.id)}
              style={{ ...btnStyle.ghost, borderColor: 'var(--green-dim)', color: 'var(--green)', padding: '4px 10px', fontSize: '9.5px' }}
            >
              <Power size={10} /> {isPaused ? 'Resume' : 'Start'}
            </button>
          )}

          <button
            onClick={() => onDelete(tunnel.id)}
            className="ml-auto"
            style={{ ...btnStyle.ghost, borderColor: '#2a1212', color: 'var(--red)', padding: '4px 10px', fontSize: '9.5px' }}
          >
            <Trash2 size={10} />
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

  const handleCopy = (url) => {
    copyToClipboard(url);
    setCopied(url);
    setTimeout(() => setCopied(null), 2000);
  };

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
            Tunnels <span style={{ color: 'var(--green)' }}>//</span> Manage
          </h1>
          <p className="mt-0.5 text-[10.5px]" style={{ color: 'var(--text-dim)' }}>
            Active tunnel endpoints — auto-refreshes every 5s
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => load(true)}
            style={btnStyle.ghost}
            onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--green-dim)'; e.currentTarget.style.color = 'var(--text)'; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border2)'; e.currentTarget.style.color = 'var(--text-mid)'; }}
          >
            <RefreshCw size={11} className={refreshing ? 'animate-spin' : ''} />
            Refresh
          </button>
          <button
            onClick={() => setShowModal(true)}
            style={btnStyle.primary}
            onMouseEnter={e => e.currentTarget.style.background = '#00f599'}
            onMouseLeave={e => e.currentTarget.style.background = 'var(--green)'}
          >
            <Plus size={11} />
            New Tunnel
          </button>
        </div>
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

      {tunnels.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16" style={{ border: '1px dashed var(--border2)' }}>
          <p className="text-[11.5px]" style={{ color: 'var(--text-dim)' }}>No tunnels yet</p>
          <button
            onClick={() => setShowModal(true)}
            className="mt-3 text-[11px] uppercase tracking-[0.09em]"
            style={{ color: 'var(--green)', background: 'none', border: 'none', cursor: 'pointer' }}
          >
            + Create your first tunnel
          </button>
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {tunnels.map((tunnel) => (
            <TunnelCard
              key={tunnel.id}
              tunnel={tunnel}
              onDelete={async (id) => { await deleteTunnel(id); load(); }}
              onToggle={async (id) => { await toggleTunnel(id); load(); }}
              onCopy={handleCopy}
            />
          ))}
        </div>
      )}

      {showModal && (
        <CreateModal
          onClose={() => setShowModal(false)}
          onCreate={async (form) => {
            const result = await createTunnel(form);
            await load();
            return result;
          }}
        />
      )}
    </div>
  );
}

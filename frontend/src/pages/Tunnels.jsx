import { useEffect, useState, useCallback, useRef } from 'react';
import { Copy, Trash2, Power, Check, RefreshCw, ArrowRight, RotateCcw } from 'lucide-react';
import { getTunnels, deleteTunnel, toggleTunnel, rebootTunnel } from '../services/api';
import { copyToClipboard } from '../utils/clipboard';

const btnStyle = {
  ghost: {
    display: 'inline-flex', alignItems: 'center', gap: '6px',
    padding: '5px 12px', fontFamily: 'inherit', fontSize: '10px',
    letterSpacing: '.09em', textTransform: 'uppercase', border: '1px solid',
    cursor: 'pointer', transition: 'all .15s', background: 'transparent',
    borderColor: 'var(--border2)', color: 'var(--text-mid)',
  },
};


function TunnelCard({ tunnel, onDelete, onToggle, onCopy, onReboot }) {
  const isActive = tunnel.status === 'active';
  const isInactive = tunnel.status === 'inactive';
  const isPaused = tunnel.status === 'paused';
  const [rebootStep, setRebootStep] = useState(0); // 0=idle, 1=confirm, 2=rebooting
  const rebootTimerRef = useRef(null);

  const handleRebootClick = () => {
    if (rebootStep === 0) {
      // First click — show confirm
      setRebootStep(1);
      // Auto-cancel after 4s if not confirmed
      rebootTimerRef.current = setTimeout(() => setRebootStep(0), 4000);
    } else if (rebootStep === 1) {
      // Second click — execute
      clearTimeout(rebootTimerRef.current);
      setRebootStep(2);
      onReboot(tunnel.id).finally(() => {
        setTimeout(() => setRebootStep(0), 3000);
      });
    }
  };

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
            <>
              <button
                onClick={() => onToggle(tunnel.id)}
                style={{ ...btnStyle.ghost, borderColor: '#3a2800', color: 'var(--amber)', padding: '4px 10px', fontSize: '9.5px' }}
              >
                <Power size={10} /> Stop
              </button>
              <button
                onClick={handleRebootClick}
                title={rebootStep === 1 ? 'Click again to confirm reboot' : 'Reboot device'}
                style={{
                  ...btnStyle.ghost,
                  padding: '4px 10px', fontSize: '9.5px',
                  ...(rebootStep === 1
                    ? { borderColor: '#5a1212', color: '#e84040', animation: 'pulse 1s infinite' }
                    : rebootStep === 2
                    ? { borderColor: 'var(--border2)', color: 'var(--text-dim)', opacity: 0.5 }
                    : { borderColor: 'var(--border2)', color: 'var(--text-dim)' }),
                }}
              >
                <RotateCcw size={10} />
                {rebootStep === 1 ? 'Confirm?' : rebootStep === 2 ? 'Rebooting…' : 'Reboot'}
              </button>
            </>
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
        <button
          onClick={() => load(true)}
          style={btnStyle.ghost}
          onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--green-dim)'; e.currentTarget.style.color = 'var(--text)'; }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border2)'; e.currentTarget.style.color = 'var(--text-mid)'; }}
        >
          <RefreshCw size={11} className={refreshing ? 'animate-spin' : ''} />
          Refresh
        </button>
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
          <p className="text-[11.5px]" style={{ color: 'var(--text-dim)' }}>No active tunnels</p>
          <p className="mt-1 text-[10.5px]" style={{ color: 'var(--text-dim)' }}>Tunnels appear automatically when a client connects</p>
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
              onReboot={async (id) => { await rebootTunnel(id); }}
            />
          ))}
        </div>
      )}

    </div>
  );
}

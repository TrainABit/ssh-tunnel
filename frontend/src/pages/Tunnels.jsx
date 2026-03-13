import { useEffect, useState, useCallback, useRef } from 'react';
import { Copy, Trash2, Power, Check, RefreshCw, ArrowRight, RotateCcw, Terminal, Globe } from 'lucide-react';
import { getTunnels, deleteTunnel, toggleTunnel, rebootTunnel } from '../services/api';
import { copyToClipboard } from '../utils/clipboard';
import SshTerminalModal from '../components/SshTerminalModal';

const btnBase = {
  display: 'inline-flex', alignItems: 'center', gap: '5px',
  padding: '5px 12px', fontFamily: 'inherit', fontSize: '12px',
  fontWeight: 500, borderRadius: '6px', border: '1px solid',
  cursor: 'pointer', transition: 'all .15s', background: 'transparent',
};

const btn = {
  ghost: { ...btnBase, borderColor: 'var(--border)', color: 'var(--text-mid)' },
  danger: { ...btnBase, borderColor: 'rgba(200,32,32,0.3)', color: 'var(--red)' },
  amber: { ...btnBase, borderColor: 'rgba(176,96,0,0.35)', color: 'var(--amber)' },
  active: { ...btnBase, borderColor: 'var(--accent-dim)', color: 'var(--accent)' },
};

function portLabel(port) {
  if (port === 22) return 'SSH';
  if (port === 80 || port === 443) return 'HTTP';
  if (port === 8080 || port === 3000 || port === 5000 || port === 8000) return 'Web';
  return `Port ${port}`;
}

// ── Grouped card: multiple tunnels from one client token ─────
function ClientCard({ tunnels, onDelete, onToggle, onCopy, onReboot, onSsh }) {
  const anyActive = tunnels.some(t => t.status === 'active');
  const allInactive = tunnels.every(t => t.status === 'inactive');
  const clientName = tunnels[0].name;

  const overallStatus = anyActive ? 'active' : allInactive ? 'inactive' : tunnels[0].status;
  const statusColor = anyActive ? 'var(--accent)' : overallStatus === 'paused' ? 'var(--amber)' : 'var(--border2)';

  const [rebootStep, setRebootStep] = useState(0);
  const rebootTimerRef = useRef(null);

  // Use any tunnel's id for reboot — they're all on the same device
  const rebootId = tunnels.find(t => t.status === 'active')?.id ?? tunnels[0].id;

  const handleRebootClick = () => {
    if (rebootStep === 0) {
      setRebootStep(1);
      rebootTimerRef.current = setTimeout(() => setRebootStep(0), 4000);
    } else if (rebootStep === 1) {
      clearTimeout(rebootTimerRef.current);
      setRebootStep(2);
      onReboot(rebootId).finally(() => setTimeout(() => setRebootStep(0), 3000));
    }
  };

  return (
    <div style={{
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: '10px',
      boxShadow: 'var(--shadow-sm)',
      overflow: 'hidden',
    }}>
      {/* Status bar */}
      <div style={{ height: '3px', background: statusColor, opacity: anyActive ? 1 : 0.4 }} />

      <div className="p-5">
        {/* Header */}
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div
              className={`h-2 w-2 rounded-full ${anyActive ? 'pulse-dot' : ''}`}
              style={{ background: statusColor, flexShrink: 0 }}
            />
            <span className="text-sm font-semibold" style={{ color: 'var(--text)' }}>{clientName}</span>
          </div>
          <span style={{
            fontSize: '11px', fontWeight: 500, padding: '2px 10px', borderRadius: '9999px',
            color: anyActive ? 'var(--accent)' : overallStatus === 'paused' ? 'var(--amber)' : 'var(--text-dim)',
            background: anyActive ? 'var(--accent-bg)' : overallStatus === 'paused' ? 'rgba(240,165,0,0.1)' : 'var(--surface2)',
          }}>
            {tunnels.length} tunnels · {overallStatus === 'inactive' ? 'disconnected' : overallStatus}
          </span>
        </div>

        {/* Tunnel rows */}
        <div className="mb-4 space-y-2">
          {tunnels.map(tunnel => {
            const isActive = tunnel.status === 'active';
            const isPaused = tunnel.status === 'paused';
            const label = portLabel(tunnel.localPort);
            const isSsh = tunnel.localPort === 22 && tunnel.protocol === 'tcp';
            const isWeb = tunnel.protocol === 'http';

            return (
              <div key={tunnel.id} style={{
                background: 'var(--bg)',
                border: '1px solid var(--border)',
                borderRadius: '8px',
                padding: '8px 12px',
              }}>
                <div className="flex items-center justify-between gap-2">
                  {/* Port info */}
                  <div className="flex items-center gap-2 text-sm min-w-0">
                    <span style={{
                      fontSize: '10px', fontWeight: 600, padding: '1px 6px', borderRadius: '4px',
                      background: 'var(--surface2)', color: 'var(--text-mid)', flexShrink: 0,
                    }}>{label}</span>
                    {tunnel.protocol === 'tcp' ? (
                      <>
                        <span style={{ color: 'var(--accent)', fontFamily: 'var(--font-mono)', fontWeight: 600, flexShrink: 0 }}>
                          :{tunnel.allocatedPort ?? '—'}
                        </span>
                        <ArrowRight size={10} style={{ color: 'var(--text-dim)', flexShrink: 0 }} />
                        <span style={{ color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', fontSize: '11px' }}>
                          :{tunnel.localPort}
                        </span>
                      </>
                    ) : (
                      <span className="truncate" style={{ color: 'var(--accent)', fontFamily: 'var(--font-mono)', fontSize: '11px' }}>
                        {tunnel.publicUrl || '—'}
                      </span>
                    )}
                  </div>

                  {/* Row actions */}
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    {isActive && isSsh && tunnel.allocatedPort && (
                      <button
                        onClick={() => onSsh(tunnel)}
                        title="Open SSH terminal"
                        style={{ ...btnBase, padding: '3px 8px', fontSize: '11px', borderColor: 'var(--accent-dim)', color: 'var(--accent)' }}
                      >
                        <Terminal size={10} /> SSH
                      </button>
                    )}
                    {isActive && isWeb && tunnel.publicUrl && (
                      <button
                        onClick={() => onCopy(tunnel.publicUrl)}
                        title="Copy URL"
                        style={{ ...btnBase, padding: '3px 8px', fontSize: '11px', borderColor: 'var(--border)', color: 'var(--text-mid)' }}
                      >
                        <Globe size={10} /> URL
                      </button>
                    )}
                    {isActive && (
                      <button
                        onClick={() => onCopy(
                          tunnel.protocol === 'tcp' && tunnel.allocatedPort
                            ? `ssh user@${window.location.hostname} -p ${tunnel.allocatedPort}`
                            : tunnel.publicUrl
                        )}
                        title="Copy"
                        style={{ ...btnBase, padding: '3px 8px', fontSize: '11px', borderColor: 'var(--border)', color: 'var(--text-mid)' }}
                      >
                        <Copy size={10} />
                      </button>
                    )}
                    {(isActive || isPaused) && (
                      <button
                        onClick={() => onToggle(tunnel.id)}
                        title={isActive ? 'Stop tunnel' : 'Resume tunnel'}
                        style={{ ...btnBase, padding: '3px 8px', fontSize: '11px', ...(isActive ? btn.amber : btn.active) }}
                      >
                        <Power size={10} /> {isActive ? 'Stop' : 'Resume'}
                      </button>
                    )}
                    <button
                      onClick={() => onDelete(tunnel.id)}
                      title="Delete tunnel"
                      style={{ ...btnBase, padding: '3px 8px', fontSize: '11px', ...btn.danger }}
                    >
                      <Trash2 size={10} />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Card footer: reboot */}
        <div className="flex items-center gap-2">
          <button
            onClick={handleRebootClick}
            title={rebootStep === 1 ? 'Click again to confirm reboot' : 'Reboot device'}
            style={{
              ...btnBase,
              ...(rebootStep === 1
                ? { borderColor: 'rgba(200,32,32,0.4)', color: 'var(--red)' }
                : rebootStep === 2
                ? { borderColor: 'var(--border)', color: 'var(--text-dim)', opacity: 0.5 }
                : btn.ghost),
            }}
          >
            <RotateCcw size={11} />
            {rebootStep === 1 ? 'Confirm?' : rebootStep === 2 ? 'Rebooting…' : 'Reboot Device'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Single tunnel card ────────────────────────────────────────
function TunnelCard({ tunnel, onDelete, onToggle, onCopy, onReboot, onSsh }) {
  const isActive = tunnel.status === 'active';
  const isInactive = tunnel.status === 'inactive';
  const isPaused = tunnel.status === 'paused';
  const [rebootStep, setRebootStep] = useState(0);
  const rebootTimerRef = useRef(null);

  const handleRebootClick = () => {
    if (rebootStep === 0) {
      setRebootStep(1);
      rebootTimerRef.current = setTimeout(() => setRebootStep(0), 4000);
    } else if (rebootStep === 1) {
      clearTimeout(rebootTimerRef.current);
      setRebootStep(2);
      onReboot(tunnel.id).finally(() => {
        setTimeout(() => setRebootStep(0), 3000);
      });
    }
  };

  const statusColor = isActive ? 'var(--accent)' : isPaused ? 'var(--amber)' : isInactive ? 'var(--border2)' : 'var(--red)';
  const statusLabel = isInactive ? 'disconnected' : tunnel.status;

  return (
    <div style={{
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: '10px',
      boxShadow: 'var(--shadow-sm)',
      overflow: 'hidden',
    }}>
      {/* Status bar */}
      <div style={{ height: '3px', background: statusColor, opacity: isActive ? 1 : 0.4 }} />

      <div className="p-5">
        {/* Header */}
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div
              className={`h-2 w-2 rounded-full ${isActive ? 'pulse-dot' : ''}`}
              style={{ background: statusColor, flexShrink: 0 }}
            />
            <span className="text-sm font-semibold" style={{ color: 'var(--text)' }}>{tunnel.name}</span>
          </div>
          <span style={{
            fontSize: '11px', fontWeight: 500, padding: '2px 10px', borderRadius: '9999px',
            color: isActive ? 'var(--accent)' : isPaused ? 'var(--amber)' : 'var(--text-dim)',
            background: isActive ? 'var(--accent-bg)' : isPaused ? 'rgba(240,165,0,0.1)' : 'var(--surface2)',
          }}>
            {statusLabel}
          </span>
        </div>

        {/* Routing */}
        {tunnel.protocol === 'tcp' ? (
          <div className="mb-4 space-y-2">
            <div className="flex items-center gap-2 px-3 py-2.5 text-sm" style={{
              background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '8px',
            }}>
              <span style={{ color: 'var(--accent)', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>:{tunnel.allocatedPort ?? '—'}</span>
              <ArrowRight size={12} style={{ color: 'var(--text-dim)', flexShrink: 0 }} />
              <span style={{ color: 'var(--text-mid)', fontFamily: 'var(--font-mono)' }}>localhost:{tunnel.localPort}</span>
            </div>
            {tunnel.allocatedPort && (
              <div className="px-3 py-2 text-xs" style={{
                background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '8px',
                color: 'var(--text-dim)', fontFamily: 'var(--font-mono)',
              }}>
                ssh user@{window.location.hostname} -p {tunnel.allocatedPort}
              </div>
            )}
          </div>
        ) : (
          <div className="mb-4 flex items-center gap-2 px-3 py-2.5 text-sm" style={{
            background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '8px',
          }}>
            <span className="truncate" style={{ color: 'var(--accent)', fontFamily: 'var(--font-mono)' }}>{tunnel.publicUrl}</span>
            <ArrowRight size={12} style={{ color: 'var(--text-dim)', flexShrink: 0 }} />
            <span style={{ color: 'var(--text-mid)', fontFamily: 'var(--font-mono)' }}>:{tunnel.localPort}</span>
          </div>
        )}

        {/* Stats */}
        <div className="mb-4 grid grid-cols-2 gap-3">
          <div style={{ background: 'var(--surface2)', borderRadius: '8px', padding: '10px 12px' }}>
            <p className="text-xs font-medium mb-1" style={{ color: 'var(--text-dim)' }}>Connections</p>
            <p className="text-base font-semibold" style={{ color: 'var(--text)' }}>{tunnel.connections}</p>
          </div>
          <div style={{ background: 'var(--surface2)', borderRadius: '8px', padding: '10px 12px' }}>
            <p className="text-xs font-medium mb-1" style={{ color: 'var(--text-dim)' }}>Data</p>
            <p className="text-base font-semibold" style={{ color: 'var(--text)' }}>
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
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => onCopy(
              tunnel.protocol === 'tcp' && tunnel.allocatedPort
                ? `ssh user@${window.location.hostname} -p ${tunnel.allocatedPort}`
                : tunnel.publicUrl
            )}
            style={btn.ghost}
          >
            <Copy size={11} /> {tunnel.protocol === 'tcp' ? 'Copy SSH' : 'Copy URL'}
          </button>

          {isActive ? (
            <>
              {tunnel.protocol === 'tcp' && tunnel.allocatedPort && (
                <button onClick={() => onSsh(tunnel)} style={btn.active}>
                  <Terminal size={11} /> SSH
                </button>
              )}
              <button onClick={() => onToggle(tunnel.id)} style={btn.amber}>
                <Power size={11} /> Stop
              </button>
              <button
                onClick={handleRebootClick}
                title={rebootStep === 1 ? 'Click again to confirm reboot' : 'Reboot device'}
                style={{
                  ...btnBase,
                  ...(rebootStep === 1
                    ? { borderColor: 'rgba(200,32,32,0.4)', color: 'var(--red)' }
                    : rebootStep === 2
                    ? { borderColor: 'var(--border)', color: 'var(--text-dim)', opacity: 0.5 }
                    : btn.ghost),
                }}
              >
                <RotateCcw size={11} />
                {rebootStep === 1 ? 'Confirm?' : rebootStep === 2 ? 'Rebooting…' : 'Reboot'}
              </button>
            </>
          ) : isInactive ? (
            <span className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-dim)', padding: '5px 0' }}>
              <span className="h-1.5 w-1.5 rounded-full animate-pulse" style={{ background: 'var(--text-dim)' }} />
              Reconnecting…
            </span>
          ) : (
            <button onClick={() => onToggle(tunnel.id)} style={btn.active}>
              <Power size={11} /> {isPaused ? 'Resume' : 'Start'}
            </button>
          )}

          <button
            onClick={() => onDelete(tunnel.id)}
            className="ml-auto"
            style={btn.danger}
          >
            <Trash2 size={11} />
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Group tunnels by clientToken ──────────────────────────────
function groupTunnels(tunnels) {
  const groups = {};
  const ungrouped = [];
  for (const t of tunnels) {
    if (t.clientId) {
      if (!groups[t.clientId]) groups[t.clientId] = [];
      groups[t.clientId].push(t);
    } else {
      ungrouped.push(t);
    }
  }
  // Only group connections with >1 tunnel; single-tunnel connections stay as TunnelCard
  const grouped = [];
  for (const [clientId, list] of Object.entries(groups)) {
    if (list.length > 1) {
      grouped.push({ clientId, tunnels: list });
    } else {
      ungrouped.push(list[0]);
    }
  }
  return { grouped, ungrouped };
}

export default function Tunnels() {
  const [tunnels, setTunnels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [sshTunnel, setSshTunnel] = useState(null);
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
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-t-transparent" style={{ borderColor: 'var(--accent)', borderTopColor: 'transparent' }} />
      </div>
    );
  }

  const { grouped, ungrouped } = groupTunnels(tunnels);
  const totalCards = grouped.length + ungrouped.length;

  return (
    <div className="space-y-5">
      {sshTunnel && (
        <SshTerminalModal
          tunnel={sshTunnel}
          onClose={() => setSshTunnel(null)}
        />
      )}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold" style={{ color: 'var(--text)' }}>Tunnels</h1>
          <p className="mt-1 text-sm" style={{ color: 'var(--text-dim)' }}>
            Active tunnel endpoints · auto-refreshes every 5s
          </p>
        </div>
        <button
          onClick={() => load(true)}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: '6px',
            padding: '7px 16px', fontFamily: 'inherit', fontSize: '13px',
            fontWeight: 500, borderRadius: '8px', border: '1px solid var(--border)',
            color: 'var(--text-mid)', background: 'transparent', cursor: 'pointer', transition: 'all .15s',
          }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--accent-dim)'; e.currentTarget.style.color = 'var(--text)'; }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-mid)'; }}
        >
          <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {/* Copied toast */}
      {copied && (
        <div
          className="fixed bottom-5 right-5 z-50 flex items-center gap-2 px-4 py-2.5 text-sm"
          style={{
            background: 'var(--surface)',
            border: '1px solid var(--accent-dim)',
            borderRadius: '8px',
            color: 'var(--accent)',
            boxShadow: 'var(--shadow-md)',
          }}
        >
          <Check size={13} /> Copied to clipboard
        </div>
      )}

      {totalCards === 0 ? (
        <div className="flex flex-col items-center justify-center py-20" style={{
          border: '2px dashed var(--border)',
          borderRadius: '10px',
        }}>
          <p className="text-sm font-medium" style={{ color: 'var(--text-dim)' }}>No active tunnels</p>
          <p className="mt-1 text-xs" style={{ color: 'var(--text-dim)' }}>Tunnels appear automatically when a client connects</p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {grouped.map(({ clientId, tunnels: group }) => (
            <ClientCard
              key={clientId}
              tunnels={group}
              onDelete={async (id) => { await deleteTunnel(id); load(); }}
              onToggle={async (id) => { await toggleTunnel(id); load(); }}
              onCopy={handleCopy}
              onReboot={async (id) => { await rebootTunnel(id); }}
              onSsh={(t) => setSshTunnel(t)}
            />
          ))}
          {ungrouped.map((tunnel) => (
            <TunnelCard
              key={tunnel.id}
              tunnel={tunnel}
              onDelete={async (id) => { await deleteTunnel(id); load(); }}
              onToggle={async (id) => { await toggleTunnel(id); load(); }}
              onCopy={handleCopy}
              onReboot={async (id) => { await rebootTunnel(id); }}
              onSsh={(t) => setSshTunnel(t)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

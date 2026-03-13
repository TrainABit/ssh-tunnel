import { useEffect, useRef, useState, useCallback } from 'react';
import { X, Terminal, Loader, AlertCircle, KeyRound, Eye, EyeOff } from 'lucide-react';
import { getSshWsUrl } from '../services/api';

// xterm.js is loaded lazily so the bundle stays small on pages that don't need it
let xtermLoaded = false;

async function loadXterm() {
  if (xtermLoaded) return;
  // dynamic imports — bundler will include them since they're in package.json
  const [{ Terminal: XTerminal }, { FitAddon }] = await Promise.all([
    import('@xterm/xterm'),
    import('@xterm/addon-fit'),
  ]);
  // Expose on module scope for reuse
  loadXterm._Terminal = XTerminal;
  loadXterm._FitAddon = FitAddon;
  xtermLoaded = true;
}

const inputStyle = {
  width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)',
  borderRadius: '8px', color: 'var(--text)', padding: '9px 12px',
  fontFamily: 'inherit', fontSize: '13px', outline: 'none', boxSizing: 'border-box',
};

const labelStyle = {
  display: 'block', fontSize: '12px', fontWeight: 500,
  color: 'var(--text-dim)', marginBottom: '5px',
};

/**
 * SSH terminal modal.
 *
 * Props:
 *   tunnel   — tunnel object ({ id, name, allocatedPort, clientToken?, ... })
 *   onClose  — () => void
 */
export default function SshTerminalModal({ tunnel, onClose }) {
  // Phase: 'creds' | 'connecting' | 'connected' | 'error'
  const [phase, setPhase] = useState('creds');
  const [errorMsg, setErrorMsg] = useState('');

  // Credential form state
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [useStoredKey, setUseStoredKey] = useState(false);
  const [privateKey, setPrivateKey] = useState('');
  const [authMode, setAuthMode] = useState('password'); // 'password' | 'key' | 'stored'

  const termRef = useRef(null);   // DOM container
  const xtermRef = useRef(null);  // XTerminal instance
  const fitRef = useRef(null);    // FitAddon instance
  const wsRef = useRef(null);     // WebSocket

  const hasStoredKey = tunnel?.has_private_key;

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (wsRef.current) {
        try { wsRef.current.close(); } catch {}
      }
      if (xtermRef.current) {
        try { xtermRef.current.dispose(); } catch {}
      }
    };
  }, []);

  // Handle resize
  const handleResize = useCallback(() => {
    if (fitRef.current && xtermRef.current) {
      try {
        fitRef.current.fit();
        const { cols, rows } = xtermRef.current;
        if (wsRef.current?.readyState === 1) {
          wsRef.current.send(JSON.stringify({ type: 'resize', cols, rows }));
        }
      } catch {}
    }
  }, []);

  useEffect(() => {
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [handleResize]);

  const initTerminal = useCallback(async () => {
    await loadXterm();
    const XTerminal = loadXterm._Terminal;
    const FitAddon = loadXterm._FitAddon;

    if (!termRef.current) return;

    const term = new XTerminal({
      theme: {
        background: '#0d1117',
        foreground: '#e6edf3',
        cursor: '#58a6ff',
        selectionBackground: 'rgba(30,180,230,0.3)',
      },
      fontFamily: "'IBM Plex Mono', 'Cascadia Code', 'Consolas', monospace",
      fontSize: 13,
      lineHeight: 1.4,
      cursorBlink: true,
      allowTransparency: false,
      scrollback: 1000,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(termRef.current);
    fitAddon.fit();

    xtermRef.current = term;
    fitRef.current = fitAddon;

    // User typed — send to WS
    term.onData((data) => {
      if (wsRef.current?.readyState === 1) {
        wsRef.current.send(JSON.stringify({
          type: 'data',
          data: btoa(unescape(encodeURIComponent(data))),
        }));
      }
    });

    // Focus
    term.focus();
    setTimeout(() => fitAddon.fit(), 50);
  }, []);

  const connect = useCallback(async () => {
    if (!username.trim()) return;

    setPhase('connecting');

    const wsUrl = getSshWsUrl(tunnel.id);
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      // Wait for 'ready' signal before sending credentials
    };

    ws.onmessage = async (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }

      if (msg.type === 'ready') {
        // Send credentials
        const creds = { type: 'credentials', username: username.trim() };
        if (authMode === 'stored') {
          creds.useStoredKey = true;
        } else if (authMode === 'key') {
          creds.privateKey = privateKey.trim();
        } else {
          creds.password = password;
        }
        ws.send(JSON.stringify(creds));
        return;
      }

      if (msg.type === 'connected') {
        setPhase('connected');
        await initTerminal();
        return;
      }

      if (msg.type === 'error') {
        setPhase('error');
        setErrorMsg(msg.message || 'SSH connection failed');
        ws.close();
        return;
      }

      if (msg.type === 'disconnected') {
        if (xtermRef.current) {
          xtermRef.current.write('\r\n\x1b[33m[Disconnected]\x1b[0m\r\n');
        }
        return;
      }

      if (msg.type === 'data' && xtermRef.current) {
        try {
          const decoded = atob(msg.data);
          xtermRef.current.write(decoded);
        } catch {}
      }
    };

    ws.onerror = () => {
      setPhase('error');
      setErrorMsg('WebSocket connection failed');
    };

    ws.onclose = (evt) => {
      if (phase === 'connecting') {
        setPhase('error');
        setErrorMsg(`Connection closed (${evt.code})`);
      } else if (xtermRef.current) {
        xtermRef.current.write('\r\n\x1b[31m[Connection closed]\x1b[0m\r\n');
      }
    };
  }, [tunnel, username, password, authMode, privateKey, initTerminal, phase]);

  // Backdrop click to close (only when not connected)
  const handleBackdrop = (e) => {
    if (e.target === e.currentTarget && phase !== 'connected') onClose();
  };

  return (
    <div
      onClick={handleBackdrop}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '16px',
      }}
    >
      <div
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: '12px',
          boxShadow: 'var(--shadow-md)',
          width: phase === 'connected' ? 'min(900px, 100%)' : 'min(460px, 100%)',
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          transition: 'width 0.2s ease',
        }}
      >
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '14px 18px',
          borderBottom: '1px solid var(--border)',
          flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Terminal size={15} style={{ color: 'var(--accent)' }} />
            <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text)' }}>
              SSH — {tunnel.name}
            </span>
            {tunnel.allocatedPort && (
              <span style={{
                fontSize: '11px', color: 'var(--text-dim)',
                fontFamily: 'var(--font-mono)',
                background: 'var(--surface2)',
                padding: '2px 8px', borderRadius: '6px',
              }}>
                :{tunnel.allocatedPort}
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'transparent', border: 'none', cursor: 'pointer',
              color: 'var(--text-dim)', padding: '4px', borderRadius: '6px',
              display: 'flex', alignItems: 'center',
            }}
            onMouseEnter={e => e.currentTarget.style.background = 'var(--surface2)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          >
            <X size={15} />
          </button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>

          {/* Credential form */}
          {(phase === 'creds' || phase === 'error') && (
            <div style={{ padding: '20px 22px', display: 'flex', flexDirection: 'column', gap: '16px' }}>

              {phase === 'error' && (
                <div style={{
                  display: 'flex', alignItems: 'flex-start', gap: '10px',
                  padding: '12px 14px', borderRadius: '8px',
                  background: 'rgba(200,32,32,0.08)', border: '1px solid rgba(200,32,32,0.2)',
                  color: 'var(--red)', fontSize: '13px',
                }}>
                  <AlertCircle size={15} style={{ flexShrink: 0, marginTop: '1px' }} />
                  {errorMsg}
                </div>
              )}

              {/* Username */}
              <div>
                <label style={labelStyle}>Username</label>
                <input
                  type="text"
                  value={username}
                  onChange={e => setUsername(e.target.value)}
                  placeholder="root"
                  autoComplete="username"
                  style={inputStyle}
                  onFocus={e => e.target.style.borderColor = 'var(--accent)'}
                  onBlur={e => e.target.style.borderColor = 'var(--border)'}
                />
              </div>

              {/* Auth mode tabs */}
              <div>
                <label style={labelStyle}>Authentication</label>
                <div style={{ display: 'flex', gap: '6px', marginBottom: '12px' }}>
                  {[
                    { id: 'password', label: 'Password' },
                    { id: 'key', label: 'Private Key' },
                    ...(hasStoredKey ? [{ id: 'stored', label: 'Stored Key' }] : []),
                  ].map(tab => (
                    <button
                      key={tab.id}
                      onClick={() => setAuthMode(tab.id)}
                      style={{
                        padding: '5px 14px', fontSize: '12px', fontWeight: 500,
                        borderRadius: '8px', border: '1px solid',
                        cursor: 'pointer', transition: 'all .15s',
                        fontFamily: 'inherit',
                        borderColor: authMode === tab.id ? 'var(--accent-dim)' : 'var(--border)',
                        color: authMode === tab.id ? 'var(--accent)' : 'var(--text-mid)',
                        background: authMode === tab.id ? 'var(--accent-bg)' : 'transparent',
                      }}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>

                {authMode === 'password' && (
                  <div style={{ position: 'relative' }}>
                    <input
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      placeholder="Password"
                      autoComplete="current-password"
                      style={{ ...inputStyle, paddingRight: '40px' }}
                      onFocus={e => e.target.style.borderColor = 'var(--accent)'}
                      onBlur={e => e.target.style.borderColor = 'var(--border)'}
                      onKeyDown={e => e.key === 'Enter' && connect()}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(v => !v)}
                      style={{
                        position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)',
                        background: 'none', border: 'none', cursor: 'pointer',
                        color: 'var(--text-dim)', padding: '2px',
                      }}
                    >
                      {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                )}

                {authMode === 'key' && (
                  <textarea
                    value={privateKey}
                    onChange={e => setPrivateKey(e.target.value)}
                    placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;...&#10;-----END OPENSSH PRIVATE KEY-----"
                    rows={6}
                    style={{
                      ...inputStyle,
                      fontFamily: 'var(--font-mono)', fontSize: '11px',
                      resize: 'vertical', lineHeight: '1.5',
                    }}
                    onFocus={e => e.target.style.borderColor = 'var(--accent)'}
                    onBlur={e => e.target.style.borderColor = 'var(--border)'}
                  />
                )}

                {authMode === 'stored' && (
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: '8px',
                    padding: '12px 14px', borderRadius: '8px',
                    background: 'var(--accent-bg)', border: '1px solid var(--accent-dim)',
                    fontSize: '13px', color: 'var(--accent)',
                  }}>
                    <KeyRound size={14} />
                    Using stored SSH private key for this token
                  </div>
                )}
              </div>

              {/* Connect button */}
              <button
                onClick={connect}
                disabled={!username.trim() || (authMode === 'password' && !password) || (authMode === 'key' && !privateKey.trim())}
                style={{
                  padding: '10px', fontFamily: 'inherit', fontSize: '13px', fontWeight: 600,
                  borderRadius: '8px', border: 'none', cursor: 'pointer',
                  background: 'linear-gradient(90deg, #0632A0 0%, #1EB4E6 100%)',
                  color: '#fff', opacity: (!username.trim() || (authMode === 'password' && !password) || (authMode === 'key' && !privateKey.trim())) ? 0.45 : 1,
                  transition: 'opacity .15s',
                }}
              >
                Connect
              </button>
            </div>
          )}

          {/* Connecting spinner */}
          {phase === 'connecting' && (
            <div style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center',
              justifyContent: 'center', gap: '14px', padding: '60px 20px',
              color: 'var(--text-dim)', fontSize: '13px',
            }}>
              <Loader size={22} className="animate-spin" style={{ color: 'var(--accent)' }} />
              Establishing SSH connection…
            </div>
          )}

          {/* Terminal */}
          {phase === 'connected' && (
            <div
              ref={termRef}
              style={{
                background: '#0d1117',
                height: '500px',
                overflow: 'hidden',
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

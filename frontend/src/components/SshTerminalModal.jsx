import { useCallback, useEffect, useRef, useState } from 'react';
import {
  X, Terminal, Loader, AlertCircle, KeyRound, Eye, EyeOff, ShieldAlert, ShieldQuestion, RotateCcw, Check,
} from 'lucide-react';
import { getSshWsUrl, forgetHostKey, getSession, UNAUTHORIZED_EVENT } from '../services/api';

// xterm.js is loaded lazily so the bundle stays small on pages that don't need it.
let xtermModulesPromise = null;
function loadXterm() {
  if (!xtermModulesPromise) {
    xtermModulesPromise = Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')])
      .then(([xterm, fit]) => ({ Terminal: xterm.Terminal, FitAddon: fit.FitAddon }))
      .catch((err) => { xtermModulesPromise = null; throw err; });
  }
  return xtermModulesPromise;
}

// Output that arrives between {type:'connected'} and the terminal being ready is buffered (bounded).
const MAX_PENDING_OUTPUT = 4 * 1024 * 1024;
const TERMINAL_FONT = "'IBM Plex Mono', 'Cascadia Code', 'Consolas', monospace";
const encoder = new TextEncoder();

const inputStyle = {
  width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)',
  borderRadius: '8px', color: 'var(--text)', padding: '9px 12px',
  fontFamily: 'inherit', fontSize: '13px', outline: 'none', boxSizing: 'border-box',
};

const labelStyle = {
  display: 'block', fontSize: '12px', fontWeight: 500,
  color: 'var(--text-dim)', marginBottom: '5px',
};

const monoBox = {
  fontFamily: 'var(--font-mono)', fontSize: '12px', wordBreak: 'break-all',
  background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '6px', padding: '8px 10px',
  color: 'var(--text)', userSelect: 'all',
};

const buttonBase = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
  padding: '9px 14px', fontFamily: 'inherit', fontSize: '13px', fontWeight: 600,
  borderRadius: '8px', cursor: 'pointer', transition: 'opacity .15s',
};
const primaryButton = { ...buttonBase, border: 'none', background: 'linear-gradient(90deg, #0632A0 0%, #1EB4E6 100%)', color: '#fff' };
const ghostButton = { ...buttonBase, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-mid)' };
const dangerButton = { ...buttonBase, border: '1px solid rgba(200,32,32,0.45)', background: 'rgba(200,32,32,0.08)', color: 'var(--red)' };

function asText(v) {
  return typeof v === 'string' ? v : '';
}

/** Strip control characters so server-provided text cannot inject terminal escape sequences. */
function plain(text) {
  let out = '';
  for (const ch of String(text)) {
    const c = ch.codePointAt(0);
    out += c < 0x20 || (c >= 0x7f && c <= 0x9f) ? ' ' : ch;
    if (out.length >= 500) break;
  }
  return out;
}

/** Path of the OpenSSH host public key that matches a key type, for verification hints. */
function hostKeyFile(keyType) {
  const t = String(keyType || '').toLowerCase();
  if (t.includes('ed25519')) return '/etc/ssh/ssh_host_ed25519_key.pub';
  if (t.includes('ecdsa')) return '/etc/ssh/ssh_host_ecdsa_key.pub';
  if (t.includes('rsa')) return '/etc/ssh/ssh_host_rsa_key.pub';
  return '/etc/ssh/ssh_host_*_key.pub';
}

function closeMessage(evt, opened) {
  const reason = evt && evt.reason ? `: ${plain(evt.reason)}` : '';
  if (!opened) {
    return 'Could not open the web terminal connection. The server may be unreachable, the request was rate limited, '
      + 'or your dashboard session has expired.';
  }
  if (evt && evt.code === 1008) return `The server refused the connection${reason || '.'}`;
  return `Connection closed (${evt ? evt.code : '?'}${reason})`;
}

function sendJson(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

/**
 * Browser SSH terminal for a TCP tunnel.
 *
 * Protocol (/ws/ssh, authenticated by the dashboard session cookie):
 *   server {type:'ready'} -> browser {type:'credentials', username, password | privateKey[,passphrase] | useStoredKey}
 *   server {type:'hostkey-unknown', fingerprint, keyType} -> browser {type:'hostkey-accept'} | {type:'hostkey-reject'}
 *   server {type:'hostkey-mismatch', expected, actual, keyType} (connection refused)
 *   server {type:'connected'} -> terminal bytes as binary frames in both directions,
 *   browser {type:'resize', cols, rows}; server {type:'disconnected'} | {type:'error', message}
 *
 * Props:
 *   tunnel   — { id, name, allocatedPort, has_private_key?, host_key_fingerprint? }
 *   onClose  — () => void
 *   onHostKeyChange — optional () => void, called after the pinned host key was forgotten
 */
export default function SshTerminalModal({ tunnel, onClose, onHostKeyChange }) {
  // 'creds' | 'connecting' | 'hostkey-unknown' | 'hostkey-mismatch' | 'connected' | 'closed' | 'error'
  const [phase, setPhase] = useState('creds');
  const [errorMsg, setErrorMsg] = useState('');
  const [hostKey, setHostKey] = useState(null);
  const [forget, setForget] = useState({ state: 'idle', error: '' }); // idle | confirm | busy | done | error

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [privateKey, setPrivateKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [authMode, setAuthMode] = useState('password'); // 'password' | 'key' | 'stored'

  const containerRef = useRef(null); // DOM node xterm renders into
  const termRef = useRef(null);      // xterm Terminal
  const fitRef = useRef(null);       // FitAddon
  const wsRef = useRef(null);        // current WebSocket
  const phaseRef = useRef('creds');
  const pendingRef = useRef({ chunks: [], bytes: 0, dropped: false });

  const hasStoredKey = tunnel?.has_private_key === true || tunnel?.has_private_key === 1;
  const pinnedFingerprint = typeof tunnel?.host_key_fingerprint === 'string' ? tunnel.host_key_fingerprint : '';
  // The stored key can be removed while the dialog is open: fall back to password auth.
  const mode = authMode === 'stored' && !hasStoredKey ? 'password' : authMode;

  const goto = useCallback((next) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const closeSocket = useCallback(() => {
    const ws = wsRef.current;
    wsRef.current = null;
    if (!ws) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    try { ws.close(1000, 'closed by user'); } catch { /* already closed */ }
  }, []);

  const disposeTerminal = useCallback(() => {
    const term = termRef.current;
    termRef.current = null;
    fitRef.current = null;
    if (term) {
      try { term.dispose(); } catch { /* ignore */ }
    }
  }, []);

  // Tear everything down on unmount.
  useEffect(() => () => {
    closeSocket();
    disposeTerminal();
  }, [closeSocket, disposeTerminal]);

  const sendBinary = useCallback((bytes) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN && phaseRef.current === 'connected') ws.send(bytes);
  }, []);

  const sendResize = useCallback((cols, rows) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || phaseRef.current !== 'connected') return;
    const c = Math.min(1000, Math.max(1, Math.floor(cols) || 1));
    const r = Math.min(1000, Math.max(1, Math.floor(rows) || 1));
    ws.send(JSON.stringify({ type: 'resize', cols: c, rows: r }));
  }, []);

  const writeOutput = useCallback((bytes) => {
    const term = termRef.current;
    if (term) {
      term.write(bytes);
      return;
    }
    const pending = pendingRef.current;
    if (pending.bytes + bytes.length <= MAX_PENDING_OUTPUT) {
      pending.chunks.push(bytes);
      pending.bytes += bytes.length;
    } else {
      pending.dropped = true;
    }
  }, []);

  const writeNotice = useCallback((text) => {
    writeOutput(encoder.encode(text));
  }, [writeOutput]);

  const fitTerminal = useCallback(() => {
    if (!fitRef.current || !termRef.current) return;
    try { fitRef.current.fit(); } catch { /* container not measurable (hidden) */ }
  }, []);

  // Create the terminal once the container is rendered (phase 'connected' or 'closed').
  useEffect(() => {
    if ((phase !== 'connected' && phase !== 'closed') || termRef.current) return undefined;
    let cancelled = false;
    (async () => {
      let mods;
      try {
        mods = await loadXterm();
      } catch {
        if (!cancelled) {
          closeSocket();
          setErrorMsg('Failed to load the terminal component. Reload the page and try again.');
          goto('error');
        }
        return;
      }
      // Measure glyphs with the real font (avoids a mis-sized grid on first open).
      try {
        if (document.fonts && document.fonts.load) {
          await Promise.race([
            document.fonts.load(`13px ${TERMINAL_FONT}`),
            new Promise((resolve) => setTimeout(resolve, 1500)),
          ]);
        }
      } catch { /* font loading is best effort */ }
      if (cancelled || termRef.current || !containerRef.current) return;

      const term = new mods.Terminal({
        theme: {
          background: '#0d1117',
          foreground: '#e6edf3',
          cursor: '#58a6ff',
          selectionBackground: 'rgba(30,180,230,0.3)',
        },
        fontFamily: TERMINAL_FONT,
        fontSize: 13,
        lineHeight: 1.2,
        cursorBlink: true,
        allowTransparency: false,
        scrollback: 5000,
      });
      const fit = new mods.FitAddon();
      term.loadAddon(fit);
      term.open(containerRef.current);
      termRef.current = term;
      fitRef.current = fit;

      // Keystrokes -> UTF-8 binary frames.
      term.onData((data) => sendBinary(encoder.encode(data)));
      // Binary (non UTF-8) input, e.g. some mouse reports: one byte per char code.
      term.onBinary((data) => {
        const bytes = new Uint8Array(data.length);
        for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 0xff;
        sendBinary(bytes);
      });
      term.onResize(({ cols, rows }) => sendResize(cols, rows));

      fitTerminal();
      const pending = pendingRef.current;
      pendingRef.current = { chunks: [], bytes: 0, dropped: false };
      for (const chunk of pending.chunks) term.write(chunk);
      if (pending.dropped) term.write('\r\n\x1b[33m[Some output was dropped while the terminal was loading]\x1b[0m\r\n');
      sendResize(term.cols, term.rows);
      term.focus();
    })();
    return () => { cancelled = true; };
  }, [phase, closeSocket, goto, fitTerminal, sendBinary, sendResize]);

  // Keep the terminal sized to its container.
  useEffect(() => {
    if (phase !== 'connected' && phase !== 'closed') return undefined;
    const el = containerRef.current;
    if (el && typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => fitTerminal());
      ro.observe(el);
      return () => ro.disconnect();
    }
    window.addEventListener('resize', fitTerminal);
    return () => window.removeEventListener('resize', fitTerminal);
  }, [phase, fitTerminal]);

  const connect = useCallback(() => {
    const user = username.trim();
    if (!user || !tunnel) return;
    let credentials = { type: 'credentials', username: user };
    if (mode === 'stored') {
      credentials.useStoredKey = true;
    } else if (mode === 'key') {
      credentials.privateKey = privateKey.trim();
      if (passphrase) credentials.passphrase = passphrase;
    } else {
      credentials.password = password;
    }

    closeSocket();
    disposeTerminal();
    pendingRef.current = { chunks: [], bytes: 0, dropped: false };
    setErrorMsg('');
    setHostKey(null);
    setForget({ state: 'idle', error: '' });
    goto('connecting');

    let ws;
    try {
      ws = new WebSocket(getSshWsUrl(tunnel.id));
    } catch (err) {
      setErrorMsg(`Could not open the web terminal connection: ${plain(err && err.message ? err.message : err)}`);
      goto('error');
      return;
    }
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;
    let opened = false;

    ws.onopen = () => { opened = true; };

    ws.onmessage = (evt) => {
      if (wsRef.current !== ws) return;
      if (typeof evt.data !== 'string') {
        // Terminal output: raw bytes, xterm decodes UTF-8 (including sequences split across frames).
        writeOutput(new Uint8Array(evt.data));
        return;
      }
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }
      if (!msg || typeof msg.type !== 'string') return;

      switch (msg.type) {
        case 'ready':
          if (credentials) {
            sendJson(ws, credentials);
            credentials = null; // do not keep secrets around longer than needed
          }
          break;
        case 'hostkey-unknown':
          setHostKey({ fingerprint: asText(msg.fingerprint), keyType: asText(msg.keyType) });
          goto('hostkey-unknown');
          break;
        case 'hostkey-mismatch':
          setHostKey({ expected: asText(msg.expected), actual: asText(msg.actual), keyType: asText(msg.keyType) });
          goto('hostkey-mismatch');
          break;
        case 'connected':
          setPassword('');
          setPrivateKey('');
          setPassphrase('');
          goto('connected');
          break;
        case 'disconnected':
          writeNotice('\r\n\x1b[33m[Disconnected]\x1b[0m\r\n');
          if (phaseRef.current === 'connected') goto('closed');
          break;
        case 'error': {
          const message = plain(asText(msg.message) || 'SSH connection failed');
          const current = phaseRef.current;
          if (current === 'connected' || current === 'closed') {
            writeNotice(`\r\n\x1b[31m[Error: ${message}]\x1b[0m\r\n`);
          } else if (current !== 'hostkey-mismatch') {
            // (On a host key mismatch the dedicated warning stays on screen.)
            setErrorMsg(message);
            goto('error');
          }
          break;
        }
        default:
          break; // unknown control message: ignore
      }
    };

    ws.onerror = () => { /* details arrive with the close event */ };

    ws.onclose = (evt) => {
      if (wsRef.current !== ws) return;
      wsRef.current = null;
      const current = phaseRef.current;
      if (current === 'connected') {
        writeNotice('\r\n\x1b[31m[Connection closed]\x1b[0m\r\n');
        goto('closed');
      } else if (current === 'connecting' || current === 'hostkey-unknown') {
        setErrorMsg(current === 'hostkey-unknown'
          ? 'The connection closed before the host key was confirmed (the server waits at most 60 seconds). Connect again.'
          : closeMessage(evt, opened));
        goto('error');
        if (!opened) {
          // The upgrade was refused before it opened: if the session expired, go back to the login screen.
          getSession().then((s) => {
            if (s.authRequired && !s.authenticated) window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
          }, () => { /* server unreachable: the error message already says so */ });
        }
      }
      // 'hostkey-mismatch', 'error', 'closed': keep what is on screen.
    };
  }, [tunnel, username, password, privateKey, passphrase, mode, closeSocket, disposeTerminal, goto, writeOutput, writeNotice]);

  const acceptHostKey = () => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      sendJson(ws, { type: 'hostkey-accept' });
      goto('connecting');
    } else {
      setErrorMsg('The connection closed before the host key was confirmed. Connect again.');
      goto('error');
    }
  };

  const rejectHostKey = () => {
    sendJson(wsRef.current, { type: 'hostkey-reject' });
    closeSocket();
    setHostKey(null);
    setErrorMsg('Host key not trusted. The connection was cancelled.');
    goto('error');
  };

  const doForgetHostKey = async () => {
    setForget({ state: 'busy', error: '' });
    try {
      await forgetHostKey(tunnel.id);
      setForget({ state: 'done', error: '' });
      if (onHostKeyChange) onHostKeyChange();
    } catch (err) {
      setForget({ state: 'error', error: err && err.message ? err.message : 'Request failed' });
    }
  };

  const backToCredentials = () => {
    closeSocket();
    disposeTerminal();
    setHostKey(null);
    setErrorMsg('');
    setForget({ state: 'idle', error: '' });
    goto('creds');
  };

  // Escape closes the dialog, except while the terminal is shown (Escape belongs to the remote shell there).
  useEffect(() => {
    if (phase === 'connected' || phase === 'closed') return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, onClose]);

  const handleBackdrop = (e) => {
    if (e.target === e.currentTarget && phase !== 'connected' && phase !== 'closed') onClose();
  };

  const showTerminal = phase === 'connected' || phase === 'closed';
  const canConnect = !!username.trim()
    && !(mode === 'password' && !password)
    && !(mode === 'key' && !privateKey.trim());

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
        role="dialog"
        aria-modal="true"
        aria-label={`SSH terminal for ${tunnel.name}`}
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: '12px',
          boxShadow: 'var(--shadow-md)',
          width: showTerminal ? 'min(960px, 100%)' : 'min(500px, 100%)',
          maxHeight: '92vh',
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
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
            <Terminal size={15} style={{ color: 'var(--accent)', flexShrink: 0 }} />
            <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
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
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              background: 'transparent', border: 'none', cursor: 'pointer',
              color: 'var(--text-dim)', padding: '4px', borderRadius: '6px',
              display: 'flex', alignItems: 'center',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface2)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          >
            <X size={15} />
          </button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>

          {/* Credential form */}
          {(phase === 'creds' || phase === 'error') && (
            <form
              onSubmit={(e) => { e.preventDefault(); if (canConnect) connect(); }}
              style={{ padding: '20px 22px', display: 'flex', flexDirection: 'column', gap: '16px' }}
            >
              {phase === 'error' && errorMsg && (
                <div role="alert" style={{
                  display: 'flex', alignItems: 'flex-start', gap: '10px',
                  padding: '12px 14px', borderRadius: '8px',
                  background: 'rgba(200,32,32,0.08)', border: '1px solid rgba(200,32,32,0.2)',
                  color: 'var(--red)', fontSize: '13px', overflowWrap: 'anywhere',
                }}>
                  <AlertCircle size={15} style={{ flexShrink: 0, marginTop: '1px' }} />
                  {errorMsg}
                </div>
              )}

              <div>
                <label htmlFor="ssh-username" style={labelStyle}>Username</label>
                <input
                  id="ssh-username"
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="root"
                  autoComplete="username"
                  spellCheck={false}
                  autoFocus
                  style={inputStyle}
                  onFocus={(e) => { e.target.style.borderColor = 'var(--accent)'; }}
                  onBlur={(e) => { e.target.style.borderColor = 'var(--border)'; }}
                />
              </div>

              <div>
                <span style={labelStyle}>Authentication</span>
                <div role="tablist" style={{ display: 'flex', gap: '6px', marginBottom: '12px', flexWrap: 'wrap' }}>
                  {[
                    { id: 'password', label: 'Password' },
                    { id: 'key', label: 'Private Key' },
                    ...(hasStoredKey ? [{ id: 'stored', label: 'Stored Key' }] : []),
                  ].map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      role="tab"
                      aria-selected={mode === tab.id}
                      onClick={() => setAuthMode(tab.id)}
                      style={{
                        padding: '5px 14px', fontSize: '12px', fontWeight: 500,
                        borderRadius: '8px', border: '1px solid',
                        cursor: 'pointer', transition: 'all .15s',
                        fontFamily: 'inherit',
                        borderColor: mode === tab.id ? 'var(--accent-dim)' : 'var(--border)',
                        color: mode === tab.id ? 'var(--accent)' : 'var(--text-mid)',
                        background: mode === tab.id ? 'var(--accent-bg)' : 'transparent',
                      }}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>

                {mode === 'password' && (
                  <div style={{ position: 'relative' }}>
                    <input
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Password"
                      aria-label="Password"
                      autoComplete="current-password"
                      style={{ ...inputStyle, paddingRight: '40px' }}
                      onFocus={(e) => { e.target.style.borderColor = 'var(--accent)'; }}
                      onBlur={(e) => { e.target.style.borderColor = 'var(--border)'; }}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
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

                {mode === 'key' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <textarea
                      value={privateKey}
                      onChange={(e) => setPrivateKey(e.target.value)}
                      placeholder={'-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----'}
                      aria-label="Private key"
                      rows={6}
                      spellCheck={false}
                      autoComplete="off"
                      style={{
                        ...inputStyle,
                        fontFamily: 'var(--font-mono)', fontSize: '11px',
                        resize: 'vertical', lineHeight: '1.5',
                      }}
                      onFocus={(e) => { e.target.style.borderColor = 'var(--accent)'; }}
                      onBlur={(e) => { e.target.style.borderColor = 'var(--border)'; }}
                    />
                    <input
                      type="password"
                      value={passphrase}
                      onChange={(e) => setPassphrase(e.target.value)}
                      placeholder="Key passphrase (if the key is encrypted)"
                      aria-label="Key passphrase"
                      autoComplete="off"
                      style={inputStyle}
                      onFocus={(e) => { e.target.style.borderColor = 'var(--accent)'; }}
                      onBlur={(e) => { e.target.style.borderColor = 'var(--border)'; }}
                    />
                    <p style={{ margin: 0, fontSize: '11px', color: 'var(--text-dim)' }}>
                      The key is sent to the TunnelVault server for this session only and is not stored.
                    </p>
                  </div>
                )}

                {mode === 'stored' && (
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: '8px',
                    padding: '12px 14px', borderRadius: '8px',
                    background: 'var(--accent-bg)', border: '1px solid var(--accent-dim)',
                    fontSize: '13px', color: 'var(--accent)',
                  }}>
                    <KeyRound size={14} />
                    Using the SSH private key stored (encrypted) for this device&apos;s token
                  </div>
                )}
              </div>

              {pinnedFingerprint && (
                <p style={{ margin: 0, fontSize: '11px', color: 'var(--text-dim)', overflowWrap: 'anywhere' }}>
                  Pinned host key: <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-mid)' }}>{pinnedFingerprint}</span>
                </p>
              )}

              <button
                type="submit"
                disabled={!canConnect}
                style={{ ...primaryButton, padding: '10px', opacity: canConnect ? 1 : 0.45, cursor: canConnect ? 'pointer' : 'default' }}
              >
                Connect
              </button>
            </form>
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

          {/* First connection: ask the admin to verify and trust the host key */}
          {phase === 'hostkey-unknown' && hostKey && (
            <div style={{ padding: '20px 22px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', color: 'var(--amber)' }}>
                <ShieldQuestion size={18} />
                <span style={{ fontSize: '14px', fontWeight: 600 }}>Verify the device&apos;s SSH host key</span>
              </div>
              <p style={{ margin: 0, fontSize: '13px', color: 'var(--text-mid)', lineHeight: 1.6 }}>
                No host key is pinned for this device yet. Compare this fingerprint with the device&apos;s real key
                before trusting it. Once trusted, the key is pinned and future connections are refused if it changes.
              </p>
              <div>
                <span style={labelStyle}>Key type</span>
                <div style={monoBox}>{hostKey.keyType || 'unknown'}</div>
              </div>
              <div>
                <span style={labelStyle}>Fingerprint</span>
                <div style={monoBox} data-testid="hostkey-fingerprint">{hostKey.fingerprint || 'unknown'}</div>
              </div>
              <p style={{ margin: 0, fontSize: '12px', color: 'var(--text-dim)' }}>
                On the device: <code style={{ fontFamily: 'var(--font-mono)' }}>ssh-keygen -lf {hostKeyFile(hostKey.keyType)}</code>
                {' '}· The server waits at most 60 seconds for your decision.
              </p>
              <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                <button type="button" onClick={rejectHostKey} style={ghostButton}>Cancel</button>
                <button type="button" onClick={acceptHostKey} style={primaryButton}>
                  <Check size={13} /> Trust &amp; connect
                </button>
              </div>
            </div>
          )}

          {/* Pinned host key changed: possible man-in-the-middle */}
          {phase === 'hostkey-mismatch' && hostKey && (
            <div style={{ padding: '20px 22px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div role="alert" style={{
                display: 'flex', flexDirection: 'column', gap: '8px',
                padding: '14px 16px', borderRadius: '8px',
                background: 'rgba(200,32,32,0.1)', border: '2px solid var(--red)', color: 'var(--red)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <ShieldAlert size={20} />
                  <span style={{ fontSize: '15px', fontWeight: 700 }}>Warning: the device&apos;s host key has changed</span>
                </div>
                <p style={{ margin: 0, fontSize: '13px', lineHeight: 1.6 }}>
                  The device answered with a different SSH host key than the one pinned for it. Someone could be
                  intercepting the connection (man-in-the-middle), or the device was reinstalled and its host keys
                  were regenerated. The connection was refused before your credentials were used.
                </p>
              </div>
              <div>
                <span style={labelStyle}>Pinned (expected)</span>
                <div style={monoBox} data-testid="hostkey-expected">{hostKey.expected || 'unknown'}</div>
              </div>
              <div>
                <span style={labelStyle}>Presented now{hostKey.keyType ? ` (${hostKey.keyType})` : ''}</span>
                <div style={{ ...monoBox, borderColor: 'rgba(200,32,32,0.45)' }} data-testid="hostkey-actual">{hostKey.actual || 'unknown'}</div>
              </div>
              <p style={{ margin: 0, fontSize: '12px', color: 'var(--text-dim)', lineHeight: 1.6 }}>
                Only forget the pinned key after verifying the new fingerprint on the device itself
                (<code style={{ fontFamily: 'var(--font-mono)' }}>ssh-keygen -lf {hostKeyFile(hostKey.keyType)}</code>).
              </p>

              {forget.state === 'done' ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  <div role="status" style={{ fontSize: '13px', color: 'var(--accent)' }}>
                    The pinned key was removed. Connect again and compare the fingerprint before trusting the new key.
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                    <button type="button" onClick={onClose} style={ghostButton}>Close</button>
                    <button type="button" onClick={backToCredentials} style={primaryButton}>Connect again</button>
                  </div>
                </div>
              ) : forget.state === 'confirm' || forget.state === 'busy' ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  <p style={{ margin: 0, fontSize: '13px', color: 'var(--text)' }}>
                    Forget the pinned host key for this device? The next connection will ask you to trust whatever key the device presents.
                  </p>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', flexWrap: 'wrap' }}>
                    <button type="button" onClick={() => setForget({ state: 'idle', error: '' })} disabled={forget.state === 'busy'} style={ghostButton}>
                      Cancel
                    </button>
                    <button type="button" onClick={doForgetHostKey} disabled={forget.state === 'busy'} style={{ ...dangerButton, opacity: forget.state === 'busy' ? 0.6 : 1 }}>
                      {forget.state === 'busy' ? 'Forgetting…' : 'Yes, forget pinned key'}
                    </button>
                  </div>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {forget.state === 'error' && (
                    <div role="alert" style={{ fontSize: '13px', color: 'var(--red)' }}>Could not forget the key: {forget.error}</div>
                  )}
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', flexWrap: 'wrap' }}>
                    <button type="button" onClick={() => setForget({ state: 'confirm', error: '' })} style={dangerButton}>
                      Forget pinned key…
                    </button>
                    <button type="button" onClick={onClose} style={ghostButton}>Close</button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Terminal (kept mounted while the session is open and after it ended) */}
          {showTerminal && (
            <div>
              <div
                ref={containerRef}
                data-testid="ssh-terminal"
                style={{ background: '#0d1117', height: 'min(500px, 65vh)', overflow: 'hidden', padding: '4px' }}
              />
              {phase === 'closed' && (
                <div style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px',
                  padding: '10px 16px', borderTop: '1px solid var(--border)', fontSize: '12px', color: 'var(--text-dim)',
                }}>
                  <span>Session ended.</span>
                  <button type="button" onClick={backToCredentials} style={{ ...ghostButton, padding: '6px 12px', fontSize: '12px' }}>
                    <RotateCcw size={12} /> Reconnect
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

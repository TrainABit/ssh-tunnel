import { useState, useEffect } from 'react';
import { getAuthToken, setAuthToken } from '../services/api';
import TunnelVaultLogo from '../assets/TunnelVaultLogo';

export default function AuthGate({ children }) {
  const [authenticated, setAuthenticated] = useState(null);
  const [token, setToken] = useState('');
  const [error, setError] = useState('');

  useEffect(() => { checkAuth(); }, []);

  async function checkAuth() {
    const stored = getAuthToken();
    try {
      const res = await fetch('/api/stats', {
        headers: stored ? { Authorization: `Bearer ${stored}` } : {},
      });
      setAuthenticated(res.ok || res.status !== 401);
    } catch {
      setAuthenticated(true);
    }
  }

  async function handleLogin(e) {
    e.preventDefault();
    if (!token.trim()) { setError('Please enter your AUTH_TOKEN'); return; }
    setAuthToken(token.trim());
    setError('');
    try {
      const res = await fetch('/api/stats', { headers: { Authorization: `Bearer ${token.trim()}` } });
      if (res.ok) { setAuthenticated(true); window.location.reload(); }
      else setError('Invalid token. Check your server .env file.');
    } catch {
      setError('Cannot reach server. Is the backend running?');
    }
  }

  if (authenticated === null) {
    return (
      <div style={{ display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)' }}>
        <div style={{ width: '28px', height: '28px', borderRadius: '50%', border: '2px solid var(--accent)', borderTopColor: 'transparent', animation: 'spin 0.8s linear infinite' }} />
      </div>
    );
  }

  if (authenticated) return children;

  return (
    <div style={{ display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)', padding: '20px' }}>
      <div style={{ width: '100%', maxWidth: '420px' }}>

        {/* Brand header */}
        <div style={{
          background: 'linear-gradient(135deg, #04133e 0%, #0632A0 60%, #1EB4E6 100%)',
          padding: '32px 36px 28px',
          borderRadius: '12px 12px 0 0',
          textAlign: 'center',
          position: 'relative',
          overflow: 'hidden',
        }}>
          <div style={{
            position: 'absolute', inset: 0, opacity: 0.06,
            backgroundImage: 'linear-gradient(rgba(255,255,255,.5) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.5) 1px, transparent 1px)',
            backgroundSize: '24px 24px',
          }} />
          <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px' }}>
            <TunnelVaultLogo height={26} />
            <div style={{ fontSize: '10px', letterSpacing: '0.25em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.55)', fontWeight: 500 }}>
              TunnelVault Dashboard
            </div>
          </div>
        </div>

        {/* Login form */}
        <div style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderTop: 'none',
          padding: '28px 32px 32px',
          borderRadius: '0 0 12px 12px',
          boxShadow: 'var(--shadow-md)',
        }}>
          <p style={{ fontSize: '13px', color: 'var(--text-dim)', marginBottom: '24px', marginTop: 0, textAlign: 'center' }}>
            Enter your AUTH_TOKEN to access the dashboard
          </p>

          <form onSubmit={handleLogin}>
            <div style={{ marginBottom: '16px' }}>
              <label style={{ display: 'block', fontSize: '11px', fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--text-mid)', marginBottom: '6px' }}>
                AUTH_TOKEN
              </label>
              <input
                type="password"
                value={token}
                onChange={e => setToken(e.target.value)}
                placeholder="Enter token from server .env…"
                autoFocus
                style={{
                  width: '100%', background: 'var(--bg)', border: '1px solid var(--border)',
                  borderRadius: '8px', color: 'var(--text)', fontFamily: 'inherit', fontSize: '13px',
                  padding: '10px 14px', outline: 'none', boxSizing: 'border-box',
                  transition: 'border-color .15s',
                }}
                onFocus={e => e.target.style.borderColor = 'var(--accent)'}
                onBlur={e => e.target.style.borderColor = 'var(--border)'}
              />
              {error && (
                <p style={{ fontSize: '12px', color: 'var(--red)', marginTop: '6px', marginBottom: 0 }}>{error}</p>
              )}
            </div>

            <button
              type="submit"
              style={{
                width: '100%',
                background: 'linear-gradient(90deg, #0632A0 0%, #1EB4E6 100%)',
                border: 'none', borderRadius: '8px',
                color: '#ffffff', fontFamily: 'inherit', fontSize: '13px',
                fontWeight: 600, padding: '12px',
                cursor: 'pointer', transition: 'opacity .15s',
              }}
              onMouseEnter={e => e.currentTarget.style.opacity = '0.88'}
              onMouseLeave={e => e.currentTarget.style.opacity = '1'}
            >
              Authenticate
            </button>

            <p style={{ marginTop: '16px', textAlign: 'center', fontSize: '12px', color: 'var(--text-dim)', marginBottom: 0 }}>
              Find your token in{' '}
              <code style={{ color: 'var(--blue)', background: 'var(--surface2)', padding: '2px 6px', borderRadius: '4px', fontFamily: 'var(--font-mono)' }}>backend/.env</code>
              {' '}→ AUTH_TOKEN
            </p>
          </form>
        </div>

      </div>
    </div>
  );
}

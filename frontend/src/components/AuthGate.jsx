import { useState, useEffect } from 'react';
import { Shield } from 'lucide-react';
import { getAuthToken, setAuthToken } from '../services/api';

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
        <div style={{ width: '24px', height: '24px', borderRadius: '50%', border: '2px solid var(--green)', borderTopColor: 'transparent', animation: 'spin 0.8s linear infinite' }} />
      </div>
    );
  }

  if (authenticated) return children;

  return (
    <div style={{ display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)', padding: '16px' }}>
      <div style={{ width: '100%', maxWidth: '380px' }}>
        {/* Logo */}
        <div style={{ textAlign: 'center', marginBottom: '32px' }}>
          <div style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: '48px', height: '48px', border: '1.5px solid var(--green)',
            color: 'var(--green)', marginBottom: '12px', position: 'relative',
          }}>
            <div style={{ position: 'absolute', inset: '5px', border: '1px solid var(--green-dim)', opacity: 0.5 }} />
            <Shield size={18} strokeWidth={1.5} />
          </div>
          <div style={{ fontSize: '12px', letterSpacing: '.18em', textTransform: 'uppercase', color: 'var(--text)' }}>
            TunnelVault
          </div>
          <div style={{ fontSize: '10px', color: 'var(--text-dim)', marginTop: '4px' }}>
            Enter AUTH_TOKEN to access the dashboard
          </div>
        </div>

        <form onSubmit={handleLogin}>
          <div style={{ marginBottom: '12px' }}>
            <label style={{ display: 'block', fontSize: '9.5px', letterSpacing: '.15em', textTransform: 'uppercase', color: 'var(--text-dim)', marginBottom: '6px' }}>
              AUTH_TOKEN
            </label>
            <input
              type="password"
              value={token}
              onChange={e => setToken(e.target.value)}
              placeholder="Enter token from server .env..."
              autoFocus
              style={{
                width: '100%', background: 'var(--surface)', border: '1px solid var(--border2)',
                color: 'var(--text)', fontFamily: 'inherit', fontSize: '12px',
                padding: '10px 12px', outline: 'none', boxSizing: 'border-box',
              }}
              onFocus={e => e.target.style.borderColor = 'var(--green-dim)'}
              onBlur={e => e.target.style.borderColor = 'var(--border2)'}
            />
            {error && (
              <p style={{ fontSize: '11px', color: 'var(--red)', marginTop: '6px' }}>{error}</p>
            )}
          </div>

          <button
            type="submit"
            style={{
              width: '100%', background: 'var(--green)', border: '1px solid var(--green)',
              color: '#040d0a', fontFamily: 'inherit', fontSize: '10.5px',
              letterSpacing: '.09em', textTransform: 'uppercase', fontWeight: 600,
              padding: '10px', cursor: 'pointer', transition: 'background .15s',
            }}
            onMouseEnter={e => e.currentTarget.style.background = '#00f599'}
            onMouseLeave={e => e.currentTarget.style.background = 'var(--green)'}
          >
            Authenticate
          </button>

          <p style={{ marginTop: '12px', textAlign: 'center', fontSize: '10.5px', color: 'var(--text-dim)' }}>
            Find your token in{' '}
            <code style={{ color: 'var(--blue)', background: 'var(--surface)', padding: '1px 6px' }}>backend/.env</code>
            {' '}→ AUTH_TOKEN
          </p>
        </form>
      </div>
    </div>
  );
}

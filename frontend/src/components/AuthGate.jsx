import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, RefreshCw, ShieldAlert } from 'lucide-react';
import { getSession, getSessionKey, login, logout as apiLogout, UNAUTHORIZED_EVENT } from '../services/api';
import { AuthContext } from '../auth/AuthContext';
import { isInsecurePublicUrl } from '../utils/serverUrl';
import TunnelVaultLogo from '../assets/TunnelVaultLogo';

const SESSION_EXPIRED = 'Your session has expired. Please sign in again.';

function sessionErrorMessage(err) {
  const status = err && typeof err.status === 'number' ? err.status : 0;
  if (status === 429) return 'Too many attempts. Please wait a minute, then retry.';
  if (status === 0 || status >= 500) return 'Cannot reach the server. Check that the TunnelVault backend is running, then retry.';
  if (status === 404) return 'This server does not support dashboard sign-in (GET /api/auth/session not found). Update the TunnelVault backend.';
  return (err && err.message) || 'Unexpected error while checking the session.';
}

function loginErrorMessage(err) {
  const status = err && typeof err.status === 'number' ? err.status : 0;
  if (status === 401) return 'Invalid token.';
  if (status === 429) return 'Too many attempts. Please wait a minute before trying again.';
  if (status === 0) return 'Cannot reach the server. Is the backend running?';
  if (status >= 500) return `The server reported an error (HTTP ${status}). Please try again later.`;
  return (err && err.message) || 'Sign-in failed.';
}

function Spinner() {
  return (
    <div
      role="status"
      aria-label="Loading"
      style={{ width: '28px', height: '28px', borderRadius: '50%', border: '2px solid var(--accent)', borderTopColor: 'transparent', animation: 'spin 0.8s linear infinite' }}
    />
  );
}

function Card({ children }) {
  return (
    <div style={{ display: 'flex', minHeight: '100vh', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)', padding: '20px' }}>
      <div style={{ width: '100%', maxWidth: '420px' }}>
        <div style={{
          background: 'linear-gradient(135deg, #04133e 0%, #0632A0 60%, #1EB4E6 100%)',
          padding: '30px 36px 26px',
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
            <TunnelVaultLogo height={28} tone="light" />
            <div style={{ fontSize: '10px', letterSpacing: '0.25em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.6)', fontWeight: 500 }}>
              Admin Dashboard
            </div>
          </div>
        </div>
        <div style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderTop: 'none',
          padding: '28px 32px 32px',
          borderRadius: '0 0 12px 12px',
          boxShadow: 'var(--shadow-md)',
        }}>
          {children}
        </div>
      </div>
    </div>
  );
}

const noticeStyle = (color, bg, border) => ({
  display: 'flex', alignItems: 'flex-start', gap: '8px',
  fontSize: '12px', lineHeight: 1.5, color, background: bg,
  border: `1px solid ${border}`, borderRadius: '8px', padding: '10px 12px', marginBottom: '16px',
});

/**
 * Gate in front of the whole dashboard.
 * status: 'checking' | 'authenticated' | 'login' | 'error'
 * Errors (network, 5xx, 429, unexpected responses) are never treated as "logged in".
 */
export default function AuthGate({ children }) {
  const [auth, setAuth] = useState({ status: 'checking', authRequired: true, error: '', notice: '' });
  const [token, setToken] = useState('');
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const applySession = useCallback((s) => {
    setAuth({ status: s.authenticated ? 'authenticated' : 'login', authRequired: s.authRequired, error: '', notice: '' });
  }, []);

  const applySessionError = useCallback((err) => {
    setAuth((prev) => ({ ...prev, status: 'error', error: sessionErrorMessage(err) }));
  }, []);

  // Initial session check.
  useEffect(() => {
    let active = true;
    getSession().then(
      (s) => { if (active) applySession(s); },
      (err) => { if (active) applySessionError(err); },
    );
    return () => { active = false; };
  }, [applySession, applySessionError]);

  // Any 401 from the API sends the user back to the login screen.
  useEffect(() => {
    const onUnauthorized = () => {
      setAuth((prev) => (prev.status === 'authenticated'
        ? { status: 'login', authRequired: true, error: '', notice: SESSION_EXPIRED }
        : prev));
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  const retry = () => {
    setAuth((prev) => ({ ...prev, status: 'checking', error: '' }));
    getSession().then(applySession, applySessionError);
  };

  const logout = useCallback(async () => {
    try {
      await apiLogout();
    } catch (err) {
      // 401 = the session is already gone, which is what we wanted.
      if (!err || err.status !== 401) throw err;
    }
    setAuth({ status: 'login', authRequired: true, error: '', notice: 'You have been signed out.' });
  }, []);

  const contextValue = useMemo(() => ({ authRequired: auth.authRequired, logout }), [auth.authRequired, logout]);

  async function handleLogin(e) {
    e.preventDefault();
    if (submitting) return;
    const value = token.trim();
    if (!value) { setFormError('Enter the admin token (AUTH_TOKEN) configured on the server.'); return; }
    setSubmitting(true);
    setFormError('');
    try {
      await login(value);
      // The session is bound to a per-session key kept in this origin's localStorage.
      if (!getSessionKey()) {
        setFormError('The server accepted the token, but this browser cannot store the session key. '
          + 'Allow site data (localStorage) for this dashboard, or leave private-browsing mode, then sign in again.');
        return;
      }
      // Make sure the browser actually kept the session cookie before entering the app.
      // (getSession() also reports "logged out" when no session key is stored.)
      const s = await getSession();
      if (!s.authenticated) {
        setFormError('The server accepted the token, but the browser did not keep the session cookie. '
          + 'Open the dashboard via its HTTPS URL, and if it runs behind a reverse proxy check the TRUST_PROXY setting.');
        return;
      }
      setToken('');
      applySession(s);
    } catch (err) {
      setFormError(loginErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (auth.status === 'checking') {
    return (
      <div style={{ display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)' }}>
        <Spinner />
      </div>
    );
  }

  if (auth.status === 'authenticated') {
    return <AuthContext.Provider value={contextValue}>{children}</AuthContext.Provider>;
  }

  if (auth.status === 'error') {
    return (
      <Card>
        <div role="alert" style={noticeStyle('var(--red)', 'rgba(200,32,32,0.08)', 'rgba(200,32,32,0.25)')}>
          <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: '1px' }} />
          <span>{auth.error}</span>
        </div>
        <button
          type="button"
          onClick={retry}
          style={{
            width: '100%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
            background: 'transparent', border: '1px solid var(--border)', borderRadius: '8px',
            color: 'var(--text)', fontFamily: 'inherit', fontSize: '13px', fontWeight: 600, padding: '11px', cursor: 'pointer',
          }}
        >
          <RefreshCw size={13} /> Retry
        </button>
      </Card>
    );
  }

  const insecure = isInsecurePublicUrl(window.location.href);

  return (
    <Card>
      <p style={{ fontSize: '13px', color: 'var(--text-dim)', marginBottom: '20px', marginTop: 0, textAlign: 'center' }}>
        Sign in with the server&apos;s admin token
      </p>

      {auth.notice && (
        <div role="status" style={noticeStyle('var(--text-mid)', 'var(--surface2)', 'var(--border)')}>
          <span>{auth.notice}</span>
        </div>
      )}

      {insecure && (
        <div style={noticeStyle('var(--amber)', 'rgba(240,165,0,0.08)', 'rgba(240,165,0,0.3)')}>
          <ShieldAlert size={14} style={{ flexShrink: 0, marginTop: '1px' }} />
          <span>
            This page is served over plain HTTP. Your admin token and session cookie cross the network unencrypted.
            Reinstall the server with <code style={{ fontFamily: 'var(--font-mono)' }}>--tls</code>.
          </span>
        </div>
      )}

      <form onSubmit={handleLogin} noValidate>
        <div style={{ marginBottom: '16px' }}>
          <label htmlFor="tv-admin-token" style={{ display: 'block', fontSize: '11px', fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--text-mid)', marginBottom: '6px' }}>
            Admin token
          </label>
          <input
            id="tv-admin-token"
            name="token"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="AUTH_TOKEN"
            autoComplete="current-password"
            autoFocus
            spellCheck={false}
            aria-invalid={formError ? 'true' : 'false'}
            aria-describedby={formError ? 'tv-login-error' : undefined}
            style={{
              width: '100%', background: 'var(--bg)', border: '1px solid var(--border)',
              borderRadius: '8px', color: 'var(--text)', fontFamily: 'var(--font-mono)', fontSize: '13px',
              padding: '10px 14px', outline: 'none', boxSizing: 'border-box',
              transition: 'border-color .15s',
            }}
            onFocus={(e) => { e.target.style.borderColor = 'var(--accent)'; }}
            onBlur={(e) => { e.target.style.borderColor = 'var(--border)'; }}
          />
          {formError && (
            <p id="tv-login-error" role="alert" style={{ fontSize: '12px', color: 'var(--red)', marginTop: '6px', marginBottom: 0 }}>{formError}</p>
          )}
        </div>

        <button
          type="submit"
          disabled={submitting}
          style={{
            width: '100%',
            background: 'linear-gradient(90deg, #0632A0 0%, #1EB4E6 100%)',
            border: 'none', borderRadius: '8px',
            color: '#ffffff', fontFamily: 'inherit', fontSize: '13px',
            fontWeight: 600, padding: '12px',
            cursor: submitting ? 'default' : 'pointer', opacity: submitting ? 0.6 : 1, transition: 'opacity .15s',
          }}
        >
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>

        <p style={{ marginTop: '16px', textAlign: 'center', fontSize: '12px', color: 'var(--text-dim)', marginBottom: 0 }}>
          The token is <code style={{ color: 'var(--blue)', background: 'var(--surface2)', padding: '2px 6px', borderRadius: '4px', fontFamily: 'var(--font-mono)' }}>AUTH_TOKEN</code>
          {' '}in the server&apos;s <code style={{ color: 'var(--blue)', background: 'var(--surface2)', padding: '2px 6px', borderRadius: '4px', fontFamily: 'var(--font-mono)' }}>backend/.env</code>.
          It is not stored in this browser (only a per-session key that expires with the session).
        </p>
      </form>
    </Card>
  );
}

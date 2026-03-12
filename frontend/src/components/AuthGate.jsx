import { useState, useEffect } from 'react';
import { Shield, Key, AlertCircle } from 'lucide-react';
import { getAuthToken, setAuthToken } from '../services/api';

export default function AuthGate({ children }) {
  const [authenticated, setAuthenticated] = useState(null); // null = checking
  const [token, setToken] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    checkAuth();
  }, []);

  async function checkAuth() {
    const stored = getAuthToken();
    try {
      const res = await fetch('/api/stats', {
        headers: stored ? { Authorization: `Bearer ${stored}` } : {},
      });
      if (res.ok) {
        setAuthenticated(true);
      } else if (res.status === 401) {
        setAuthenticated(false);
      } else {
        // Server might be down or other error — let through
        setAuthenticated(true);
      }
    } catch {
      // Network error — server probably not reachable, let through and show empty states
      setAuthenticated(true);
    }
  }

  async function handleLogin(e) {
    e.preventDefault();
    if (!token.trim()) {
      setError('Please enter your AUTH_TOKEN');
      return;
    }
    setAuthToken(token.trim());
    setError('');
    try {
      const res = await fetch('/api/stats', {
        headers: { Authorization: `Bearer ${token.trim()}` },
      });
      if (res.ok) {
        setAuthenticated(true);
        window.location.reload();
      } else {
        setError('Invalid token. Check your server .env file.');
      }
    } catch {
      setError('Cannot reach server. Is the backend running?');
    }
  }

  // Still checking
  if (authenticated === null) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#0a0a0f]">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
      </div>
    );
  }

  // Authenticated — show app
  if (authenticated) {
    return children;
  }

  // Not authenticated — show login
  return (
    <div className="flex h-screen items-center justify-center bg-[#0a0a0f] p-4">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-emerald-500/10">
            <Shield size={32} className="text-emerald-400" />
          </div>
          <h1 className="text-2xl font-bold text-white">
            Tunnel<span className="text-emerald-400">Vault</span>
          </h1>
          <p className="mt-2 text-sm text-gray-500">
            Enter your API token to access the dashboard
          </p>
        </div>

        <form onSubmit={handleLogin} className="space-y-4">
          <div className="rounded-xl border border-gray-800/60 bg-gray-900 p-6">
            <label className="mb-2 flex items-center gap-2 text-sm font-medium text-gray-300">
              <Key size={14} />
              AUTH_TOKEN
            </label>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Enter token from server .env..."
              autoFocus
              className="w-full rounded-lg border border-gray-700 bg-gray-800/60 px-4 py-3 font-mono text-sm text-white placeholder-gray-600 outline-none transition-colors focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/20"
            />
            {error && (
              <div className="mt-3 flex items-center gap-2 text-xs text-red-400">
                <AlertCircle size={12} />
                {error}
              </div>
            )}
          </div>

          <button
            type="submit"
            className="w-full rounded-lg bg-emerald-600 py-3 text-sm font-medium text-white shadow-lg shadow-emerald-500/20 transition-all hover:bg-emerald-500"
          >
            Authenticate
          </button>

          <p className="text-center text-xs text-gray-600">
            Find your token in{' '}
            <code className="rounded bg-gray-800 px-1.5 py-0.5 font-mono text-gray-400">
              backend/.env
            </code>{' '}
            → AUTH_TOKEN
          </p>
        </form>
      </div>
    </div>
  );
}

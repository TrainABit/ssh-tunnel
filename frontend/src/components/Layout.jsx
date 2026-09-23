import { NavLink, Outlet } from 'react-router-dom';
import {
  LayoutDashboard,
  Globe,
  Network,
  Settings,
  Key,
  Radio,
  BookOpen,
  Menu,
  X,
  Sun,
  Moon,
  LogOut,
} from 'lucide-react';
import { useState, useEffect, useCallback } from 'react';
import { getStats } from '../services/api';
import { useAuth } from '../auth/AuthContext';
import usePolling from '../hooks/usePolling';
import TunnelVaultLogo from '../assets/TunnelVaultLogo';

const NAV_MAIN = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/tunnels', label: 'Tunnels', icon: Globe },
  { to: '/connections', label: 'Connections', icon: Network },
  { to: '/settings', label: 'Settings', icon: Settings },
];

const NAV_CLIENTS = [
  { to: '/tokens', label: 'Tokens', icon: Key },
  { to: '/sessions', label: 'Sessions', icon: Radio },
  { to: '/setup', label: 'Setup Guide', icon: BookOpen },
];

function NavItem({ to, label, icon, onClick }) {
  const Icon = icon;
  return (
    <NavLink
      to={to}
      end={to === '/'}
      onClick={onClick}
      className={({ isActive }) =>
        `flex items-center gap-3 mx-2 px-3 py-2 rounded-lg text-sm transition-all duration-150 ${
          isActive
            ? 'bg-[var(--accent-bg)] text-[var(--accent)] font-medium'
            : 'text-[var(--text-mid)] hover:bg-[var(--accent-glow)] hover:text-[var(--text)]'
        }`
      }
    >
      <Icon size={15} strokeWidth={1.8} />
      {label}
    </NavLink>
  );
}

const headerButtonStyle = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: '32px', height: '32px', borderRadius: '8px',
  background: 'var(--surface2)', border: '1px solid var(--border)',
  cursor: 'pointer', color: 'var(--text-mid)',
  flexShrink: 0,
  transition: 'all .15s',
};

function LogoutButton() {
  const { authRequired, logout } = useAuth();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!authRequired) return null;
  const handleClick = async () => {
    setBusy(true);
    setFailed(false);
    try {
      await logout(); // AuthGate switches to the login screen and unmounts this component
    } catch {
      setFailed(true);
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={busy}
      title={failed ? 'Sign-out failed (server unreachable). Click to retry.' : 'Sign out'}
      aria-label="Sign out"
      style={{ ...headerButtonStyle, color: failed ? 'var(--red)' : 'var(--text-mid)', opacity: busy ? 0.5 : 1 }}
    >
      <LogOut size={14} />
    </button>
  );
}

function ThemeToggle({ theme, onToggle }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      style={headerButtonStyle}
      onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--accent-dim)'; e.currentTarget.style.color = 'var(--accent)'; }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-mid)'; }}
    >
      {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
    </button>
  );
}

export default function Layout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem('tv-theme') === 'light' ? 'light' : 'dark'; } catch { return 'dark'; }
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('tv-theme', theme); } catch { /* storage unavailable (private mode) */ }
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme(t => t === 'dark' ? 'light' : 'dark');
  }, []);

  const { data: stats, error: statsError, loading: statsLoading } = usePolling(getStats, 15000);
  const headerStats = {
    activeTunnels: stats?.activeTunnels ?? 0,
    liveSessions: stats?.liveSessions ?? 0,
    activeTokens: stats?.activeTokens ?? 0,
  };
  const serverOnline = !statsError && !statsLoading;

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: 'var(--bg)', color: 'var(--text)' }}>
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/60 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-60 flex-col transition-transform duration-300 lg:static lg:translate-x-0 ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
        style={{ background: 'var(--surface)', borderRight: '1px solid var(--border)' }}
      >
        {/* Logo area */}
        <div
          className="flex h-16 items-center justify-center px-5 relative"
          style={{ borderBottom: '1px solid var(--border)' }}
        >
          <TunnelVaultLogo height={22} />
          <button
            type="button"
            aria-label="Close navigation"
            className="absolute right-4 lg:hidden"
            style={{ color: 'var(--text-dim)', background: 'none', border: 'none', cursor: 'pointer' }}
            onClick={() => setSidebarOpen(false)}
          >
            <X size={16} />
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto py-4 space-y-0.5">
          <div className="mb-2 px-5 text-[10px] font-semibold uppercase tracking-widest" style={{ color: 'var(--text-dim)' }}>
            Overview
          </div>
          {NAV_MAIN.map((item) => (
            <NavItem key={item.to} {...item} onClick={() => setSidebarOpen(false)} />
          ))}

          <div className="my-4 mx-5" style={{ borderTop: '1px solid var(--border)' }} />

          <div className="mb-2 px-5 text-[10px] font-semibold uppercase tracking-widest" style={{ color: 'var(--text-dim)' }}>
            Clients
          </div>
          {NAV_CLIENTS.map((item) => (
            <NavItem key={item.to} {...item} onClick={() => setSidebarOpen(false)} />
          ))}
        </nav>

        {/* Footer status */}
        <div
          className="flex items-center gap-2 px-5 py-3.5 text-xs"
          style={{ borderTop: '1px solid var(--border)', color: 'var(--text-dim)' }}
        >
          <div
            className={`h-2 w-2 rounded-full ${serverOnline ? 'pulse-dot' : ''}`}
            style={{ background: statsLoading ? 'var(--text-dim)' : serverOnline ? 'var(--accent)' : 'var(--red)' }}
          />
          {statsLoading ? 'Connecting…' : serverOnline ? 'Server online' : 'Server unreachable'}
        </div>
      </aside>

      {/* Main */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Top bar */}
        <header
          className="flex h-14 items-center px-4 lg:px-6"
          style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}
        >
          <button
            type="button"
            aria-label="Open navigation"
            className="mr-4 lg:hidden"
            style={{ color: 'var(--text-dim)', background: 'none', border: 'none', cursor: 'pointer' }}
            onClick={() => setSidebarOpen(true)}
          >
            <Menu size={18} />
          </button>

          {/* Header stats */}
          <div className="ml-auto flex items-center gap-5 text-sm">
            <div className="flex items-center gap-2" style={{ color: 'var(--text-dim)' }}>
              <div className="h-1.5 w-1.5 rounded-full pulse-dot" style={{ background: 'var(--accent)' }} />
              <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{headerStats.liveSessions}</span>
              {' '}Live
            </div>
            <div className="hidden sm:flex items-center gap-1.5" style={{ color: 'var(--text-dim)' }}>
              <span style={{ color: 'var(--text)', fontWeight: 600 }}>{headerStats.activeTunnels}</span>
              {' '}Tunnels
            </div>
            <div className="hidden sm:flex items-center gap-1.5" style={{ color: 'var(--text-dim)' }}>
              <span style={{ color: 'var(--text)', fontWeight: 600 }}>{headerStats.activeTokens}</span>
              {' '}Tokens
            </div>

            <div style={{ width: '1px', height: '18px', background: 'var(--border)' }} />
            <ThemeToggle theme={theme} onToggle={toggleTheme} />
            <LogoutButton />
          </div>
        </header>

        {/* Content */}
        <main className="flex-1 overflow-y-auto p-5 lg:p-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

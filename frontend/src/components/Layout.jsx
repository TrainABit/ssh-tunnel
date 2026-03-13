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
} from 'lucide-react';
import { useState, useEffect, useCallback } from 'react';
import { getStats } from '../services/api';
import BrandLogo from '../assets/BrandLogo';

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

function NavItem({ to, label, icon: Icon, onClick }) {
  return (
    <NavLink
      to={to}
      end={to === '/'}
      onClick={onClick}
      className={({ isActive }) =>
        `flex items-center gap-2.5 border-l-2 px-4 py-2 text-[11.5px] uppercase tracking-widest transition-all duration-150 ${
          isActive
            ? 'border-[var(--accent)] bg-[var(--accent-bg)] text-[var(--accent)]'
            : 'border-transparent text-[var(--text-mid)] hover:bg-[var(--accent-glow)] hover:text-[var(--text)]'
        }`
      }
    >
      <Icon size={13} strokeWidth={1.5} />
      {label}
    </NavLink>
  );
}

function ThemeToggle({ theme, onToggle }) {
  return (
    <button
      onClick={onToggle}
      title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: '30px', height: '30px',
        background: 'var(--surface2)', border: '1px solid var(--border2)',
        cursor: 'pointer', color: 'var(--text-mid)',
        flexShrink: 0,
        transition: 'all .15s',
      }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.color = 'var(--accent)'; }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border2)'; e.currentTarget.style.color = 'var(--text-mid)'; }}
    >
      {theme === 'dark' ? <Sun size={13} /> : <Moon size={13} />}
    </button>
  );
}

export default function Layout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [headerStats, setHeaderStats] = useState({ activeTunnels: 0, liveSessions: 0, activeTokens: 0 });
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem('tv-theme') || 'dark'; } catch { return 'dark'; }
  });

  // Apply theme to <html> element
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('tv-theme', theme); } catch {}
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme(t => t === 'dark' ? 'light' : 'dark');
  }, []);

  useEffect(() => {
    const load = async () => {
      const s = await getStats();
      setHeaderStats({
        activeTunnels: s.activeTunnels ?? 0,
        liveSessions: s.liveSessions ?? 0,
        activeTokens: s.activeTokens ?? 0,
      });
    };
    load();
    const iv = setInterval(load, 15000);
    return () => clearInterval(iv);
  }, []);

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
        className={`fixed inset-y-0 left-0 z-40 flex w-56 flex-col transition-transform duration-300 lg:static lg:translate-x-0 ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
        style={{ background: 'var(--surface)', borderRight: '1px solid var(--border)' }}
      >
        {/* Logo area — brand gradient header */}
        <div
          className="flex h-16 items-center px-4 gap-3 relative overflow-hidden"
          style={{
            background: 'linear-gradient(135deg, #04133e 0%, #0632A0 60%, #1EB4E6 100%)',
            borderBottom: '1px solid rgba(30,180,230,0.3)',
          }}
        >
          {/* Subtle grid overlay */}
          <div style={{
            position: 'absolute', inset: 0, opacity: 0.06,
            backgroundImage: 'linear-gradient(rgba(255,255,255,.5) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.5) 1px, transparent 1px)',
            backgroundSize: '20px 20px',
          }} />
          <div className="relative flex flex-col gap-0.5 min-w-0">
            <BrandLogo height={18} />
            <div
              className="text-[8.5px] uppercase tracking-[0.22em] pl-0.5"
              style={{ color: 'rgba(255,255,255,0.55)', letterSpacing: '0.22em' }}
            >
              TunnelVault
            </div>
          </div>
          <button
            className="ml-auto lg:hidden relative"
            style={{ color: 'rgba(255,255,255,0.7)', background: 'none', border: 'none', cursor: 'pointer' }}
            onClick={() => setSidebarOpen(false)}
          >
            <X size={16} />
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto py-4">
          <div className="mb-1.5 px-4 text-[9px] uppercase tracking-[0.22em]" style={{ color: 'var(--text-dim)' }}>
            Overview
          </div>
          {NAV_MAIN.map((item) => (
            <NavItem key={item.to} {...item} onClick={() => setSidebarOpen(false)} />
          ))}

          <div className="my-3 mx-4" style={{ borderTop: '1px solid var(--border)' }} />

          <div className="mb-1.5 px-4 text-[9px] uppercase tracking-[0.22em]" style={{ color: 'var(--text-dim)' }}>
            Clients
          </div>
          {NAV_CLIENTS.map((item) => (
            <NavItem key={item.to} {...item} onClick={() => setSidebarOpen(false)} />
          ))}
        </nav>

        {/* Footer status */}
        <div
          className="flex items-center gap-2 px-4 py-3 text-[10px]"
          style={{ borderTop: '1px solid var(--border)', color: 'var(--text-dim)' }}
        >
          <div className="h-1.5 w-1.5 rounded-full pulse-dot" style={{ background: 'var(--accent)' }} />
          Server online
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
            className="mr-4 lg:hidden"
            style={{ color: 'var(--text-dim)', background: 'none', border: 'none', cursor: 'pointer' }}
            onClick={() => setSidebarOpen(true)}
          >
            <Menu size={18} />
          </button>

          {/* Header stats */}
          <div className="ml-auto flex items-center gap-4 text-[11px]">
            <div className="flex items-center gap-2" style={{ color: 'var(--text-dim)' }}>
              <div className="h-1.5 w-1.5 rounded-full pulse-dot" style={{ background: 'var(--accent)' }} />
              <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{headerStats.liveSessions}</span>
              {' '}Live
            </div>
            <div className="hidden sm:flex items-center gap-1.5" style={{ color: 'var(--text-dim)' }}>
              <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{headerStats.activeTunnels}</span>
              {' '}Tunnels
            </div>
            <div className="hidden sm:flex items-center gap-1.5" style={{ color: 'var(--text-dim)' }}>
              <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{headerStats.activeTokens}</span>
              {' '}Tokens
            </div>

            {/* Divider */}
            <div style={{ width: '1px', height: '18px', background: 'var(--border2)' }} />

            <ThemeToggle theme={theme} onToggle={toggleTheme} />
          </div>
        </header>

        {/* Content */}
        <main className="flex-1 overflow-y-auto p-4 lg:p-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

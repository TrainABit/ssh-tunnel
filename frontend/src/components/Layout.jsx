import { NavLink, Outlet } from 'react-router-dom';
import {
  LayoutDashboard,
  Globe,
  Network,
  Settings,
  Shield,
  Key,
  Radio,
  BookOpen,
  Menu,
  X,
} from 'lucide-react';
import { useState, useEffect } from 'react';
import { getStats } from '../services/api';

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
            ? 'border-[var(--green)] bg-[var(--green-bg)] text-[var(--green)]'
            : 'border-transparent text-[var(--text-mid)] hover:bg-[var(--green-glow)] hover:text-[var(--text)]'
        }`
      }
    >
      <Icon size={13} strokeWidth={1.5} />
      {label}
    </NavLink>
  );
}

export default function Layout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [headerStats, setHeaderStats] = useState({ activeTunnels: 0, liveSessions: 0, activeTokens: 0 });

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
        {/* Logo */}
        <div
          className="flex h-14 items-center gap-3 px-5"
          style={{ borderBottom: '1px solid var(--border)' }}
        >
          <div
            className="flex h-8 w-8 items-center justify-center"
            style={{ border: '1.5px solid var(--green)', color: 'var(--green)', fontSize: '14px' }}
          >
            <Shield size={14} strokeWidth={1.5} />
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-[0.18em]" style={{ color: 'var(--text)' }}>
              TunnelVault
            </div>
            <div className="text-[9px] uppercase tracking-[0.1em]" style={{ color: 'var(--text-dim)' }}>
              v0.1.0
            </div>
          </div>
          <button
            className="ml-auto lg:hidden"
            style={{ color: 'var(--text-dim)' }}
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

          <div
            className="my-3 mx-4"
            style={{ borderTop: '1px solid var(--border)' }}
          />

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
          <div className="h-1.5 w-1.5 rounded-full pulse-dot" style={{ background: 'var(--green)' }} />
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
            style={{ color: 'var(--text-dim)' }}
            onClick={() => setSidebarOpen(true)}
          >
            <Menu size={18} />
          </button>

          {/* Header stats (like reference) */}
          <div className="ml-auto flex items-center gap-6 text-[11px]">
            <div className="flex items-center gap-2" style={{ color: 'var(--text-dim)' }}>
              <div className="h-1.5 w-1.5 rounded-full pulse-dot" style={{ background: 'var(--green)' }} />
              <span style={{ color: 'var(--green)', fontWeight: 600 }}>{headerStats.liveSessions}</span>
              {' '}Live
            </div>
            <div className="flex items-center gap-1.5 hidden sm:flex" style={{ color: 'var(--text-dim)' }}>
              <span style={{ color: 'var(--green)', fontWeight: 600 }}>{headerStats.activeTunnels}</span>
              {' '}Tunnels
            </div>
            <div className="flex items-center gap-1.5 hidden sm:flex" style={{ color: 'var(--text-dim)' }}>
              <span style={{ color: 'var(--green)', fontWeight: 600 }}>{headerStats.activeTokens}</span>
              {' '}Tokens
            </div>
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

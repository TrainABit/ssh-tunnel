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
import { useState } from 'react';

const NAV_MAIN = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/tunnels', label: 'Tunnels', icon: Globe },
  { to: '/connections', label: 'Connections', icon: Network },
  { to: '/settings', label: 'Settings', icon: Settings },
];

const NAV_SSH = [
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
        `flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-200 ${
          isActive
            ? 'bg-emerald-500/10 text-emerald-400 shadow-[inset_0_0_20px_rgba(16,185,129,0.05)]'
            : 'text-gray-400 hover:bg-gray-800/50 hover:text-gray-200'
        }`
      }
    >
      <Icon size={18} />
      {label}
    </NavLink>
  );
}

export default function Layout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="scanline-overlay flex h-screen overflow-hidden bg-[#0a0a0f]">
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/60 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-gray-800/60 bg-[#0c0c14]  transition-transform duration-300 lg:static lg:translate-x-0 ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* Logo */}
        <div className="flex h-16 items-center gap-3 border-b border-gray-800/60 px-6">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-400">
            <Shield size={20} />
          </div>
          <span className="text-lg font-bold tracking-tight text-white">
            Tunnel<span className="text-emerald-400">Vault</span>
          </span>
          <button
            className="ml-auto text-gray-400 lg:hidden"
            onClick={() => setSidebarOpen(false)}
          >
            <X size={20} />
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
          {NAV_MAIN.map((item) => (
            <NavItem key={item.to} {...item} onClick={() => setSidebarOpen(false)} />
          ))}

          {/* SSH Gateway section */}
          <div className="mt-5 mb-2 px-3">
            <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-600">
              SSH Gateway
            </span>
          </div>
          {NAV_SSH.map((item) => (
            <NavItem key={item.to} {...item} onClick={() => setSidebarOpen(false)} />
          ))}
        </nav>

        {/* Footer */}
        <div className="border-t border-gray-800/60 px-4 py-4">
          <div className="flex items-center gap-2 text-xs text-gray-500">
            <div className="h-2 w-2 rounded-full bg-emerald-500 pulse-dot" />
            Server online
          </div>
        </div>
      </aside>

      {/* Main */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Top bar */}
        <header className="flex h-16 items-center border-b border-gray-800/60 bg-[#0c0c14] px-4  lg:px-8">
          <button
            className="mr-4 text-gray-400 hover:text-white lg:hidden"
            onClick={() => setSidebarOpen(true)}
          >
            <Menu size={22} />
          </button>
          <div className="ml-auto flex items-center gap-3">
            <span className="font-mono text-xs text-gray-500">v0.1.0</span>
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

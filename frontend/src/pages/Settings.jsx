import { useState, useEffect } from 'react';
import {
  Server,
  Key,
  Globe,
  Copy,
  Eye,
  EyeOff,
  Save,
  Check,
  LogOut,
} from 'lucide-react';
import { getAuthToken, setAuthToken, clearAuthToken } from '../services/api';

function Section({ icon: Icon, title, children }) {
  return (
    <div className="rounded-xl border border-gray-800/60 bg-gray-900">
      <div className="flex items-center gap-3 border-b border-gray-800/60 px-5 py-4">
        <div className="rounded-lg bg-emerald-500/10 p-2 text-emerald-400">
          <Icon size={16} />
        </div>
        <h2 className="text-sm font-semibold text-white">{title}</h2>
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}

function ConfigRow({ label, value, mono }) {
  return (
    <div className="flex items-center justify-between py-2.5">
      <span className="text-sm text-gray-400">{label}</span>
      <span className={`text-sm text-gray-200 ${mono ? 'font-mono' : ''}`}>
        {value}
      </span>
    </div>
  );
}

export default function Settings() {
  const [showToken, setShowToken] = useState(false);
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const [authToken, setAuthTokenLocal] = useState('');

  useEffect(() => {
    setAuthTokenLocal(getAuthToken());
  }, []);

  const handleCopy = () => {
    navigator.clipboard?.writeText(authToken);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSaveToken = () => {
    setAuthToken(authToken);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    // Reload to re-fetch data with new token
    window.location.reload();
  };

  const handleLogout = () => {
    clearAuthToken();
    window.location.reload();
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Settings</h1>
        <p className="text-sm text-gray-400">
          Server configuration and authentication
        </p>
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        {/* Auth Token */}
        <Section icon={Key} title="API Authentication Token">
          <p className="mb-4 text-xs text-gray-500">
            Enter the AUTH_TOKEN from your server&apos;s .env file to authenticate
            API requests from this dashboard.
          </p>
          <div className="mb-4 flex items-center gap-2 rounded-lg border border-gray-700 bg-gray-800/60 px-3 py-2.5">
            <input
              type={showToken ? 'text' : 'password'}
              value={authToken}
              onChange={(e) => setAuthTokenLocal(e.target.value)}
              placeholder="Enter your AUTH_TOKEN..."
              className="flex-1 truncate bg-transparent font-mono text-sm text-gray-200 placeholder-gray-600 outline-none"
            />
            <button
              onClick={() => setShowToken(!showToken)}
              className="shrink-0 text-gray-400 transition-colors hover:text-white"
            >
              {showToken ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
            <button
              onClick={handleCopy}
              className="shrink-0 text-gray-400 transition-colors hover:text-white"
            >
              {copied ? (
                <Check size={14} className="text-emerald-400" />
              ) : (
                <Copy size={14} />
              )}
            </button>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleSaveToken}
              className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-medium text-white transition-all hover:bg-emerald-500"
            >
              {saved ? (
                <>
                  <Check size={12} /> Saved
                </>
              ) : (
                <>
                  <Save size={12} /> Save & Reconnect
                </>
              )}
            </button>
            {getAuthToken() && (
              <button
                onClick={handleLogout}
                className="inline-flex items-center gap-2 rounded-lg border border-gray-700 px-4 py-2 text-xs text-gray-400 transition-colors hover:border-red-500/50 hover:text-red-400"
              >
                <LogOut size={12} /> Clear Token
              </button>
            )}
          </div>
        </Section>

        {/* Server Config */}
        <Section icon={Server} title="Server Configuration">
          <div className="divide-y divide-gray-800/40">
            <ConfigRow label="API Port" value="4000" mono />
            <ConfigRow label="Proxy Port" value="4001" mono />
            <ConfigRow label="WebSocket" value="ws://localhost:4000/ws" mono />
            <ConfigRow label="Protocol" value="SSH / HTTP / WS" />
          </div>
        </Section>

        {/* Server Info */}
        <Section icon={Globe} title="Server Information">
          <div className="divide-y divide-gray-800/40">
            <ConfigRow label="Domain" value="Configured in backend .env" />
            <ConfigRow label="TLS" value="Managed by Nginx / Let's Encrypt" />
            <ConfigRow label="Database" value="SQLite (data/tunnelvault.db)" />
          </div>
          <p className="mt-3 text-xs text-gray-600">
            To change server settings, edit the .env file on the server and restart the service.
          </p>
        </Section>
      </div>
    </div>
  );
}

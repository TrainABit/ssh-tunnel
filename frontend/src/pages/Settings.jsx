import { useState, useEffect } from 'react';
import { Copy, Eye, EyeOff, Save, Check, LogOut, Bell } from 'lucide-react';
import { getAuthToken, setAuthToken, clearAuthToken } from '../services/api';
import { copyToClipboard } from '../utils/clipboard';

function Card({ title, children }) {
  return (
    <div style={{
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: '10px',
      boxShadow: 'var(--shadow-sm)',
      overflow: 'hidden',
    }}>
      <div className="px-5 py-4" style={{ borderBottom: '1px solid var(--border)' }}>
        <span className="text-sm font-semibold" style={{ color: 'var(--text)' }}>{title}</span>
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div className="flex items-center justify-between py-2.5" style={{ borderBottom: '1px solid var(--border)' }}>
      <span className="text-sm" style={{ color: 'var(--text-mid)' }}>{label}</span>
      <span className="text-sm font-medium" style={{ color: 'var(--text)' }}>{value}</span>
    </div>
  );
}

const btnBase = {
  display: 'inline-flex', alignItems: 'center', gap: '6px',
  padding: '8px 16px', fontFamily: 'inherit', fontSize: '13px',
  fontWeight: 500, borderRadius: '8px', border: '1px solid',
  cursor: 'pointer', transition: 'all .15s', background: 'transparent',
};

export default function Settings() {
  const [showToken, setShowToken] = useState(false);
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const [authToken, setAuthTokenLocal] = useState('');

  useEffect(() => { setAuthTokenLocal(getAuthToken()); }, []);

  const handleCopy = () => { copyToClipboard(authToken); setCopied(true); setTimeout(() => setCopied(false), 2000); };
  const handleSave = () => { setAuthToken(authToken); setSaved(true); setTimeout(() => { setSaved(false); window.location.reload(); }, 800); };
  const handleLogout = () => { clearAuthToken(); window.location.reload(); };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold" style={{ color: 'var(--text)' }}>Settings</h1>
        <p className="mt-1 text-sm" style={{ color: 'var(--text-dim)' }}>
          Server configuration and authentication
        </p>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        {/* Auth Token */}
        <Card title="API Authentication">
          <p className="mb-4 text-sm" style={{ color: 'var(--text-dim)' }}>
            Enter the AUTH_TOKEN from your server&apos;s .env file.
          </p>
          <div className="flex items-center gap-2 mb-4 px-3 py-2.5" style={{
            background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '8px',
            transition: 'border-color .15s',
          }}>
            <input
              type={showToken ? 'text' : 'password'}
              value={authToken}
              onChange={e => setAuthTokenLocal(e.target.value)}
              placeholder="Enter your AUTH_TOKEN…"
              style={{
                flex: 1, background: 'transparent', border: 'none', outline: 'none',
                fontFamily: 'var(--font-mono)', fontSize: '13px', color: 'var(--text)',
              }}
            />
            <button onClick={() => setShowToken(!showToken)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-dim)', display: 'flex', padding: '2px' }}>
              {showToken ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
            <button onClick={handleCopy} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-dim)', display: 'flex', padding: '2px' }}>
              {copied ? <Check size={14} style={{ color: 'var(--accent)' }} /> : <Copy size={14} />}
            </button>
          </div>
          <div className="flex gap-2">
            <button onClick={handleSave} style={{ ...btnBase, background: 'linear-gradient(90deg, #0632A0 0%, #1EB4E6 100%)', borderColor: 'transparent', color: '#ffffff', fontWeight: 600 }}>
              {saved ? <><Check size={13} /> Saved</> : <><Save size={13} /> Save & Reconnect</>}
            </button>
            {getAuthToken() && (
              <button onClick={handleLogout} style={{ ...btnBase, borderColor: 'rgba(200,32,32,0.3)', color: 'var(--red)' }}>
                <LogOut size={13} /> Clear
              </button>
            )}
          </div>
        </Card>

        {/* Server Config */}
        <Card title="Server Configuration">
          <div>
            <Row label="API Port" value="4000" />
            <Row label="Proxy Port" value="4001" />
            <Row label="WebSocket" value="ws://<host>:4000/ws" />
            <Row label="TCP Tunnel Ports" value="10000 – 10999" />
          </div>
        </Card>

        {/* Server Info */}
        <Card title="Server Information">
          <div>
            <Row label="Database" value="SQLite (data/tunnelvault.db)" />
            <Row label="Domain" value="Set via DOMAIN in .env" />
            <Row label="TLS" value="Managed by Nginx" />
            <Row label="Auto-updater" value="Every 72h via systemd timer" />
          </div>
          <p className="mt-4 text-sm" style={{ color: 'var(--text-dim)' }}>
            To change server settings, edit the .env file on the server and restart the service.
          </p>
        </Card>

        {/* Webhook Notifications */}
        <Card title="Webhook Notifications">
          <div className="flex items-start gap-3 mb-4">
            <Bell size={15} style={{ color: 'var(--accent)', marginTop: '2px', flexShrink: 0 }} />
            <p className="text-sm" style={{ color: 'var(--text-dim)' }}>
              Receive push alerts when tunnels connect or disconnect. Configure in{' '}
              <code style={{
                background: 'var(--surface2)', borderRadius: '4px',
                padding: '1px 6px', fontSize: '12px', color: 'var(--blue)',
                fontFamily: 'var(--font-mono)',
              }}>backend/.env</code> on the server.
            </p>
          </div>
          <div style={{
            background: 'var(--bg)', border: '1px solid var(--border)',
            borderRadius: '8px', padding: '12px 16px',
            fontSize: '12px', lineHeight: 1.9, fontFamily: 'var(--font-mono)',
          }}>
            <div><span style={{ color: 'var(--text-dim)' }}># Set one of: ntfy | slack | discord | json</span></div>
            <div><span style={{ color: 'var(--blue)' }}>WEBHOOK_URL</span>=<span style={{ color: 'var(--accent)' }}>https://ntfy.sh/your-topic</span></div>
            <div><span style={{ color: 'var(--blue)' }}>WEBHOOK_TYPE</span>=<span style={{ color: 'var(--accent)' }}>ntfy</span></div>
          </div>
          <p className="mt-3 text-xs" style={{ color: 'var(--text-dim)' }}>
            Then:{' '}
            <code style={{
              background: 'var(--surface2)', borderRadius: '4px',
              padding: '1px 6px', color: 'var(--text-mid)', fontFamily: 'var(--font-mono)',
            }}>sudo systemctl restart tunnelvault</code>
          </p>
        </Card>
      </div>
    </div>
  );
}

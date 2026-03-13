import { useState, useEffect } from 'react';
import { Copy, Eye, EyeOff, Save, Check, LogOut, Bell } from 'lucide-react';
import { getAuthToken, setAuthToken, clearAuthToken } from '../services/api';
import { copyToClipboard } from '../utils/clipboard';

function Card({ title, children }) {
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
      <div className="px-4 py-3" style={{ borderBottom: '1px solid var(--border)' }}>
        <span className="text-[10px] uppercase tracking-[0.15em]" style={{ color: 'var(--text-mid)' }}>{title}</span>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div className="flex items-center justify-between py-2" style={{ borderBottom: '1px solid var(--border)' }}>
      <span className="text-[11px]" style={{ color: 'var(--text-dim)' }}>{label}</span>
      <span className="text-[11px]" style={{ color: 'var(--text)' }}>{value}</span>
    </div>
  );
}

const btnStyle = (variant = 'ghost') => ({
  display: 'inline-flex', alignItems: 'center', gap: '6px',
  padding: '6px 14px', fontFamily: 'inherit', fontSize: '10px',
  letterSpacing: '.09em', textTransform: 'uppercase', border: '1px solid',
  cursor: 'pointer', transition: 'all .15s', background: 'transparent',
  ...(variant === 'primary'
    ? { background: 'linear-gradient(90deg, #0632A0 0%, #1EB4E6 100%)', borderColor: 'transparent', color: '#ffffff', fontWeight: 600 }
    : variant === 'danger'
    ? { borderColor: '#2a1212', color: 'var(--red)' }
    : { borderColor: 'var(--border2)', color: 'var(--text-mid)' }),
});

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
        <h1 className="text-[16px] font-normal tracking-[0.06em]" style={{ color: 'var(--text)' }}>
          Settings <span style={{ color: 'var(--green)' }}>//</span> Config
        </h1>
        <p className="mt-0.5 text-[10.5px]" style={{ color: 'var(--text-dim)' }}>
          Server configuration and authentication
        </p>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        {/* Auth Token */}
        <Card title="API Authentication">
          <p className="mb-3 text-[10.5px]" style={{ color: 'var(--text-dim)' }}>
            Enter the AUTH_TOKEN from your server&apos;s .env file.
          </p>
          <div className="flex items-center gap-2 mb-3 px-3 py-2" style={{ background: 'var(--bg)', border: '1px solid var(--border2)' }}>
            <input
              type={showToken ? 'text' : 'password'}
              value={authToken}
              onChange={e => setAuthTokenLocal(e.target.value)}
              placeholder="Enter your AUTH_TOKEN..."
              style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', fontFamily: 'inherit', fontSize: '12px', color: 'var(--text)' }}
            />
            <button onClick={() => setShowToken(!showToken)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-dim)', display: 'flex' }}>
              {showToken ? <EyeOff size={13} /> : <Eye size={13} />}
            </button>
            <button onClick={handleCopy} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-dim)', display: 'flex' }}>
              {copied ? <Check size={13} style={{ color: 'var(--green)' }} /> : <Copy size={13} />}
            </button>
          </div>
          <div className="flex gap-2">
            <button onClick={handleSave} style={btnStyle('primary')}>
              {saved ? <><Check size={11} /> Saved</> : <><Save size={11} /> Save & Reconnect</>}
            </button>
            {getAuthToken() && (
              <button onClick={handleLogout} style={btnStyle('danger')}>
                <LogOut size={11} /> Clear
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
          <p className="mt-3 text-[10.5px]" style={{ color: 'var(--text-dim)' }}>
            To change server settings, edit the .env file on the server and restart the service.
          </p>
        </Card>

        {/* Webhook Notifications */}
        <Card title="Webhook Notifications">
          <div className="flex items-start gap-3 mb-3">
            <Bell size={13} style={{ color: 'var(--green)', marginTop: '1px', flexShrink: 0 }} />
            <p className="text-[10.5px]" style={{ color: 'var(--text-dim)' }}>
              Receive push alerts when tunnels connect or disconnect. Configure in <code style={{ background: 'var(--bg)', border: '1px solid var(--border2)', padding: '1px 5px', fontSize: '10px', color: 'var(--blue)' }}>backend/.env</code> on the server.
            </p>
          </div>
          <div style={{ background: 'var(--bg)', border: '1px solid var(--border2)', padding: '10px 14px', fontSize: '11px', lineHeight: 1.8 }}>
            <div><span style={{ color: 'var(--text-dim)' }}># Set one of: ntfy | slack | discord | json</span></div>
            <div><span style={{ color: 'var(--blue)' }}>WEBHOOK_URL</span>=<span style={{ color: 'var(--green)' }}>https://ntfy.sh/your-topic</span></div>
            <div><span style={{ color: 'var(--blue)' }}>WEBHOOK_TYPE</span>=<span style={{ color: 'var(--green)' }}>ntfy</span></div>
          </div>
          <p className="mt-2 text-[10px]" style={{ color: 'var(--text-dim)' }}>
            Then: <code style={{ background: 'var(--bg)', border: '1px solid var(--border2)', padding: '1px 5px', fontSize: '10px', color: 'var(--text-mid)' }}>sudo systemctl restart tunnelvault</code>
          </p>
        </Card>
      </div>
    </div>
  );
}

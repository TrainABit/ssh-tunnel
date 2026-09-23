import { useState } from 'react';
import { LogOut, Bell, RefreshCw, Settings2 } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { getConfig } from '../services/api';
import { deviceServerUrl, isInsecurePublicUrl } from '../utils/serverUrl';
import useServerConfig from '../hooks/useServerConfig';
import Banner from '../components/Banner';

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

function Row({ label, value, mono, tone }) {
  const color = tone === 'warn' ? 'var(--amber)' : tone === 'good' ? 'var(--accent)' : 'var(--text)';
  return (
    <div className="flex items-start justify-between gap-4 py-2.5" style={{ borderBottom: '1px solid var(--border)' }}>
      <span className="text-sm shrink-0" style={{ color: 'var(--text-mid)' }}>{label}</span>
      <span
        className="text-sm font-medium text-right"
        style={{ color, fontFamily: mono ? 'var(--font-mono)' : 'inherit', overflowWrap: 'anywhere', minWidth: 0 }}
      >
        {value}
      </span>
    </div>
  );
}

const btnBase = {
  display: 'inline-flex', alignItems: 'center', gap: '6px',
  padding: '8px 16px', fontFamily: 'inherit', fontSize: '13px',
  fontWeight: 500, borderRadius: '8px', border: '1px solid',
  cursor: 'pointer', transition: 'all .15s', background: 'transparent',
};

function show(v, fallback = '–') {
  return v === null || v === undefined || v === '' ? fallback : String(v);
}

function retentionText(days, what) {
  const n = Number(days);
  if (!Number.isFinite(n)) return '–';
  if (n <= 0) return `kept forever (${what} cleanup disabled)`;
  return `${n} day${n === 1 ? '' : 's'}`;
}

const GEO_LABELS = {
  off: 'Off (no IP geolocation)',
  maxmind: 'MaxMind GeoLite2 (local database)',
  'ip-api': 'ip-api.com (sends visitor IPs to a third party over HTTP)',
};

function SessionCard() {
  const { authRequired, logout } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const handleLogout = async () => {
    setBusy(true);
    setError('');
    try {
      await logout(); // AuthGate shows the login screen
    } catch (err) {
      setError(err?.message || 'Sign-out failed.');
      setBusy(false);
    }
  };

  return (
    <Card title="Dashboard Session">
      {authRequired ? (
        <div className="space-y-4">
          <p className="text-sm" style={{ color: 'var(--text-dim)' }}>
            You are signed in with a session cookie (HttpOnly, SameSite=Strict). The admin token itself is not stored
            in this browser. Sessions expire after a period of inactivity.
          </p>
          {error && <Banner tone="error">{error}</Banner>}
          <button
            type="button"
            onClick={handleLogout}
            disabled={busy}
            style={{ ...btnBase, borderColor: 'rgba(200,32,32,0.3)', color: 'var(--red)', opacity: busy ? 0.6 : 1 }}
          >
            <LogOut size={13} /> {busy ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      ) : (
        <Banner tone="warning">
          Authentication is disabled: the server runs without <code style={{ fontFamily: 'var(--font-mono)' }}>AUTH_TOKEN</code>
          {' '}(development mode). Anyone who can reach the dashboard can control it. Set AUTH_TOKEN in the server&apos;s .env
          before exposing it.
        </Banner>
      )}
    </Card>
  );
}

function ConfigCards({ config }) {
  const server = deviceServerUrl(config);
  const pageHttps = window.location.protocol === 'https:';
  const publicUrl = typeof config.publicUrl === 'string' && config.publicUrl ? config.publicUrl : null;
  const tlsOn = pageHttps || (publicUrl ? publicUrl.startsWith('https://') : false);
  const range = Array.isArray(config.tcpPortRange) && config.tcpPortRange.length === 2
    ? `${config.tcpPortRange[0]} – ${config.tcpPortRange[1]}`
    : '–';
  const autoUpdate = config.autoUpdate && typeof config.autoUpdate === 'object' ? config.autoUpdate : null;
  const geo = config.geoipProvider || 'off';

  return (
    <>
      <Card title="Server Configuration">
        <div>
          <Row label="Version" value={show(config.version)} mono />
          <Row label="Domain" value={show(config.domain)} mono />
          <Row label="API / dashboard port" value={show(config.apiPort)} mono />
          <Row label="HTTP tunnel proxy port" value={show(config.proxyPort)} mono />
          <Row label="TCP tunnel ports" value={range} mono />
          <Row label="Device server URL" value={server} mono tone={isInsecurePublicUrl(server) ? 'warn' : undefined} />
          <Row label="Device WebSocket" value={`${server}/ws`} mono />
          <Row label="HTTP tunnel URLs" value={show(config.httpTunnelUrlTemplate)} mono />
          <Row label="Max tunnels per token" value={show(config.maxTunnelsPerToken)} />
        </div>
      </Card>

      <Card title="Security & Privacy">
        <div>
          <Row
            label="TLS"
            value={tlsOn ? 'HTTPS enabled' : 'Not enabled (plaintext HTTP)'}
            tone={tlsOn ? 'good' : 'warn'}
          />
          <Row label="Public URL" value={show(publicUrl, 'not set (PUBLIC_URL)')} mono={!!publicUrl} />
          <Row label="Trust reverse proxy headers" value={config.trustProxy ? 'yes (TRUST_PROXY)' : 'no'} />
          <Row
            label="Stored SSH keys"
            value={config.storedKeysEnabled ? 'enabled (encrypted at rest)' : 'disabled (no DATA_ENCRYPTION_KEY)'}
            tone={config.storedKeysEnabled ? undefined : 'warn'}
          />
          <Row label="IP geolocation" value={GEO_LABELS[geo] || String(geo)} tone={geo === 'ip-api' ? 'warn' : undefined} />
          <Row label="Session history retention" value={retentionText(config.sessionRetentionDays, 'session')} />
          <Row label="Idle tunnel retention" value={retentionText(config.tunnelIdleRetentionDays, 'idle tunnel')} />
        </div>
        {!tlsOn && (
          <Banner tone="warning" style={{ marginTop: '16px' }}>
            The dashboard, admin token and device tokens are transmitted unencrypted. Reinstall the server with
            {' '}<code style={{ fontFamily: 'var(--font-mono)' }}>install-server.sh --tls</code> (nginx + Let&apos;s Encrypt).
          </Banner>
        )}
      </Card>

      <Card title="Updates">
        <div>
          <Row
            label="Automatic updates"
            value={autoUpdate?.enabled ? 'enabled (signed releases)' : 'disabled'}
            tone={autoUpdate?.enabled ? 'good' : undefined}
          />
          <Row label="Schedule" value={autoUpdate?.enabled ? show(autoUpdate.schedule, 'default') : '–'} mono />
        </div>
        <p className="mt-4 text-sm" style={{ color: 'var(--text-dim)' }}>
          {autoUpdate?.enabled
            ? 'The updater installs only GitHub releases whose signature and checksum verify against the configured release key, and never downgrades. Settings: /etc/tunnelvault/update.conf.'
            : 'Enable with install-server.sh --upgrade --auto-update (requires the release signing public key). Settings live in /etc/tunnelvault/update.conf.'}
        </p>
      </Card>
    </>
  );
}

export default function Settings() {
  const { config, error, loading } = useServerConfig();
  const [reloaded, setReloaded] = useState(null); // { config?, error? } after a manual reload
  const current = reloaded ? reloaded.config : config;
  const currentError = reloaded ? reloaded.error : error;

  const reload = () => {
    getConfig({ force: true }).then(
      (c) => setReloaded({ config: c, error: null }),
      (err) => setReloaded({ config: current, error: err }),
    );
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold" style={{ color: 'var(--text)' }}>Settings</h1>
          <p className="mt-1 text-sm" style={{ color: 'var(--text-dim)' }}>
            Server configuration (read-only) and your dashboard session
          </p>
        </div>
        <button
          type="button"
          onClick={reload}
          style={{ ...btnBase, borderColor: 'var(--border)', color: 'var(--text-mid)' }}
        >
          <RefreshCw size={13} /> Reload
        </button>
      </div>

      {currentError && (
        <Banner tone="error">Could not load the server configuration: {currentError.message}</Banner>
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        <SessionCard />

        {loading && !current ? (
          <Card title="Server Configuration">
            <p className="text-sm" style={{ color: 'var(--text-dim)' }}>Loading…</p>
          </Card>
        ) : current ? (
          <ConfigCards config={current} />
        ) : null}

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
              }}>/opt/tunnelvault/backend/.env</code> on the server.
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

        <Card title="Changing Settings">
          <div className="flex items-start gap-3">
            <Settings2 size={15} style={{ color: 'var(--accent)', marginTop: '2px', flexShrink: 0 }} />
            <p className="text-sm" style={{ color: 'var(--text-dim)' }}>
              Server settings are read from <code style={{ fontFamily: 'var(--font-mono)' }}>/opt/tunnelvault/backend/.env</code>.
              Edit it (or re-run <code style={{ fontFamily: 'var(--font-mono)' }}>install-server.sh --upgrade</code> with new flags)
              and restart the service with <code style={{ fontFamily: 'var(--font-mono)' }}>sudo systemctl restart tunnelvault</code>.
            </p>
          </div>
        </Card>
      </div>
    </div>
  );
}

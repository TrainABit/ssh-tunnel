import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { copyToClipboard } from '../utils/clipboard';
import { deviceServerUrl, isInsecurePublicUrl } from '../utils/serverUrl';
import useServerConfig from '../hooks/useServerConfig';
import Banner from '../components/Banner';
import {
  Copy, Check, Terminal, Server, Key, Shield, Globe, Network, PackageCheck, SquareTerminal,
  Cpu, AlertCircle, BookOpen, ChevronDown, ChevronRight, ExternalLink, Bell,
} from 'lucide-react';

function CodeBlock({ children, copyText }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    const text = copyText || (typeof children === 'string' ? children : '');
    if (text) copyToClipboard(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div style={{
      position: 'relative', marginTop: '10px',
      background: 'var(--bg)', border: '1px solid var(--border)',
      borderRadius: '8px', padding: '14px 16px',
      fontFamily: 'var(--font-mono)', fontSize: '12px', lineHeight: 1.8,
    }}
      className="group">
      <button
        type="button"
        onClick={handleCopy}
        aria-label="Copy to clipboard"
        style={{
          position: 'absolute', top: '10px', right: '10px',
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: '6px', cursor: 'pointer', padding: '4px 8px',
          display: 'flex', alignItems: 'center', color: 'var(--text-dim)',
          opacity: 0, transition: 'opacity .15s',
        }}
        className="group-hover:opacity-100"
        onMouseEnter={e => e.currentTarget.style.opacity = 1}
        onMouseLeave={e => e.currentTarget.style.opacity = 0}
        onFocus={e => e.currentTarget.style.opacity = 1}
        onBlur={e => e.currentTarget.style.opacity = 0}
      >
        {copied ? <Check size={11} style={{ color: 'var(--accent)' }} /> : <Copy size={11} />}
      </button>
      <div style={{ overflowX: 'auto', color: 'var(--text-dim)' }}>{children}</div>
    </div>
  );
}

function Kw({ children }) { return <span style={{ color: 'var(--blue)' }}>{children}</span>; }
function Val({ children }) { return <span style={{ color: 'var(--accent)' }}>{children}</span>; }
function Cmt({ children }) { return <span style={{ color: 'var(--text-dim)', opacity: 0.6 }}>{children}</span>; }

function SectionCard({ icon, title, id, children }) {
  const Icon = icon;
  return (
    <div id={id} style={{
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: '10px',
      boxShadow: 'var(--shadow-sm)',
      overflow: 'hidden',
    }}>
      <div className="px-5 py-4 flex items-center gap-3" style={{ borderBottom: '1px solid var(--border)' }}>
        <div style={{
          width: '28px', height: '28px', borderRadius: '8px',
          background: 'var(--accent-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
        }}>
          <Icon size={13} style={{ color: 'var(--accent)' }} />
        </div>
        <span className="text-sm font-semibold" style={{ color: 'var(--text)' }}>{title}</span>
      </div>
      <div className="p-5 space-y-3">{children}</div>
    </div>
  );
}

function Step({ number, title, children }) {
  return (
    <div className="flex gap-4">
      <div className="flex flex-col items-center">
        <span style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: '26px', height: '26px', borderRadius: '50%',
          background: 'var(--accent-bg)', border: '1px solid var(--accent-dim)',
          color: 'var(--accent)', fontSize: '11px', fontWeight: 700, flexShrink: 0,
        }}>
          {number}
        </span>
        <div style={{ flex: 1, width: '1px', background: 'var(--border)', marginTop: '6px' }} />
      </div>
      <div className="pb-5 flex-1 min-w-0">
        <p className="text-sm font-semibold mb-1.5" style={{ color: 'var(--text)' }}>{title}</p>
        <div className="text-sm space-y-1" style={{ color: 'var(--text-dim)' }}>{children}</div>
      </div>
    </div>
  );
}

function TroubleshootItem({ question, children }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ borderBottom: '1px solid var(--border)' }} className="last:border-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        style={{
          display: 'flex', width: '100%', alignItems: 'center', gap: '10px',
          padding: '12px 0', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left',
        }}
      >
        {open
          ? <ChevronDown size={13} style={{ color: 'var(--accent)', flexShrink: 0 }} />
          : <ChevronRight size={13} style={{ color: 'var(--text-dim)', flexShrink: 0 }} />}
        <AlertCircle size={13} style={{ color: 'var(--amber)', flexShrink: 0 }} />
        <span className="text-sm" style={{ color: 'var(--text-mid)' }}>{question}</span>
      </button>
      {open && (
        <div className="pb-4 text-sm leading-relaxed" style={{ paddingLeft: '36px', color: 'var(--text-dim)' }}>
          {children}
        </div>
      )}
    </div>
  );
}

function DataTable({ headers, rows }) {
  return (
    <div style={{ marginTop: '10px', border: '1px solid var(--border)', borderRadius: '8px', overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--surface2)' }}>
            {headers.map(h => (
              <th key={h} className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-dim)' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} style={{ borderBottom: i < rows.length - 1 ? '1px solid var(--border)' : 'none' }}>
              {row.map((cell, j) => (
                <td key={j} className="px-4 py-2.5 text-sm" style={{ color: cell.color || 'var(--text-dim)', fontFamily: cell.mono ? 'var(--font-mono)' : 'inherit' }}>
                  {cell.text}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function InlineCode({ children }) {
  return (
    <code style={{
      background: 'var(--surface2)', borderRadius: '4px',
      padding: '1px 6px', fontSize: '12px', color: 'var(--blue)',
      fontFamily: 'var(--font-mono)',
    }}>
      {children}
    </code>
  );
}

function Label({ children }) {
  return <p className="text-xs font-semibold uppercase tracking-wide mb-1 mt-5" style={{ color: 'var(--text-dim)' }}>{children}</p>;
}

function Bullets({ items }) {
  return (
    <ul className="space-y-1.5 text-sm" style={{ color: 'var(--text-dim)' }}>
      {items.map((item, i) => (
        <li key={i} className="flex items-start gap-2">
          <span style={{ color: 'var(--accent)', marginTop: '2px', flexShrink: 0 }}>›</span>
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

const flag = (text) => ({ text, mono: true, color: 'var(--blue)' });
const mono = (text) => ({ text, mono: true });
const plain = (text) => ({ text });
const method = (m) => ({ text: m, mono: true, color: m === 'GET' ? 'var(--accent)' : m === 'DELETE' ? 'var(--amber)' : 'var(--blue)' });

const RELEASE_VERIFY = [
  'V=2.0.0',
  'BASE=https://github.com/TrainABit/ssh-tunnel/releases/download/v$V',
  'curl -fLO "$BASE/tunnelvault-v$V.tar.gz" -O "$BASE/SHA256SUMS" -O "$BASE/SHA256SUMS.sig"',
  'openssl dgst -sha256 -verify release-signing.pub -signature SHA256SUMS.sig SHA256SUMS',
  'sha256sum -c --ignore-missing SHA256SUMS',
  'tar xzf "tunnelvault-v$V.tar.gz" && cd "tunnelvault-v$V"',
].join('\n');

const tocItems = [
  { href: '#server-install', label: 'Server Install', icon: Server },
  { href: '#ports', label: 'Ports & Firewall', icon: Network },
  { href: '#client-install', label: 'Client Install', icon: Terminal },
  { href: '#updates', label: 'Signed Updates', icon: PackageCheck },
  { href: '#quick-start', label: 'Quick Start', icon: Cpu },
  { href: '#tunnels', label: 'TCP & HTTP Tunnels', icon: Key },
  { href: '#web-terminal', label: 'Web Terminal', icon: SquareTerminal },
  { href: '#webhooks', label: 'Webhooks', icon: Bell },
  { href: '#cli-commands', label: 'CLI Reference', icon: Terminal },
  { href: '#api-endpoints', label: 'API Endpoints', icon: Globe },
  { href: '#security', label: 'Security', icon: Shield },
  { href: '#troubleshooting', label: 'Troubleshooting', icon: AlertCircle },
];

export default function SetupGuide() {
  const navigate = useNavigate();
  const { config } = useServerConfig();
  const thisServer = deviceServerUrl(config);
  const thisServerInsecure = isInsecurePublicUrl(thisServer);

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold" style={{ color: 'var(--text)' }}>Setup Guide</h1>
          <p className="mt-1 text-sm" style={{ color: 'var(--text-dim)' }}>
            Deployment, configuration, and usage reference
          </p>
        </div>
        <div className="flex items-center gap-2">
          <BookOpen size={14} style={{ color: 'var(--accent)' }} />
          <span className="text-sm font-medium" style={{ color: 'var(--text-dim)' }}>TunnelVault Docs</span>
        </div>
      </div>

      {/* Table of Contents */}
      <div style={{
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: '10px', boxShadow: 'var(--shadow-sm)', overflow: 'hidden',
      }}>
        <div className="px-5 py-4" style={{ borderBottom: '1px solid var(--border)' }}>
          <span className="text-sm font-semibold" style={{ color: 'var(--text)' }}>Contents</span>
        </div>
        <div className="p-4 grid gap-1 sm:grid-cols-2 lg:grid-cols-4">
          {tocItems.map(({ href, label, icon }) => {
            const Icon = icon;
            return (
              <a
                key={href}
                href={href}
                style={{
                  display: 'flex', alignItems: 'center', gap: '8px',
                  padding: '8px 10px', color: 'var(--text-mid)',
                  textDecoration: 'none', fontSize: '13px',
                  borderRadius: '6px', transition: 'all .15s',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--accent-bg)'; e.currentTarget.style.color = 'var(--accent)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-mid)'; }}
              >
                <Icon size={13} style={{ color: 'var(--accent)', flexShrink: 0 }} />
                {label}
              </a>
            );
          })}
        </div>
      </div>

      <div className="max-w-4xl space-y-5">

        {/* 1. Server Installation */}
        <SectionCard icon={Server} title="Server Installation" id="server-install">
          <p className="text-sm" style={{ color: 'var(--text-dim)' }}>
            Install TunnelVault on a Linux server with a public IP address (Ubuntu 22.04 / 24.04 LTS recommended).
            The installer sets up Node.js 22 when needed, installs the backend and dashboard, creates the
            {' '}<InlineCode>tunnelvault</InlineCode> systemd service, generates <InlineCode>AUTH_TOKEN</InlineCode> and
            {' '}<InlineCode>DATA_ENCRYPTION_KEY</InlineCode> in <InlineCode>/opt/tunnelvault/backend/.env</InlineCode>, and configures the firewall.
          </p>

          <Label>Prerequisites</Label>
          <Bullets items={[
            'A server with a public IP, 1 vCPU and 1 GB RAM minimum',
            <>A DNS A record for your domain (e.g. <InlineCode>tunnel.example.com</InlineCode>) pointing at the server — required for <InlineCode>--tls</InlineCode></>,
            <>For HTTP tunnels additionally a wildcard record <InlineCode>*.tunnel.example.com</InlineCode></>,
            <>Inbound ports as listed under <a href="#ports" style={{ color: 'var(--accent)' }}>Ports &amp; Firewall</a></>,
            <>A verified release (see <a href="#updates" style={{ color: 'var(--accent)' }}>Signed Updates</a>) extracted on the server</>,
          ]} />

          <Label>Install with TLS (recommended)</Label>
          <CodeBlock copyText="sudo bash install-server.sh --domain tunnel.example.com --tls --email admin@example.com">
            <div><Kw>sudo bash</Kw> install-server.sh --domain <Val>tunnel.example.com</Val> --tls --email <Val>admin@example.com</Val></div>
          </CodeBlock>
          <p className="text-sm" style={{ color: 'var(--text-dim)' }}>
            <InlineCode>--tls</InlineCode> installs nginx as a reverse proxy and obtains a Let&apos;s Encrypt certificate for the
            domain itself (HTTP-01 via webroot, automatic renewal reloads nginx). The dashboard, API and device WebSocket are then
            served at <InlineCode>https://tunnel.example.com</InlineCode> / <InlineCode>wss://tunnel.example.com/ws</InlineCode>;
            the Node process only listens on 127.0.0.1. The installer prints the admin token (<InlineCode>AUTH_TOKEN</InlineCode>) — use it to sign in.
          </p>

          <Banner tone="warning">
            Without <InlineCode>--tls</InlineCode> the dashboard runs on plain HTTP (<InlineCode>http://SERVER-IP:4000</InlineCode>): the admin
            token, device tokens and web-terminal passwords cross the network unencrypted. Use that mode only for testing or on a trusted network.
          </Banner>

          <Label>Install Options</Label>
          <DataTable
            headers={['Flag', 'Default', 'Description']}
            rows={[
              [flag('--domain NAME'), mono('—'), plain('Public domain name (required with --tls)')],
              [flag('--tls'), mono('off'), plain('nginx + Let\'s Encrypt certificate for the apex domain; API bound to 127.0.0.1')],
              [flag('--email ADDR'), mono('—'), plain('Optional Let\'s Encrypt account e-mail')],
              [flag('--wildcard-cert DIR'), mono('—'), plain('Wildcard certificate for *.DOMAIN obtained separately (DNS-01); enables HTTPS for HTTP tunnels')],
              [flag('--auth-token TOKEN'), mono('generated'), plain('Admin token for the dashboard and the API')],
              [flag('--port PORT'), mono('4000'), plain('API / dashboard / WebSocket port')],
              [flag('--proxy-port PORT'), mono('4001'), plain('HTTP tunnel proxy port')],
              [flag('--no-firewall'), mono('—'), plain('Do not touch ufw')],
              [flag('--auto-update'), mono('off'), plain('Install the signed-release auto-updater (needs a release public key)')],
              [flag('--release-pubkey FILE'), mono('release-signing.pub'), plain('Public key used to verify releases')],
              [flag('--upgrade'), mono('—'), plain('Upgrade an existing install; keeps the database, .env and previous choices')],
              [flag('--yes'), mono('—'), plain('Non-interactive mode (used by the updater)')],
            ]}
          />
        </SectionCard>

        {/* 2. Ports & Firewall */}
        <SectionCard icon={Network} title="Ports & Firewall" id="ports">
          <Label>With --tls</Label>
          <DataTable
            headers={['Port', 'Purpose']}
            rows={[
              [mono('22/tcp'), plain('SSH administration of the server (restrict to your IPs if possible)')],
              [mono('80/tcp'), plain('Let\'s Encrypt challenges, redirect to HTTPS, HTTP tunnels on *.DOMAIN (unless --wildcard-cert)')],
              [mono('443/tcp'), plain('Dashboard, REST API, device WebSocket (wss://DOMAIN/ws), web terminal; HTTPS tunnels with --wildcard-cert')],
              [mono('10000–10999/tcp'), plain('TCP tunnels (one public port per tunnel)')],
              [mono('4000, 4001'), plain('Loopback only behind nginx — not opened in the firewall')],
            ]}
          />
          <Label>Without TLS</Label>
          <DataTable
            headers={['Port', 'Purpose']}
            rows={[
              [mono('22/tcp'), plain('SSH administration of the server')],
              [mono('4000/tcp'), plain('Dashboard, REST API, device WebSocket (ws://IP:4000/ws) — unencrypted')],
              [mono('4001/tcp'), plain('HTTP tunnel proxy')],
              [mono('10000–10999/tcp'), plain('TCP tunnels')],
            ]}
          />
          <p className="text-sm" style={{ color: 'var(--text-dim)' }}>
            The installer manages <InlineCode>ufw</InlineCode> without ever resetting it: if ufw is inactive it sets default-deny for incoming
            traffic, allows 22 and the ports above, and enables it; if ufw is already active it only adds TunnelVault&apos;s rules.
            {' '}<InlineCode>--no-firewall</InlineCode> skips this. Cloud security groups must allow the same ports.
          </p>
        </SectionCard>

        {/* 3. Client Installation */}
        <SectionCard icon={Terminal} title="Client Installation" id="client-install">
          <p className="text-sm" style={{ color: 'var(--text-dim)' }}>
            Install the <InlineCode>tunnelvault</InlineCode> client on each device that should expose a port (e.g. a Raspberry Pi).
            Create a token for the device on the <InlineCode>Tokens</InlineCode> page first — its dialog shows the exact install command.
          </p>

          <CodeBlock copyText="sudo bash install-client.sh --server wss://tunnel.example.com --token YOUR_TOKEN">
            <div><Kw>sudo bash</Kw> install-client.sh \</div>
            <div>  --server <Val>wss://tunnel.example.com</Val> \</div>
            <div>  --token <Val>YOUR_TOKEN</Val></div>
          </CodeBlock>
          <p className="text-sm" style={{ color: 'var(--text-dim)' }}>
            This server: <InlineCode>{thisServer}</InlineCode>
          </p>
          <Banner tone="warning">
            Servers installed without TLS use <InlineCode>--server ws://SERVER-IP:4000</InlineCode>. That is insecure: the device token
            is sent in plaintext and the client logs a warning. Prefer <InlineCode>wss://</InlineCode>.
            {thisServerInsecure ? ' This server currently uses ws://.' : ''}
          </Banner>

          <Label>Install Options</Label>
          <DataTable
            headers={['Flag', 'Default', 'Description']}
            rows={[
              [flag('--server URL'), plain('required'), plain('wss://DOMAIN (TLS) or ws://IP:4000 (no TLS, insecure)')],
              [flag('--token TOKEN'), plain('required'), plain('Device token from the dashboard (letters and digits)')],
              [flag('--port PORT'), mono('22'), plain('Local port to expose')],
              [flag('--protocol tcp|http'), mono('tcp'), plain('Protocol of that tunnel')],
              [flag('--extra-port PORT:PROTO:NAME'), mono('—'), plain('Additional tunnel, repeatable (e.g. 8080:http:web)')],
              [flag('--allow-reboot'), mono('off'), plain('Allow the dashboard\'s Reboot button for this device')],
              [flag('--no-reboot'), mono('—'), plain('Disable remote reboot again (with --upgrade)')],
              [flag('--auto-update'), mono('off'), plain('Install the signed-release auto-updater')],
              [flag('--release-pubkey FILE'), mono('release-signing.pub'), plain('Public key used to verify releases')],
              [flag('--upgrade'), mono('—'), plain('Upgrade in place; keeps server, token, tunnels and reboot setting unless overridden')],
            ]}
          />

          <Label>Where the client keeps its secrets</Label>
          <Bullets items={[
            <>The token is stored only in <InlineCode>/etc/tunnelvault/client.env</InlineCode> (root, mode 0600) and passed to the service through
              systemd <InlineCode>EnvironmentFile=</InlineCode>. The service runs <InlineCode>/usr/local/bin/tunnelvault connect</InlineCode> — no
              token on the command line, so it never shows up in <InlineCode>ps</InlineCode>.</>,
            <>The tunnel list (<InlineCode>config.json</InlineCode>) holds server URL, tunnels and the reboot setting — no token.</>,
            <>The device only forwards to the ports in its own tunnel list; the server cannot make it open other local ports.</>,
          ]} />

          <Label>Manual use</Label>
          <p className="text-sm" style={{ color: 'var(--text-dim)' }}>
            Settings are taken from CLI flags, then the environment (<InlineCode>TUNNELVAULT_SERVER</InlineCode>,
            {' '}<InlineCode>TUNNELVAULT_AUTH_TOKEN</InlineCode>), then <InlineCode>~/.tunnelvault/config.json</InlineCode>. Prefer the environment
            variable over <InlineCode>--auth-token</InlineCode>, which other local users can see in the process list.
          </p>
        </SectionCard>

        {/* 4. Signed updates */}
        <SectionCard icon={PackageCheck} title="Signed Releases & Updates" id="updates">
          <p className="text-sm" style={{ color: 'var(--text-dim)' }}>
            TunnelVault is distributed as signed GitHub releases (<InlineCode>TrainABit/ssh-tunnel</InlineCode>):
            {' '}<InlineCode>tunnelvault-vX.Y.Z.tar.gz</InlineCode> plus <InlineCode>SHA256SUMS</InlineCode> and its ECDSA signature
            {' '}<InlineCode>SHA256SUMS.sig</InlineCode>. Servers and devices never update from a git branch.
          </p>

          <Label>Download and verify a release</Label>
          <CodeBlock copyText={RELEASE_VERIFY}>
            {RELEASE_VERIFY.split('\n').map((line) => <div key={line}>{line}</div>)}
          </CodeBlock>
          <p className="text-sm" style={{ color: 'var(--text-dim)' }}>
            <InlineCode>release-signing.pub</InlineCode> is published in the repository; confirm its fingerprint through a second channel
            before relying on it. Then run <InlineCode>sudo bash install-server.sh --upgrade</InlineCode> or
            {' '}<InlineCode>sudo bash install-client.sh --upgrade</InlineCode> from the extracted directory.
          </p>

          <Label>Automatic updates</Label>
          <p className="text-sm" style={{ color: 'var(--text-dim)' }}>
            Installing with <InlineCode>--auto-update</InlineCode> (and a release public key) adds a systemd timer. Each run resolves the
            latest release (or the pinned version), refuses downgrades, downloads over HTTPS, verifies the signature and then the
            checksum, checks the <InlineCode>VERSION</InlineCode> file and runs the installer with <InlineCode>--upgrade</InlineCode>.
            Any failure aborts without changing the installation.
          </p>
          <CodeBlock copyText={'ENABLED=1\nSCHEDULE=12h\nUPDATE_REPO=TrainABit/ssh-tunnel\nPINNED_VERSION=\nPUBKEY=/etc/tunnelvault/release-signing.pub'}>
            <div><Cmt># /etc/tunnelvault/update.conf</Cmt></div>
            <div><Kw>ENABLED</Kw>=<Val>1</Val></div>
            <div><Kw>SCHEDULE</Kw>=<Val>12h</Val></div>
            <div><Kw>UPDATE_REPO</Kw>=<Val>TrainABit/ssh-tunnel</Val></div>
            <div><Kw>PINNED_VERSION</Kw>=   <Cmt># empty = latest release</Cmt></div>
            <div><Kw>PUBKEY</Kw>=<Val>/etc/tunnelvault/release-signing.pub</Val></div>
          </CodeBlock>
        </SectionCard>

        {/* 5. Quick Start */}
        <SectionCard icon={Cpu} title="Quick Start" id="quick-start">
          <p className="text-sm" style={{ color: 'var(--text-dim)' }}>Get up and running in five steps.</p>

          <div className="mt-4">
            <Step number="1" title="Install the server with TLS">
              <p>Point the domain at the server, verify a release and run the installer.</p>
              <CodeBlock copyText="sudo bash install-server.sh --domain tunnel.example.com --tls">
                <div><Kw>sudo bash</Kw> install-server.sh --domain <Val>tunnel.example.com</Val> --tls</div>
              </CodeBlock>
            </Step>

            <Step number="2" title="Sign in">
              <p>
                Open <InlineCode>https://tunnel.example.com</InlineCode> and sign in with the <InlineCode>AUTH_TOKEN</InlineCode> printed by the
                installer (also in <InlineCode>/opt/tunnelvault/backend/.env</InlineCode>).
              </p>
            </Step>

            <Step number="3" title="Create a device token">
              <p>One token per device, so a lost device can be revoked on its own.</p>
              <div className="mt-2">
                <button
                  type="button"
                  onClick={() => navigate('/tokens')}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: '6px',
                    background: 'linear-gradient(90deg, #0632A0 0%, #1EB4E6 100%)',
                    border: 'none', borderRadius: '8px', color: '#ffffff',
                    fontFamily: 'inherit', fontSize: '12px', fontWeight: 600,
                    padding: '8px 14px', cursor: 'pointer', transition: 'opacity .15s',
                  }}
                  onMouseEnter={e => e.currentTarget.style.opacity = '0.88'}
                  onMouseLeave={e => e.currentTarget.style.opacity = '1'}
                >
                  <ExternalLink size={12} /> Token Management
                </button>
              </div>
            </Step>

            <Step number="4" title="Install the client">
              <p>Run the install command from the token dialog on the device.</p>
              <CodeBlock copyText="sudo bash install-client.sh --server wss://tunnel.example.com --token YOUR_TOKEN">
                <div><Kw>sudo bash</Kw> install-client.sh --server <Val>wss://tunnel.example.com</Val> --token <Val>YOUR_TOKEN</Val></div>
              </CodeBlock>
            </Step>

            <Step number="5" title="Connect">
              <p>The tunnel appears on the Tunnels page with its public port. Use the web terminal or plain SSH:</p>
              <CodeBlock copyText="ssh -p 10001 pi@tunnel.example.com">
                <div><Kw>ssh</Kw> -p <Val>10001</Val> pi@<Val>tunnel.example.com</Val></div>
              </CodeBlock>
            </Step>
          </div>
        </SectionCard>

        {/* 6. Tunnels */}
        <SectionCard icon={Key} title="TCP & HTTP Tunnels" id="tunnels">
          <Label>How it works</Label>
          <ol className="space-y-2 text-sm list-decimal list-inside" style={{ color: 'var(--text-dim)' }}>
            <li>The device connects to <InlineCode>wss://DOMAIN/ws</InlineCode> and authenticates with its token in the
              {' '}<InlineCode>Authorization</InlineCode> header (never in the URL).</li>
            <li>The server allocates a public TCP port (default 10000–10999) for each tunnel. The port is remembered per device token and local
              port, so reconnects and reboots keep it.</li>
            <li>Every incoming connection is multiplexed over the WebSocket as binary frames with flow control.</li>
            <li>The device forwards the data to the configured local port (e.g. <InlineCode>localhost:22</InlineCode>).</li>
            <li>Connections appear live on the Connections and Sessions pages.</li>
          </ol>
          <p className="text-sm" style={{ color: 'var(--text-dim)' }}>
            Deactivating or deleting a token disconnects its devices within seconds; deleting also removes their tunnels.
            Limits per token: <InlineCode>MAX_TUNNELS_PER_TOKEN</InlineCode> tunnels (default 10) and <InlineCode>MAX_CONNECTIONS_PER_TOKEN</InlineCode> simultaneous device connections (default 4; the newest connection wins).
          </p>

          <Label>SSH Config (~/.ssh/config)</Label>
          <CodeBlock copyText={"Host my-pi\n    HostName tunnel.example.com\n    Port 10001\n    User pi\n    IdentityFile ~/.ssh/id_ed25519"}>
            <div><Kw>Host</Kw>           <Val>my-pi</Val></div>
            <div>    <Kw>HostName</Kw>   <Val>tunnel.example.com</Val></div>
            <div>    <Kw>Port</Kw>       <Val>10001</Val>   <Cmt># public TCP port from the dashboard</Cmt></div>
            <div>    <Kw>User</Kw>       <Val>pi</Val></div>
            <div>    <Kw>IdentityFile</Kw> <Val>~/.ssh/id_ed25519</Val></div>
          </CodeBlock>

          <Label>HTTP tunnels</Label>
          <p className="text-sm" style={{ color: 'var(--text-dim)' }}>
            Tunnels with protocol <InlineCode>http</InlineCode> get a subdomain such as <InlineCode>http://web.tunnel.example.com</InlineCode>
            {' '}(via nginx on port 80), or <InlineCode>https://…</InlineCode> when the server was installed with
            {' '}<InlineCode>--wildcard-cert</InlineCode>. Requests and responses are streamed, cookies stay bound to the tunnel&apos;s host
            and WebSockets are passed through. Requires the wildcard DNS record <InlineCode>*.DOMAIN</InlineCode>.
          </p>
        </SectionCard>

        {/* 7. Web terminal */}
        <SectionCard icon={SquareTerminal} title="Web Terminal" id="web-terminal">
          <p className="text-sm" style={{ color: 'var(--text-dim)' }}>
            Click <InlineCode>SSH</InlineCode> on an active SSH tunnel to open a terminal in the browser. Authenticate with a password, a private
            key (used for that session only) or the key stored for the device&apos;s token.
          </p>
          <Bullets items={[
            <>Host key pinning: on the first connection the device&apos;s host key fingerprint is shown. Compare it on the device
              (<InlineCode>ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</InlineCode>) before choosing <InlineCode>Trust &amp; connect</InlineCode>.</>,
            <>If the key later changes, the connection is refused with a warning (possible man-in-the-middle). Forget the pinned key — in the
              terminal dialog or on the tunnel card — only after verifying the change on the device.</>,
            <>Stored keys are managed in the token details (Tokens page). They are encrypted at rest with AES-256-GCM using
              {' '}<InlineCode>DATA_ENCRYPTION_KEY</InlineCode>; without that key the feature is disabled. Passphrase-protected keys are not supported.
              Back up <InlineCode>DATA_ENCRYPTION_KEY</InlineCode> — stored keys cannot be decrypted without it.</>,
          ]} />
        </SectionCard>

        {/* 8. Webhooks */}
        <SectionCard icon={Bell} title="Webhook Notifications" id="webhooks">
          <p className="text-sm" style={{ color: 'var(--text-dim)' }}>
            Receive push notifications when tunnels connect or disconnect. Set two variables in
            {' '}<InlineCode>/opt/tunnelvault/backend/.env</InlineCode> on the server, then restart the service.
          </p>

          <Label>Configuration (.env)</Label>
          <CodeBlock>
            <div><Cmt># Webhook URL — the destination to POST events to</Cmt></div>
            <div><Kw>WEBHOOK_URL</Kw>=<Val>https://ntfy.sh/your-topic</Val></div>
            <div />
            <div><Cmt># Type: ntfy | slack | discord | json</Cmt></div>
            <div><Kw>WEBHOOK_TYPE</Kw>=<Val>ntfy</Val></div>
          </CodeBlock>

          <Label>Supported Types</Label>
          <DataTable
            headers={['Type', 'WEBHOOK_URL', 'Payload']}
            rows={[
              [{ text: 'ntfy', mono: true, color: 'var(--accent)' }, plain('https://ntfy.sh/your-topic'), plain('Plain text push notification')],
              [{ text: 'slack', mono: true, color: 'var(--accent)' }, plain('Slack Incoming Webhook URL'), plain('{ text }')],
              [{ text: 'discord', mono: true, color: 'var(--accent)' }, plain('Discord Webhook URL'), plain('{ content }')],
              [{ text: 'json', mono: true, color: 'var(--accent)' }, plain('Any HTTPS endpoint'), plain('{ event, text, tunnelName, tunnelId, allocatedPort, timestamp }')],
            ]}
          />

          <Label>Apply Changes</Label>
          <CodeBlock copyText="sudo systemctl restart tunnelvault">
            <div><Kw>sudo systemctl</Kw> restart <Val>tunnelvault</Val></div>
          </CodeBlock>
        </SectionCard>

        {/* 9. CLI Commands */}
        <SectionCard icon={Terminal} title="CLI Commands Reference" id="cli-commands">
          <DataTable
            headers={['Command', 'Description', 'Example']}
            rows={[
              [{ text: 'connect [port]', mono: true, color: 'var(--accent)' }, plain('Expose local ports (all configured tunnels when no port is given)'), mono('tunnelvault connect 22 --name my-pi')],
              [{ text: 'list', mono: true, color: 'var(--accent)' }, plain('List tunnels on the server'), mono('tunnelvault list')],
              [{ text: 'status', mono: true, color: 'var(--accent)' }, plain('Show server status (uptime, tunnels, connections)'), mono('tunnelvault status')],
            ]}
          />

          <Label>Options</Label>
          <DataTable
            headers={['Flag', 'Description']}
            rows={[
              [flag('-n, --name <name>'), plain('Tunnel name shown in the dashboard')],
              [flag('-s, --subdomain <sub>'), plain('Requested subdomain for HTTP tunnels')],
              [flag('--protocol <tcp|http>'), plain('Tunnel protocol (default tcp)')],
              [flag('--server <url>'), plain('Server URL, e.g. wss://tunnel.example.com (or TUNNELVAULT_SERVER)')],
              [flag('--auth-token <token>'), plain('Device token — prefer the TUNNELVAULT_AUTH_TOKEN environment variable')],
            ]}
          />

          <Label>Examples</Label>
          <CodeBlock copyText={"export TUNNELVAULT_SERVER=wss://tunnel.example.com\nexport TUNNELVAULT_AUTH_TOKEN=YOUR_TOKEN\ntunnelvault connect 22 --name my-pi\ntunnelvault connect 3000 --name webapp --protocol http\ntunnelvault status"}>
            <div><Kw>export</Kw> TUNNELVAULT_SERVER=<Val>wss://tunnel.example.com</Val></div>
            <div><Kw>export</Kw> TUNNELVAULT_AUTH_TOKEN=<Val>YOUR_TOKEN</Val></div>
            <div />
            <div><Cmt># Expose the SSH port</Cmt></div>
            <div><Kw>tunnelvault</Kw> connect <Val>22</Val> --name <Val>my-pi</Val></div>
            <div />
            <div><Cmt># Expose a web app as an HTTP tunnel</Cmt></div>
            <div><Kw>tunnelvault</Kw> connect <Val>3000</Val> --name <Val>webapp</Val> --protocol <Val>http</Val></div>
          </CodeBlock>
        </SectionCard>

        {/* 10. API Endpoints */}
        <SectionCard icon={Globe} title="API Endpoints" id="api-endpoints">
          <p className="text-sm" style={{ color: 'var(--text-dim)' }}>
            Scripts authenticate with the header <InlineCode>Authorization: Bearer {'<AUTH_TOKEN>'}</InlineCode>; the dashboard uses its
            session cookie. Tokens in query strings are not accepted. Without <InlineCode>AUTH_TOKEN</InlineCode> (development mode only)
            authentication is disabled.
          </p>
          <CodeBlock copyText={'curl -H "Authorization: Bearer $AUTH_TOKEN" https://tunnel.example.com/api/tunnels'}>
            <div><Kw>curl</Kw> -H <Val>&quot;Authorization: Bearer $AUTH_TOKEN&quot;</Val> https://tunnel.example.com/api/tunnels</div>
          </CodeBlock>

          <Label>Auth, Health & Config</Label>
          <DataTable
            headers={['Method', 'Path', 'Description']}
            rows={[
              [method('GET'), mono('/api/health'), plain('Health check (no auth)')],
              [method('POST'), mono('/api/auth/login'), plain('Dashboard sign-in, body { token }; sets the session cookie (rate limited)')],
              [method('POST'), mono('/api/auth/logout'), plain('End the dashboard session')],
              [method('GET'), mono('/api/auth/session'), plain('{ authenticated, authRequired } (no auth)')],
              [method('GET'), mono('/api/config'), plain('Server configuration shown on the Settings page')],
              [method('GET'), mono('/api/stats'), plain('Aggregated stats (tunnels, connections, bytes, tokens, sessions)')],
            ]}
          />

          <Label>Tunnels</Label>
          <DataTable
            headers={['Method', 'Path', 'Description']}
            rows={[
              [method('GET'), mono('/api/tunnels'), plain('List tunnels (incl. has_private_key, host_key_fingerprint)')],
              [method('GET'), mono('/api/tunnels/:id'), plain('Get a single tunnel')],
              [method('POST'), mono('/api/tunnels/:id/toggle'), plain('Pause / resume a tunnel')],
              [method('POST'), mono('/api/tunnels/:id/reboot'), plain('Ask the device to reboot (only if it allows remote reboot)')],
              [method('DELETE'), mono('/api/tunnels/:id/hostkey'), plain('Forget the pinned SSH host key')],
              [method('DELETE'), mono('/api/tunnels/:id'), plain('Remove a tunnel')],
            ]}
          />

          <Label>Tokens</Label>
          <DataTable
            headers={['Method', 'Path', 'Description']}
            rows={[
              [method('GET'), mono('/api/tokens'), plain('List tokens with session counts')],
              [method('GET'), mono('/api/tokens/:token'), plain('Token details + last 50 sessions')],
              [method('POST'), mono('/api/tokens'), plain('Create a token (body: token, label, target_ip, target_port, public_key)')],
              [method('PATCH'), mono('/api/tokens/:token'), plain('Update label, target_ip, target_port, active, public_key, private_key ("" clears)')],
              [method('DELETE'), mono('/api/tokens/:token'), plain('Delete a token: disconnects its devices and removes their tunnels')],
            ]}
          />

          <Label>Sessions & Connections</Label>
          <DataTable
            headers={['Method', 'Path', 'Description']}
            rows={[
              [method('GET'), mono('/api/sessions'), plain('Session history (?active=1 for open sessions only)')],
              [method('GET'), mono('/api/connections'), plain('Active connections (?tunnel=id to filter)')],
            ]}
          />
        </SectionCard>

        {/* 11. Security Checklist */}
        <SectionCard icon={Shield} title="Security Checklist" id="security">
          <div className="space-y-0.5">
            {[
              'Install the server with --tls; never expose the dashboard over plain HTTP on the internet',
              'Keep AUTH_TOKEN secret and rotate it if it may have leaked (edit /opt/tunnelvault/backend/.env, restart)',
              'Back up the database (/opt/tunnelvault/data) and DATA_ENCRYPTION_KEY — store the key separately from the backups',
              'Use one token per device; deactivate or delete the token of a lost device (it is disconnected immediately)',
              'Enable remote reboot (--allow-reboot) only on devices that need it',
              'Verify SSH host key fingerprints on the device before trusting them in the web terminal',
              'Set TRUST_PROXY only when running behind your own reverse proxy (the --tls installer configures loopback)',
              'Keep IP geolocation off, or use a local MaxMind database (GEOIP_PROVIDER=maxmind, GEOIP_DB=…)',
              'Review retention: SESSION_RETENTION_DAYS (default 90) and TUNNEL_IDLE_RETENTION_DAYS (default 30)',
              'Enable signed auto-updates (--auto-update) or apply releases promptly; keep the OS patched',
              'Restrict SSH (port 22) on the server to your admin IPs',
              'Review active sessions periodically on the Sessions page',
            ].map((item, i) => (
              <label key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', padding: '8px 10px', cursor: 'pointer', borderRadius: '6px' }}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--accent-bg)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                <input type="checkbox" style={{ marginTop: '3px', accentColor: 'var(--accent)', flexShrink: 0 }} />
                <span className="text-sm" style={{ color: 'var(--text-dim)' }}>{item}</span>
              </label>
            ))}
          </div>
        </SectionCard>

        {/* 12. Troubleshooting */}
        <SectionCard icon={AlertCircle} title="Troubleshooting" id="troubleshooting">
          <p className="text-sm" style={{ color: 'var(--text-dim)' }}>Click an issue to expand the solution.</p>
          <div style={{ marginTop: '8px' }}>
            <TroubleshootItem question="Sign-in says “Too many attempts”">
              Sign-in is limited to 10 attempts per minute per IP address. Wait a minute and try again. Behind your own reverse proxy,
              set <InlineCode>TRUST_PROXY</InlineCode> so the server sees real client IPs instead of the proxy&apos;s.
            </TroubleshootItem>
            <TroubleshootItem question="Dashboard says “Cannot reach the server”">
              Check the service with <InlineCode>systemctl status tunnelvault</InlineCode> and the logs with
              {' '}<InlineCode>journalctl -u tunnelvault -n 50</InlineCode>. With <InlineCode>--tls</InlineCode> also check nginx:
              {' '}<InlineCode>systemctl status nginx</InlineCode>.
            </TroubleshootItem>
            <TroubleshootItem question="Signed in, but immediately back at the login screen">
              The browser did not keep the session cookie. Open the dashboard through its HTTPS URL. Behind a reverse proxy, make sure
              {' '}<InlineCode>TRUST_PROXY</InlineCode> is set so the server recognises HTTPS requests.
            </TroubleshootItem>
            <TroubleshootItem question="Certificate issuance fails with --tls">
              The domain&apos;s A record must point at the server and port 80 must be reachable from the internet. <InlineCode>--tls</InlineCode>
              {' '}only requests a certificate for the domain itself; a wildcard certificate for HTTP tunnels needs a DNS-01 challenge and is
              passed with <InlineCode>--wildcard-cert DIR</InlineCode>.
            </TroubleshootItem>
            <TroubleshootItem question="Device logs “token revoked or invalid”">
              The token was deactivated, deleted or mistyped. Check it on the Tokens page, then update the device with
              {' '}<InlineCode>sudo bash install-client.sh --upgrade --token NEW_TOKEN</InlineCode>. The client keeps retrying in the background.
            </TroubleshootItem>
            <TroubleshootItem question="Device cannot connect to the server">
              With TLS the server URL is <InlineCode>wss://DOMAIN</InlineCode> (port 443) — not port 4000, which only listens on localhost.
              Without TLS it is <InlineCode>ws://SERVER-IP:4000</InlineCode> and port 4000 must be open. Check
              {' '}<InlineCode>journalctl -u tunnelvault-client -n 50</InlineCode> on the device.
            </TroubleshootItem>
            <TroubleshootItem question="Web terminal: “the device’s host key has changed”">
              Do not continue until you know why. If the device was reinstalled or its SSH host keys were regenerated, verify the new
              fingerprint on the device and then use “Forget pinned key”. Otherwise treat it as a possible man-in-the-middle attack.
            </TroubleshootItem>
            <TroubleshootItem question="“Stored Key” option missing or stored keys disabled">
              The Stored Key option only appears when the device&apos;s token has a key (Tokens → details). Storing keys requires
              {' '}<InlineCode>DATA_ENCRYPTION_KEY</InlineCode> in the server&apos;s .env; <InlineCode>install-server.sh --upgrade</InlineCode> generates one.
            </TroubleshootItem>
            <TroubleshootItem question="Reboot button has no effect">
              Remote reboot is off by default. Re-run <InlineCode>sudo bash install-client.sh --upgrade --allow-reboot</InlineCode> on the device.
            </TroubleshootItem>
            <TroubleshootItem question="Tunnel stays at “Reconnecting…”">
              The device is offline or its client is stopped. Check <InlineCode>sudo systemctl status tunnelvault-client</InlineCode> on the device.
              The client reclaims its tunnel and public port when it reconnects.
            </TroubleshootItem>
            <TroubleshootItem question="API returns 401 Unauthorized">
              Send the admin token as a header: <InlineCode>Authorization: Bearer YOUR_TOKEN</InlineCode>. Query-string tokens
              ({' '}<InlineCode>?auth_token=</InlineCode>) are no longer accepted.
            </TroubleshootItem>
            <TroubleshootItem question="Server won't start: EADDRINUSE">
              Another process uses port 4000 or 4001. Find it with <InlineCode>sudo lsof -i :4000</InlineCode>, or change
              {' '}<InlineCode>PORT</InlineCode> / <InlineCode>PROXY_PORT</InlineCode> in the .env file.
            </TroubleshootItem>
          </div>
        </SectionCard>

      </div>
    </div>
  );
}

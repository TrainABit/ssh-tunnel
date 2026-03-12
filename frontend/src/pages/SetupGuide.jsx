import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { copyToClipboard } from '../utils/clipboard';
import {
  Copy, Check, Terminal, Server, Key, Shield, Globe,
  Cpu, AlertCircle, BookOpen, ChevronDown, ChevronRight, ExternalLink,
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
    <div style={{ position: 'relative', marginTop: '10px', background: 'var(--bg)', border: '1px solid var(--border2)', padding: '12px 14px', fontFamily: 'inherit', fontSize: '11.5px', lineHeight: 1.7 }}
      className="group">
      <button
        onClick={handleCopy}
        style={{ position: 'absolute', top: '8px', right: '8px', background: 'var(--surface)', border: '1px solid var(--border2)', cursor: 'pointer', padding: '4px 6px', display: 'flex', alignItems: 'center', color: 'var(--text-dim)', opacity: 0, transition: 'opacity .15s' }}
        className="group-hover:opacity-100"
        onMouseEnter={e => e.currentTarget.style.opacity = 1}
        onMouseLeave={e => e.currentTarget.style.opacity = 0}
      >
        {copied ? <Check size={11} style={{ color: 'var(--green)' }} /> : <Copy size={11} />}
      </button>
      <div style={{ overflowX: 'auto', color: 'var(--text-dim)' }}>{children}</div>
    </div>
  );
}

function Kw({ children }) { return <span style={{ color: 'var(--blue)' }}>{children}</span>; }
function Val({ children }) { return <span style={{ color: 'var(--green)' }}>{children}</span>; }
function Cmt({ children }) { return <span style={{ color: 'var(--border2)' }}>{children}</span>; }

function SectionCard({ icon: Icon, title, id, children }) {
  return (
    <div id={id} style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
      <div className="px-4 py-3 flex items-center gap-3" style={{ borderBottom: '1px solid var(--border)' }}>
        <Icon size={13} style={{ color: 'var(--green)' }} />
        <span className="text-[10px] uppercase tracking-[0.15em]" style={{ color: 'var(--text-mid)' }}>{title}</span>
      </div>
      <div className="p-4 space-y-3">{children}</div>
    </div>
  );
}

function Step({ number, title, children }) {
  return (
    <div className="flex gap-4">
      <div className="flex flex-col items-center">
        <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '22px', height: '22px', border: '1px solid var(--green-dim)', color: 'var(--green)', fontSize: '10px', flexShrink: 0 }}>
          {number}
        </span>
        <div style={{ flex: 1, width: '1px', background: 'var(--border)', marginTop: '4px' }} />
      </div>
      <div className="pb-5 flex-1 min-w-0">
        <p className="text-[11.5px] mb-1" style={{ color: 'var(--text)' }}>{title}</p>
        <div className="text-[11px] space-y-1" style={{ color: 'var(--text-dim)' }}>{children}</div>
      </div>
    </div>
  );
}

function TroubleshootItem({ question, children }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ borderBottom: '1px solid var(--border)' }} className="last:border-0">
      <button
        onClick={() => setOpen(!open)}
        style={{ display: 'flex', width: '100%', alignItems: 'center', gap: '8px', padding: '10px 0', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left' }}
      >
        {open
          ? <ChevronDown size={11} style={{ color: 'var(--green)', flexShrink: 0 }} />
          : <ChevronRight size={11} style={{ color: 'var(--text-dim)', flexShrink: 0 }} />}
        <AlertCircle size={11} style={{ color: 'var(--amber)', flexShrink: 0 }} />
        <span className="text-[11px]" style={{ color: 'var(--text-mid)' }}>{question}</span>
      </button>
      {open && (
        <div className="pb-3 text-[11px] leading-relaxed" style={{ paddingLeft: '31px', color: 'var(--text-dim)' }}>
          {children}
        </div>
      )}
    </div>
  );
}

function DataTable({ headers, rows }) {
  return (
    <div style={{ marginTop: '8px', border: '1px solid var(--border)', overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--border)' }}>
            {headers.map(h => (
              <th key={h} className="px-3 py-2 text-left text-[9px] uppercase tracking-[0.18em] font-normal" style={{ color: 'var(--text-dim)' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} style={{ borderBottom: i < rows.length - 1 ? '1px solid var(--border)' : 'none' }}>
              {row.map((cell, j) => (
                <td key={j} className="px-3 py-2 text-[11px]" style={{ color: cell.color || 'var(--text-dim)', fontFamily: cell.mono ? 'inherit' : undefined }}>
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
    <code style={{ background: 'var(--bg)', border: '1px solid var(--border2)', padding: '1px 6px', fontSize: '10.5px', color: 'var(--blue)' }}>
      {children}
    </code>
  );
}

function Label({ children }) {
  return <p className="text-[9.5px] uppercase tracking-[0.15em] mb-1 mt-4" style={{ color: 'var(--text-dim)' }}>{children}</p>;
}

const tocItems = [
  { href: '#server-install', label: 'Server Install', icon: Server },
  { href: '#client-install', label: 'Client Install', icon: Terminal },
  { href: '#quick-start', label: 'Quick Start', icon: Cpu },
  { href: '#ssh-gateway', label: 'SSH Gateway', icon: Key },
  { href: '#cli-commands', label: 'CLI Reference', icon: Terminal },
  { href: '#api-endpoints', label: 'API Endpoints', icon: Globe },
  { href: '#security', label: 'Security', icon: Shield },
  { href: '#troubleshooting', label: 'Troubleshooting', icon: AlertCircle },
];

export default function SetupGuide() {
  const navigate = useNavigate();

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-[16px] font-normal tracking-[0.06em]" style={{ color: 'var(--text)' }}>
            Setup Guide <span style={{ color: 'var(--green)' }}>//</span> Docs
          </h1>
          <p className="mt-0.5 text-[10.5px]" style={{ color: 'var(--text-dim)' }}>
            Deployment, configuration, and usage reference
          </p>
        </div>
        <div className="flex items-center gap-2">
          <BookOpen size={12} style={{ color: 'var(--green)' }} />
          <span className="text-[10px] uppercase tracking-[0.12em]" style={{ color: 'var(--text-dim)' }}>TunnelVault Docs</span>
        </div>
      </div>

      {/* Table of Contents */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
        <div className="px-4 py-3" style={{ borderBottom: '1px solid var(--border)' }}>
          <span className="text-[10px] uppercase tracking-[0.15em]" style={{ color: 'var(--text-mid)' }}>Contents</span>
        </div>
        <div className="p-4 grid gap-1 sm:grid-cols-2 lg:grid-cols-4">
          {tocItems.map(({ href, label, icon: Icon }) => (
            <a
              key={href}
              href={href}
              style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 8px', color: 'var(--text-dim)', textDecoration: 'none', fontSize: '11px', transition: 'color .15s' }}
              onMouseEnter={e => { e.currentTarget.style.color = 'var(--text)'; }}
              onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-dim)'; }}
            >
              <Icon size={11} style={{ color: 'var(--green)', flexShrink: 0 }} />
              {label}
            </a>
          ))}
        </div>
      </div>

      <div className="max-w-4xl space-y-5">

        {/* 1. Server Installation */}
        <SectionCard icon={Server} title="Server Installation" id="server-install">
          <p className="text-[11px]" style={{ color: 'var(--text-dim)' }}>
            Deploy TunnelVault on an EC2 instance (Ubuntu 22.04 recommended). The install script sets up Node.js, builds the frontend, and creates systemd services.
          </p>

          <Label>Prerequisites</Label>
          <ul className="space-y-1 text-[11px]" style={{ color: 'var(--text-dim)' }}>
            {[
              'EC2 instance: t3.micro minimum (1 vCPU, 1 GB RAM)',
              'Ubuntu 22.04 LTS (x86_64 or ARM)',
              'Security group: ports 22, 4000, 4001, 10000-10999 open',
              'Public IP or Elastic IP assigned',
            ].map((item, i) => (
              <li key={i} className="flex items-start gap-2">
                <span style={{ color: 'var(--green)', marginTop: '1px' }}>›</span>
                {item}
              </li>
            ))}
          </ul>

          <Label>Install Command</Label>
          <CodeBlock copyText="git clone <repo> /opt/tunnelvault-src && cd /opt/tunnelvault-src && sudo bash install-server.sh --domain tunnel.yourdomain.com">
            <div><Kw>git clone</Kw> <Val>{'<repo>'}</Val> /opt/tunnelvault-src</div>
            <div><Kw>cd</Kw> /opt/tunnelvault-src</div>
            <div><Kw>sudo bash</Kw> install-server.sh --domain <Val>tunnel.yourdomain.com</Val></div>
          </CodeBlock>

          <Label>Install Options</Label>
          <DataTable
            headers={['Flag', 'Default', 'Description']}
            rows={[
              [{ text: '--domain', mono: true, color: 'var(--blue)' }, { text: 'tunnel.local', mono: true }, { text: 'Server domain name' }],
              [{ text: '--auth-token', mono: true, color: 'var(--blue)' }, { text: 'auto-generated', mono: true }, { text: 'API authentication token' }],
              [{ text: '--port', mono: true, color: 'var(--blue)' }, { text: '4000', mono: true }, { text: 'API + WebSocket + Dashboard port' }],
              [{ text: '--proxy-port', mono: true, color: 'var(--blue)' }, { text: '4001', mono: true }, { text: 'Tunnel proxy port' }],
              [{ text: '--upgrade', mono: true, color: 'var(--blue)' }, { text: '—' }, { text: 'Upgrade existing install (preserves DB and config)' }],
            ]}
          />
        </SectionCard>

        {/* 2. Client Installation */}
        <SectionCard icon={Terminal} title="Client Installation" id="client-install">
          <p className="text-[11px]" style={{ color: 'var(--text-dim)' }}>
            Install the <InlineCode>tunnelvault</InlineCode> CLI on any machine that needs to create tunnels. Config is saved to <InlineCode>~/.tunnelvault/config.json</InlineCode>.
          </p>

          <CodeBlock copyText="bash install-client.sh --server ws://YOUR-EC2-IP:4000 --auth-token YOUR_TOKEN">
            <div><Kw>bash</Kw> install-client.sh \</div>
            <div>  --server <Val>ws://YOUR-EC2-IP:4000</Val> \</div>
            <div>  --auth-token <Val>YOUR_TOKEN</Val></div>
          </CodeBlock>

          <p className="text-[11px] mt-2" style={{ color: 'var(--text-dim)' }}>
            To uninstall: <InlineCode>bash install-client.sh --uninstall</InlineCode>
          </p>

          <Label>Config Priority</Label>
          <p className="text-[11px]" style={{ color: 'var(--text-dim)' }}>
            CLI flag → env var (<InlineCode>TUNNELVAULT_SERVER</InlineCode>, <InlineCode>TUNNELVAULT_AUTH_TOKEN</InlineCode>) → config.json → defaults.
          </p>
        </SectionCard>

        {/* 3. Quick Start */}
        <SectionCard icon={Cpu} title="Quick Start" id="quick-start">
          <p className="text-[11px]" style={{ color: 'var(--text-dim)' }}>Get up and running in four steps.</p>

          <div className="mt-3">
            <Step number="1" title="Deploy the Server">
              <p>Run <InlineCode>install-server.sh</InlineCode> on your EC2 instance.</p>
              <CodeBlock copyText="sudo bash install-server.sh --domain tunnel.yourdomain.com">
                <div><Kw>sudo bash</Kw> install-server.sh --domain <Val>tunnel.yourdomain.com</Val></div>
              </CodeBlock>
            </Step>

            <Step number="2" title="Create a Token">
              <p>Register a token with a target IP and the client's public key.</p>
              <div className="mt-2">
                <button
                  onClick={() => navigate('/tokens')}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', background: 'var(--green)', border: '1px solid var(--green)', color: '#040d0a', fontFamily: 'inherit', fontSize: '10px', letterSpacing: '.09em', textTransform: 'uppercase', fontWeight: 600, padding: '6px 12px', cursor: 'pointer' }}
                >
                  <ExternalLink size={10} /> Token Management
                </button>
              </div>
            </Step>

            <Step number="3" title="Install the Client">
              <p>Run the client installer on your local machine.</p>
              <CodeBlock copyText="bash install-client.sh --server ws://YOUR-EC2-IP:4000 --auth-token YOUR_TOKEN">
                <div><Kw>bash</Kw> install-client.sh --server <Val>ws://YOUR-EC2-IP:4000</Val> --auth-token <Val>YOUR_TOKEN</Val></div>
              </CodeBlock>
            </Step>

            <Step number="4" title="Connect">
              <p>Expose a local port via TCP tunnel.</p>
              <CodeBlock copyText="tunnelvault connect 22 --name my-pi">
                <div><Cmt># Expose local SSH port as a TCP tunnel</Cmt></div>
                <div><Kw>tunnelvault</Kw> connect <Val>22</Val> --name <Val>my-pi</Val></div>
                <div />
                <div><Cmt># Then SSH to the allocated port on your server</Cmt></div>
                <div><Kw>ssh</Kw> user@<Val>your-ec2-ip</Val> -p <Val>10001</Val></div>
              </CodeBlock>
            </Step>
          </div>
        </SectionCard>

        {/* 4. SSH Gateway Usage */}
        <SectionCard icon={Key} title="TCP Tunnel Usage" id="ssh-gateway">
          <p className="text-[11px]" style={{ color: 'var(--text-dim)' }}>
            TunnelVault creates a TCP listener on the server (port range 10000–10999) that forwards raw TCP data through a WebSocket to the client. This enables SSH and any other TCP protocol.
          </p>

          <Label>How It Works</Label>
          <ol className="space-y-1.5 text-[11px] list-decimal list-inside" style={{ color: 'var(--text-dim)' }}>
            <li>Client connects to server WebSocket at <InlineCode>ws://host:4000/ws</InlineCode> with auth token</li>
            <li>Server allocates a TCP port (10000–10999) and starts a listener</li>
            <li>Incoming TCP connections are multiplexed as JSON frames over the WebSocket</li>
            <li>Client forwards the data to the local target (e.g., <InlineCode>localhost:22</InlineCode>)</li>
            <li>Connection is tracked in real-time on the Connections and Sessions pages</li>
          </ol>

          <Label>SSH Config (~/.ssh/config)</Label>
          <CodeBlock copyText={"Host my-pi\n    HostName YOUR-EC2-IP\n    Port 10001\n    User pi\n    IdentityFile ~/.ssh/id_rsa"}>
            <div><Kw>Host</Kw>           <Val>my-pi</Val></div>
            <div>    <Kw>HostName</Kw>   <Val>YOUR-EC2-IP</Val></div>
            <div>    <Kw>Port</Kw>       <Val>10001</Val>   <Cmt># allocated TCP port from dashboard</Cmt></div>
            <div>    <Kw>User</Kw>       <Val>pi</Val></div>
            <div>    <Kw>IdentityFile</Kw> <Val>~/.ssh/id_rsa</Val></div>
          </CodeBlock>

          <Label>Connect</Label>
          <CodeBlock copyText="ssh my-pi">
            <div><Kw>ssh</Kw> my-pi</div>
            <div><Cmt># Traffic tunnels through WebSocket to your Raspberry Pi</Cmt></div>
          </CodeBlock>
        </SectionCard>

        {/* 5. CLI Commands */}
        <SectionCard icon={Terminal} title="CLI Commands Reference" id="cli-commands">
          <DataTable
            headers={['Command', 'Description', 'Example']}
            rows={[
              [{ text: 'connect <port>', mono: true, color: 'var(--green)' }, { text: 'Expose a local port via WebSocket tunnel' }, { text: 'tunnelvault connect 22 --name my-pi', mono: true }],
              [{ text: 'list', mono: true, color: 'var(--green)' }, { text: 'List all active tunnels on the server' }, { text: 'tunnelvault list', mono: true }],
              [{ text: 'status', mono: true, color: 'var(--green)' }, { text: 'Show server status (uptime, tunnels, connections)' }, { text: 'tunnelvault status', mono: true }],
            ]}
          />

          <Label>Connect Options</Label>
          <DataTable
            headers={['Flag', 'Description']}
            rows={[
              [{ text: '-n, --name <name>', mono: true, color: 'var(--blue)' }, { text: 'Tunnel name (shown in dashboard)' }],
              [{ text: '-s, --subdomain <sub>', mono: true, color: 'var(--blue)' }, { text: 'Requested subdomain for public URL' }],
              [{ text: '--server <url>', mono: true, color: 'var(--blue)' }, { text: 'Server WebSocket URL (default: ws://localhost:4000)' }],
              [{ text: '--auth-token <token>', mono: true, color: 'var(--blue)' }, { text: 'Bearer token for authentication' }],
            ]}
          />

          <Label>Examples</Label>
          <CodeBlock copyText={"tunnelvault connect 22 --name my-pi\ntunnelvault connect 3000 --name webapp\ntunnelvault list --server http://tunnel.example.com:4000\ntunnelvault status"}>
            <div><Cmt># Expose SSH port</Cmt></div>
            <div><Kw>tunnelvault</Kw> connect <Val>22</Val> --name <Val>my-pi</Val></div>
            <div />
            <div><Cmt># Expose a web app</Cmt></div>
            <div><Kw>tunnelvault</Kw> connect <Val>3000</Val> --name <Val>webapp</Val></div>
            <div />
            <div><Cmt># List tunnels on a remote server</Cmt></div>
            <div><Kw>tunnelvault</Kw> list --server <Val>http://tunnel.example.com:4000</Val></div>
          </CodeBlock>
        </SectionCard>

        {/* 6. API Endpoints */}
        <SectionCard icon={Globe} title="API Endpoints" id="api-endpoints">
          <p className="text-[11px]" style={{ color: 'var(--text-dim)' }}>
            All routes require <InlineCode>Authorization: Bearer {'<AUTH_TOKEN>'}</InlineCode> unless noted. When <InlineCode>AUTH_TOKEN</InlineCode> is unset, auth is disabled (dev mode).
          </p>

          <Label>Health & Stats</Label>
          <DataTable
            headers={['Method', 'Path', 'Auth', 'Description']}
            rows={[
              [{ text: 'GET', mono: true, color: 'var(--green)' }, { text: '/api/health', mono: true }, { text: 'No' }, { text: 'Health check with uptime' }],
              [{ text: 'GET', mono: true, color: 'var(--green)' }, { text: '/api/stats', mono: true }, { text: 'Yes' }, { text: 'Aggregated stats (tunnels, connections, bytes, tokens, sessions)' }],
            ]}
          />

          <Label>Tunnels</Label>
          <DataTable
            headers={['Method', 'Path', 'Description']}
            rows={[
              [{ text: 'GET', mono: true, color: 'var(--green)' }, { text: '/api/tunnels', mono: true }, { text: 'List all active tunnels' }],
              [{ text: 'GET', mono: true, color: 'var(--green)' }, { text: '/api/tunnels/:id', mono: true }, { text: 'Get single tunnel' }],
              [{ text: 'POST', mono: true, color: 'var(--blue)' }, { text: '/api/tunnels', mono: true }, { text: 'Create tunnel (body: name, localPort, subdomain)' }],
              [{ text: 'DELETE', mono: true, color: 'var(--amber)' }, { text: '/api/tunnels/:id', mono: true }, { text: 'Remove tunnel' }],
            ]}
          />

          <Label>Tokens</Label>
          <DataTable
            headers={['Method', 'Path', 'Description']}
            rows={[
              [{ text: 'GET', mono: true, color: 'var(--green)' }, { text: '/api/tokens', mono: true }, { text: 'List all tokens with session counts' }],
              [{ text: 'GET', mono: true, color: 'var(--green)' }, { text: '/api/tokens/:token', mono: true }, { text: 'Token details + last 50 sessions' }],
              [{ text: 'POST', mono: true, color: 'var(--blue)' }, { text: '/api/tokens', mono: true }, { text: 'Create token (body: token, label, target_ip, target_port, public_key)' }],
              [{ text: 'PATCH', mono: true, color: 'var(--blue)' }, { text: '/api/tokens/:token', mono: true }, { text: 'Update fields (target_ip, target_port, label, active, public_key)' }],
              [{ text: 'DELETE', mono: true, color: 'var(--amber)' }, { text: '/api/tokens/:token', mono: true }, { text: 'Delete token + associated sessions' }],
            ]}
          />

          <Label>Sessions & Connections</Label>
          <DataTable
            headers={['Method', 'Path', 'Description']}
            rows={[
              [{ text: 'GET', mono: true, color: 'var(--green)' }, { text: '/api/sessions', mono: true }, { text: 'List sessions (?active=1 for active only)' }],
              [{ text: 'POST', mono: true, color: 'var(--blue)' }, { text: '/api/sessions', mono: true }, { text: 'Create session (body: token, client_ip, pid)' }],
              [{ text: 'PATCH', mono: true, color: 'var(--blue)' }, { text: '/api/sessions/:id', mono: true }, { text: 'Mark session disconnected' }],
              [{ text: 'GET', mono: true, color: 'var(--green)' }, { text: '/api/connections', mono: true }, { text: 'Active connections (?tunnel=id to filter)' }],
            ]}
          />
        </SectionCard>

        {/* 7. Security Checklist */}
        <SectionCard icon={Shield} title="Security Checklist" id="security">
          <div className="space-y-0.5">
            {[
              "Set a strong AUTH_TOKEN in production (use: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\")",
              'Configure ALLOWED_ORIGINS to restrict CORS to your dashboard domain',
              'Restrict SSH admin access (port 22) to your IP in the security group',
              'Use TLS (Nginx + Let\'s Encrypt) in front of ports 4000/4001',
              'Regularly rotate the AUTH_TOKEN and update client configs',
              'Monitor /var/log/tunnelvault.log for suspicious connections',
              'Disable inactive tokens promptly via the dashboard',
              'Keep the EC2 instance and Node.js updated with security patches',
              'Use private IPs only for target_ip values',
              'Review active sessions periodically on the Sessions page',
            ].map((item, i) => (
              <label key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', padding: '7px 8px', cursor: 'pointer' }}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--green-bg)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                <input type="checkbox" style={{ marginTop: '2px', accentColor: 'var(--green)', flexShrink: 0 }} />
                <span className="text-[11px]" style={{ color: 'var(--text-dim)' }}>{item}</span>
              </label>
            ))}
          </div>
        </SectionCard>

        {/* 8. Troubleshooting */}
        <SectionCard icon={AlertCircle} title="Troubleshooting" id="troubleshooting">
          <p className="text-[11px]" style={{ color: 'var(--text-dim)' }}>Click an issue to expand the solution.</p>
          <div style={{ marginTop: '8px' }}>
            <TroubleshootItem question="Server won't start: EADDRINUSE error">
              Ports 4000 or 4001 are already in use. Find the process with <InlineCode>sudo lsof -i :4000</InlineCode> and stop it, or change the port in <InlineCode>.env</InlineCode>.
            </TroubleshootItem>
            <TroubleshootItem question="WebSocket connection refused from CLI client">
              Ensure the server is running and port 4000 is open in your security group. The WebSocket endpoint is <InlineCode>ws://host:4000/ws</InlineCode>. Check firewall rules if using a non-AWS environment.
            </TroubleshootItem>
            <TroubleshootItem question="TCP tunnel connects but SSH fails">
              Verify the client is running (<InlineCode>tunnelvault status</InlineCode>), the tunnel shows as active in the dashboard, and the allocated port is correct. Ensure the local SSH service is running on the client machine.
            </TroubleshootItem>
            <TroubleshootItem question="Tunnel stops working after server restart">
              The client will auto-reconnect (if installed as a service). Check the tunnel is re-registered via the dashboard. If using systemd: <InlineCode>sudo systemctl status tunnelvault-client</InlineCode>.
            </TroubleshootItem>
            <TroubleshootItem question="Dashboard shows 'Frontend not built yet'">
              Run <InlineCode>npm run build</InlineCode> from the project root to build the frontend into <InlineCode>frontend/dist/</InlineCode>. The API serves the dashboard from that directory.
            </TroubleshootItem>
            <TroubleshootItem question="API returns 401 Unauthorized">
              Include the auth token as a Bearer header: <InlineCode>Authorization: Bearer YOUR_TOKEN</InlineCode>. If you don't know the token, check <InlineCode>backend/.env</InlineCode> on the server.
            </TroubleshootItem>
            <TroubleshootItem question="Connections page shows nothing">
              This means no active TCP connections exist. Connect via SSH through the tunnel port first. If connections still don't appear, check that the client is sending traffic and the server backend is up to date.
            </TroubleshootItem>
            <TroubleshootItem question="Tunnel is inactive and won't reactivate">
              Click the toggle in the Tunnels page. The status will show 'Reconnecting…' until the client reconnects via WebSocket. If the client service is stopped, restart it: <InlineCode>sudo systemctl restart tunnelvault-client</InlineCode>.
            </TroubleshootItem>
            <TroubleshootItem question="Systemd service fails to start after reboot">
              Check logs with <InlineCode>journalctl -u tunnelvault -n 50</InlineCode>. Common causes: Node.js not in PATH, missing .env file, or database permissions. Re-run <InlineCode>install-server.sh --upgrade</InlineCode> to fix service configuration.
            </TroubleshootItem>
          </div>
        </SectionCard>

      </div>
    </div>
  );
}

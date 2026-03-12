import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Copy,
  Check,
  Terminal,
  Server,
  Key,
  Shield,
  Globe,
  Cpu,
  AlertCircle,
  BookOpen,
  ChevronDown,
  ChevronRight,
  ExternalLink,
} from 'lucide-react';

/* ─── Shared sub-components ─────────────────────────────────────── */

function CodeBlock({ children, copyText }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    const text =
      copyText ||
      (typeof children === 'string'
        ? children
        : '');
    if (text) {
      navigator.clipboard?.writeText(text);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="group relative mt-3 rounded-lg border border-gray-700/60 bg-gray-950 p-4 font-mono text-[13px] leading-relaxed">
      <button
        onClick={handleCopy}
        className="absolute top-2 right-2 rounded-md border border-gray-700 bg-gray-800/60 p-1.5 text-gray-500 opacity-0 transition-all hover:border-gray-600 hover:text-white group-hover:opacity-100"
      >
        {copied ? (
          <Check size={12} className="text-emerald-400" />
        ) : (
          <Copy size={12} />
        )}
      </button>
      <div className="overflow-x-auto text-gray-400">{children}</div>
    </div>
  );
}

function Kw({ children }) {
  return <span className="text-blue-400">{children}</span>;
}

function Val({ children }) {
  return <span className="text-emerald-400">{children}</span>;
}

function Comment({ children }) {
  return <span className="text-gray-600">{children}</span>;
}

function SectionCard({ icon: Icon, title, id, children }) {
  return (
    <div id={id} className="rounded-xl border border-gray-800/60 bg-gray-900 p-6">
      <div className="mb-4 flex items-center gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-400">
          <Icon size={16} />
        </div>
        <h2 className="text-lg font-semibold text-white">{title}</h2>
      </div>
      {children}
    </div>
  );
}

function StepIndicator({ number, title, children }) {
  return (
    <div className="flex gap-4">
      <div className="flex flex-col items-center">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-500/20 font-mono text-xs font-bold text-emerald-400">
          {number}
        </span>
        <div className="mt-2 flex-1 w-px bg-gray-800/60" />
      </div>
      <div className="pb-6 flex-1 min-w-0">
        <h3 className="mb-2 text-sm font-semibold text-white">{title}</h3>
        <div className="text-sm leading-relaxed text-gray-400">{children}</div>
      </div>
    </div>
  );
}

function TroubleshootItem({ question, children }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-gray-800/40 last:border-0">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-3 py-3 text-left text-sm font-medium text-gray-300 transition-colors hover:text-white"
      >
        {open ? (
          <ChevronDown size={14} className="shrink-0 text-emerald-400" />
        ) : (
          <ChevronRight size={14} className="shrink-0 text-gray-500" />
        )}
        <AlertCircle size={14} className="shrink-0 text-amber-400/70" />
        <span>{question}</span>
      </button>
      {open && (
        <div className="pb-3 pl-11 text-sm leading-relaxed text-gray-400">
          {children}
        </div>
      )}
    </div>
  );
}

function TableWrapper({ children }) {
  return (
    <div className="mt-3 overflow-x-auto rounded-lg border border-gray-800/60">
      <table className="w-full">{children}</table>
    </div>
  );
}

function Th({ children }) {
  return (
    <th className="px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
      {children}
    </th>
  );
}

function Td({ children, mono, accent }) {
  const cls = [
    'px-4 py-2 text-xs',
    mono ? 'font-mono' : '',
    accent === 'emerald'
      ? 'text-emerald-400'
      : accent === 'blue'
        ? 'text-blue-400'
        : accent === 'amber'
          ? 'text-amber-400'
          : 'text-gray-300',
  ].join(' ');
  return <td className={cls}>{children}</td>;
}

/* ─── Main page ─────────────────────────────────────────────────── */

export default function SetupGuide() {
  const navigate = useNavigate();

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Setup Guide</h1>
          <p className="text-sm text-gray-400">
            Comprehensive deployment, configuration, and usage reference
          </p>
        </div>
        <div className="flex items-center gap-2">
          <BookOpen size={16} className="text-emerald-400" />
          <span className="font-mono text-xs text-gray-500">TunnelVault Docs</span>
        </div>
      </div>

      {/* Table of Contents */}
      <div className="rounded-xl border border-gray-800/60 bg-gray-900 p-5">
        <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-gray-500">
          Contents
        </p>
        <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-4">
          {[
            { href: '#server-install', label: 'Server Installation', icon: Server },
            { href: '#client-install', label: 'Client Installation', icon: Terminal },
            { href: '#quick-start', label: 'Quick Start', icon: Cpu },
            { href: '#ssh-gateway', label: 'SSH Gateway Usage', icon: Key },
            { href: '#cli-commands', label: 'CLI Commands', icon: Terminal },
            { href: '#api-endpoints', label: 'API Endpoints', icon: Globe },
            { href: '#security', label: 'Security Checklist', icon: Shield },
            { href: '#troubleshooting', label: 'Troubleshooting', icon: AlertCircle },
          ].map(({ href, label, icon: Icon }) => (
            <a
              key={href}
              href={href}
              className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-gray-400 transition-colors hover:bg-gray-800/60 hover:text-white"
            >
              <Icon size={14} className="shrink-0 text-emerald-400/60" />
              {label}
            </a>
          ))}
        </div>
      </div>

      <div className="max-w-4xl space-y-8">
        {/* ────────────────────────────────────────────────────────── */}
        {/* 1. Server Installation                                    */}
        {/* ────────────────────────────────────────────────────────── */}
        <SectionCard icon={Server} title="Server Installation" id="server-install">
          <p className="mb-2 text-sm text-gray-400">
            Deploy TunnelVault on an EC2 instance (Ubuntu 22.04 recommended). The
            install script sets up Node.js, builds the frontend, configures the SSH
            gateway, and creates systemd services.
          </p>

          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
            Prerequisites
          </p>
          <ul className="mb-4 space-y-1 text-sm text-gray-400">
            <li className="flex items-start gap-2">
              <span className="mt-0.5 text-emerald-400">&#8226;</span>
              EC2 instance: t3.micro minimum (1 vCPU, 1 GB RAM)
            </li>
            <li className="flex items-start gap-2">
              <span className="mt-0.5 text-emerald-400">&#8226;</span>
              Ubuntu 22.04 LTS (x86_64 or ARM)
            </li>
            <li className="flex items-start gap-2">
              <span className="mt-0.5 text-emerald-400">&#8226;</span>
              Security group: ports 22, 4000, 4001 open
            </li>
            <li className="flex items-start gap-2">
              <span className="mt-0.5 text-emerald-400">&#8226;</span>
              Public IP or Elastic IP assigned
            </li>
          </ul>

          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
            Install Command
          </p>
          <CodeBlock copyText="git clone <repo> /opt/tunnelvault-src && cd /opt/tunnelvault-src && sudo bash install-server.sh --domain tunnel.yourdomain.com">
            <div><Kw>git clone</Kw> <Val>{'<repo>'}</Val> /opt/tunnelvault-src</div>
            <div><Kw>cd</Kw> /opt/tunnelvault-src</div>
            <div><Kw>sudo bash</Kw> install-server.sh --domain <Val>tunnel.yourdomain.com</Val></div>
          </CodeBlock>

          <p className="mt-4 mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
            Install Options
          </p>
          <TableWrapper>
            <thead>
              <tr className="border-b border-gray-800/60 bg-gray-900/80">
                <Th>Flag</Th>
                <Th>Default</Th>
                <Th>Description</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/40">
              <tr><Td mono accent="blue">--domain</Td><Td mono>tunnel.local</Td><Td>Server domain name</Td></tr>
              <tr><Td mono accent="blue">--auth-token</Td><Td mono>auto-generated</Td><Td>API authentication token</Td></tr>
              <tr><Td mono accent="blue">--port</Td><Td mono>4000</Td><Td>API + WebSocket + Dashboard port</Td></tr>
              <tr><Td mono accent="blue">--proxy-port</Td><Td mono>4001</Td><Td>Tunnel proxy port</Td></tr>
              <tr><Td mono accent="blue">--upgrade</Td><Td mono>&mdash;</Td><Td>Upgrade existing install (preserves DB and config)</Td></tr>
            </tbody>
          </TableWrapper>
        </SectionCard>

        {/* ────────────────────────────────────────────────────────── */}
        {/* 2. Client Installation                                    */}
        {/* ────────────────────────────────────────────────────────── */}
        <SectionCard icon={Terminal} title="Client Installation" id="client-install">
          <p className="mb-2 text-sm text-gray-400">
            Install the <code className="rounded bg-gray-800 px-1.5 py-0.5 text-xs text-emerald-400">tunnelvault</code> CLI
            on any machine that needs to create tunnels. Config is saved
            to <code className="rounded bg-gray-800 px-1.5 py-0.5 text-xs text-gray-300">~/.tunnelvault/config.json</code>.
          </p>

          <CodeBlock copyText="bash install-client.sh --server ws://YOUR-EC2-IP:4000 --auth-token YOUR_TOKEN">
            <div><Kw>bash</Kw> install-client.sh \</div>
            <div>  --server <Val>ws://YOUR-EC2-IP:4000</Val> \</div>
            <div>  --auth-token <Val>YOUR_TOKEN</Val></div>
          </CodeBlock>

          <p className="mt-3 text-xs text-gray-500">
            To uninstall: <code className="rounded bg-gray-800 px-1.5 py-0.5 text-xs text-gray-300">bash install-client.sh --uninstall</code>
          </p>

          <p className="mt-4 mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
            Config Priority
          </p>
          <p className="text-sm text-gray-400">
            CLI flag &rarr; environment variable (<code className="rounded bg-gray-800 px-1.5 py-0.5 text-xs text-gray-300">TUNNELVAULT_SERVER</code>,{' '}
            <code className="rounded bg-gray-800 px-1.5 py-0.5 text-xs text-gray-300">TUNNELVAULT_AUTH_TOKEN</code>) &rarr;{' '}
            config.json &rarr; defaults.
          </p>
        </SectionCard>

        {/* ────────────────────────────────────────────────────────── */}
        {/* 3. Quick Start                                            */}
        {/* ────────────────────────────────────────────────────────── */}
        <SectionCard icon={Cpu} title="Quick Start" id="quick-start">
          <p className="mb-4 text-sm text-gray-400">
            Get up and running in four steps.
          </p>

          <StepIndicator number="1" title="Deploy the Server">
            <p>Run <code className="rounded bg-gray-800 px-1.5 py-0.5 text-xs text-emerald-400">install-server.sh</code> on
            your EC2 instance. This installs Node.js, builds the dashboard, configures the SSH gateway, and starts systemd services.</p>
            <CodeBlock copyText="sudo bash install-server.sh --domain tunnel.yourdomain.com">
              <div><Kw>sudo bash</Kw> install-server.sh --domain <Val>tunnel.yourdomain.com</Val></div>
            </CodeBlock>
          </StepIndicator>

          <StepIndicator number="2" title="Create a Token">
            <p>Use the web dashboard or API to register a token with a target IP and the client{"'"}s SSH public key.</p>
            <div className="mt-2">
              <button
                onClick={() => navigate('/tokens')}
                className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-medium text-white shadow-lg shadow-emerald-500/20 transition-all hover:bg-emerald-500 hover:shadow-emerald-500/30"
              >
                <ExternalLink size={12} />
                Go to Token Management
              </button>
            </div>
          </StepIndicator>

          <StepIndicator number="3" title="Install the Client">
            <p>On your local machine, run the client installer to set up
              the <code className="rounded bg-gray-800 px-1.5 py-0.5 text-xs text-emerald-400">tunnelvault</code> CLI.</p>
            <CodeBlock copyText="bash install-client.sh --server ws://YOUR-EC2-IP:4000 --auth-token YOUR_TOKEN">
              <div><Kw>bash</Kw> install-client.sh --server <Val>ws://YOUR-EC2-IP:4000</Val> --auth-token <Val>YOUR_TOKEN</Val></div>
            </CodeBlock>
          </StepIndicator>

          <StepIndicator number="4" title="Connect">
            <p>Expose a local port or SSH through the gateway.</p>
            <CodeBlock copyText="tunnelvault connect 3000 --name myapp">
              <div><Comment># Expose local port 3000 as a tunnel</Comment></div>
              <div><Kw>tunnelvault</Kw> connect <Val>3000</Val> --name <Val>myapp</Val></div>
              <div />
              <div><Comment># Or SSH through the gateway</Comment></div>
              <div><Kw>ssh</Kw> <Val>gw-myToken123@your-gateway-ip</Val></div>
            </CodeBlock>
          </StepIndicator>
        </SectionCard>

        {/* ────────────────────────────────────────────────────────── */}
        {/* 4. SSH Gateway Usage                                      */}
        {/* ────────────────────────────────────────────────────────── */}
        <SectionCard icon={Key} title="SSH Gateway Usage" id="ssh-gateway">
          <p className="mb-3 text-sm text-gray-400">
            The SSH gateway routes connections to private EC2 instances using
            token-based usernames. When you connect
            as <code className="rounded bg-gray-800 px-1.5 py-0.5 text-xs text-emerald-400">gw-&lt;TOKEN&gt;</code>,
            the gateway looks up the token in SQLite and proxies the SSH session to
            the target IP via netcat.
          </p>

          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
            How It Works
          </p>
          <ol className="mb-4 space-y-1.5 text-sm text-gray-400 list-decimal list-inside">
            <li>Admin creates a token (dashboard or API) with target IP, port, and client public key</li>
            <li>A Linux user <code className="rounded bg-gray-800 px-1.5 py-0.5 text-xs text-emerald-400">gw-&lt;TOKEN&gt;</code> is created on the gateway</li>
            <li>Client public key is added to that user{"'"}s authorized_keys</li>
            <li><code className="rounded bg-gray-800 px-1.5 py-0.5 text-xs text-gray-300">ssh_router.sh</code> (ForceCommand) looks up the token and proxies to the target</li>
            <li>Session is logged to the database and visible on the dashboard</li>
          </ol>

          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
            SSH Config (~/.ssh/config)
          </p>
          <CodeBlock copyText={"Host my-server\n    HostName <GATEWAY_PUBLIC_IP>\n    User gw-myToken123\n    IdentityFile ~/.ssh/id_rsa"}>
            <div><Kw>Host</Kw>          <Val>my-server</Val></div>
            <div>    <Kw>HostName</Kw>  <Val>&lt;GATEWAY_PUBLIC_IP&gt;</Val></div>
            <div>    <Kw>User</Kw>      <Val>gw-myToken123</Val></div>
            <div>    <Kw>IdentityFile</Kw> <Val>~/.ssh/id_rsa</Val></div>
          </CodeBlock>

          <p className="mt-4 mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
            Connect
          </p>
          <CodeBlock copyText="ssh my-server">
            <div><Kw>ssh</Kw> my-server</div>
            <div><Comment># Gateway automatically routes to the target EC2 private IP</Comment></div>
          </CodeBlock>

          <p className="mt-4 mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
            Register Token via CLI (on gateway server)
          </p>
          <CodeBlock copyText={'sudo bash /opt/tunnelvault/gateway/register_token.sh \\\n  --token myToken123 \\\n  --ip 10.0.1.42 \\\n  --label "My Server" \\\n  --pubkey "ssh-rsa AAAAB3Nza..."'}>
            <div><Kw>sudo bash</Kw> /opt/tunnelvault/gateway/register_token.sh \</div>
            <div>  --token   <Val>myToken123</Val> \</div>
            <div>  --ip      <Val>10.0.1.42</Val> \</div>
            <div>  --label   <Val>{'"'}My Server{'"'}</Val> \</div>
            <div>  --pubkey  <Val>{'"'}ssh-rsa AAAAB3Nza...{'"'}</Val></div>
          </CodeBlock>
        </SectionCard>

        {/* ────────────────────────────────────────────────────────── */}
        {/* 5. CLI Commands                                           */}
        {/* ────────────────────────────────────────────────────────── */}
        <SectionCard icon={Terminal} title="CLI Commands Reference" id="cli-commands">
          <TableWrapper>
            <thead>
              <tr className="border-b border-gray-800/60 bg-gray-900/80">
                <Th>Command</Th>
                <Th>Description</Th>
                <Th>Example</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/40">
              <tr>
                <Td mono accent="emerald">connect &lt;port&gt;</Td>
                <Td>Expose a local port via WebSocket tunnel</Td>
                <Td mono>tunnelvault connect 3000 --name myapp</Td>
              </tr>
              <tr>
                <Td mono accent="emerald">list</Td>
                <Td>List all active tunnels on the server</Td>
                <Td mono>tunnelvault list</Td>
              </tr>
              <tr>
                <Td mono accent="emerald">status</Td>
                <Td>Show server status (uptime, tunnels, connections)</Td>
                <Td mono>tunnelvault status</Td>
              </tr>
            </tbody>
          </TableWrapper>

          <p className="mt-4 mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
            Connect Options
          </p>
          <TableWrapper>
            <thead>
              <tr className="border-b border-gray-800/60 bg-gray-900/80">
                <Th>Flag</Th>
                <Th>Description</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/40">
              <tr><Td mono accent="blue">-n, --name &lt;name&gt;</Td><Td>Tunnel name (shown in dashboard)</Td></tr>
              <tr><Td mono accent="blue">-s, --subdomain &lt;sub&gt;</Td><Td>Requested subdomain for public URL</Td></tr>
              <tr><Td mono accent="blue">--server &lt;url&gt;</Td><Td>Server WebSocket URL (default: ws://localhost:4000)</Td></tr>
              <tr><Td mono accent="blue">--auth-token &lt;token&gt;</Td><Td>Bearer token for authentication</Td></tr>
            </tbody>
          </TableWrapper>

          <p className="mt-4 mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
            Examples
          </p>
          <CodeBlock copyText={"tunnelvault connect 3000 --name myapp\ntunnelvault connect 8080 --name api --subdomain api\ntunnelvault list --server http://tunnel.example.com:4000\ntunnelvault status"}>
            <div><Comment># Expose local port 3000</Comment></div>
            <div><Kw>tunnelvault</Kw> connect <Val>3000</Val> --name <Val>myapp</Val></div>
            <div />
            <div><Comment># Request a specific subdomain</Comment></div>
            <div><Kw>tunnelvault</Kw> connect <Val>8080</Val> --name <Val>api</Val> --subdomain <Val>api</Val></div>
            <div />
            <div><Comment># List tunnels on a remote server</Comment></div>
            <div><Kw>tunnelvault</Kw> list --server <Val>http://tunnel.example.com:4000</Val></div>
            <div />
            <div><Comment># Check server status</Comment></div>
            <div><Kw>tunnelvault</Kw> status</div>
          </CodeBlock>
        </SectionCard>

        {/* ────────────────────────────────────────────────────────── */}
        {/* 6. API Endpoints                                          */}
        {/* ────────────────────────────────────────────────────────── */}
        <SectionCard icon={Globe} title="API Endpoints" id="api-endpoints">
          <p className="mb-3 text-sm text-gray-400">
            All routes require <code className="rounded bg-gray-800 px-1.5 py-0.5 text-xs text-gray-300">Authorization: Bearer &lt;AUTH_TOKEN&gt;</code> unless
            noted. When <code className="rounded bg-gray-800 px-1.5 py-0.5 text-xs text-gray-300">AUTH_TOKEN</code> is
            unset, auth is disabled (dev mode).
          </p>

          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
            Health &amp; Stats
          </p>
          <TableWrapper>
            <thead>
              <tr className="border-b border-gray-800/60 bg-gray-900/80">
                <Th>Method</Th>
                <Th>Path</Th>
                <Th>Auth</Th>
                <Th>Description</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/40">
              <tr><Td mono accent="emerald">GET</Td><Td mono>/api/health</Td><Td>No</Td><Td>Health check with uptime</Td></tr>
              <tr><Td mono accent="emerald">GET</Td><Td mono>/api/stats</Td><Td>Yes</Td><Td>Aggregated stats (tunnels, connections, bytes, tokens, sessions)</Td></tr>
            </tbody>
          </TableWrapper>

          <p className="mt-4 mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
            Tunnels
          </p>
          <TableWrapper>
            <thead>
              <tr className="border-b border-gray-800/60 bg-gray-900/80">
                <Th>Method</Th>
                <Th>Path</Th>
                <Th>Description</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/40">
              <tr><Td mono accent="emerald">GET</Td><Td mono>/api/tunnels</Td><Td>List all active tunnels</Td></tr>
              <tr><Td mono accent="emerald">GET</Td><Td mono>/api/tunnels/:id</Td><Td>Get single tunnel</Td></tr>
              <tr><Td mono accent="blue">POST</Td><Td mono>/api/tunnels</Td><Td>Create tunnel (body: name, localPort, subdomain)</Td></tr>
              <tr><Td mono accent="amber">DELETE</Td><Td mono>/api/tunnels/:id</Td><Td>Remove tunnel</Td></tr>
            </tbody>
          </TableWrapper>

          <p className="mt-4 mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
            Tokens
          </p>
          <TableWrapper>
            <thead>
              <tr className="border-b border-gray-800/60 bg-gray-900/80">
                <Th>Method</Th>
                <Th>Path</Th>
                <Th>Description</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/40">
              <tr><Td mono accent="emerald">GET</Td><Td mono>/api/tokens</Td><Td>List all tokens with session counts</Td></tr>
              <tr><Td mono accent="emerald">GET</Td><Td mono>/api/tokens/:token</Td><Td>Token details + last 50 sessions</Td></tr>
              <tr><Td mono accent="blue">POST</Td><Td mono>/api/tokens</Td><Td>Create token (body: token, label, target_ip, target_port, public_key)</Td></tr>
              <tr><Td mono accent="blue">PATCH</Td><Td mono>/api/tokens/:token</Td><Td>Update fields (target_ip, target_port, label, active, public_key)</Td></tr>
              <tr><Td mono accent="amber">DELETE</Td><Td mono>/api/tokens/:token</Td><Td>Delete token + associated sessions</Td></tr>
            </tbody>
          </TableWrapper>

          <p className="mt-4 mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
            Sessions
          </p>
          <TableWrapper>
            <thead>
              <tr className="border-b border-gray-800/60 bg-gray-900/80">
                <Th>Method</Th>
                <Th>Path</Th>
                <Th>Description</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/40">
              <tr><Td mono accent="emerald">GET</Td><Td mono>/api/sessions</Td><Td>List sessions (?active=1 for active only)</Td></tr>
              <tr><Td mono accent="blue">POST</Td><Td mono>/api/sessions</Td><Td>Create session (body: token, client_ip, pid)</Td></tr>
              <tr><Td mono accent="blue">PATCH</Td><Td mono>/api/sessions/:id</Td><Td>Mark session disconnected</Td></tr>
            </tbody>
          </TableWrapper>

          <p className="mt-4 mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
            Connections
          </p>
          <TableWrapper>
            <thead>
              <tr className="border-b border-gray-800/60 bg-gray-900/80">
                <Th>Method</Th>
                <Th>Path</Th>
                <Th>Description</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/40">
              <tr><Td mono accent="emerald">GET</Td><Td mono>/api/connections</Td><Td>Active connections (?tunnel=id to filter)</Td></tr>
            </tbody>
          </TableWrapper>
        </SectionCard>

        {/* ────────────────────────────────────────────────────────── */}
        {/* 7. Security Checklist                                     */}
        {/* ────────────────────────────────────────────────────────── */}
        <SectionCard icon={Shield} title="Security Checklist" id="security">
          <div className="space-y-2">
            {[
              'Set a strong AUTH_TOKEN in production (use: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))")',
              'Configure ALLOWED_ORIGINS to restrict CORS to your dashboard domain',
              'Restrict SSH admin access (port 22) to your IP in the security group',
              'Use TLS (Nginx + Let\'s Encrypt) in front of ports 4000/4001',
              'Regularly rotate the AUTH_TOKEN and update client configs',
              'Monitor /var/log/tunnelvault-gateway.log for suspicious SSH sessions',
              'Disable inactive tokens promptly via the dashboard',
              'Keep the EC2 instance and Node.js updated with security patches',
              'Use private IPs only for target_ip values (no public IPs through the gateway)',
              'Review active sessions periodically on the Sessions page',
            ].map((item, i) => (
              <label key={i} className="flex items-start gap-3 rounded-lg px-3 py-2 text-sm text-gray-400 transition-colors hover:bg-gray-800/40">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 shrink-0 rounded border-gray-600 bg-gray-800 text-emerald-500 focus:ring-emerald-500/30 focus:ring-offset-0"
                />
                <span>{item}</span>
              </label>
            ))}
          </div>
        </SectionCard>

        {/* ────────────────────────────────────────────────────────── */}
        {/* 8. Troubleshooting                                        */}
        {/* ────────────────────────────────────────────────────────── */}
        <SectionCard icon={AlertCircle} title="Troubleshooting" id="troubleshooting">
          <p className="mb-3 text-sm text-gray-400">
            Click an issue to expand the solution.
          </p>
          <div className="rounded-lg border border-gray-800/60 divide-y divide-gray-800/40 px-3">
            <TroubleshootItem question="Server won't start: EADDRINUSE error">
              Ports 4000 or 4001 are already in use. Find the process
              with <code className="rounded bg-gray-800 px-1.5 py-0.5 text-xs text-gray-300">sudo lsof -i :4000</code> and
              stop it, or change the port in <code className="rounded bg-gray-800 px-1.5 py-0.5 text-xs text-gray-300">.env</code>.
            </TroubleshootItem>

            <TroubleshootItem question="WebSocket connection refused from CLI client">
              Ensure the server is running and port 4000 is open in your security group. The
              WebSocket endpoint is <code className="rounded bg-gray-800 px-1.5 py-0.5 text-xs text-gray-300">ws://host:4000/ws</code>.
              Check firewall rules if using a non-AWS environment.
            </TroubleshootItem>

            <TroubleshootItem question="SSH: Permission denied (publickey)">
              The client{"'"}s public key does not match the registered key for the token. Verify
              with <code className="rounded bg-gray-800 px-1.5 py-0.5 text-xs text-gray-300">GET /api/tokens/:token</code> and
              update the public_key field if needed. Also ensure the token is active.
            </TroubleshootItem>

            <TroubleshootItem question="SSH: Token not found in gateway log">
              The SSH username must be exactly <code className="rounded bg-gray-800 px-1.5 py-0.5 text-xs text-gray-300">gw-&lt;TOKEN&gt;</code>.
              Check that the token exists in the database and the Linux user was created.
              Re-run the register script if needed.
            </TroubleshootItem>

            <TroubleshootItem question="Dashboard shows 'Frontend not built yet'">
              Run <code className="rounded bg-gray-800 px-1.5 py-0.5 text-xs text-gray-300">npm run build</code> from the
              project root to build the frontend
              into <code className="rounded bg-gray-800 px-1.5 py-0.5 text-xs text-gray-300">frontend/dist/</code>. The
              API serves the dashboard from that directory.
            </TroubleshootItem>

            <TroubleshootItem question="API returns 401 Unauthorized">
              Include the auth token as a Bearer
              header: <code className="rounded bg-gray-800 px-1.5 py-0.5 text-xs text-gray-300">Authorization: Bearer YOUR_TOKEN</code>.
              If you don{"'"}t know the token, check <code className="rounded bg-gray-800 px-1.5 py-0.5 text-xs text-gray-300">backend/.env</code> on
              the server.
            </TroubleshootItem>

            <TroubleshootItem question="API returns 429 Too Many Requests">
              Rate limiting is 100 requests per minute per IP. Wait 60 seconds and try again.
              If you need higher limits, modify <code className="rounded bg-gray-800 px-1.5 py-0.5 text-xs text-gray-300">RATE_LIMIT_MAX</code> in
              server.js.
            </TroubleshootItem>

            <TroubleshootItem question="Tunnel connects but traffic doesn't flow">
              Check that the local application is running on the port you specified. The CLI
              client forwards traffic
              to <code className="rounded bg-gray-800 px-1.5 py-0.5 text-xs text-gray-300">localhost:&lt;port&gt;</code>.
              Also verify the proxy server is running on port 4001.
            </TroubleshootItem>

            <TroubleshootItem question="SSH gateway works but session not tracked">
              The gateway script calls <code className="rounded bg-gray-800 px-1.5 py-0.5 text-xs text-gray-300">POST /api/sessions</code> to
              log sessions. Verify the API is reachable from localhost
              (<code className="rounded bg-gray-800 px-1.5 py-0.5 text-xs text-gray-300">curl http://127.0.0.1:4000/api/health</code>).
              Check <code className="rounded bg-gray-800 px-1.5 py-0.5 text-xs text-gray-300">/var/log/tunnelvault-gateway.log</code> for errors.
            </TroubleshootItem>

            <TroubleshootItem question="Systemd service fails to start after reboot">
              Check logs
              with <code className="rounded bg-gray-800 px-1.5 py-0.5 text-xs text-gray-300">journalctl -u tunnelvault -n 50</code>.
              Common causes: Node.js not in PATH, missing .env file, or database permissions.
              Re-run <code className="rounded bg-gray-800 px-1.5 py-0.5 text-xs text-gray-300">install-server.sh --upgrade</code> to
              fix service configuration.
            </TroubleshootItem>
          </div>
        </SectionCard>
      </div>
    </div>
  );
}

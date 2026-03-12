# TunnelVault

Self-hosted tunneling service with TCP/SSH tunneling, WebSocket HTTP tunnels, and a web dashboard — like ngrok, but private and self-hosted.

- **TCP Tunneling** — expose any TCP port (e.g. SSH on port 22) through the server; connect with a plain `ssh` command
- **HTTP Tunnels** — expose local HTTP services via persistent WebSocket connections
- **Named Client Tokens** — create per-device tokens in the dashboard; clients identify themselves automatically by token
- **Fixed TCP Ports** — each tunnel reuses the same port across reconnects and server restarts
- **Auto-connect Service** — client runs as a systemd service, reconnects on boot without manual commands
- **Auto-Updater (server)** — server checks for new Git commits every 72h and redeploys automatically
- **Auto-Updater (client)** — client checks for updates every 12h; safe over live tunnels
- **Webhook Notifications** — push alerts when tunnels connect/disconnect (ntfy, Slack, Discord, or generic JSON)
- **Web Dashboard** — real-time monitoring of tunnels, tokens, sessions, and connections
- **Sessions Log** — searchable, filterable history with CSV export
- **CLI Client** — lightweight command-line tool (`connect`, `list`, `status`)
- **Built-in Security** — per-client token auth, rate limiting, input validation, security headers

---

## TL;DR — SSH into a Raspberry Pi through EC2

**1. Deploy the server** (on your EC2 instance):
```bash
git clone https://github.com/florianhengross/sshtunnel.git ~/tunnelvault
cd ~/tunnelvault
sudo bash install-server.sh
```
Save the admin auth token printed at the end.

**2. Create a client token in the dashboard:**

Open `http://YOUR-EC2-IP:4000` → Tokens → New Token → give it a name (e.g. "Raspberry Pi").

**3. Install the client** (on the Raspberry Pi):
```bash
git clone https://github.com/florianhengross/sshtunnel.git ~/tunnelvault
cd ~/tunnelvault
sudo bash install-client.sh --server ws://YOUR-EC2-IP:4000 --token CLIENT_TOKEN
```
The client starts automatically on boot and reconnects if the connection drops.

**4. SSH from anywhere:**

The dashboard shows the assigned port under Tunnels. Connect from any device:
```bash
ssh pi@YOUR-EC2-IP -p PORT_FROM_DASHBOARD
```

> Make sure your EC2 security group allows inbound TCP on ports **22**, **4000**, **4001**, and **10000–10999**.

---

## Architecture

```
 Any Device          EC2 Instance
 ──────────┐    ┌──────────────────────────────┐
           │    │  Dashboard + API  (port 4000) │
 ssh -p N  ├───▶│  TCP Proxy        (port N)    │
           │    │  HTTP Proxy       (port 4001) │
 ──────────┘    └────────────┬─────────────────┘
                             │ WebSocket (persistent)
                    ┌────────▼───────────┐
                    │  TunnelVault       │
                    │  Client (device)   │
                    │  runs as systemd   │
                    │  service           │
                    └────────┬───────────┘
                             │
                    ┌────────▼───────────┐
                    │  localhost:22      │
                    │  (SSH / any port)  │
                    └────────────────────┘
```

**TCP tunnel flow:** Client connects to server via WebSocket using its per-client token → server allocates a port (10000–10999) → when someone SSHes to that port on EC2, raw TCP is piped through the WebSocket to the client → client forwards to `localhost:22`.

**HTTP tunnel flow:** CLI client registers via WebSocket → server assigns subdomain → incoming HTTP on proxy port (4001) is forwarded through WebSocket to client → client forwards to local app.

---

## Features

- **TCP tunneling** — pipe raw TCP (SSH, databases, anything) through WebSocket to any client device
- **SSH access from anywhere** — `ssh user@ec2-ip -p PORT` with port assigned and shown in the dashboard
- **Per-client token auth** — each device gets its own named token; tunnel appears in dashboard with device name
- **Auto-connect systemd service** — client installer sets up a service that starts on boot and auto-reconnects
- **HTTP tunneling** — expose local HTTP services via subdomain routing through proxy port
- Web dashboard with real-time stats, charts, and session history
- CLI client with `connect`, `list`, and `status` commands
- Token management (create, enable/disable, delete) via dashboard or API
- Connection monitoring with bytes transferred
- Rate limiting (100 req/min per IP)
- Security headers (CSP, X-Frame-Options, etc.)
- SQLite database — no external DB required
- Automated server (`install-server.sh`) and client (`install-client.sh`) installation scripts

---

## Quick Start (Local Dev)

```bash
# Install all dependencies (frontend + backend + client)
npm run install:all

# Build the frontend
npm run build

# Start the server (API + dashboard on :4000, proxy on :4001)
npm start

# Open dashboard
open http://localhost:4000
```

For development with hot-reload:

```bash
npm run dev
# Frontend: http://localhost:3000
# Backend API: http://localhost:4000
# Proxy: http://localhost:4001
```

---

## Production Deployment (EC2)

```bash
# On your EC2 instance:
git clone <repo> ~/tunnelvault
cd ~/tunnelvault
sudo bash install-server.sh --domain tunnel.yourdomain.com
```

### install-server.sh Options

| Flag | Description | Default |
|------|-------------|---------|
| `--domain DOMAIN` | Server domain name | `tunnel.local` |
| `--auth-token TOKEN` | API auth token | Auto-generated |
| `--port PORT` | API server port | `4000` |
| `--proxy-port PORT` | Proxy server port | `4001` |
| `--upgrade` | Upgrade existing install (preserves DB and config), rebuilds frontend | — |
| `--tls` | Set up Nginx + Let's Encrypt automatically | — |

After a successful install, the server auto-updates itself every 12 hours by checking for new commits on `origin/main`. Logs: `tail -f /opt/tunnelvault/logs/auto-update.log`. Force update: `sudo /opt/tunnelvault/auto-update.sh`.

### EC2 Requirements

| Requirement | Minimum | Recommended |
|-------------|---------|-------------|
| Instance | t3.micro (1 vCPU, 1 GB) | t3.small (2 vCPU, 2 GB) |
| AMI | Ubuntu 22.04 LTS | Ubuntu 22.04 LTS |
| Storage | 8 GB gp3 | 20 GB gp3 |

### Security Group Rules

| Port | Protocol | Source | Purpose |
|------|----------|--------|---------|
| 22 | TCP | 0.0.0.0/0 | Admin SSH access to EC2 |
| 4000 | TCP | 0.0.0.0/0 | API + Dashboard + WebSocket |
| 4001 | TCP | 0.0.0.0/0 | HTTP proxy (tunnel traffic) |
| 10000–10999 | TCP | 0.0.0.0/0 | TCP tunnels (SSH access to devices) |
| 80/443 | TCP | 0.0.0.0/0 | Optional: Nginx + TLS |

---

## Client Installation

First, create a client token in the dashboard (Tokens → New Token), then run on the client device:

```bash
git clone https://github.com/florianhengross/sshtunnel.git ~/tunnelvault
cd ~/tunnelvault
sudo bash install-client.sh --server ws://YOUR-EC2-IP:4000 --token YOUR_CLIENT_TOKEN
```

This installs the `tunnelvault` CLI, writes config to `/etc/tunnelvault/config.json` and `~/.tunnelvault/config.json`, and creates a systemd service (`tunnelvault-client`) that:
- Starts automatically on boot
- Reconnects automatically if the connection drops
- Exposes the local SSH port (22) as a TCP tunnel

### install-client.sh Options

| Flag | Description | Default |
|------|-------------|---------|
| `--server URL` | TunnelVault server WebSocket URL | required |
| `--token TOKEN` | Per-client auth token from dashboard | required |
| `--port PORT` | Local port to tunnel | `22` |
| `--protocol PROTO` | Tunnel protocol: `tcp` or `http` | `tcp` |
| `--user USER` | Linux user to run the service as | current user |
| `--upgrade` | Update client files, preserve config, schedule safe restart | — |

> **Safe upgrade over an active tunnel:** If you run `--upgrade` while connected via the tunnel, the script copies all files first without stopping the service, then schedules a service restart 30 seconds later. Your SSH session will disconnect when the tunnel restarts and reconnect automatically.

Once connected, the assigned SSH port is shown in the dashboard under Tunnels:
```bash
ssh pi@YOUR-EC2-IP -p PORT_FROM_DASHBOARD
```

---

## Usage

### Connect a Local Port (HTTP)

```bash
tunnelvault connect 3000 --name myapp
tunnelvault connect 8080 --name api --subdomain api
tunnelvault connect 3000 --server ws://tunnel.example.com:4000
```

### Connect a TCP Port (SSH / raw TCP)

```bash
tunnelvault connect 22 --protocol tcp
tunnelvault connect 22 --protocol tcp --server ws://YOUR-EC2-IP:4000 --auth-token YOUR_TOKEN
```

The server assigns a port and shows it in the dashboard. SSH from anywhere:
```bash
ssh user@YOUR-EC2-IP -p ASSIGNED_PORT
```

### List Active Tunnels

```bash
tunnelvault list
tunnelvault list --server http://tunnel.example.com:4000
```

### Check Server Status

```bash
tunnelvault status
tunnelvault status --server http://tunnel.example.com:4000
```

### Global Options

| Option | Env Variable | Config Key | Description |
|--------|-------------|------------|-------------|
| `--auth-token <token>` | `TUNNELVAULT_AUTH_TOKEN` | `auth_token` | Bearer token for API auth |
| `--server <url>` | `TUNNELVAULT_SERVER` | `server` | Server URL |

Priority: CLI flag > environment variable > `~/.tunnelvault/config.json` > default.

---

## TCP Tunneling (SSH Access)

TCP tunneling lets you SSH into any device running the TunnelVault client, even if it's behind NAT or a firewall.

### How It Works

1. Create a named client token in the dashboard (Tokens → New Token, just a label — no IP or public key needed)
2. Install and start the client on the device: `sudo bash install-client.sh --server ws://EC2:4000 --token TOKEN`
3. The client connects to the server via WebSocket and registers a TCP tunnel for port 22
4. The server allocates a port from the range 10000–10999 and shows it in the dashboard under Tunnels
5. From any device: `ssh user@EC2-IP -p ASSIGNED_PORT` — traffic is piped through the WebSocket to the client

### SSH from Anywhere

```bash
# Port shown in the dashboard under Tunnels
ssh pi@YOUR-EC2-IP -p 10001
```

Or add to `~/.ssh/config` for convenience:
```
Host raspberry-pi
    HostName YOUR-EC2-IP
    Port 10001
    User pi
```
```bash
ssh raspberry-pi
```

---

## Web Dashboard

The dashboard is served on port 4000 alongside the API. Pages:

| Page | Path | Description |
|------|------|-------------|
| Dashboard | `/` | Overview stats, connection history chart, live sessions |
| Tunnels | `/tunnels` | Active WebSocket tunnels with public URLs |
| Tokens | `/tokens` | Create, edit, enable/disable, delete SSH gateway tokens |
| Sessions | `/sessions` | TCP tunnel session history with client IP, port, duration, status |
| Connections | `/connections` | Active proxy connections with bytes transferred |
| Settings | `/settings` | Server configuration and status |
| Setup Guide | `/setup` | In-app deployment and usage documentation |

---

## API Reference

All endpoints require `Authorization: Bearer <AUTH_TOKEN>` header (except health check). When `AUTH_TOKEN` is not set in `.env`, auth is disabled (dev mode).

### Health

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/health` | No | Health check, returns uptime |

### Tunnels

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/tunnels` | Yes | List all active tunnels |
| GET | `/api/tunnels/:id` | Yes | Get a single tunnel |
| POST | `/api/tunnels` | Yes | Create a tunnel (body: `name`, `localPort`, `subdomain`) |
| DELETE | `/api/tunnels/:id` | Yes | Remove a tunnel |

### Tokens

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/tokens` | Yes | List all tokens with session counts |
| GET | `/api/tokens/:token` | Yes | Get token details + last 50 sessions |
| POST | `/api/tokens` | Yes | Create token (body: `label`, optional `token`) |
| PATCH | `/api/tokens/:token` | Yes | Update token fields (`label`, `active`) |
| DELETE | `/api/tokens/:token` | Yes | Delete token and associated sessions |

### Sessions

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/sessions` | Yes | List sessions (query: `?active=1` for active only) |
| POST | `/api/sessions` | Yes | Create session entry (body: `token`, `client_ip`, `pid`) |
| PATCH | `/api/sessions/:id` | Yes | Mark session disconnected |

### Connections

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/connections` | Yes | List active connections (query: `?tunnel=<id>` to filter) |

### Stats

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/stats` | Yes | Aggregated stats: tunnels, connections, bytes, uptime, tokens, sessions |

---

## Security

| Feature | Details |
|---------|---------|
| Authentication | Bearer token on all API routes; configurable via `AUTH_TOKEN` env var |
| Rate Limiting | 100 requests per minute per IP on `/api` routes |
| Security Headers | X-Frame-Options: DENY, X-Content-Type-Options: nosniff, X-XSS-Protection, CSP, Referrer-Policy |
| Input Validation | Token format (alphanumeric, 1-64 chars), IPv4 validation, port range checks, label sanitization |
| WebSocket Auth | Token-based authentication on WebSocket upgrade |
| CORS | Configurable allowed origins via `ALLOWED_ORIGINS` |
| SSH Keys | Public key authentication for gateway connections |

---

## Configuration

All configuration is via environment variables in `backend/.env`:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `4000` | API + WebSocket + Dashboard port |
| `PROXY_PORT` | `4001` | HTTP tunnel proxy port |
| `DOMAIN` | `tunnel.local` | Server domain for generating HTTP tunnel URLs |
| `AUTH_TOKEN` | — | Admin API auth token (leave unset for dev mode) |
| `TCP_PORT_MIN` | `10000` | Start of TCP tunnel port range |
| `TCP_PORT_MAX` | `10999` | End of TCP tunnel port range |
| `ALLOWED_ORIGINS` | — | Comma-separated CORS origins (unset = allow all) |
| `WEBHOOK_URL` | — | URL to POST tunnel events to (see Webhooks below) |
| `WEBHOOK_TYPE` | `json` | Webhook format: `ntfy`, `slack`, `discord`, or `json` |

Generate a secure token:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Webhooks

Set `WEBHOOK_URL` and `WEBHOOK_TYPE` in `backend/.env` to receive push notifications when tunnels connect or disconnect.

| Type | How to use |
|------|------------|
| `ntfy` | `WEBHOOK_URL=https://ntfy.sh/your-topic` |
| `slack` | `WEBHOOK_URL=<Incoming Webhook URL>` |
| `discord` | `WEBHOOK_URL=<Discord Webhook URL>` |
| `json` | `WEBHOOK_URL=https://your-endpoint.com/hook` — receives `{ event, text, tunnelName, tunnelId, allocatedPort, timestamp }` |

Restart the server after changing `.env`: `sudo systemctl restart tunnelvault`

---

## Project Structure

```
tunnelvault/
├── backend/
│   ├── src/
│   │   ├── server.js           # Express app, HTTP server, WebSocket init
│   │   ├── tunnelManager.js    # Tunnel lifecycle management
│   │   ├── connectionTracker.js# Connection stats and history
│   │   ├── wsHandler.js        # WebSocket handler for tunnel clients
│   │   ├── proxyServer.js      # HTTP proxy for tunnel traffic
│   │   ├── tcpProxy.js         # TCP-over-WebSocket proxy (SSH tunneling)
│   │   ├── database.js         # SQLite database helpers
│   │   └── routes/
│   │       ├── tunnels.js      # /api/tunnels CRUD
│   │       ├── tokens.js       # /api/tokens CRUD
│   │       ├── sessions.js     # /api/sessions CRUD
│   │       ├── connections.js  # /api/connections read
│   │       └── stats.js        # /api/stats aggregation
│   └── .env                    # Server configuration
├── frontend/
│   └── src/
│       └── pages/
│           ├── Dashboard.jsx   # Overview stats and charts
│           ├── Tunnels.jsx     # Tunnel management
│           ├── Tokens.jsx      # Token CRUD with SSH config
│           ├── Sessions.jsx    # Session history
│           ├── Connections.jsx # Active connections
│           ├── Settings.jsx    # Server settings
│           └── SetupGuide.jsx  # In-app documentation
├── client/
│   └── bin/
│       └── tunnelvault.js      # CLI entry point (connect, list, status)
├── gateway/
│   ├── ssh_router.sh           # ForceCommand for sshd (token → target routing)
│   ├── register_token.sh       # CLI script to register tokens
│   └── setup.sh                # Gateway sshd configuration
├── install-server.sh           # Automated server deployment script
├── install-client.sh           # Automated client installation script
├── auto-update.sh              # Auto-updater (installed to /opt/tunnelvault/ by install-server.sh)
├── DEPLOYMENT.md               # Full EC2 deployment guide
└── package.json                # Root scripts (install:all, dev, build, start)
```

---

## Troubleshooting

For the full troubleshooting guide, see [DEPLOYMENT.md](DEPLOYMENT.md).

**Server won't start**
Check that ports 4000 and 4001 are not in use: `sudo lsof -i :4000`. Verify Node.js is installed: `node --version`.

**WebSocket connection refused**
Ensure the server is running and port 4000 is open in your security group. The client connects to `ws://<host>:4000/ws`.

**TCP tunnel: connection refused on SSH port**
Check the client service is running: `journalctl -u tunnelvault-client -f`. Verify the tunnel shows as active in the dashboard. Make sure your EC2 security group allows TCP on ports 10000–10999.

**TCP tunnel: port not shown in dashboard**
The client must connect with `--protocol tcp`. If using the install script, this is the default. Check tunnel status in the dashboard — the port appears once the client is connected.

**Dashboard shows no data / 500 errors on `/api/stats`**
If upgrading from an older install, the database may be missing columns added in newer versions. Restart the service — migrations run automatically on startup: `sudo systemctl restart tunnelvault`. Also ensure the frontend is built: `npm run build`.

**Dashboard UI looks outdated after `git pull`**
The `--upgrade` flag now always rebuilds the frontend. Run `cd ~/tunnelvault && git pull && sudo bash install-server.sh --upgrade`, then hard-refresh the browser (`Ctrl+Shift+R`).

---

## License

MIT

# TunnelVault

Self-hosted tunneling service with SSH gateway routing, WebSocket tunnels, and a web dashboard — like ngrok, but private.

- **SSH Token Routing** — route SSH connections through a gateway to private EC2 instances using `gw-<TOKEN>` usernames
- **WebSocket Tunnels** — expose local ports to the internet via persistent WebSocket connections
- **Web Dashboard** — real-time monitoring of tunnels, tokens, sessions, and connections
- **CLI Client** — lightweight command-line tool to create and manage tunnels
- **Built-in Security** — auth tokens, rate limiting, input validation, security headers

---

## TL;DR — Get Running in 3 Steps

**1. Deploy the server** (on your EC2 instance):
```bash
git clone https://github.com/florianhengross/sshtunnel.git ~/tunnelvault
cd ~/tunnelvault
sudo bash install-server.sh --domain tunnel.yourdomain.com
```
Save the auth token printed at the end.

**2. Install the client** (on your local machine):
```bash
bash install-client.sh --server ws://YOUR-EC2-IP:4000 --auth-token YOUR_TOKEN
```

**3. Expose a local port:**
```bash
tunnelvault connect 3000
```

Open the dashboard at `http://YOUR-EC2-IP:4000`.

> Make sure your EC2 security group allows inbound TCP on ports **22**, **4000**, and **4001**.

---

## Architecture

```
                          EC2 Instance
                    ┌─────────────────────────┐
 Internet           │  SSH Gateway (port 22)   │         VPC
 ────────┐          │  API + WS   (port 4000)  │    ┌────────────┐
         │          │  Proxy      (port 4001)  │    │ Target EC2 │
 SSH     ├────SSH──▶│  Dashboard  (port 4000)  │───▶│ 10.0.x.x   │
 Client  │          └─────────────────────────┘    └────────────┘
 ────────┘                     ▲
                               │ WebSocket
 ┌────────────┐     ┌─────────┴──────────┐
 │ Browser    │────▶│  TunnelVault       │◀───── CLI Client (local)
 │ Dashboard  │     │  Server (:4000)    │              │
 └────────────┘     │  Proxy  (:4001)    │              ▼
                    └────────────────────┘       ┌─────────────┐
                                                 │ Local App   │
                                                 │ (:3000 etc) │
                                                 └─────────────┘
```

**SSH flow:** Client connects as `gw-<TOKEN>@gateway` &rarr; `ssh_router.sh` looks up token in SQLite &rarr; proxies to target EC2 private IP via netcat.

**Tunnel flow:** CLI client opens WebSocket to server &rarr; server assigns subdomain &rarr; incoming HTTP on proxy port is forwarded through WebSocket to client &rarr; client forwards to local app.

---

## Features

- SSH token-based routing to private VPC instances
- Web dashboard with real-time stats, charts, and session history
- WebSocket tunnel creation and management
- CLI client with `connect`, `list`, and `status` commands
- Token management (create, update, enable/disable, delete) via API or dashboard
- Session tracking with client IP, PID, and duration
- Connection monitoring with bytes transferred
- Rate limiting (100 req/min per IP)
- Security headers (CSP, X-Frame-Options, XSS protection)
- Bearer token authentication on all API routes
- SQLite database for tokens and sessions
- Systemd service integration for production
- Automated server and client installation scripts

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
| `--upgrade` | Upgrade existing install (preserves DB and config) | — |
| `--tls` | Set up Nginx + Let's Encrypt automatically | — |

### EC2 Requirements

| Requirement | Minimum | Recommended |
|-------------|---------|-------------|
| Instance | t3.micro (1 vCPU, 1 GB) | t3.small (2 vCPU, 2 GB) |
| AMI | Ubuntu 22.04 LTS | Ubuntu 22.04 LTS |
| Storage | 8 GB gp3 | 20 GB gp3 |

### Security Group Rules

| Port | Protocol | Source | Purpose |
|------|----------|--------|---------|
| 22 | TCP | 0.0.0.0/0 | SSH gateway + admin access |
| 4000 | TCP | 0.0.0.0/0 | API + Dashboard + WebSocket |
| 4001 | TCP | 0.0.0.0/0 | Proxy server (tunnel traffic) |
| 80/443 | TCP | 0.0.0.0/0 | Optional: Nginx + TLS |

---

## Client Installation

```bash
bash install-client.sh --server ws://YOUR-EC2-IP:4000 --auth-token YOUR_TOKEN
```

This installs the `tunnelvault` CLI to your system and saves config to `~/.tunnelvault/config.json`.

To uninstall:

```bash
bash install-client.sh --uninstall
```

---

## Usage

### Connect a Local Port

```bash
tunnelvault connect 3000 --name myapp
tunnelvault connect 8080 --name api --subdomain api
tunnelvault connect 3000 --server ws://tunnel.example.com:4000
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

## SSH Gateway

The SSH gateway routes connections to private EC2 instances using token-based usernames.

### How It Works

1. Admin creates a token via the web dashboard or API, specifying: token name, target IP, target port, and client public key
2. A Linux user `gw-<TOKEN>` is created on the gateway server
3. The client's public key is added to that user's `authorized_keys`
4. When a client connects as `gw-<TOKEN>`, the `ssh_router.sh` ForceCommand looks up the token in SQLite and proxies the connection to the target IP via netcat
5. The session is recorded in the database and appears on the dashboard

### SSH Config Example

```
Host my-server
    HostName <GATEWAY_PUBLIC_IP>
    User gw-myToken123
    IdentityFile ~/.ssh/id_rsa
```

```bash
ssh my-server
# Automatically routes to the target EC2 private IP
```

### Register a Token via CLI

```bash
sudo bash /opt/tunnelvault/register_token.sh \
  --token   myToken123 \
  --ip      10.0.1.42 \
  --label   "My Server" \
  --pubkey  "ssh-rsa AAAAB3Nza..."
```

---

## Web Dashboard

The dashboard is served on port 4000 alongside the API. Pages:

| Page | Path | Description |
|------|------|-------------|
| Dashboard | `/` | Overview stats, connection history chart, live sessions |
| Tunnels | `/tunnels` | Active WebSocket tunnels with public URLs |
| Tokens | `/tokens` | Create, edit, enable/disable, delete SSH gateway tokens |
| Sessions | `/sessions` | SSH session history with client IP, duration, status |
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
| POST | `/api/tokens` | Yes | Create token (body: `token`, `label`, `target_ip`, `target_port`, `public_key`) |
| PATCH | `/api/tokens/:token` | Yes | Update token fields (`target_ip`, `target_port`, `label`, `active`, `public_key`) |
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
| `PROXY_PORT` | `4001` | Tunnel proxy port |
| `DOMAIN` | `tunnel.local` | Server domain for generating public URLs |
| `AUTH_TOKEN` | — | API authentication token (leave unset for dev mode) |
| `ALLOWED_ORIGINS` | — | Comma-separated CORS origins (unset = allow all) |

Generate a secure token:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

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

**SSH gateway: "Permission denied"**
Verify the token exists and is active (`GET /api/tokens`). Check that the client's public key matches what was registered.

**SSH gateway: "Token not found"**
The username must be `gw-<TOKEN>` exactly. Verify the token is in the database and the `gw-` user was created on the system.

**Dashboard shows no data**
Build the frontend first: `npm run build`. The API serves the frontend from `frontend/dist/`. In dev mode, run `npm run dev` for hot-reload on port 3000.

---

## License

MIT

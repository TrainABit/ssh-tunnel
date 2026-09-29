# TunnelVault

> Self-hosted SSH and TCP tunneling over WebSocket. Like ngrok, but on your own server.

TunnelVault gives you SSH access to devices behind NAT, CGNAT or restrictive firewalls, such as Raspberry Pis, edge boxes, lab machines or home servers. You don't need port forwarding or a VPN, and no third-party relay sees your traffic. Each device keeps one outbound WebSocket connection open to your server. The server gives that device a fixed public TCP port and pipes connections through.

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![Node.js 20](https://img.shields.io/badge/node-20.x-green.svg)
![Platform: Linux](https://img.shields.io/badge/platform-linux-lightgrey.svg)

---

## Features

- **TCP tunneling over WebSocket.** Tunnel SSH, web dashboards, databases or any other TCP service. The device only needs outbound access.
- **Multiple ports per device.** One connection carries several ports (`--extra-port 8080:tcp:dashboard`).
- **Stable ports.** A device keeps its assigned port across reconnects and reboots.
- **Browser SSH terminal.** Open a shell on any connected device straight from the dashboard.
- **Named device tokens.** Every device gets its own token that you can revoke, and it shows up by name in the dashboard.
- **Web dashboard.** Live view of tunnels, tokens, TCP sessions (with client IP and GeoIP), bytes transferred and connection history.
- **Webhooks.** Connect and disconnect events go to ntfy, Slack, Discord or plain JSON.
- **Unattended operation.** The client runs as a systemd service and reconnects with backoff. The server can update itself from Git every 12 hours.
- **Hardening.** Token auth, rate limiting, security headers and input validation. Gateway SSH users are locked down with `ForceCommand`. Optional Nginx + Let's Encrypt TLS with a single flag.

## How it works

```
 Your laptop          Your server (VPS / EC2 / on-prem)          Remote device (behind NAT)
┌────────────┐       ┌──────────────────────────────────┐       ┌────────────────────┐
│            │ ssh   │ TCP proxy          10000–10999   │  WS   │ TunnelVault client │
│ ssh / web  ├──────▶│ HTTP proxy         4001          │◀──────┤ (systemd service)  │
│            │ -p N  │ API + dashboard    4000          │ out-  │         │          │
└────────────┘       │ SQLite: tokens, sessions, stats  │ bound │         ▼          │
                     └──────────────────────────────────┘ only  │   localhost:22     │
                                                                └────────────────────┘
```

1. The client opens a persistent WebSocket to the server and authenticates with its token.
2. The server reserves a port from the pool (10000–10999 by default) and stores it for that token.
3. A TCP connection that arrives on that port is multiplexed over the WebSocket to the client, which connects to the local target port (e.g. `22`).

| Component | Path | Stack |
|---|---|---|
| Server (API, WebSocket hub, TCP/HTTP proxy) | `backend/` | Node.js, Express 5, `ws`, `ssh2`, better-sqlite3 |
| Dashboard | `frontend/` | React + Vite |
| Device client / CLI | `client/` | Node.js, `ws`, commander |
| SSH gateway (`ForceCommand` router) | `gateway/` | Bash, OpenSSH |
| Installers | `install-*.sh`, `uninstall-*.sh` | Bash, systemd |

## Quick start

**1. Deploy the server** on any Linux host (Ubuntu 22.04 recommended):

```bash
git clone https://github.com/TrainABit/ssh-tunnel.git ~/tunnelvault
cd ~/tunnelvault
sudo bash install-server.sh
```

Save the admin auth token that the installer prints at the end.

**2. Create a device token.** Open `http://SERVER_IP:4000`, go to **Tokens → New Token** and give it a name (e.g. `office-pi`).

**3. Install the client on the device:**

```bash
git clone https://github.com/TrainABit/ssh-tunnel.git ~/tunnelvault
cd ~/tunnelvault
sudo bash install-client.sh --server ws://SERVER_IP:4000 --token DEVICE_TOKEN
```

**4. Connect from anywhere.** The dashboard shows the assigned port under **Tunnels**:

```bash
ssh user@SERVER_IP -p ASSIGNED_PORT
```

> Your firewall or security group must allow inbound TCP on **22**, **4000**, **4001** and **10000–10999**.

## Server

```bash
sudo bash install-server.sh --domain tunnel.example.com --tls
```

| Flag | Description | Default |
|---|---|---|
| `--domain DOMAIN` | Public domain of the server | `tunnel.local` |
| `--auth-token TOKEN` | Admin API token | generated |
| `--port PORT` | API, dashboard and WebSocket port | `4000` |
| `--proxy-port PORT` | HTTP proxy port | `4001` |
| `--tls` | Set up Nginx and a Let's Encrypt certificate | off |
| `--upgrade` | Update in place, keep database and config | — |

**Requirements:** 1 vCPU / 1 GB RAM / 8 GB disk is enough (2 vCPU / 2 GB recommended). The installer sets up Node.js 20.

**Firewall**

| Port | Purpose |
|---|---|
| 22/tcp | Admin SSH and gateway SSH |
| 4000/tcp | API, dashboard, WebSocket |
| 4001/tcp | HTTP proxy |
| 10000–10999/tcp | Tunnel ports |
| 80, 443/tcp | Optional: Nginx + TLS |

For a step-by-step AWS walkthrough with a hardening checklist, see [DEPLOYMENT.md](DEPLOYMENT.md).

## Client

```bash
sudo bash install-client.sh --server ws://SERVER_IP:4000 --token DEVICE_TOKEN \
  --extra-port 8080:tcp:dashboard
```

| Flag | Description | Default |
|---|---|---|
| `--server URL` | WebSocket URL of the server (`ws://` or `wss://`) | required |
| `--token TOKEN` | Device token from the dashboard | required |
| `--port PORT` | Primary local port | `22` |
| `--protocol PROTO` | `tcp` or `http` | `tcp` |
| `--extra-port PORT:PROTO:NAME` | Additional port, can be repeated | — |
| `--user USER` | User the service runs as | — |
| `--upgrade` | Update the client and rewrite config and service | — |

The installer can upgrade the client through a live tunnel. It copies the new files without stopping the service and schedules a restart 30 seconds later. Your SSH session drops briefly and reconnects on its own.

## Configuration

The server reads `backend/.env`:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `4000` | API, dashboard and WebSocket |
| `PROXY_PORT` | `4001` | HTTP proxy |
| `DOMAIN` | `tunnel.local` | Domain for HTTP tunnel URLs |
| `AUTH_TOKEN` | — | Admin token |
| `TCP_PORT_MIN` / `TCP_PORT_MAX` | `10000` / `10999` | Tunnel port pool |
| `WEBHOOK_URL` | — | Target for tunnel events |
| `WEBHOOK_TYPE` | `json` | `json`, `ntfy`, `slack` or `discord` |

Generate a strong token:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| Client fails with `ECONNREFUSED` | Port 4000 isn't reachable. Check the firewall. Some corporate networks block outbound 4000; use `--tls` and `wss://` on 443 instead. |
| Tunnel is up but SSH fails | Check `journalctl -u tunnelvault-client -f` on the device, and make sure 10000–10999/tcp is open on the server. |
| Dashboard shows an old UI after an update | Run `sudo bash install-server.sh --upgrade`, then hard-refresh the browser. |
| Extra ports are missing after an upgrade | Run `sudo bash install-client.sh --upgrade --extra-port …` to rewrite the config and service. |

## Security notes

- Use `--tls` for anything beyond a lab setup, so tokens and traffic are encrypted between device and server.
- Tunnel ports are publicly reachable. The service behind them (e.g. `sshd` with key-only auth) still has to be secure.
- Revoke a device token in the dashboard to cut that device off immediately.

## License

[MIT](LICENSE) © Florian Groß

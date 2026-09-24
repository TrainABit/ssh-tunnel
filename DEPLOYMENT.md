# TunnelVault 2.0 — Deployment and Operations Guide

This guide covers installing, configuring, upgrading and operating a TunnelVault server and its
devices in production. The short version (in German) is in the [README](README.md); the security
model and hardening checklist are in [SECURITY.md](SECURITY.md); the device wire protocol is in
[docs/PROTOCOL.md](docs/PROTOCOL.md).

## Contents

1. [Overview](#overview)
2. [Requirements](#requirements)
3. [Getting a release](#getting-a-release)
4. [Server installation](#server-installation)
5. [Server configuration](#server-configuration)
6. [Dashboard and API access](#dashboard-and-api-access)
7. [Devices](#devices)
8. [Signed releases and automatic updates](#signed-releases-and-automatic-updates)
9. [Web terminal and stored SSH keys](#web-terminal-and-stored-ssh-keys)
10. [Privacy: GeoIP and data retention](#privacy-geoip-and-data-retention)
11. [Legacy SSH gateway](#legacy-ssh-gateway)
12. [Docker](#docker)
13. [Backups and restore](#backups-and-restore)
14. [Upgrading from 1.x](#upgrading-from-1x)
15. [Operations](#operations)
16. [Troubleshooting](#troubleshooting)

---

## Overview

| Component | What it is | Where it runs |
|---|---|---|
| **Server** (`tunnelvault.service`) | Node.js service: dashboard, REST API, device WebSocket (`/ws`), web terminal (`/ws/ssh`), HTTP tunnel proxy and the public TCP tunnel ports | Your internet-facing Linux server |
| **nginx + Let's Encrypt** (optional, recommended) | Terminates TLS for the dashboard, API, WebSockets and HTTP tunnels | Same server (`install-server.sh --tls`) |
| **Device client** (`tunnelvault-client.service`) | Keeps an outbound WebSocket to the server and forwards tunnel streams to local ports | Each device you want to reach |
| **Signed updaters** (optional) | systemd timers that install new signed GitHub releases | Server and/or devices (`--auto-update`) |
| **Legacy SSH gateway** (optional) | `gw-<token>` Linux users whose SSH sessions are relayed to a fixed target | Server (installed with the server) |

How a TCP tunnel works: the device connects to `wss://DOMAIN/ws` with its device token and registers
its configured local ports. The server assigns each TCP tunnel a public port from
`TCP_PORT_MIN`–`TCP_PORT_MAX` (default 10000–10999). The port stays the same across reconnects,
restarts and upgrades. When someone connects to that port, the server opens a stream over the
device's WebSocket, and the device connects it to `localhost:<local port>`. HTTP tunnels work the
same way, routed by host name `<subdomain>.DOMAIN`.

### Files and paths

Server:

| Path | Content |
|---|---|
| `/opt/tunnelvault/backend/.env` | Server configuration (0600, owned by `tunnelvault`) |
| `/opt/tunnelvault/data/tunnelvault.db` | SQLite database: tokens, tunnels, sessions, encrypted keys (0600) |
| `/opt/tunnelvault/logs/tunnelvault.log` | Log file (also in the journal), rotated daily (`/etc/logrotate.d/tunnelvault`) |
| `/opt/tunnelvault/VERSION` | Installed version |
| `/opt/tunnelvault/{backend,frontend}` | Application (owned by root, read-only for the service) |
| `/etc/systemd/system/tunnelvault.service` | Server unit (hardened, user `tunnelvault`) |
| `/etc/nginx/sites-available/tunnelvault` | nginx site (with `--tls`; `/etc/nginx/conf.d/tunnelvault.conf` on systems without `sites-available`) |
| `/etc/letsencrypt/renewal-hooks/deploy/tunnelvault-reload-nginx.sh` | Reloads nginx after certificate renewal |
| `/etc/tunnelvault/update.conf`, `/etc/tunnelvault/release-signing.pub` | Updater settings and pinned release key (with `--auto-update`) |
| `/opt/tunnelvault/auto-update.sh`, `tunnelvault-autoupdate.{service,timer}` | Signed updater (with `--auto-update`) |
| `/var/log/tunnelvault-update.log` | Updater log (also in the journal) |
| `/var/backups/tunnelvault/` | Configuration backups made by the installer, full backups made by the uninstaller (0700) |
| `/opt/tunnelvault/{ssh_router,gateway-helper,manage-user,register_token,usermgr-worker}.sh`, `/etc/sudoers.d/tunnelvault`, `tunnelvault-usermgr.{path,service}` | Legacy SSH gateway |

Device:

| Path | Content |
|---|---|
| `/etc/tunnelvault/client.env` | `TUNNELVAULT_SERVER`, `TUNNELVAULT_AUTH_TOKEN`, `TUNNELVAULT_ALLOW_REBOOT` (0600 root, systemd `EnvironmentFile=`) |
| `/etc/tunnelvault/config.json` | Server URL, tunnels, `allow_reboot`; no token (root:&lt;service group&gt; 0640, read by the service) |
| `~SERVICE_USER/.tunnelvault/config.json` | Copy of the configuration for the `tunnelvault` CLI (0600) |
| `/var/lib/tunnelvault/state.json` | Reconnect state: tunnel IDs and owner secrets that keep the public ports (0600, directory 0700) |
| `/opt/tunnelvault-client/` (+ `.previous`) | Client code; the previous version is kept for rollback |
| `/usr/local/bin/tunnelvault` | CLI |
| `/etc/systemd/system/tunnelvault-client.service` | Device unit |
| `/etc/sudoers.d/tunnelvault-reboot` | Remote reboot rule (only with `--allow-reboot`) |
| `/opt/tunnelvault-client/auto-update-client.sh`, `tunnelvault-client-autoupdate.{service,timer}`, `/var/log/tunnelvault-client-update.log` | Signed updater (with `--auto-update`) |

---

## Requirements

**Server**

- Debian or Ubuntu with systemd and `apt` (the installer refuses other systems). Minimum 1 vCPU,
  1 GB RAM and 8 GB disk; 2 vCPU and 2 GB RAM recommended.
- Node.js 20 or newer. If it is missing or older, the installer installs Node.js 22 from
  NodeSource. It installs `sqlite3`, `curl`, `openssl` and friends, and with `--tls` also nginx
  and certbot.
- A DNS name for the server (`tunnel.example.com`, A/AAAA record), required for `--tls`. For
  HTTP tunnels also a wildcard record `*.tunnel.example.com` pointing to the same server.
- Inbound ports: see [Firewall](#firewall). Cloud security groups must allow the same ports.

**Devices**

- Linux with systemd (Debian, Ubuntu, Raspberry Pi OS, …). With `apt` the installer installs
  Node.js 22 when needed; on other distributions install Node.js ≥ 20 first.
- Outbound access to the server: TCP 443 (`wss://`), or the API port (default 4000) without TLS.
  No inbound ports are needed on the device.
- A Linux account for the service. A dedicated unprivileged user is recommended (see
  [Installing a device](#installing-a-device)).

---

## Getting a release

TunnelVault is distributed as signed GitHub releases: `tunnelvault-vX.Y.Z.tar.gz`, `SHA256SUMS` and
`SHA256SUMS.sig` (an ECDSA P-256 signature over `SHA256SUMS`). Verify every download before you run
anything from it.

1. Obtain the release public key `release-signing.pub` once from a trusted source (the repository,
   or a device/server you already trust: `/etc/tunnelvault/release-signing.pub`). Compare its
   fingerprint with the one the maintainers published through a separate channel:

   ```bash
   openssl pkey -pubin -in release-signing.pub -outform DER | sha256sum
   ```

2. Download and verify:

   ```bash
   V=2.0.0
   BASE=https://github.com/TrainABit/ssh-tunnel/releases/download/v$V
   curl -fLO "$BASE/tunnelvault-v$V.tar.gz" -O "$BASE/SHA256SUMS" -O "$BASE/SHA256SUMS.sig"
   openssl dgst -sha256 -verify release-signing.pub -signature SHA256SUMS.sig SHA256SUMS   # "Verified OK"
   sha256sum -c --ignore-missing SHA256SUMS                                                  # "...: OK"
   tar xzf "tunnelvault-v$V.tar.gz" && cd "tunnelvault-v$V"
   ```

   With a trusted checkout of the repository you can instead run
   `scripts/release/verify-release.sh --pubkey release-signing.pub tunnelvault-v$V.tar.gz` (it checks
   the signature first, then the checksum, and fails closed). Never trust the key or script that
   ships *inside* the archive you are verifying.

A release tree contains a prebuilt dashboard, so the server never runs a frontend build as root.
Installing from a git checkout (`git clone --branch vX.Y.Z https://github.com/TrainABit/ssh-tunnel.git`)
also works, but the installer then builds the dashboard itself: as root, with `npm ci` pulling the
frontend's build dependencies from the npm registry. Prefer release packages in production.

All installers must be started from the root of the extracted tree (or checkout), with `sudo bash`:
`sudo bash install-server.sh …`, `sudo bash install-client.sh …`.

---

## Server installation

### With TLS (recommended)

```bash
sudo bash install-server.sh --tls --domain tunnel.example.com --email admin@example.com
```

What happens:

1. Pre-flight checks (root, apt, systemd, a complete source tree, valid arguments, `DOMAIN` is a
   public name).
2. System packages, Node.js, the service user `tunnelvault` and the group `tunnelvault-gw`.
3. The application is staged (`npm ci --omit=dev`), then swapped into `/opt/tunnelvault`.
4. `/opt/tunnelvault/backend/.env` is written with a generated 64-hex-character `AUTH_TOKEN` (unless
   `--auth-token` is given) and a generated `DATA_ENCRYPTION_KEY`.
5. The database is created or migrated by the backend itself.
6. Legacy SSH gateway: a `Match User "gw-*"` block is added to `sshd_config`, validated with
   `sshd -t` and rolled back if sshd rejects it.
7. The systemd units are installed, and the service is started and health-checked. With
   `--auto-update` the signed updater is installed next.
8. Firewall (see below).
9. nginx is configured, a Let's Encrypt certificate for `DOMAIN` is obtained with the HTTP-01
   challenge (webroot `/var/www/tunnelvault-acme`), and a deploy hook reloads nginx after every
   renewal. certbot's own timer renews the certificate.
10. A summary: dashboard URL, device server URL, and **the admin token, printed only on a fresh
    install**. It is also in `/opt/tunnelvault/backend/.env` (`AUTH_TOKEN=`).

In TLS mode the backend listens on `127.0.0.1` only (`BIND_HOST=127.0.0.1`), trusts `X-Forwarded-*`
from nginx only (`TRUST_PROXY=loopback`), and advertises `PUBLIC_URL=https://DOMAIN`. Devices
connect to `wss://DOMAIN`. Ports 4000/4001 are not opened in the firewall.

The certificate covers `DOMAIN` only. Without a wildcard certificate, HTTP tunnels on
`*.DOMAIN` are served over **plain HTTP** on port 80 (nginx forwards them to the HTTP proxy).

**TCP tunnel ports and HSTS.** Over HTTPS the backend sends `Strict-Transport-Security` for
`DOMAIN`. HSTS applies to a host on every port, so a browser that has opened the dashboard over
HTTPS rewrites `http://DOMAIN:<port>` to `https://DOMAIN:<port>`, and a plain-HTTP service on a
TCP tunnel port fails with `ERR_SSL_PROTOCOL_ERROR`. The dashboard therefore shows the
`DOMAIN:<port>` address with a copy button instead of an "Open" link in TLS mode. Open such
services via the server's IP address (`http://SERVER_IP:<port>`, not covered by HSTS) or publish
them as an HTTP tunnel (`<subdomain>.DOMAIN`). Non-HTTP clients (`ssh -p`, database clients)
are not affected.

If certbot fails (DNS not pointing to the server yet, port 80 blocked), the installer reports it and
exits with status 1. Fix the cause and re-run
`sudo bash install-server.sh --upgrade --tls --domain tunnel.example.com`.

### HTTPS for HTTP tunnels (wildcard certificate)

A certificate for `*.DOMAIN` needs the DNS-01 challenge, which depends on your DNS provider. Obtain
it separately, for example with certbot and your provider's DNS plugin or with a manual challenge:

```bash
sudo certbot certonly --manual --preferred-challenges dns \
  --cert-name tunnel.example.com-wildcard -d '*.tunnel.example.com'
```

Then pass the directory that contains `fullchain.pem` and `privkey.pem`:

```bash
sudo bash install-server.sh --upgrade --tls --domain tunnel.example.com \
  --wildcard-cert /etc/letsencrypt/live/tunnel.example.com-wildcard
```

nginx then serves `https://<subdomain>.DOMAIN` (HTTP redirects to HTTPS) and the installer sets
`HTTP_TUNNEL_URL_TEMPLATE=https://{subdomain}.DOMAIN`. Later upgrades keep the wildcard setting.
Renewal is your responsibility: a certificate from `--manual` cannot renew automatically, so use a
DNS plugin for unattended renewals. When certbot renews a certificate on this host, the deploy hook
reloads nginx.

### Without TLS (LAN and testing only)

```bash
sudo bash install-server.sh --domain tunnel.local
```

The dashboard, API and device WebSocket listen on port 4000 and the HTTP proxy on 4001, all in
plaintext: the admin token, device tokens and web-terminal passwords cross the network unencrypted.
Without TLS the browser also sends the dashboard's session cookie to every other port of the same
host, including TCP tunnel ports that serve device-controlled web pages (cookies are scoped to a
host, not to a port). The dashboard session is therefore bound to a per-session key that only the
dashboard origin (`http://SERVER:4000`) holds; the cookie alone grants nothing. See
[SECURITY.md](SECURITY.md#what-tunnelvault-does-not-do).
The installer and the server both warn about this. To switch to TLS later, run
`sudo bash install-server.sh --upgrade --tls --domain <your domain>` and move the devices over as
described in [Moving devices from ws:// to wss://](#moving-devices-from-ws-to-wss).

### Installer options

`sudo bash install-server.sh --help` prints the same list.

| Option | Meaning | Default |
|---|---|---|
| `--domain DOMAIN` | Server domain (lower-cased). A public name is required with `--tls`. | `tunnel.local` (on `--upgrade`: the configured value) |
| `--tls` | nginx + Let's Encrypt (HTTP-01, `DOMAIN` only). | off (on `--upgrade`: an existing TunnelVault nginx site is kept) |
| `--email EMAIL` | Let's Encrypt account e-mail (expiry notices). Only with `--tls`. | none |
| `--wildcard-cert DIR` | Directory with `fullchain.pem` + `privkey.pem` of a separately obtained `*.DOMAIN` certificate. Only with `--tls`. | none |
| `--auth-token TOKEN` | Admin token, 16–256 characters of `[A-Za-z0-9._~-]`. On `--upgrade` it replaces the current token (all dashboard sessions end). | 64 random hex characters, fresh installs only |
| `--port PORT` | API / dashboard port. | `4000` |
| `--proxy-port PORT` | HTTP tunnel proxy port. | `4001` |
| `--no-firewall` | Do not touch the firewall; the installer prints the ports to open. | off |
| `--auto-update` | Install the signed updater (needs a release key). Kept on `--upgrade`. | off |
| `--no-auto-update` | Remove the updater. | – |
| `--release-pubkey FILE` | Release signing public key (ECDSA P-256 PEM). An installed key is only replaced by this option. | installed `/etc/tunnelvault/release-signing.pub`, else `release-signing.pub` next to the script |
| `--upgrade` | Upgrade in place: code is replaced, database and configuration are kept. | – |
| `--yes`, `-y` | Never prompt (used by the updater). A fresh install over an existing one is refused with `--yes`. | – |

Exit status: 0 on success; 1 on invalid arguments, a service that is not healthy after the
installation, or a requested `--tls` that did not complete.

Re-running without `--upgrade` over an existing installation asks for confirmation and replaces the
configuration (the old `.env` is backed up; the existing `DATA_ENCRYPTION_KEY` is kept so stored
keys stay readable). Use `--upgrade` to keep everything.

### Firewall

| Port | With `--tls` | Without `--tls` |
|---|---|---|
| 22/tcp (and the port(s) sshd listens on) | allowed when the installer enables ufw | allowed when the installer enables ufw |
| 80/tcp | allowed: ACME, redirects, HTTP tunnels without a wildcard certificate | – |
| 443/tcp | allowed: dashboard, API, `/ws`, `/ws/ssh`, HTTP tunnels with a wildcard certificate | – |
| 4000/tcp (`PORT`) | not opened (backend on 127.0.0.1) | allowed |
| 4001/tcp (`PROXY_PORT`) | not opened (backend on 127.0.0.1) | allowed |
| 10000–10999/tcp (`TCP_PORT_MIN`–`TCP_PORT_MAX`) | allowed | allowed |

Behaviour:

- **ufw inactive, fresh install:** default deny incoming / allow outgoing, the SSH port(s), the
  rules above, then ufw is enabled.
- **ufw already active:** only the TunnelVault rules are added. Existing rules are never removed,
  and the firewall is never reset.
- **`--upgrade` with ufw inactive or not installed:** nothing is changed; the installer prints the
  ports to open.
- **firewalld active:** left alone; the installer prints the ports to open.
- **`--no-firewall`:** skipped; the installer prints the ports to open.
- After switching an existing install to TLS, old `4000/tcp` / `4001/tcp` rules stay. The installer
  prints the `ufw delete allow …` commands to remove them.

If you change `TCP_PORT_MIN`/`TCP_PORT_MAX`, run `sudo bash install-server.sh --upgrade` so the new
range is allowed, and delete the old rule with `sudo ufw delete allow 10000:10999/tcp`.

---

## Server configuration

The server reads `/opt/tunnelvault/backend/.env` (systemd `EnvironmentFile=`). The file belongs to
the service user and is mode 0600. Every variable, with its default, is documented in
[backend/.env.example](backend/.env.example). Apply changes with
`sudo systemctl restart tunnelvault`. `install-server.sh --upgrade` keeps your values; it only adds
missing settings and updates what you pass on the command line.

| Group | Variables |
|---|---|
| Core | `NODE_ENV=production` (refuses to start without `AUTH_TOKEN`), `AUTH_TOKEN`, `DOMAIN`, `PUBLIC_URL`, `HTTP_TUNNEL_URL_TEMPLATE` |
| Network | `PORT` (4000), `PROXY_PORT` (4001), `BIND_HOST` (0.0.0.0), `TCP_BIND_HOST` (0.0.0.0), `TCP_PORT_MIN`/`TCP_PORT_MAX` (10000/10999), `TCP_MAX_CONNECTIONS_PER_TUNNEL` (1000), `HTTP_PROXY_IDLE_TIMEOUT_MS` (120000) |
| Reverse proxy | `TRUST_PROXY` (unset = ignore `X-Forwarded-*`; `loopback`, a hop count, or a list of addresses/subnets), legacy alias `BEHIND_PROXY=true`, `ALLOWED_ORIGINS` (extra CORS origins for Bearer calls, never cookies) |
| Direct TLS | `TLS_CERT`/`TLS_KEY`, `TLS_PROXY_CERT`/`TLS_PROXY_KEY` (only without nginx; files must be readable by the `tunnelvault` user) |
| Limits | `MAX_TUNNELS_PER_TOKEN` (10), `MAX_CONNECTIONS_PER_TOKEN` (4), `WS_UPGRADE_RATE_MAX` (60/min), `WS_AUTH_FAIL_MAX` (10/min), `API_RATE_LIMIT_PER_MIN` (300), `WEB_SSH_MAX_SESSIONS` (10), `WEB_SSH_RATE_LIMIT_PER_MIN` (10) |
| Dashboard | `SESSION_TTL_HOURS` (12, sliding) |
| Secrets at rest | `DATA_ENCRYPTION_KEY` or `DATA_ENCRYPTION_KEY_FILE`, `DATA_ENCRYPTION_KEY_PREVIOUS` / `_PREVIOUS_FILE` (rotation) |
| Data & privacy | `DB_PATH`, `SESSION_RETENTION_DAYS` (90), `TUNNEL_IDLE_RETENTION_DAYS` (30), `GEOIP_PROVIDER` (`off`), `GEOIP_DB` |
| Logging | `LOG_LEVEL` (`info`), `LOG_FORMAT` (`pretty` or `json`), `LOG_FILE` |
| Notifications | `WEBHOOK_URL`, `WEBHOOK_TYPE` (`json`, `ntfy`, `slack`, `discord`); fired when tunnels connect or disconnect |
| Legacy gateway | `USERMGR_SPOOL_DIR` (set by the installer), `MANAGE_USER_SCRIPT` |
| Installation | `INSTALL_DIR` (location of `VERSION`), `TUNNELVAULT_UPDATE_CONF` (updater settings shown on the Settings page) |

The server exits with status **78** and a single log line when the configuration is invalid (for
example no `AUTH_TOKEN` in production, unreadable TLS files, an invalid port). systemd does not
restart it in that case (`RestartPreventExitStatus=78`). Fix the configuration and start it again.

### Your own reverse proxy

If you terminate TLS with your own proxy instead of `--tls`:

- Forward the dashboard host to `PORT`, including WebSocket upgrades for `/ws` and `/ws/ssh` with
  long read timeouts and no buffering. Forward `*.DOMAIN` to `PROXY_PORT` with request and response
  buffering off.
- Set `Host`, `X-Forwarded-For`, `X-Forwarded-Proto` and `X-Forwarded-Host`. Do not add
  `Strict-Transport-Security` with `includeSubDomains` unless every tunnel subdomain is served over
  HTTPS.
- Set `BIND_HOST=127.0.0.1` (proxy on the same host), `TRUST_PROXY` to the proxy's address
  (`loopback` on the same host), `PUBLIC_URL=https://DOMAIN` and `HTTP_TUNNEL_URL_TEMPLATE`.

`TRUST_PROXY` must name only your proxy. Trusting addresses that clients can reach directly lets
them forge their IP address and bypass rate limits.

The nginx site that `--tls` generates is a working reference. See the `render_nginx_conf` function
in `install-server.sh`, or `/etc/nginx/sites-available/tunnelvault` on an installed server. The
installer regenerates that file on `--upgrade`; to keep manual changes, delete its first line (the
"Managed by TunnelVault" marker) and the installer will leave the file alone.

---

## Dashboard and API access

**Dashboard login.** Open `https://DOMAIN` (or `http://SERVER:4000` without TLS) and enter the
admin token. The server exchanges it for a session cookie: `__Host-tv_session` over HTTPS,
`tv_session` over plain HTTP, plus a per-session key that the dashboard keeps in its origin's
`localStorage` and sends as `X-TV-Session-Key` on every request (and as a `tv-key.<key>`
WebSocket subprotocol for the web terminal). A request with the cookie but without the key is
unauthenticated. The cookie is HttpOnly and SameSite=Strict, and the session expires after
`SESSION_TTL_HOURS` (default 12) without activity. The browser never stores the admin token
itself. Log out from the sidebar. Changing `AUTH_TOKEN` ends every session.

The login is rate limited to 10 attempts per minute per client IP; failed Bearer attempts on the API
count too. The client IP is the socket address unless `TRUST_PROXY` says otherwise.

**Scripts and the CLI** use the admin token as a Bearer token. Tokens in query strings are not
accepted.

```bash
TOKEN=$(sudo sed -n 's/^AUTH_TOKEN=//p' /opt/tunnelvault/backend/.env)
curl -fsS -H "Authorization: Bearer $TOKEN" https://tunnel.example.com/api/tunnels
```

Cookie-authenticated `POST`/`PUT`/`PATCH`/`DELETE` requests must carry an `Origin` of the dashboard
itself. Bearer requests are not affected. Browser calls from other origins with a Bearer token need
`ALLOWED_ORIGINS`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Health check, no authentication: `{"status":"ok","uptime":…}` |
| POST | `/api/auth/login` | Body `{"token": "<AUTH_TOKEN>"}`; sets the session cookie |
| POST | `/api/auth/logout` | Ends the session |
| GET | `/api/auth/session` | `{authenticated, authRequired}`, no authentication |
| GET | `/api/config` | Version, domain, ports, TCP range, public URLs, proxy trust, GeoIP, retention, limits, updater status |
| GET | `/api/stats` | Aggregated statistics |
| GET | `/api/tunnels`, `/api/tunnels/:id` | Tunnels (including `has_private_key`, `host_key_fingerprint`) |
| POST | `/api/tunnels/:id/toggle` | Pause / resume a tunnel |
| POST | `/api/tunnels/:id/reboot` | Ask the device to reboot (ignored unless the device opted in) |
| DELETE | `/api/tunnels/:id/hostkey` | Forget the pinned SSH host key |
| DELETE | `/api/tunnels/:id` | Remove a tunnel record |
| GET | `/api/tokens`, `/api/tokens/:token` | Tokens (with session counts / last 50 sessions) |
| POST | `/api/tokens` | Create a token: `token` (optional, 1–64 alphanumerics), `label`, and for the legacy gateway `target_ip`, `target_port`, `public_key` |
| PATCH | `/api/tokens/:token` | Update `label`, `active` (0 disconnects the device at once), `target_ip`, `target_port`, `public_key`, `private_key` (`""` clears) |
| DELETE | `/api/tokens/:token` | Delete a token: disconnects its devices, removes its tunnels, sessions and pinned host keys |
| GET | `/api/sessions` | Connection history (`?active=1` for open sessions) |
| GET | `/api/connections` | Live connections (`?tunnel=<id>`) |

`POST /api/tunnels` no longer exists (405): tunnels are created only by connecting devices.

**Rotating the admin token:** from the installed release tree run
`sudo bash install-server.sh --upgrade --auth-token "$(openssl rand -hex 32)"`, or edit `AUTH_TOKEN`
in `.env` and restart. Every dashboard session ends. Devices use their own tokens and are not
affected, unless one was set up with the admin token. Don't do that.

---

## Devices

### Creating a device token

Dashboard → **Tokens** → **New Token**. Give it a label (for example the device's location). Leave
the token field empty to get a random 20-character token. Use one token per device: deactivating a
token disconnects exactly that device, at once (close code 4000; the public ports stop accepting
within seconds), and it keeps retrying until the token is active again. Deleting a token also
removes its tunnels and pinned host keys.

### Installing a device

On the device, from a verified release tree ([Getting a release](#getting-a-release)):

```bash
# optional: a dedicated, unprivileged service account (no home directory needed)
sudo useradd --system --shell /usr/sbin/nologin tvclient

sudo bash install-client.sh --server wss://tunnel.example.com --token-file /root/tv-token --user tvclient
```

`--token TOKEN` works too, but the token then shows up in `ps` and in the shell history while the
installer runs. Without `--user`, the service runs as the user who invoked `sudo`. Avoid running it
as root. On hosts that also run the server, don't use the server's `tunnelvault` account.

| Option | Meaning | Default |
|---|---|---|
| `--server URL` | `wss://HOST[:PORT][/PATH]`, or `ws://HOST[:PORT][/PATH]` for LAN/testing. No credentials, query string or fragment. | required for a fresh install |
| `--token TOKEN` | Device token (1–64 letters and digits). | required for a fresh install (or `--token-file`) |
| `--token-file FILE` | Read the token from a file. | – |
| `--port PORT` | Local port of the main tunnel. | `22` |
| `--protocol tcp\|http` | Protocol of the main tunnel. With `--upgrade` it needs `--port`. | `tcp` |
| `--extra-port PORT[:PROTO[:NAME]]` | Additional tunnel, repeatable. `PROTO` is `tcp` or `http`; `NAME` is `[A-Za-z0-9._-]{1,64}`. | `PROTO` `tcp`, `NAME` `tunnel-PORT` |
| `--user USER` | Account the service runs as (must exist). | the sudo user; kept on `--upgrade` |
| `--allow-reboot` / `--no-reboot` | Allow / forbid remote reboot from the dashboard. | forbidden; kept on `--upgrade` |
| `--auto-update` / `--no-auto-update` | Install / remove the signed updater. | off; kept on `--upgrade` |
| `--release-pubkey FILE` | Release signing public key (ECDSA P-256 PEM). | installed key, else `release-signing.pub` next to the script |
| `--upgrade` | Upgrade or reconfigure in place. Server, token, tunnels, service user, reboot and updater settings are kept unless given again. | – |
| `--yes`, `-y` | Accepted for symmetry; the client installer never prompts. | – |

Examples:

```bash
# SSH plus a web UI (HTTP tunnel on <subdomain>.DOMAIN) and a database port
sudo bash install-client.sh --server wss://tunnel.example.com --token-file /root/tv-token \
  --extra-port 8080:http:webui --extra-port 5432:tcp:postgres

# change the tunnels later: --port / --extra-port replace the whole list (main port defaults to 22)
sudo bash install-client.sh --upgrade --port 22 --extra-port 8080:http:webui

# new token
sudo bash install-client.sh --upgrade --token-file /root/new-token
```

After the installation the device appears on the **Tunnels** page with its public port(s). HTTP
tunnels get `http(s)://<subdomain>.DOMAIN` (according to `HTTP_TUNNEL_URL_TEMPLATE`).

The device authenticates the server through TLS only: use `wss://` with a publicly trusted
certificate (Let's Encrypt). The device warns when a `ws://` URL points to a public address.

### What the device accepts

The device opens local connections only to the ports it was configured with, and only for its own
tunnels. Any other request from the server is refused. Remote reboot works only with
`--allow-reboot`: that installs a sudoers rule that allows exactly `systemctl reboot` / `reboot`
for the service user. Without the rule, the device logs and ignores the command. For a non-root
service with remote reboot enabled, the unit keeps only the systemd protections that do not imply
`NoNewPrivileges` (otherwise sudo could not work). Without remote reboot the full hardening applies.

### Upgrading and reconfiguring a device

From a newer verified release tree: `sudo bash install-client.sh --upgrade`. If the service is
running, and so an SSH session may be going through the tunnel, the new version is started about
**30 seconds** later by a transient systemd timer. The session drops once and you reconnect.
The previous version is kept in `/opt/tunnelvault-client.previous`.

### Device logs and CLI

```bash
journalctl -u tunnelvault-client -f
sudo systemctl restart tunnelvault-client
```

The `tunnelvault` CLI (`tunnelvault connect [port]`, `list`, `status`) reads `TUNNELVAULT_SERVER`,
`TUNNELVAULT_AUTH_TOKEN`, `TUNNELVAULT_ALLOW_REBOOT`, `TUNNELVAULT_STATE_DIR` and
`TUNNELVAULT_CONFIG`. It looks for its configuration in `$TUNNELVAULT_CONFIG`, then
`~/.tunnelvault/config.json`, then `/etc/tunnelvault/config.json`. `list` and `status` query the
REST API and need the admin token.

### Uninstalling a device

```bash
sudo bash uninstall-client.sh               # asks for confirmation
sudo bash uninstall-client.sh --keep-config # keep token, tunnels and reconnect state (same ports after reinstall)
```

It removes the service, the updater, the reboot rule, `/opt/tunnelvault-client`, the CLI, the
device configuration and state, and the updater log. `update.conf` and the release key are kept
while the TunnelVault server is installed on the same host. `--remove-source` also deletes the
directory the script is in.

---

## Signed releases and automatic updates

### How the updaters work

`auto-update.sh` (server) and `auto-update-client.sh` (device) run as root from a systemd timer.
Each run:

1. Reads `/etc/tunnelvault/update.conf`. It refuses to run if that file, the pinned key or
   `/etc/tunnelvault` is not root-owned or is group/world-writable.
2. Resolves the target release: `PINNED_VERSION`, or the latest release of `UPDATE_REPO`. It skips
   the run if that version is installed and never downgrades.
3. Downloads the tarball, `SHA256SUMS` and `SHA256SUMS.sig` over HTTPS.
4. Verifies the signature with the pinned public key, **then** the checksum.
5. Extracts into a private staging directory (rejecting links, absolute paths and `..`) and checks
   that `VERSION` matches the tag.
6. Runs `install-server.sh --upgrade --yes` or `install-client.sh --upgrade` from the verified tree,
   non-interactively.

Any failure aborts the run and leaves the installation untouched. A lock prevents concurrent runs.

### Enabling, pausing, pinning

Enable at install time or later, from a verified release tree:

```bash
sudo bash install-server.sh --upgrade --auto-update --release-pubkey /path/to/release-signing.pub
sudo bash install-client.sh --upgrade --auto-update --release-pubkey /path/to/release-signing.pub
```

`/etc/tunnelvault/update.conf`:

| Key | Default | Meaning |
|---|---|---|
| `ENABLED` | `1` | `0` pauses updates (the timer keeps running and does nothing) |
| `SCHEDULE` | `12h` | Timer interval (`30min`, `6h`, `1d`, …). It is applied to the timer by the installer: re-run `--upgrade`, or wait for the next update, which does it. |
| `UPDATE_REPO` | `TrainABit/ssh-tunnel` | GitHub repository to take releases from |
| `PINNED_VERSION` | empty | Empty = latest release; `X.Y.Z` = exactly this version (never lower than the installed one) |
| `PUBKEY` | `/etc/tunnelvault/release-signing.pub` | Pinned release key |

On a host that runs **both** the server and the client, `update.conf` and the key are shared.
`ENABLED=0` pauses both updaters, and `UPDATE_REPO`, `PINNED_VERSION` and `SCHEDULE` apply to both;
each keeps its own timer. `--no-auto-update` on one side removes only that side's updater and leaves
`ENABLED` alone while the other side's updater is installed. A plain `--upgrade` keeps a pause;
`--auto-update` sets `ENABLED=1` again.

Run and inspect:

```bash
sudo /opt/tunnelvault/auto-update.sh --dry-run                 # server: what would happen
sudo systemctl start tunnelvault-autoupdate.service            # server: update now
journalctl -u tunnelvault-autoupdate; sudo tail /var/log/tunnelvault-update.log
systemctl list-timers 'tunnelvault*'

sudo /opt/tunnelvault-client/auto-update-client.sh --dry-run   # device
journalctl -u tunnelvault-client-autoupdate; sudo tail /var/log/tunnelvault-client-update.log
```

The server updater exits non-zero, and the timer run shows as failed, when the upgraded service is
not healthy afterwards.

### Release process (maintainers)

One-time setup:

1. Generate the signing key pair outside any git work tree:
   `scripts/release/generate-signing-key.sh` (or `--out DIR`). It creates `release-signing.key`
   (private, 0600) and `release-signing.pub`, and prints the key fingerprint.
2. In GitHub → Settings → Environments, create the environment **`release`** with required
   reviewers and a deployment rule for tags `v*.*.*`. Store the private key as the environment
   secret `RELEASE_SIGNING_KEY`:
   `gh secret set RELEASE_SIGNING_KEY --env release --repo TrainABit/ssh-tunnel < release-signing.key`
3. Commit the public key as `release-signing.pub` at the repository root. Publish its fingerprint
   through a second channel, keep an offline backup of the private key, and delete the local copy
   (`shred -u release-signing.key`).

Every release:

1. Set `VERSION` to `X.Y.Z` and date the entry in `CHANGELOG.md`; merge to `main` with CI green.
2. Tag and push: `git tag -a vX.Y.Z -m "TunnelVault X.Y.Z" && git push origin vX.Y.Z`. The tag must
   equal `VERSION`.
3. The `Release` workflow runs all tests and builds `tunnelvault-vX.Y.Z.tar.gz` + `SHA256SUMS`
   without access to the key. Then, in the `release` environment (after a reviewer approves, if you
   configured required reviewers), it signs `SHA256SUMS`, checks the signature against the
   committed `release-signing.pub`, and publishes the GitHub release.
4. Verify the published release as an operator would ([Getting a release](#getting-a-release)).

A local, unsigned test build: `scripts/release/build-release.sh X.Y.Z --unsigned` (output in
`dist/release/`; the tree must be clean and `VERSION` must match).

**Key rotation / compromise:** generate a new pair, replace the secret and `release-signing.pub`,
and publish the new fingerprint. Installations never switch keys on their own. Operators install
the new key explicitly, with `install-server.sh --upgrade --release-pubkey NEW.pub` /
`install-client.sh --upgrade --release-pubkey NEW.pub` from a release they verified by hand.

---

## Web terminal and stored SSH keys

The **Tunnels** page opens an in-browser SSH terminal to a device's TCP tunnel. The SSH client runs
on the server and reaches the device through the device's tunnel stream. Log in with a password, a
pasted private key, or a key stored for the device's token.

**Host keys:** the first connection shows the device's host key fingerprint (`SHA256:…`) and
waits up to 60 s for you to accept it. Compare it with
`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` (or the key type shown) on the device. After
that, the key is pinned per device token and local port, and a different key is refused with a
mismatch warning. If the change is legitimate (the device was reinstalled), forget the pin on the
Tunnels page and connect again.

**Stored keys** (Tokens page → a token → stored SSH key) are encrypted with AES-256-GCM using
`DATA_ENCRYPTION_KEY`, which the installer generates. Keys must be unencrypted OpenSSH or PEM keys
(no passphrase), because the server has to use them without asking. No API response ever contains
a stored key. Without `DATA_ENCRYPTION_KEY` the feature is disabled.

**`DATA_ENCRYPTION_KEY`** is 64 hex characters (`openssl rand -hex 32`) or base64 of 32 bytes; any
other string is stretched with scrypt. `DATA_ENCRYPTION_KEY_FILE` reads it from a file that the
`tunnelvault` user can read, for example under `/opt/tunnelvault/data`. Back it up together with the
database: without it, stored keys cannot be decrypted.

Rotating the key:

```bash
NEW=$(openssl rand -hex 32)
sudo sed -i "s/^DATA_ENCRYPTION_KEY=\(.*\)$/DATA_ENCRYPTION_KEY_PREVIOUS=\1\nDATA_ENCRYPTION_KEY=$NEW/" /opt/tunnelvault/backend/.env
sudo systemctl restart tunnelvault
sleep 3; sudo journalctl -u tunnelvault -n 50 | grep -i 're-encrypted'   # "Re-encrypted stored SSH keys with the current key"
sudo sed -i '/^DATA_ENCRYPTION_KEY_PREVIOUS=/d' /opt/tunnelvault/backend/.env
sudo systemctl restart tunnelvault
```

On startup the server re-encrypts every stored key with the new key (no log line appears when no
keys are stored). With `DATA_ENCRYPTION_KEY_FILE`, point `DATA_ENCRYPTION_KEY_PREVIOUS_FILE` at the
old key file instead. Database backups taken before
the rotation need the old key. If the log says that stored keys are "encrypted with an unknown
key", set the old key as `DATA_ENCRYPTION_KEY_PREVIOUS`, or clear the affected keys on the Tokens
page and upload them again.

---

## Privacy: GeoIP and data retention

Every public TCP connection creates a session row with the visitor's IP address, which is personal
data.

- `SESSION_RETENTION_DAYS` (default 90) deletes older sessions every hour (`0` keeps them forever).
- `TUNNEL_IDLE_RETENTION_DAYS` (default 30) removes tunnels that have been offline that long. The
  device registers again when it comes back, possibly on a new port.
- At startup, tunnel sessions left open by a restart are closed. Expired dashboard sessions are
  deleted.

GeoIP (country/city in the Sessions page):

| `GEOIP_PROVIDER` | Behaviour |
|---|---|
| `off` (default) | No lookups. |
| `maxmind` | Local lookups in a MaxMind GeoLite2-City database (`GEOIP_DB=/var/lib/GeoIP/GeoLite2-City.mmdb`, free MaxMind account; `geoipupdate` keeps it current, and the server reloads the file when it changes). The file must be readable by the `tunnelvault` user and must not be under `/home` (the service cannot see `/home`). Setting `GEOIP_DB` alone selects `maxmind`. |
| `ip-api` | Sends every visitor IP to ip-api.com over **plain HTTP**. Their free tier is for non-commercial use only. The server logs a warning at startup. |

Private, CGNAT and link-local addresses are never looked up.

---

## Legacy SSH gateway

The gateway predates the WebSocket tunnels. A token with an SSH public key becomes a Linux user
`gw-<token>` on the server. When that user logs in by SSH (key only), sshd runs
`/opt/tunnelvault/ssh_router.sh`, which relays the connection to the token's fixed `target_ip:target_port`
(an IPv4 address the server can reach, for example in the same private network). The SSH handshake
is end-to-end with the target, so clients use the gateway as a `ProxyCommand`:

```
# ~/.ssh/config on the client.
# HostName is only used for the target's known_hosts entry; User is the account on the target.
Host app-server
    HostName app-server
    User ubuntu
    ProxyCommand ssh -T -i ~/.ssh/id_ed25519 gw-TOKEN@tunnel.example.com
```

Then `ssh app-server` (also `scp`/`sftp`) reaches the target through the gateway. A plain
`ssh gw-TOKEN@tunnel.example.com` without `ProxyCommand` does not give you a shell: the session
carries the raw SSH stream of the target.

Managing gateway tokens:

- API: `POST /api/tokens` with `public_key`, `target_ip` and `target_port` (tokens with a public key
  can have at most **29** characters, because Linux user names are limited to 32). The response
  reports `linux_user_queued` / `linux_user_created` / `linux_user_error`. `PATCH` updates the key or
  target; `active: 0` disables the token.
- Shell: `sudo /opt/tunnelvault/register_token.sh --token TOKEN --ip 10.0.1.42 --pubkey "ssh-ed25519 AAAA… user@laptop" [--port 22] [--label TEXT]`,
  plus `--disable`, `--enable`, `--delete TOKEN` and `--list`.

How it works: the API cannot create Linux users itself (the service is sandboxed). It writes a
request file into `/opt/tunnelvault/data/usermgr/` (`USERMGR_SPOOL_DIR`). The
`tunnelvault-usermgr.path` unit notices it, and the root worker `usermgr-worker.sh` validates the
request and calls `manage-user.sh`. Gateway users belong to the group `tunnelvault-gw` and may run
only `gateway-helper.sh` as the `tunnelvault` user (via `/etc/sudoers.d/tunnelvault`). That helper
looks up their target and records their sessions in the database.

Logs: `journalctl -t tunnelvault-gateway -t tunnelvault-usermgr`.

`gateway/setup.sh` from 1.x is deprecated. It prints a notice and runs `install-server.sh` with the
same arguments. If you do not need the gateway, do not create tokens with public keys. The sshd
`Match User "gw-*"` block does nothing without such users.

---

## Docker

The image contains the server only (dashboard, API, WebSockets, HTTP proxy, TCP tunnels). The legacy
SSH gateway, nginx, certbot and the updaters are not part of it. Update containers by rebuilding
from a verified release tree or checkout.

```bash
cd tunnelvault-v2.0.0          # verified release tree (or a checkout)
cat > tunnelvault.env <<EOF
AUTH_TOKEN=$(openssl rand -hex 32)
DATA_ENCRYPTION_KEY=$(openssl rand -hex 32)
DOMAIN=tunnel.example.com
EOF
chmod 600 tunnelvault.env
docker compose up -d --build
docker compose logs -f
```

What [docker-compose.yml](docker-compose.yml) sets up:

- The image runs as the unprivileged `node` user (uid 1000). The application files are root-owned.
  The container runs with a read-only root filesystem, all capabilities dropped and
  `no-new-privileges`.
- The database lives in the named volume `tunnelvault-data` at `/data` (`DB_PATH=/data/tunnelvault.db`).
  A bind mount must be writable by uid 1000.
- Container layout variables (`NODE_ENV`, `BIND_HOST`, `PORT`, `PROXY_PORT`, `DB_PATH`, TCP range) are
  fixed in the compose file, so the env file cannot break them. Everything else comes from the env
  file (see [backend/.env.example](backend/.env.example)).
- The published TCP range is **10000–10099**. By default Docker starts one `docker-proxy` process
  per published port, so the example uses 100 ports instead of 1000. Widen `TCP_PORT_MAX` and the
  port mapping together.
- The image has a `HEALTHCHECK` on `/api/health`. The server shuts down cleanly on `SIGTERM`
  (`stop_grace_period: 20s`).
- Exit code 78 means a configuration error (for example a missing `AUTH_TOKEN`). Check
  `docker compose logs`.

**TLS for the container.** The container serves plain HTTP. On the internet, put a TLS reverse
proxy in front of it:

1. Publish the API and proxy on loopback only (`127.0.0.1:4000:4000`, `127.0.0.1:4001:4001`). The TCP
   tunnel ports stay public.
2. Configure the proxy as in [Your own reverse proxy](#your-own-reverse-proxy): `DOMAIN` →
   `127.0.0.1:4000` (WebSockets on `/ws` and `/ws/ssh`), `*.DOMAIN` → `127.0.0.1:4001`.
3. In `tunnelvault.env`, set `PUBLIC_URL=https://tunnel.example.com`,
   `HTTP_TUNNEL_URL_TEMPLATE=https://{subdomain}.tunnel.example.com` (or `http://…` without a
   wildcard certificate) and `TRUST_PROXY` to the address the container sees the proxy connect
   from. For a proxy on the host that is the gateway of the compose network:
   `docker network inspect <project>_default --format '{{(index .IPAM.Config 0).Gateway}}'`.
   Do not set `TRUST_PROXY=loopback` here: inside the container the proxy does not appear as
   loopback.

The Docker daemon rewrites published ports with its own firewall rules, which bypass ufw. Restrict
access with the port bindings above, not with ufw.

---

## Backups and restore

What to back up:

- `/opt/tunnelvault/data/tunnelvault.db`: tokens, tunnels (owner secrets keep device ports),
  sessions, pinned host keys, encrypted stored keys.
- `/opt/tunnelvault/backend/.env`: `AUTH_TOKEN` and `DATA_ENCRYPTION_KEY`. Without the key, stored
  SSH keys in a restored database cannot be used.
- Optional: `/etc/tunnelvault/` (updater settings and pinned key) and your nginx/certificate
  configuration.

Both files are secrets. Keep backups encrypted and access-controlled.

An online backup (the database is in WAL mode, and `.backup` gives a consistent copy while the
service runs):

```bash
sudo install -d -m 0700 /var/backups/tunnelvault
sudo sh -c 'umask 077; sqlite3 /opt/tunnelvault/data/tunnelvault.db ".backup /var/backups/tunnelvault/tunnelvault-$(date +%F).db"'
sudo sh -c 'umask 077; cp /opt/tunnelvault/backend/.env /var/backups/tunnelvault/env-$(date +%F)'
```

Daily, keeping 14 days (`/etc/cron.d/tunnelvault-backup`; `%` must be escaped in cron):

```
15 3 * * * root umask 077; sqlite3 /opt/tunnelvault/data/tunnelvault.db ".backup /var/backups/tunnelvault/tunnelvault-$(date +\%F).db" && find /var/backups/tunnelvault -name 'tunnelvault-*.db' -mtime +14 -delete
```

The installer also copies the previous `.env` to `/var/backups/tunnelvault/env.<timestamp>` on every
run, and the previous nginx site before replacing it. `uninstall-server.sh` saves `data/`,
`backend/.env` and `VERSION` to `/var/backups/tunnelvault/tunnelvault-backup-<timestamp>.tar.gz`
first (skip with `--no-backup`). It does not back up the database before an upgrade, so take a
backup yourself first.

Restore onto an installed server (same or newer version):

```bash
sudo systemctl stop tunnelvault
sudo install -m 0600 -o tunnelvault -g tunnelvault /var/backups/tunnelvault/tunnelvault-2026-01-31.db /opt/tunnelvault/data/tunnelvault.db
sudo rm -f /opt/tunnelvault/data/tunnelvault.db-wal /opt/tunnelvault/data/tunnelvault.db-shm
sudo install -m 0600 -o tunnelvault -g tunnelvault /var/backups/tunnelvault/env-2026-01-31 /opt/tunnelvault/backend/.env   # if needed
sudo systemctl start tunnelvault
```

To restore from an uninstaller archive, reinstall the same or a newer version first, then:

```bash
sudo systemctl stop tunnelvault
sudo rm -f /opt/tunnelvault/data/tunnelvault.db /opt/tunnelvault/data/tunnelvault.db-wal /opt/tunnelvault/data/tunnelvault.db-shm
sudo tar -xzf /var/backups/tunnelvault/tunnelvault-backup-<timestamp>.tar.gz -C /opt/tunnelvault data backend/.env
sudo chown -R tunnelvault:tunnelvault /opt/tunnelvault/data /opt/tunnelvault/backend/.env
sudo systemctl start tunnelvault
```

 Newer versions migrate an older database automatically. Going back to an
older version after a migration is not supported: restore the backup taken before the upgrade
instead.

---

## Upgrading from 1.x

What changes for you is listed in [CHANGELOG.md](CHANGELOG.md#200---unreleased) under "Breaking
changes". In short: no tokens in URLs, cookie-based dashboard login, remote reboot opt-in,
signed updates only, GeoIP off, `trust proxy` only when configured.

1. **Stop the 1.x auto-updaters** on the server and on every device. They run `git pull` as root
   and would only half-upgrade a 2.0 tree:

   ```bash
   sudo systemctl disable --now tunnelvault-autoupdate.timer          # server
   sudo systemctl disable --now tunnelvault-client-autoupdate.timer   # devices
   ```

2. **Back up** the server database and `.env` ([Backups and restore](#backups-and-restore)).

3. **Upgrade the server** from a verified 2.0 release tree:

   ```bash
   sudo bash install-server.sh --upgrade            # keeps plain HTTP on port 4000 for now
   ```

   The installer keeps the database (the backend migrates it), `AUTH_TOKEN`, domain and ports. It
   adds `DATA_ENCRYPTION_KEY` (and encrypts any stored SSH keys), `GEOIP_PROVIDER=off`,
   `SESSION_RETENTION_DAYS=90` and the spool directory for the gateway. It installs the hardened unit,
   removes the old git-pull updater and a leftover `tunnelvault-api.service` from `gateway/setup.sh`,
   and makes existing `gw-*` users work with the new gateway helper. The firewall is only extended,
   never reset.
   If the 1.x server used `--tls`, its nginx site is regenerated and `TLS_CERT`/`TLS_KEY` lines that
   point into `/etc/letsencrypt` are commented out: nginx terminates TLS from now on, and the backend
   moves to `127.0.0.1`. Devices that connect with `ws://SERVER:4000` then lose their connection:
   continue right away with step 2 of
   [Moving devices from ws:// to wss://](#moving-devices-from-ws-to-wss).

4. **Upgrade the devices.** 1.x devices keep working against a 2.0 server (protocol v1) until you
   upgrade them, but their token is still visible in `ps`, they have no port allowlist, and they
   still obey the dashboard's reboot button unconditionally. On each
   device, from a verified 2.0 release tree:

   ```bash
   sudo bash install-client.sh --upgrade [--allow-reboot] [--auto-update --release-pubkey /path/to/release-signing.pub]
   ```

   The token moves from the unit's command line and `config.json` into `client.env`, and the git
   updater and the old unconditional reboot rule are removed. Reconnect state migrates to
   `/var/lib/tunnelvault`, so the device keeps its public ports. Remote reboot is **off** unless you
   pass `--allow-reboot`. The restart happens about 30 s later, so you can run this through the
   device's own tunnel.

5. **Log in to the dashboard again.** The old dashboard kept the admin token in the browser; 2.0
   deletes it and asks you to log in. Dashboard sessions are bound to a per-session key, so a
   session cookie from an earlier 2.0 build is not accepted either: sign in once more after
   every upgrade to this release. Update scripts that used `?auth_token=` to send
   `Authorization: Bearer` instead.

6. **Switch to TLS** if you have not already. See the next section.

Tunnel records created by 1.x have no owner. The first device that reconnects with the correct
owner secret claims such a record (and its port). After that the normal ownership rules apply.

### Moving devices from ws:// to wss://

`--tls` moves the backend to `127.0.0.1`. Devices that still connect to `ws://SERVER:4000` lose their
connection. Devices that you can only reach through their own tunnel would then be unreachable.
Keep port 4000 open during the transition:

```bash
# 1. on the server: enable TLS (DNS for DOMAIN must point to the server, port 80 must be reachable)
sudo bash install-server.sh --upgrade --tls --domain tunnel.example.com --email admin@example.com

# 2. temporarily accept direct connections on port 4000 again
sudo sed -i 's/^BIND_HOST=127.0.0.1$/BIND_HOST=0.0.0.0/' /opt/tunnelvault/backend/.env
sudo systemctl restart tunnelvault
sudo ufw allow 4000/tcp            # if ufw is active

# 3. on every device (e.g. through its tunnel): point it at wss://
sudo bash install-client.sh --upgrade --server wss://tunnel.example.com

# 4. on the server: list devices that still use port 4000 directly
sudo ss -Htn state established '( sport = :4000 )' | grep -v -e '127.0.0.1' -e '\[::1\]'

# 5. when that list is empty: back to loopback only
sudo sed -i 's/^BIND_HOST=0.0.0.0$/BIND_HOST=127.0.0.1/' /opt/tunnelvault/backend/.env
sudo systemctl restart tunnelvault
sudo ufw delete allow 4000/tcp
```

During step 2 the dashboard is also reachable over plain HTTP on port 4000. Log in only through
`https://DOMAIN`. `TRUST_PROXY=loopback` stays in place, so direct clients cannot spoof their
address. Upgrades (including automatic ones) keep your `BIND_HOST` choice unless you pass `--tls`
again.

---

## Operations

**Service management**

```bash
sudo systemctl status tunnelvault
sudo systemctl restart tunnelvault
journalctl -u tunnelvault -f                        # also /opt/tunnelvault/logs/tunnelvault.log
journalctl -u tunnelvault -p warning --since today
cat /opt/tunnelvault/VERSION
```

Set `LOG_FORMAT=json` for log collectors. Logs never contain full tokens, cookies, passwords or
keys; tokens appear as a 4-character prefix plus `***`.

**Monitoring**

- Health: `curl -fsS https://tunnel.example.com/api/health` → `{"status":"ok",...}` (no
  authentication; also `http://127.0.0.1:4000/api/health` on the server).
- Tunnel connect/disconnect notifications: `WEBHOOK_URL` + `WEBHOOK_TYPE` (`ntfy`, `slack`,
  `discord`, `json`).
- Certificate renewal: `sudo certbot renew --dry-run`; `systemctl list-timers certbot.timer`.
- Updates: `systemctl list-timers 'tunnelvault*'`, updater logs as above.

**Pausing a tunnel** (Tunnels page) keeps the device connected in standby; the public port refuses
connections until you resume it. Pausing or resuming briefly reconnects the device, and with it its
other tunnels.

**Uninstalling the server**

```bash
sudo bash uninstall-server.sh            # asks; backs up data + .env to /var/backups/tunnelvault/ first
sudo bash uninstall-server.sh --yes --no-backup
```

It removes the services and timers, `/opt/tunnelvault`, gateway users and group, the sshd block,
sudoers/logrotate files, the nginx site, the deploy hook, the updater files and TunnelVault's
firewall rules. `/etc/tunnelvault` is kept while the device client is installed on the same host.
Let's Encrypt certificates, installed packages and the SSH/HTTP/HTTPS firewall rules are kept.

---

## Troubleshooting

**The service does not start.**
Run `journalctl -u tunnelvault -n 50`. Exit status 78 is a configuration error, and the last log
line names it:

- *AUTH_TOKEN is not set*: set it in `.env`.
- *Cannot read the TLS certificate/key*: the files under `/etc/letsencrypt` are root-only. Use
  `--tls` (nginx terminates TLS) instead of `TLS_CERT`/`TLS_KEY`, or copy the files somewhere the
  `tunnelvault` user can read.
- *BIND_HOST … is not an address of this machine*, or an invalid port.

`EADDRINUSE` means another process holds the port (`sudo ss -tlnp | grep ':4000'`).

**`--tls` fails.**
`dig +short tunnel.example.com` must return this server's address, and
`http://tunnel.example.com/.well-known/acme-challenge/x` must reach it (port 80 open in ufw and in
the cloud firewall). Re-run `sudo bash install-server.sh --upgrade --tls --domain tunnel.example.com`.
Let's Encrypt rate-limits repeated failures, so test with `sudo certbot renew --dry-run` once a
certificate exists.

**Login fails or ends at once.**
Wrong token → 401. Too many attempts → 429; wait a minute. Behind your own proxy without
`TRUST_PROXY`, all users share the proxy's IP address for rate limiting and the cookie is not
marked secure. With `TRUST_PROXY` pointing at a proxy that does not send `X-Forwarded-Proto`, the
server assumes HTTP.

**"Forbidden" (403) on dashboard actions.**
The request's `Origin` does not match the dashboard host. Access the dashboard through one
consistent URL (`PUBLIC_URL`). A proxy must pass the original `Host` (and `X-Forwarded-Host` with
`TRUST_PROXY`).

**A device does not connect.**
On the device: `journalctl -u tunnelvault-client -f`.

- *token revoked or invalid*: the token is deactivated, deleted or mistyped. Fix it with
  `sudo bash install-client.sh --upgrade --token-file FILE`.
- *superseded*: another client is running with the same token (limit
  `MAX_CONNECTIONS_PER_TOKEN`). Give each device its own token.
- *rate limiting*: too many connection attempts from that IP address (for example many devices
  behind one NAT with wrong tokens).
- TLS errors: the server certificate must be publicly trusted and match the host name in
  `--server`.
- `ECONNREFUSED` / timeouts: wrong URL or port (with TLS: `wss://DOMAIN`, no port), or outbound
  traffic is blocked.

**The tunnel is up but `ssh -p PORT` fails.**
The TCP range must be open in ufw and in the cloud firewall. The local service must listen on the
device (`ss -tln` on the device). Only configured ports are forwarded: add ports with
`install-client.sh --upgrade --port … --extra-port …` (these options replace the whole list).

**A device got a different public port.**
Ports are kept per token, local port and protocol, even after a reinstall, as long as the port is
free. They change when the device uses a new token, or when the tunnel was offline longer than
`TUNNEL_IDLE_RETENTION_DAYS` and was removed.

**Too many tunnels.**
"Max tunnel limit (10) reached" in the device log: the token already has `MAX_TUNNELS_PER_TOKEN`
tunnels (default 10) across all of its connections.

**HTTP tunnel returns 404/502/504.**
404: no tunnel matches the host name (it must be `<subdomain>.DOMAIN` as shown on the Tunnels page).
502: the tunnel is offline or paused, or the local web server on the device refused or closed the
connection. 504: no response within `HTTP_PROXY_IDLE_TIMEOUT_MS` (default 120 s).

**Web terminal: "host key mismatch".**
The device presents a different SSH host key than the pinned one. Find out why before you forget
the pin on the Tunnels page.

**Web terminal: stored key not available.**
`DATA_ENCRYPTION_KEY` is not set (the Settings page shows stored keys as "disabled (no
DATA_ENCRYPTION_KEY)"), or the key was stored under a different encryption key. See
[Web terminal and stored SSH keys](#web-terminal-and-stored-ssh-keys).

**The updater does nothing or fails.**
`sudo /opt/tunnelvault/auto-update.sh --dry-run` shows the decision. Common causes: `ENABLED=0`;
`PINNED_VERSION` is lower than the installed version (downgrades are refused); the signature does
not verify (wrong or rotated `release-signing.pub`; do not "fix" this by replacing the key with one
from the download); `update.conf` or `/etc/tunnelvault` is writable by others.

**The dashboard shows the old UI after an update.**
Hard-refresh the browser (Ctrl+Shift+R).

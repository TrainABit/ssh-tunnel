# Security

This document describes what TunnelVault protects, what it does not, how version 2.0 addressed
the findings of the external security review, and how to run it safely. Installation and
operation: [DEPLOYMENT.md](DEPLOYMENT.md). Wire protocol: [docs/PROTOCOL.md](docs/PROTOCOL.md).

## Reporting a vulnerability

Please report vulnerabilities **privately** through GitHub's private vulnerability reporting:
<https://github.com/TrainABit/ssh-tunnel/security/advisories/new>. Do not open a public issue,
pull request or discussion for a security problem.

Please include the affected version (`cat /opt/tunnelvault/VERSION` on a server,
`tunnelvault --version` on a device), your configuration without secrets, and the steps to
reproduce. Never send real tokens, keys, database files or backups. The maintainers coordinate
the fix, a signed release and the advisory with you.

| Version | Supported |
|---|---|
| 2.0.x | yes |
| 1.x | no. It has the unfixed problems listed below; upgrade as described in [DEPLOYMENT.md](DEPLOYMENT.md#upgrading-from-1x). |

## Threat model

### Components and trust

| Party | Trusted with | Must not be able to |
|---|---|---|
| **Operator** (holds `AUTH_TOKEN`) | Everything on the server: dashboard, REST API, all devices' configured ports, the web terminal, stored SSH keys. | Reach device ports the device owner did not configure, reboot a device that did not opt in. |
| **Device token** (one per device) | Creating up to `MAX_TUNNELS_PER_TOKEN` tunnels for its own configured local ports and receiving their traffic. | See or use the REST API, take over, delete or reconnect another device's tunnels or HTTP subdomains, exhaust the port range with unlimited connections. |
| **Server, as seen by a device** | Opening streams to the ports the device configured. | Open connections to any other local port, reboot the device without its opt-in, inject control characters into its logs. |
| **Internet** | Reaching the dashboard login, the device WebSocket, the HTTP tunnel proxy and the public TCP tunnel ports. | Log in, spoof its client IP to evade rate limits, read tokens or passwords on the wire (with TLS), hijack tunnels. |
| **Release pipeline** | Publishing signed releases. | Get unsigned or tampered code installed by the auto-updaters. |

### Assets

`AUTH_TOKEN`; device tokens; tunnel owner secrets (they keep a device's public TCP ports stable);
SSH private keys stored for the web terminal and passwords typed into it; the dashboard session
cookie; `DATA_ENCRYPTION_KEY`; the release signing key; visitor IP addresses in the sessions
table (personal data); and, above all, the services running on the devices.

### What TunnelVault does not do

- **Public TCP ports have no access control of their own.** A TCP tunnel makes a device's local
  service (for example its SSH server) reachable by anyone who can reach the server's port. That
  service must authenticate its users itself. For SSH, allow key-based login only. Restrict the
  tunnel port range in the server's firewall if your users have fixed addresses.
- **The web terminal runs its SSH client on the server.** Passwords and keys used in the
  browser terminal are handled by the server process (and stored keys are decrypted there). Use it
  only over HTTPS and only on a server you trust with those credentials.
- **One administrator role.** Whoever holds `AUTH_TOKEN` controls everything. There are no user
  accounts, roles or audit log.
- **HTTP tunnels share the site with the dashboard.** Tunnelled web applications are served on
  `<subdomain>.DOMAIN`, which is the same site as a dashboard on `DOMAIN`. `SameSite` cookies
  alone therefore do not separate them. Over HTTPS the dashboard uses an HttpOnly `__Host-`
  cookie that subdomains can neither read nor overwrite, and it refuses cookie-authenticated
  state-changing requests whose `Origin` is not the dashboard itself (tunnel subdomains included).
  Treat tunnelled applications as untrusted content.
- **The `?tunnel=<id>` fallback of the HTTP proxy** (used only for hosts outside `DOMAIN`, such
  as a bare IP address) puts every tunnel on the same browser origin. Use it for testing only.
- **Legacy SSH gateway.** `gw-<token>` users are real Linux accounts on the server (public key
  only, no TTY, no forwarding, forced command). Only use the gateway if you need it.

## What 2.0 changed

Every finding of the review and how 2.0 addresses it. The test files named in the last column run
in CI (`.github/workflows/ci.yml`).

### Findings

| Finding | Fix in 2.0 | Tests |
|---|---|---|
| **P1-1** SSH private keys for the web terminal stored in plaintext | AES-256-GCM encryption at rest with `DATA_ENCRYPTION_KEY` (or `_FILE`) and rotation via `DATA_ENCRYPTION_KEY_PREVIOUS`. Existing plaintext keys are encrypted at startup. Without a key the feature is disabled. Keys are validated (no passphrase) and never returned by the API. The Tokens page can set and clear them. | `platform-secretbox`, `platform-tokens`, `platform-sshws` |
| **P1-2** Revoked tokens stay connected; no per-token limits | A registry of live connections per token. Deactivating or deleting a token closes its WebSocket with `4000` (hard terminate after 2 s), which also closes its public ports. Deleting also removes its tunnels and pinned host keys. The server re-checks tokens every 30 s. Rate limits apply per IP on upgrades (60/min, 10 failed auths/min). At most 4 connections per token (oldest replaced) and 10 tunnels per token across all its connections. Idle tunnels are cleaned up. | `core-control`, `platform-app`, `e2e-stack` |
| **P1-3** Synchronous DB write per packet, no backpressure | Statistics are batched (one transaction at most every 5 s). Protocol v2 uses binary frames with per-stream `tcp-pause`/`tcp-resume` and per-WebSocket high/low water marks (8 MiB/1 MiB) on both sides, plus memory caps per stream and connection. `ws` upgraded. | `core-throughput` (64 MiB each way, sha256, minimum rate), `core-protocol` |
| **P1-4** Updaters `git pull` as root without verification | Signed GitHub releases: an ECDSA P-256 signature over `SHA256SUMS` (verified with a pinned key) and then the SHA-256 checksum, both checked before extracting. Also: HTTPS only, downgrades refused, optional version pinning, flock against concurrent runs, fail closed. The release workflow signs in a protected environment. Updaters are opt-in (`--auto-update`), and upgrades remove the old git-based ones. | `scripts/release/test/updater.test.js`, `release.test.js`, `ops-server-e2e` |
| **P1-5** Tokens exposed in logs, process list and world-readable state | The logger redacts URLs, headers, `gw-`/`ws-` user names and sensitive fields. The device token lives only in `/etc/tunnelvault/client.env` (0600, `EnvironmentFile=`), never in `ExecStart` or `config.json`. `state.json` is 0600 in a 0700 directory (existing files are tightened). | `platform-logger`, `client/test/*`, `install-client.test.js` |
| **P2-6** Device connects to any local port the server names | `tcp-open` is accepted only for configured ports and the device's own tunnel IDs; anything else gets `tcp-close` without a local connection. Legacy `request` messages from 1.x servers go only to configured HTTP tunnel ports. | `client/test/tunnel.test.js` |
| **P2-7** Web terminal mangles UTF-8; "Stored Key" tab unreachable | Terminal data travels as binary frames and is decoded by xterm (split UTF-8 sequences included). Pastes are chunked. `has_private_key` exists in the API. | `platform-sshws`, `frontend/test/terminalFrames.test.js` |
| **P2-8** Unconditional `trust proxy` allows IP spoofing | `X-Forwarded-*` is honoured only from proxies named in `TRUST_PROXY` (the `--tls` install sets `loopback`). The same resolver feeds every rate limiter and the upgrade handlers. | `platform-auth` |
| **P2-9** Broken TLS install, crash loop, hardcoded `ws://host:4000`, Google-hosted font | `--tls` = nginx + Let's Encrypt HTTP-01 for the apex domain (webroot, deploy hook reloads nginx), plus an optional DNS-01 wildcard certificate via `--wildcard-cert`. The backend listens on `127.0.0.1`. Unreadable `TLS_CERT`/`TLS_KEY` exit with code 78 and one clear message (no restart loop). The dashboard uses `wss://` over HTTPS. IBM Plex Mono is self-hosted. | `ops-server-install` (`nginx -t` of all variants), `ops-server-e2e`, `platform-auth`, `frontend/test/serverUrl.test.js` |
| **P3-10** Stale backend lockfile | Lockfiles regenerated; `npm ci` in CI and in the image build. | CI |
| **P3-11** Client upgrade needs `python3`, can write empty credentials | The installers use Node only; an upgrade refuses to write an empty server or token. | `install-client.test.js` |
| **P3-12** Shell/JSON injection via `--extra-port` name | Every argument is validated (`NAME` = `[A-Za-z0-9._-]{1,64}`, ports, protocol, URL, token) and JSON is built with `JSON.stringify`. | `install-client.test.js` |
| **P3-13** `ufw --force reset` wipes firewall rules | Never reset. An inactive ufw gets default-deny plus the SSH port(s) and TunnelVault rules; an active one only gets TunnelVault rules. `--no-firewall` skips it, and firewalld is left alone. | `ops-server-install`, `ops-server-e2e` |
| **P3-14** No SSH host key verification in the web terminal | Trust on first use: an unknown key is shown for explicit acceptance (60 s), a changed key is refused. Pins are per device token and port, and can be forgotten in the dashboard. | `platform-sshws`, `e2e-stack` |
| **P3-15** Google Fonts (GDPR) | Font bundled with the dashboard; CSP allows same-origin fonts only. | `platform-auth` |
| **Arch-A** Tunnel limit per WebSocket, not per token | `MAX_TUNNELS_PER_TOKEN` counts all connections of a token; `MAX_CONNECTIONS_PER_TOKEN` caps connections. | `core-control` |
| **Arch-B** No cleanup of idle tunnels | `last_activity` column; hourly cleanup after `TUNNEL_IDLE_RETENTION_DAYS` (30). | `core-control`, `platform-maintenance` |
| **Dependencies** (`ws` DoS, `path-to-regexp`, `uuid`, `postcss`, `cross-spawn`, frontend advisories) | Upgraded or removed (`uuid` → `crypto.randomUUID`). `npm audit --omit=dev --audit-level=high` runs in CI for backend, client and dashboard. | CI |

### Additional items from the review

| Item | Fix in 2.0 |
|---|---|
| Dashboard reachable over plaintext HTTP by default | `--tls` is documented as the standard install. Installing without it prints a prominent warning, and the server logs one at startup. Devices warn about `ws://` to public hosts. |
| Tunnel/subdomain hijacking by another device | Stale records are replaced only for the same token, local port and protocol. Records of other owners are never deleted. HTTP subdomains are unique across owners (`-2`, `-3`, …). `reconnect` needs the owner secret **and** the same token. |
| Device trusts the server completely (ports, reboot) | Port allowlist (P2-6). Remote reboot needs `--allow-reboot` on the device, which installs a sudoers rule limited to `systemctl reboot` / `reboot`. |
| Admin token in query strings, `localStorage`, `ps` | Query-string tokens are rejected everywhere. The dashboard uses an HttpOnly session cookie (only a keyed hash is stored server-side). The device token is kept out of argv. |
| Rate limits bypassable; no limits on WebSocket upgrades | Proxy-aware client IP (P2-8). Limits on the API (300/min), login and bad Bearer tokens (10/min), device WebSocket upgrades (60/min, 10 failed authentications/min) and the web terminal (10/min, 10 concurrent sessions). |
| GeoIP sends visitor IPs to ip-api.com over HTTP | `GEOIP_PROVIDER=off` by default. `maxmind` does local lookups. `ip-api` is only available as an explicit, warned opt-in. Sessions are deleted after `SESSION_RETENTION_DAYS` (90). |
| Custom tokens > 29 characters break gateway users silently | Rejected with a clear error when a public key is set; the API reports `linux_user_created` / `linux_user_queued` / `linux_user_error`. |
| Legacy gateway cannot read config or write the DB (session tracking broken) | `gateway-helper.sh` runs as the service user via a narrow sudo rule. A root worker creates Linux users from a spool directory. |
| Two installers, three schemas, stale docs | One installer (`gateway/setup.sh` forwards to it), and the backend owns the schema through versioned migrations. The documentation has been rewritten. |
| HTTP tunnels buffer everything, strip cookies, no WebSockets | Streaming with backpressure, WebSocket passthrough, `Set-Cookie` without `Domain`, idle timeouts. |
| Leftovers (simulated tunnels, hardcoded settings, `ws://` install commands, branding, license mismatch, repo URL, login gate) | Removed or fixed: `POST /api/tunnels` → 405, settings come from `/api/config`, install commands follow the server URL, MIT everywhere, repo `TrainABit/ssh-tunnel`. The login gate treats 429/5xx/network errors as errors. |
| No tests, CI or container image | node:test suites for every component (including an end-to-end test with the real device client), CI workflow, Dockerfile. |

Preserved from 1.x: parameterised SQL everywhere, validated helpers before `useradd` and
`authorized_keys`, `execFile` instead of shell strings, sudo scoped to single root-owned
scripts, response-header injection blocked, a CSP with same-origin scripts, and no secrets in the
git history.

## Security properties of a 2.0 installation

- **Transport:** with `--tls`, nginx terminates TLS for the dashboard, API, `/ws` and `/ws/ssh`,
  and the backend listens on `127.0.0.1` only. HSTS (`max-age=31536000`, without
  `includeSubDomains`, because HTTP tunnels may still be plain HTTP) is sent over HTTPS.
- **Dashboard session:** the cookie is `__Host-tv_session` (HttpOnly, Secure, SameSite=Strict,
  Path=/), with a sliding lifetime of `SESSION_TTL_HOURS` (12). The server stores only a keyed
  hash of the session ID and keeps at most 100 sessions. Changing `AUTH_TOKEN` invalidates all of
  them.
- **Headers:** `Content-Security-Policy` (scripts and fonts from the same origin only, WebSockets
  only to the dashboard's own host, `object-src 'none'`, `frame-ancestors 'none'`),
  `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`,
  `Cross-Origin-Opener-Policy: same-origin`, no `X-Powered-By`.
- **Server process:** a dedicated `tunnelvault` user under a hardened systemd unit
  (`NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, empty capability set, …) with
  write access only to `/opt/tunnelvault/data` and `/opt/tunnelvault/logs`. Application files
  are owned by root. `.env` and the database are 0600.
- **Device process:** runs as the chosen service user with `EnvironmentFile=` for the token,
  a root-owned read-only config (`/etc/tunnelvault/config.json`, 0640), state in
  `/var/lib/tunnelvault` (0700) and systemd hardening. When remote reboot is enabled, the unit
  keeps only the protections that do not imply `NoNewPrivileges`, so `sudo reboot` still works.
- **Updates:** signed releases only. The trust anchor `/etc/tunnelvault/release-signing.pub` is
  replaced only by an explicit `--release-pubkey`, never by a key shipped inside a download.
  `update.conf` and the key are root-owned and not group/world-writable, and the updater refuses
  them otherwise.

## Hardening checklist

Server:

- [ ] Install with `--tls --domain <your domain>` (and `--wildcard-cert DIR` if you use HTTP
      tunnels). Point devices at `wss://<your domain>`.
- [ ] Keep the generated `AUTH_TOKEN` (64 hex characters) in a password manager. Use it for
      dashboard logins and `Authorization: Bearer` in scripts only. Do not use it as a device
      token. Rotate it with `sudo bash install-server.sh --upgrade --auth-token NEW` (this logs out
      every dashboard session).
- [ ] Give every device its own token. Deactivate lost or retired devices at once (this
      disconnects them); delete tokens you no longer need.
- [ ] Back up `/opt/tunnelvault/backend/.env` (holds `AUTH_TOKEN` and `DATA_ENCRYPTION_KEY`) and
      the database. Encrypt the backups: they contain every token.
- [ ] Set `TRUST_PROXY` only to your own reverse proxy (`loopback` for nginx on the same host).
      Never trust a range that clients can reach directly.
- [ ] Keep `GEOIP_PROVIDER=off` or use `maxmind`. Choose `SESSION_RETENTION_DAYS` to match your
      privacy obligations (visitor IPs are personal data).
- [ ] Narrow `TCP_PORT_MIN`/`TCP_PORT_MAX` to what you need, and if possible restrict the tunnel
      ports in the firewall to your users' networks.
- [ ] Enable signed auto-updates (`--auto-update`) after checking the release key fingerprint
      through a second channel, or subscribe to releases and upgrade promptly by hand.
- [ ] Keep the operating system patched (for example `unattended-upgrades`) and administer the
      server over SSH with keys only.
- [ ] If you do not need the legacy SSH gateway, do not create tokens with public keys.
- [ ] Set `WEBHOOK_URL` to get notified when tunnels connect or disconnect.

Devices:

- [ ] Run the service as a dedicated unprivileged user (`--user`), not root.
- [ ] Use key-based SSH login only on devices exposed through TCP tunnels
      (`PasswordAuthentication no`).
- [ ] Configure only the ports you want to expose. The device refuses everything else.
- [ ] Enable `--allow-reboot` only where you need remote reboots.
- [ ] Pass the token with `--token-file` when installing from shared shells (keeps it out of `ps`
      and shell history).

Web terminal:

- [ ] Compare the host key fingerprint on the first connection with the device's real key
      (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the device). A mismatch warning
      later means the key changed: find out why before you forget the pin.
- [ ] Store SSH keys on the server only if the convenience is worth it. They are encrypted, but
      the server can use them.

Docker:

- [ ] Publish ports 4000/4001 on `127.0.0.1` only and put a TLS reverse proxy in front. Keep the
      `/data` volume and the env file private.

## Release signing key

Releases are signed with an ECDSA P-256 key. The private key exists only as the GitHub Actions
secret `RELEASE_SIGNING_KEY` in the protected `release` environment and in the maintainers'
offline backup. Its public half is committed as `release-signing.pub`. Check its fingerprint
through a second channel before trusting it:

```bash
openssl pkey -pubin -in release-signing.pub -outform DER | sha256sum
```

If the key is ever compromised, the maintainers publish a new key, and operators must install it
explicitly (`--release-pubkey FILE`). The updaters never accept a key change on their own.

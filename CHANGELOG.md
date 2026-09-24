# Changelog

All notable changes to TunnelVault. Versions follow [semantic versioning](https://semver.org/);
releases are published as signed GitHub releases (`tunnelvault-vX.Y.Z.tar.gz` + `SHA256SUMS` +
`SHA256SUMS.sig`).

## [2.0.0] - Unreleased

Security remediation release. It fixes every finding of the external security review; see
[SECURITY.md](SECURITY.md) for the finding-by-finding mapping. Upgrade instructions:
[DEPLOYMENT.md, "Upgrading from 1.x"](DEPLOYMENT.md#upgrading-from-1x).

### Breaking changes

- **Tokens in URLs are no longer accepted.** `?auth_token=` is ignored on the REST API, on the
  device WebSocket (`/ws`) and on the web terminal (`/ws/ssh`). Scripts send
  `Authorization: Bearer <AUTH_TOKEN>`. Devices already send the token as a header (1.x clients
  included), so they keep working.
- **Dashboard login uses a session cookie.** The dashboard exchanges the admin token once
  (`POST /api/auth/login`) for an HttpOnly, SameSite=Strict cookie (`__Host-tv_session` over
  HTTPS) and never stores the token in the browser; the old `localStorage` copy is deleted.
  Cookie-authenticated `POST`/`PUT`/`PATCH`/`DELETE` requests must come from the dashboard's own
  origin. Changing `AUTH_TOKEN` logs out every dashboard session.
- **Dashboard sessions are bound to a session key; everyone signs in again after the upgrade.**
  Without TLS the browser sends the dashboard cookie to every port of the host, including TCP
  tunnel ports that serve device-controlled pages. The login response therefore also returns a
  per-session key, which the dashboard keeps in its origin's `localStorage` and sends as
  `X-TV-Session-Key` (web terminal: `tv-key.<key>` WebSocket subprotocol). The cookie alone is
  no longer accepted, so existing sessions end and the dashboard shows the login screen once.
- **Remote reboot is opt-in on each device.** A device ignores the dashboard's reboot command
  unless it was installed with `--allow-reboot` (config `"allow_reboot": true` or
  `TUNNELVAULT_ALLOW_REBOOT=1`). Upgrading a 1.x device turns remote reboot **off** and removes
  its old unconditional sudoers rule; re-enable it with
  `sudo bash install-client.sh --upgrade --allow-reboot`.
- **The device token moved out of the process list and `config.json`.** It now lives only in
  `/etc/tunnelvault/client.env` (0600 root, systemd `EnvironmentFile=`); `ExecStart` carries no
  secrets. `install-client.sh --upgrade` migrates existing devices automatically.
- **The auto-updaters install signed releases only.** The old updaters ran `git pull` as root
  every 12 h without any verification. The new updaters download a GitHub release, verify the
  ECDSA P-256 signature of `SHA256SUMS` with a pinned public key, then the checksum, refuse
  downgrades and fail closed. They are off by default: install them with
  `--auto-update` (plus the release public key). Upgrading removes the old git-based updaters.
- **`POST /api/tunnels` is removed** (it created "simulated" tunnels that counted as active).
  Tunnels are created by connecting devices only; the endpoint answers `405`.
- **GeoIP is off by default.** 1.x sent every visitor IP to ip-api.com over plain HTTP. Choose
  `GEOIP_PROVIDER=maxmind` (local GeoLite2 database) or, for non-commercial use only,
  `GEOIP_PROVIDER=ip-api`.
- **`trust proxy` is no longer enabled unconditionally.** `X-Forwarded-For` is ignored unless
  `TRUST_PROXY` names the reverse proxy (`install-server.sh --tls` sets `TRUST_PROXY=loopback`).
- **Legacy SSH-gateway tokens are limited to 29 characters** when a public key is set (the Linux
  user `gw-<token>` may not exceed 32 characters). The API rejects longer ones instead of failing
  silently.
- **`gateway/setup.sh` is deprecated.** It now prints a notice and runs `install-server.sh`,
  which installs and maintains the legacy SSH gateway.

### Security

- TLS by default in the documentation and installer: `install-server.sh --tls` puts nginx +
  Let's Encrypt (HTTP-01, apex domain) in front of TunnelVault, binds the backend to
  `127.0.0.1`, renews automatically and reloads nginx through a certbot deploy hook. HTTPS for
  HTTP tunnels via an optional DNS-01 wildcard certificate (`--wildcard-cert DIR`). The broken
  1.x TLS mode (wildcard through the nginx plugin, certificates the service could not read) is
  gone; old `TLS_CERT`/`TLS_KEY` lines pointing into `/etc/letsencrypt` are commented out on
  upgrade. Installing without `--tls` prints a prominent warning.
- Revoking or deleting a device token disconnects its live WebSocket within seconds (close code
  `4000`) and with it the public TCP ports and the web-terminal sessions running through that
  device; deleting also removes its tunnels and pinned host keys. The server re-checks device
  tokens every 30 s.
- Per-token limits: at most `MAX_CONNECTIONS_PER_TOKEN` (4) connections and
  `MAX_TUNNELS_PER_TOKEN` (10) tunnels across all connections of a token.
- Tunnel ownership: a device can no longer take over or delete another device's tunnel or HTTP
  subdomain; reconnecting requires the tunnel's owner secret **and** the same token.
- Devices accept `tcp-open` only for their configured local ports and their own tunnels.
- SSH private keys stored for the web terminal are encrypted at rest (AES-256-GCM,
  `DATA_ENCRYPTION_KEY`, with key rotation); without a key the feature is disabled. No API
  response contains a private key.
- The web terminal verifies SSH host keys (trust on first use with an explicit prompt; a changed
  key is refused).
- Rate limits per client IP on the API, dashboard login, device WebSocket upgrades and the web
  terminal; client IPs cannot be spoofed with `X-Forwarded-For` unless the proxy is trusted.
- Logs never contain full tokens, cookies, passwords or keys (URLs, `gw-`/`ws-` user names and
  structured fields are redacted).
- Device state (`state.json`, owner secrets) is written 0600 in a 0700 directory; the systemd
  service keeps it in `/var/lib/tunnelvault`.
- Hardened systemd units for server and device; the server's application files are root-owned
  and read-only for the service user; the installers validate every argument and build JSON with
  Node (no shell or JSON injection through `--extra-port` names).
- The firewall is never reset: `ufw --force reset` is gone. An inactive ufw is set up with
  default-deny plus SSH and TunnelVault rules; an active one only gets TunnelVault rules.
- HSTS only over HTTPS and without `includeSubDomains`; the Content Security Policy no longer
  allows Google Fonts.
- Dependencies upgraded (`ws` DoS fix, stale backend lockfile regenerated so `npm ci` works);
  `npm audit` reports no known vulnerabilities in backend, client or dashboard.

### Added

- Device protocol v2: binary data frames, per-stream and per-connection flow control (bounded
  memory), `hello` negotiation, error codes and close codes. v1 peers keep working in both
  directions. Specification: [docs/PROTOCOL.md](docs/PROTOCOL.md).
- Signed release pipeline: `scripts/release/` (key generation, build, sign, verify) and the
  `release` GitHub Actions workflow triggered by tags `vX.Y.Z`.
- Updater settings in `/etc/tunnelvault/update.conf` (`ENABLED`, `SCHEDULE`, `UPDATE_REPO`,
  `PINNED_VERSION`, `PUBKEY`), shared by server and device updaters on one host;
  `--dry-run` for a manual check.
- `install-client.sh`: `--token-file`, `--allow-reboot`/`--no-reboot`,
  `--auto-update`/`--no-auto-update`, `--release-pubkey`, `--yes`.
- `install-server.sh`: `--email`, `--wildcard-cert DIR`, `--no-firewall`,
  `--auto-update`/`--no-auto-update`, `--release-pubkey`, `--yes` (and a reworked `--tls`).
- `uninstall-server.sh` backs up the database and configuration to `/var/backups/tunnelvault/`
  first and removes everything the installer created; `uninstall-client.sh --keep-config` keeps
  token, tunnels and reconnect state for a reinstall.
- Data retention: sessions (visitor IPs) are deleted after `SESSION_RETENTION_DAYS` (90), offline
  tunnels after `TUNNEL_IDLE_RETENTION_DAYS` (30).
- Optional local GeoIP with a MaxMind GeoLite2 database (`GEOIP_PROVIDER=maxmind`).
- `GET /api/config`, `GET /api/auth/session`, `POST /api/auth/login`, `POST /api/auth/logout`,
  `DELETE /api/tunnels/:id/hostkey`.
- Dashboard: stored-key management on the Tokens page, host-key prompts in the web terminal,
  install commands that match the server (`wss://` behind TLS).
- Container image (`Dockerfile`, `docker-compose.yml`) running as a non-root user.
- Continuous integration (`.github/workflows/ci.yml`): tests, lint, build, shellcheck and
  `npm audit` on every push and pull request.
- Test suites for backend (including an end-to-end test with the real device client), client,
  dashboard, installers, updaters and release tooling.

### Changed

- Throughput: no database write per packet (statistics are batched every 5 s), binary frames,
  backpressure on both sides. Large transfers (`scp`) no longer grow the server's memory.
- HTTP tunnels stream request and response bodies, pass WebSockets and `Set-Cookie` (with the
  `Domain` attribute removed, so cookies stay host-only) and use idle timeouts instead of a
  whole-request timeout. Their public URL is configurable (`HTTP_TUNNEL_URL_TEMPLATE`).
- Web terminal: binary frames, correct UTF-8 (umlauts, emoji), large pastes are chunked.
- The backend owns the database schema (versioned migrations); the installers no longer create
  tables. One service name (`tunnelvault`), one database path
  (`/opt/tunnelvault/data/tunnelvault.db`).
- Legacy SSH gateway: gateway users look up their target through a helper that runs as the
  service user, and Linux users are created by a root worker from a spool directory, so session
  tracking and user management work under systemd hardening.
- Installers use Node (never `python3`) to read and write JSON; an upgrade refuses to write an
  empty server URL or token.
- Server configuration errors exit with code 78 and one clear log line; systemd does not
  restart in a loop.
- Dashboard font (IBM Plex Mono) is self-hosted; the web terminal and install commands use
  `wss://` when the dashboard is served over HTTPS.
- License: `backend`, `client` and the root `package.json` declare MIT, matching the README, and
  the repository ships the MIT license text as a root `LICENSE` file (included in release
  archives and the container image).

### Fixed

- `install-client.sh --upgrade` without `python3` wrote an empty server URL and token.
- The device's public TCP port now survives upgrades (reconnect state is migrated) and service
  users without a home directory.
- The dashboard login no longer treats rate limiting or server errors as "logged in".
- Idle tunnels and old session rows are cleaned up (hourly, and at startup open session rows
  left behind by a restart are closed); the sessions table is indexed.
- Sessions of the web terminal are released exactly once.
- The Settings page shows the real ports, update schedule and version.

## [1.0.0]

Initial release (unsigned, installed from a git checkout).

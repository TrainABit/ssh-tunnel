# TunnelVault

> Selbst gehostete SSH- & TCP-Tunnel über WebSocket — wie ngrok, aber privat.

Ein Gerät hinter NAT oder Firewall (Raspberry Pi, Server im Kundennetz, Maschine im Labor) baut eine
ausgehende, verschlüsselte WebSocket-Verbindung zu deinem TunnelVault-Server auf. Der Server stellt
die lokalen Dienste des Geräts (SSH, Web-Oberflächen, beliebige TCP-Ports) unter einem festen
öffentlichen Port bzw. einer Subdomain bereit. Verwaltet wird alles über ein Web-Dashboard.

**Dokumentation:** [DEPLOYMENT.md](DEPLOYMENT.md) (Betriebshandbuch, Englisch) ·
[SECURITY.md](SECURITY.md) (Sicherheitsmodell, Meldung von Schwachstellen) ·
[CHANGELOG.md](CHANGELOG.md) · [docs/PROTOCOL.md](docs/PROTOCOL.md) (Geräteprotokoll)

---

## Schnellstart

Voraussetzungen: ein Linux-Server mit Debian oder Ubuntu (systemd, `apt`), eine Domain, deren
A-Record auf den Server zeigt (z. B. `tunnel.example.com`), und eingehend offene Ports **80**, **443**
und **10000–10999**. Node.js 22 installiert der Installer bei Bedarf selbst.

### 1. Release herunterladen und prüfen

TunnelVault wird als signiertes Release veröffentlicht. Den öffentlichen Schlüssel
(`release-signing.pub`) nur aus einer vertrauenswürdigen Quelle beziehen und seinen Fingerprint über
einen zweiten Kanal abgleichen (siehe [SECURITY.md](SECURITY.md#release-signing-key)).

```bash
V=2.0.0
BASE=https://github.com/TrainABit/ssh-tunnel/releases/download/v$V
curl -fLO "$BASE/tunnelvault-v$V.tar.gz" -O "$BASE/SHA256SUMS" -O "$BASE/SHA256SUMS.sig"
curl -fL -o release-signing.pub https://raw.githubusercontent.com/TrainABit/ssh-tunnel/main/release-signing.pub
openssl pkey -pubin -in release-signing.pub -outform DER | sha256sum   # Fingerprint abgleichen
openssl dgst -sha256 -verify release-signing.pub -signature SHA256SUMS.sig SHA256SUMS
sha256sum -c --ignore-missing SHA256SUMS
tar xzf "tunnelvault-v$V.tar.gz" && cd "tunnelvault-v$V"
```

Alternativ aus Git: `git clone --branch v2.0.0 https://github.com/TrainABit/ssh-tunnel.git && cd ssh-tunnel`.
Der Installer baut das Dashboard dann selbst, als root und mit `npm ci`. Für den Produktivbetrieb
sind die signierten Releases vorzuziehen.

### 2. Server installieren (mit TLS)

```bash
sudo bash install-server.sh --tls --domain tunnel.example.com --email admin@example.com
```

`--tls` richtet nginx + Let's Encrypt ein. Dashboard, API und Geräteverbindung laufen dann über
`https://tunnel.example.com` bzw. `wss://tunnel.example.com`. Der Backend-Dienst lauscht nur noch auf
`127.0.0.1`. Am Ende gibt der Installer einmalig den **Admin-Token** aus. Er liegt außerdem in
`/opt/tunnelvault/backend/.env`. Damit meldest du dich im Dashboard an.

Signierte automatische Updates gleich mit einschalten:
`--auto-update --release-pubkey ../release-signing.pub` (der Schlüssel, mit dem du oben geprüft hast).

> Ohne `--tls` laufen Dashboard (Port 4000) und Geräteverbindung unverschlüsselt. Tokens und
> Web-Terminal-Passwörter gehen dann im Klartext übers Netz. Das ist nur im LAN oder zum Testen
> vertretbar.

### 3. Geräte-Token anlegen

Dashboard öffnen → **Tokens** → **New Token** (z. B. „Gerät A“). Jedes Gerät bekommt einen eigenen
Token. Wird ein Token deaktiviert oder gelöscht, trennt der Server das Gerät sofort.

### 4. Client auf dem Gerät installieren

Release wie in Schritt 1 herunterladen und prüfen, dann:

```bash
sudo bash install-client.sh --server wss://tunnel.example.com --token GERAETE_TOKEN
```

- Der Token landet ausschließlich in `/etc/tunnelvault/client.env` (0600, root). Er steht weder in
  der Prozessliste noch in `config.json`. Mit `--token-file DATEI` taucht er auch nicht in der
  Shell-History auf.
- Der Dienst `tunnelvault-client` läuft unter dem Benutzer, der `sudo` aufgerufen hat (oder
  `--user NAME`), startet beim Booten und verbindet sich nach Abbrüchen neu.
- Mehrere Ports: `--extra-port 8080:http:web --extra-port 5432:tcp:db`
- Neustart des Geräts aus dem Dashboard erlauben (standardmäßig aus): `--allow-reboot`
- Signierte automatische Updates: `--auto-update --release-pubkey ../release-signing.pub`

### 5. Verbinden

Das Dashboard zeigt unter **Tunnels** den öffentlichen Port des Geräts (bleibt über Neustarts und
Updates gleich):

```bash
ssh -p PORT benutzer@tunnel.example.com
```

Oder direkt im Browser: **Tunnels** → Terminal-Symbol (Web-SSH mit Host-Key-Prüfung).

---

## Architektur

```
 SSH-/TCP-Client           TunnelVault-Server                              Gerät (hinter NAT)
 ───────────────     ┌─────────────────────────────────────────┐     ┌───────────────────────────┐
                     │ nginx :443 (TLS, Let's Encrypt)          │     │ tunnelvault-client        │
 Browser ──https───▶ │   └─▶ Dashboard + API + /ws + /ws/ssh    │◀═══ │ (systemd, eigener User)   │
                     │        (127.0.0.1:4000)                  │ wss │        │                  │
 ssh -p N ──tcp────▶ │ TCP-Tunnel-Ports 10000–10999             │     │        ▼                  │
                     │ nginx :80 ─▶ HTTP-Proxy (127.0.0.1:4001) │     │ localhost:22, :8080, …    │
 http://sub.domain ▶ │   für <subdomain>.DOMAIN                 │     │                           │
                     └─────────────────────────────────────────┘     └───────────────────────────┘
```

Das Gerät hält eine ausgehende WebSocket-Verbindung (`wss://…/ws`) zum Server. Für jede eingehende
Verbindung auf dem öffentlichen Port öffnet der Server über diese Verbindung einen Datenstrom zum
Gerät, das ihn an den lokalen Dienst weitergibt. Das Gerät akzeptiert dabei nur die Ports, die bei
der Installation konfiguriert wurden.

## Funktionen

- **TCP-Tunnel**: SSH, Datenbanken, beliebige TCP-Dienste mit festem öffentlichem Port
- **HTTP-Tunnel**: Web-Anwendungen unter `<subdomain>.DOMAIN`, mit Streaming, WebSockets und Cookies.
  Über HTTPS mit einem Wildcard-Zertifikat (`--wildcard-cert`).
- **Mehrere Ports pro Gerät** über eine einzige Verbindung (`--extra-port`)
- **Web-SSH-Terminal** im Dashboard: UTF-8, Host-Key-Prüfung (Trust on First Use), optional
  verschlüsselt gespeicherte SSH-Schlüssel
- **Signierte Releases und Auto-Updater**: Server und Geräte installieren nur Releases mit gültiger
  ECDSA-Signatur. Kein Downgrade, Versions-Pinning möglich, standardmäßig aus.
- **Webhooks** bei Connect/Disconnect: ntfy, Slack, Discord oder JSON
- **Dashboard** mit Tunneln, Tokens, Sessions, aktiven Verbindungen und einer Setup-Anleitung, die
  zur Server-Konfiguration passt
- **Docker-Image** für den Server ([Dockerfile](Dockerfile), [docker-compose.yml](docker-compose.yml))

### Sicherheit

- TLS über nginx + Let's Encrypt mit automatischer Erneuerung, HSTS
- Dashboard-Login per HttpOnly-Session-Cookie. Der Admin-Token wird nie im Browser gespeichert.
- Tokens nie in URLs, Logs oder der Prozessliste. Logs werden geschwärzt.
- Widerruf wirkt sofort: Ein deaktivierter Token trennt Gerät, öffentliche Ports und Terminal-Sitzungen.
- Limits pro Token (Verbindungen, Tunnel) und Rate-Limits pro IP (API, Login, WebSocket, Terminal).
  `X-Forwarded-For` gilt nur von einem explizit vertrauten Proxy (`TRUST_PROXY`).
- Geräte vertrauen dem Server nur für ihre konfigurierten Ports. Remote-Reboot ist Opt-in.
- SSH-Schlüssel für das Web-Terminal sind verschlüsselt gespeichert (AES-256-GCM).
- Tunnel können nicht von fremden Tokens übernommen werden.
- Gehärtete systemd-Dienste; die Firewall wird ergänzt, nie zurückgesetzt.
- GeoIP ist standardmäßig aus (optional lokal mit MaxMind). Alte Sessions werden automatisch
  gelöscht (DSGVO).

Details und die vollständige Zuordnung der Audit-Befunde: [SECURITY.md](SECURITY.md).

---

## Ports & Firewall

| Port | Mit `--tls` | Ohne `--tls` | Zweck |
|------|-------------|--------------|-------|
| 22/tcp | offen | offen | SSH-Administration des Servers (vom Installer nur freigegeben, wenn er ufw selbst aktiviert) |
| 80/tcp | offen | – | Let's-Encrypt-Prüfung, Umleitung auf HTTPS, HTTP-Tunnel ohne Wildcard-Zertifikat |
| 443/tcp | offen | – | Dashboard, API, Geräteverbindung (`/ws`), Web-Terminal (`/ws/ssh`), HTTP-Tunnel mit Wildcard-Zertifikat |
| 4000/tcp | nur lokal | offen | Dashboard, API, `/ws`, `/ws/ssh` (unverschlüsselt) |
| 4001/tcp | nur lokal | offen | HTTP-Tunnel-Proxy (unverschlüsselt) |
| 10000–10999/tcp | offen | offen | Öffentliche TCP-Tunnel-Ports (`TCP_PORT_MIN`/`TCP_PORT_MAX`) |

Der Installer richtet `ufw` so ein: Ist ufw inaktiv, setzt er „eingehend verbieten“ und gibt SSH
sowie die TunnelVault-Ports frei. Ist ufw schon aktiv, ergänzt er nur die TunnelVault-Regeln.
Bestehende Regeln bleiben immer erhalten. `--no-firewall` überspringt diesen Schritt. Ein aktives
`firewalld` wird nicht angefasst. Bei Cloud-Anbietern zusätzlich die Security Group bzw. externe
Firewall öffnen.

Geräte brauchen nur **ausgehend** 443 (bzw. 4000 ohne TLS). Auf dem Gerät muss kein Port offen sein.

---

## Installer-Optionen

### `install-server.sh`

| Option | Beschreibung | Standard |
|--------|-------------|---------|
| `--domain DOMAIN` | Server-Domain (mit `--tls` ein öffentlicher Name) | `tunnel.local` |
| `--tls` | nginx + Let's Encrypt (HTTP-01, nur die Domain selbst) | aus |
| `--email EMAIL` | E-Mail für Let's Encrypt (nur mit `--tls`) | – |
| `--wildcard-cert DIR` | Verzeichnis mit `fullchain.pem` + `privkey.pem` eines separat (DNS-01) besorgten `*.DOMAIN`-Zertifikats; HTTPS für HTTP-Tunnel (nur mit `--tls`) | – |
| `--auth-token TOKEN` | Admin-Token, 16–256 Zeichen aus `[A-Za-z0-9._~-]` | 64 Hex-Zeichen, generiert |
| `--port PORT` | API-/Dashboard-Port | `4000` |
| `--proxy-port PORT` | HTTP-Tunnel-Proxy-Port | `4001` |
| `--no-firewall` | Firewall nicht verändern | – |
| `--auto-update` / `--no-auto-update` | Signierten Auto-Updater installieren / entfernen | aus; bei `--upgrade` beibehalten |
| `--release-pubkey FILE` | Öffentlicher Release-Schlüssel (ECDSA P-256, PEM) | installierter Schlüssel, sonst `release-signing.pub` neben dem Skript |
| `--upgrade` | Bestehende Installation aktualisieren (Datenbank + Konfiguration bleiben) | – |
| `--yes`, `-y` | Nie nachfragen | – |

### `install-client.sh`

| Option | Beschreibung | Standard |
|--------|-------------|---------|
| `--server URL` | `wss://HOST[:PORT][/PFAD]` (oder `ws://…` nur im LAN) | erforderlich (Neuinstallation) |
| `--token TOKEN` / `--token-file FILE` | Geräte-Token aus dem Dashboard (1–64 Buchstaben/Ziffern) | erforderlich (Neuinstallation) |
| `--port PORT` | Lokaler Port des Haupttunnels | `22` |
| `--protocol tcp\|http` | Protokoll des Haupttunnels | `tcp` |
| `--extra-port PORT[:PROTO[:NAME]]` | Weiterer Tunnel, wiederholbar; NAME aus `[A-Za-z0-9._-]`. Mit `--upgrade` ersetzen `--port`/`--extra-port` die gesamte Tunnel-Liste. | PROTO `tcp`, NAME `tunnel-PORT` |
| `--user USER` | Linux-Benutzer des Dienstes | der `sudo`-Aufrufer; bei `--upgrade` beibehalten |
| `--allow-reboot` / `--no-reboot` | Neustart aus dem Dashboard erlauben / verbieten | verboten |
| `--auto-update` / `--no-auto-update` | Signierten Auto-Updater installieren / entfernen | aus; bei `--upgrade` beibehalten |
| `--release-pubkey FILE` | Öffentlicher Release-Schlüssel (ECDSA P-256, PEM) | wie beim Server |
| `--upgrade` | Aktualisieren; Server, Token, Tunnel, Benutzer, Reboot- und Update-Einstellungen bleiben, sofern nicht überschrieben | – |
| `--yes`, `-y` | Ohne Wirkung (fragt nie nach) | – |

Deinstallation: `sudo bash uninstall-server.sh` (sichert Datenbank und Konfiguration vorher nach
`/var/backups/tunnelvault/`) bzw. `sudo bash uninstall-client.sh [--keep-config]`.

---

## Konfiguration

Der Server liest seine Einstellungen aus `/opt/tunnelvault/backend/.env` (0600, gehört dem
Dienstbenutzer `tunnelvault`). Alle Variablen mit Erklärung und Standardwerten stehen in
[backend/.env.example](backend/.env.example). Nach Änderungen: `sudo systemctl restart tunnelvault`.

| Variable | Standard | Beschreibung |
|----------|---------|-------------|
| `AUTH_TOKEN` | – (Pflicht) | Admin-Token: Dashboard-Login und `Authorization: Bearer` für Skripte |
| `DOMAIN` | `tunnel.local` | Basis-Domain; HTTP-Tunnel unter `<subdomain>.DOMAIN` |
| `PUBLIC_URL` | – | Öffentliche Dashboard-URL (setzt `--tls`) |
| `PORT` / `PROXY_PORT` | `4000` / `4001` | API + Dashboard / HTTP-Tunnel-Proxy |
| `BIND_HOST` | `0.0.0.0` | Adresse für `PORT`/`PROXY_PORT` (`127.0.0.1` hinter nginx) |
| `TRUST_PROXY` | – (aus) | Vertrauter Reverse Proxy, z. B. `loopback` (setzt `--tls`) |
| `TCP_PORT_MIN` / `TCP_PORT_MAX` | `10000` / `10999` | Bereich der öffentlichen TCP-Ports |
| `MAX_TUNNELS_PER_TOKEN` / `MAX_CONNECTIONS_PER_TOKEN` | `10` / `4` | Limits pro Geräte-Token |
| `DATA_ENCRYPTION_KEY` | vom Installer generiert | Verschlüsselt gespeicherte SSH-Schlüssel; nicht verlieren |
| `SESSION_TTL_HOURS` | `12` | Gültigkeit der Dashboard-Anmeldung |
| `SESSION_RETENTION_DAYS` | `90` | Sessions (Besucher-IPs) nach N Tagen löschen (`0` = nie) |
| `TUNNEL_IDLE_RETENTION_DAYS` | `30` | Offline-Tunnel nach N Tagen entfernen (`0` = nie) |
| `GEOIP_PROVIDER` / `GEOIP_DB` | `off` | `off`, `maxmind` (lokale GeoLite2-Datei) oder `ip-api` (nur nicht-kommerziell) |
| `WEBHOOK_URL` / `WEBHOOK_TYPE` | – / `json` | Benachrichtigungen: `json`, `ntfy`, `slack`, `discord` |
| `LOG_LEVEL` / `LOG_FORMAT` | `info` / `pretty` | Logging (`json` für Log-Sammler) |

Das Gerät wird über `install-client.sh --upgrade …` umkonfiguriert: Token in
`/etc/tunnelvault/client.env`, Tunnel in `/etc/tunnelvault/config.json`, Reconnect-Zustand (hält die
öffentlichen Ports stabil) in `/var/lib/tunnelvault/`.

---

## Updates

**Manuell** (Server wie Gerät): neues Release herunterladen und prüfen (Schnellstart, Schritt 1),
dann im entpackten Verzeichnis:

```bash
sudo bash install-server.sh --upgrade      # Server
sudo bash install-client.sh --upgrade      # Gerät (läuft der Dienst, startet die neue Version nach ~30 s)
```

**Automatisch** (`--auto-update`): Ein systemd-Timer (`tunnelvault-autoupdate` bzw.
`tunnelvault-client-autoupdate`) prüft standardmäßig alle 12 h das neueste GitHub-Release. Er
installiert es nur, wenn Signatur und Prüfsumme zum hinterlegten Schlüssel
(`/etc/tunnelvault/release-signing.pub`) passen, und nie als Downgrade. Einstellungen stehen in
`/etc/tunnelvault/update.conf` (`ENABLED`, `SCHEDULE`, `PINNED_VERSION`, `UPDATE_REPO`). Prüfen, was
ein Lauf tun würde: `sudo /opt/tunnelvault/auto-update.sh --dry-run` (Gerät:
`sudo /opt/tunnelvault-client/auto-update-client.sh --dry-run`); ohne `--dry-run` wird sofort
aktualisiert.

### Upgrade von 1.x

1.x-Installationen haben einen Auto-Updater, der ungeprüft `git pull` als root ausführt. Vor dem
Upgrade abschalten:

```bash
sudo systemctl disable --now tunnelvault-autoupdate.timer          # Server
sudo systemctl disable --now tunnelvault-client-autoupdate.timer   # Geräte
```

Datenbank und `.env` sichern ([DEPLOYMENT.md](DEPLOYMENT.md#backups-and-restore)). Dann zuerst den
Server aus einem geprüften 2.0-Release mit `sudo bash install-server.sh --upgrade` aktualisieren
(optional gleich `--tls --domain …`), danach jedes Gerät mit
`sudo bash install-client.sh --upgrade`. Datenbank, Tokens, Tunnel und öffentliche Ports bleiben
erhalten. 1.x-Geräte funktionieren mit einem 2.0-Server weiter, bis sie aktualisiert sind. Der
Token wird dabei aus Dienstdatei und `config.json` nach `client.env` verschoben, und der alte
Updater wird entfernt. Remote-Reboot ist danach aus (wieder einschalten mit `--allow-reboot`).

**Wichtig beim Wechsel auf TLS:** Mit `--tls` ist Port 4000 von außen nicht mehr erreichbar. Geräte,
die noch mit `ws://SERVER:4000` verbunden sind, verlieren dann die Verbindung. Die Reihenfolge, mit
der auch nur über den Tunnel erreichbare Geräte erreichbar bleiben, steht in
[DEPLOYMENT.md](DEPLOYMENT.md#moving-devices-from-ws-to-wss).

---

## Troubleshooting

**Dashboard nicht erreichbar / Dienst startet nicht**
`sudo systemctl status tunnelvault` und `journalctl -u tunnelvault -n 50`. Exit-Code 78 bedeutet
einen Konfigurationsfehler (z. B. fehlender `AUTH_TOKEN` oder nicht lesbares Zertifikat); die
Log-Zeile nennt die Ursache.

**`--tls` schlägt fehl**
Die Domain muss per DNS auf den Server zeigen, und Port 80 muss von außen erreichbar sein. Dann
erneut ausführen: `sudo bash install-server.sh --upgrade --tls --domain tunnel.example.com`.

**Gerät verbindet sich nicht**
Auf dem Gerät `journalctl -u tunnelvault-client -f`.
„token revoked or invalid“: Der Token ist deaktiviert, gelöscht oder falsch. Ändern mit
`sudo bash install-client.sh --upgrade --token NEUER_TOKEN`.
`ECONNREFUSED` oder Timeout: URL prüfen (`wss://` mit TLS, sonst `ws://HOST:4000`) und die
ausgehende Firewall prüfen.

**Tunnel aktiv, aber SSH schlägt fehl**
Die TCP-Ports (10000–10999) müssen in Firewall und Security Group eingehend offen sein. Der lokale
Dienst muss auf dem Gerät laufen (`ss -tln` auf dem Gerät).

**Öffentlicher Port hat sich geändert**
Ein Gerät behält seinen Port, solange es denselben Token und denselben lokalen Port verwendet und der
öffentliche Port frei ist. Das gilt auch nach einer Neuinstallation. Der Port ändert sich, wenn ein
neuer Token verwendet wird, wenn der Tunnel länger als `TUNNEL_IDLE_RETENTION_DAYS` (30 Tage) offline
war und entfernt wurde, oder wenn der Port inzwischen belegt ist.

**Web-Terminal meldet „host key mismatch“**
Der SSH-Host-Key des Geräts hat sich geändert. Den Grund klären (Neuinstallation? anderes Gerät?)
und erst dann unter **Tunnels** den gespeicherten Schlüssel vergessen.

**Dashboard zeigt nach einem Update die alte Oberfläche**
Browser-Cache leeren bzw. Hard-Refresh (`Strg+Shift+R`).

Weitere Fälle (Englisch): [DEPLOYMENT.md, Troubleshooting](DEPLOYMENT.md#troubleshooting).

---

## Entwicklung

```bash
npm run install:all   # npm ci in backend/, client/ und frontend/
npm test              # Backend-, Client-, Dashboard- und Release-Tooling-Tests
npm run lint          # ESLint (Dashboard)
npm run dev           # Backend + Vite-Dev-Server (vorher einmal `npm install` im Hauptverzeichnis)
```

Node.js ≥ 20 (CI nutzt Node 22). Die CI (`.github/workflows/ci.yml`) führt zusätzlich `shellcheck`
für alle Shell-Skripte und `npm audit` aus.

---

## Lizenz

MIT, siehe [LICENSE](LICENSE).

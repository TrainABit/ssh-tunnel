# TunnelVault

> Self-hosted SSH & TCP tunneling over WebSocket — like ngrok, but private.

---

## Schnellstart

**1. Server deployen** (auf einem Linux-Server, z.B. EC2):
```bash
git clone https://github.com/TrainABit/ssh-tunnel.git ~/tunnelvault
cd ~/tunnelvault
sudo bash install-server.sh
```
Den Auth-Token am Ende der Ausgabe notieren.

**2. Client-Token erstellen:**

Dashboard öffnen: `http://SERVER-IP:4000` → Tokens → New Token (z.B. "Gerät A")

**3. Client installieren** (auf dem Zielgerät):
```bash
git clone https://github.com/TrainABit/ssh-tunnel.git ~/tunnelvault
cd ~/tunnelvault
sudo bash install-client.sh --server ws://SERVER-IP:4000 --token CLIENT_TOKEN
```

Optional: mehrere Ports gleichzeitig tunneln (z.B. SSH + Web-Dashboard):
```bash
sudo bash install-client.sh --server ws://SERVER-IP:4000 --token CLIENT_TOKEN \
  --extra-port 8080:tcp:dashboard
```

**4. Von überall verbinden:**

Das Dashboard zeigt den zugewiesenen Port unter Tunnels:
```bash
ssh user@SERVER-IP -p PORT_AUS_DASHBOARD
```

> Firewall/Security Group muss eingehend TCP auf den Ports **22**, **4000**, **4001** und **10000–10999** freigeben.

---

## Architektur

```
Beliebiges Gerät      EC2 Instanz
──────────┐    ┌──────────────────────────────┐
          │    │  Dashboard + API  (Port 4000) │
ssh -p N  ├───▶│  TCP Proxy        (Port N)    │
          │    │  HTTP Proxy       (Port 4001) │
──────────┘    └────────────┬─────────────────┘
                            │ WebSocket (persistent)
                   ┌────────▼───────────┐
                   │  TunnelVault       │
                   │  Client (Gerät)    │
                   │  läuft als systemd │
                   └────────┬───────────┘
                            │
                   ┌────────▼───────────┐
                   │  localhost:22      │
                   │  (SSH / belieb.)   │
                   └────────────────────┘
```

Der Client baut eine persistente WebSocket-Verbindung zum Server auf. Der Server weist einen Port zu (10000–10999) und piped eingehende TCP-Verbindungen durch den WebSocket zum Client.

---

## Features

- **TCP Tunneling** — beliebige TCP-Ports (SSH, Web-Dashboards, Datenbanken) durch WebSocket tunneln
- **Multi-Port** — mehrere Ports pro Gerät über eine einzige Verbindung (`--extra-port`)
- **Gruppierte Tunnel-Karten** — alle Tunnel eines Geräts erscheinen zusammen im Dashboard
- **Web-SSH Terminal** — direkt aus dem Dashboard per Browser ins Gerät einloggen
- **Named Client Tokens** — jedes Gerät bekommt ein eigenes Token; erscheint im Dashboard mit Gerätename
- **Feste TCP-Ports** — Port bleibt über Reconnects und Neustarts hinweg gleich
- **Systemd Service** — startet automatisch beim Boot, reconnectet bei Verbindungsabbruch
- **Auto-Updater** — Server prüft alle 12h auf neue Commits und deployed automatisch
- **Web Dashboard** — Echtzeit-Monitoring von Tunneln, Tokens, Sessions und Verbindungen
- **Webhook-Benachrichtigungen** — ntfy, Slack, Discord oder generisches JSON bei Connect/Disconnect
- **Sicherheit** — Token-Auth, Rate Limiting, Security Headers, Input Validation

---

## Server-Deployment

```bash
git clone https://github.com/TrainABit/ssh-tunnel.git ~/tunnelvault
cd ~/tunnelvault
sudo bash install-server.sh --domain tunnel.example.com
```

Läuft auf jedem Linux-Server (Ubuntu 22.04 empfohlen) — lokal, EC2, VPS, etc.

### install-server.sh Optionen

| Flag | Beschreibung | Standard |
|------|-------------|---------|
| `--domain DOMAIN` | Server-Domain | `tunnel.local` |
| `--auth-token TOKEN` | API Auth-Token | Auto-generiert |
| `--port PORT` | API Server Port | `4000` |
| `--proxy-port PORT` | Proxy Port | `4001` |
| `--upgrade` | Upgrade (DB + Config behalten, Frontend neu bauen) | — |
| `--tls` | Nginx + Let's Encrypt automatisch einrichten | — |

### Server-Anforderungen

| | Minimum | Empfohlen |
|---|---------|-----------|
| CPU / RAM | 1 vCPU, 1 GB | 2 vCPU, 2 GB |
| OS | Ubuntu 22.04 LTS | Ubuntu 22.04 LTS |
| Storage | 8 GB | 20 GB |

### Firewall-Regeln

| Port | Protokoll | Zweck |
|------|-----------|-------|
| 22 | TCP | Admin SSH auf den Server |
| 4000 | TCP | API + Dashboard + WebSocket |
| 4001 | TCP | HTTP Proxy |
| 10000–10999 | TCP | TCP Tunnel Ports |
| 80/443 | TCP | Optional: Nginx + TLS |

---

## Client-Installation

Client-Token im Dashboard anlegen (Tokens → New Token), dann auf dem Gerät:

```bash
git clone https://github.com/TrainABit/ssh-tunnel.git ~/tunnelvault
cd ~/tunnelvault
sudo bash install-client.sh --server ws://SERVER-IP:4000 --token DEIN_TOKEN
```

### install-client.sh Optionen

| Flag | Beschreibung | Standard |
|------|-------------|---------|
| `--server URL` | WebSocket URL des Servers | erforderlich |
| `--token TOKEN` | Client-Token aus dem Dashboard | erforderlich |
| `--port PORT` | Lokaler Port (primär) | `22` |
| `--protocol PROTO` | `tcp` oder `http` | `tcp` |
| `--extra-port PORT:PROTO:NAME` | Zusätzlichen Port hinzufügen (wiederholbar) | — |
| `--upgrade` | Client aktualisieren, Config + Service neu schreiben | — |

> **Upgrade über aktiven Tunnel:** Das Script kopiert alle Dateien zuerst ohne den Service zu stoppen, dann plant es einen Neustart in 30 Sekunden. Die SSH-Session trennt kurz und reconnectet automatisch.

---

## Web Dashboard

| Seite | Beschreibung |
|-------|-------------|
| Dashboard | Übersicht, Verbindungshistorie, Live-Sessions |
| Tunnels | Aktive Tunnel — mehrere Ports pro Gerät in einer Karte zusammengefasst |
| Tokens | Tokens erstellen, aktivieren/deaktivieren, löschen |
| Sessions | TCP Session-History mit Client-IP, Port, Dauer |
| Connections | Aktive Verbindungen mit übertragenen Bytes |
| Settings | Server-Konfiguration |

---

## Konfiguration

Alle Einstellungen via Environment Variables in `backend/.env`:

| Variable | Standard | Beschreibung |
|----------|---------|-------------|
| `PORT` | `4000` | API + WebSocket + Dashboard Port |
| `PROXY_PORT` | `4001` | HTTP Proxy Port |
| `DOMAIN` | `tunnel.local` | Domain für HTTP Tunnel URLs |
| `AUTH_TOKEN` | — | Admin Auth-Token |
| `TCP_PORT_MIN` | `10000` | Anfang des TCP Port-Bereichs |
| `TCP_PORT_MAX` | `10999` | Ende des TCP Port-Bereichs |
| `WEBHOOK_URL` | — | URL für Tunnel-Events (ntfy, Slack, Discord, JSON) |
| `WEBHOOK_TYPE` | `json` | Webhook-Format |

Token generieren:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## Troubleshooting

**Client verbindet nicht (ECONNREFUSED)**
Firewall prüfen — Port 4000 muss eingehend freigegeben sein. Manche Unternehmensnetzwerke blockieren ausgehend Port 4000 → Gerät in einem anderen Netzwerk testen.

**Tunnel aktiv, SSH schlägt fehl**
`journalctl -u tunnelvault-client -f` auf dem Gerät prüfen. EC2 Security Group muss TCP 10000–10999 freigeben.

**Dashboard zeigt veraltete UI nach Update**
`sudo bash install-server.sh --upgrade` ausführen, dann Browser hard-refresh (`Strg+Shift+R`).

**Port nach Upgrade noch hardcoded im Service**
`sudo bash install-client.sh --upgrade --extra-port 8080:tcp:dashboard` — das überschreibt Config und Service-Datei.

---

## Lizenz

MIT

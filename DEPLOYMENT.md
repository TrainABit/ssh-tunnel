# TunnelVault -- AWS EC2 Deployment Guide

> Self-hosted SSH tunneling service. This document covers deploying TunnelVault
> on an AWS EC2 instance, configuring it for production, and troubleshooting
> common issues.

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [EC2 Instance Setup](#2-ec2-instance-setup-step-by-step)
3. [Configuration](#3-configuration)
4. [Post-Deployment Verification](#4-post-deployment-verification)
5. [Client Setup](#5-client-setup)
6. [Operations](#6-operations)
7. [Troubleshooting](#7-troubleshooting)
8. [Security Hardening Checklist](#8-security-hardening-checklist)

---

## 1. Prerequisites

### AWS Account and EC2 Requirements

| Requirement        | Minimum                 | Recommended              |
|--------------------|-------------------------|--------------------------|
| Instance type      | t3.micro (1 vCPU, 1 GB) | t3.small (2 vCPU, 2 GB) |
| AMI                | Ubuntu 22.04 LTS        | Ubuntu 22.04 LTS         |
| Storage            | 8 GB gp3                | 20 GB gp3                |
| Architecture       | x86_64 (amd64)          | x86_64 (amd64)           |

> ARM-based instances (t4g family with Ubuntu 22.04 arm64) also work and are
> more cost-effective. The setup is identical.

### Security Group Rules

Create a Security Group named `tunnelvault-sg` with the following inbound rules:

| Type          | Protocol | Port Range | Source        | Purpose                          |
|---------------|----------|------------|---------------|----------------------------------|
| SSH           | TCP      | 22         | Your IP/32    | Admin SSH access to the EC2 host |
| SSH           | TCP      | 22         | 0.0.0.0/0    | Gateway SSH tunnels from clients |
| Custom TCP    | TCP      | 4000       | 0.0.0.0/0    | API + Dashboard + WebSocket      |
| Custom TCP    | TCP      | 4001       | 0.0.0.0/0    | Proxy server (tunnel traffic)    |
| HTTP          | TCP      | 80         | 0.0.0.0/0    | (Optional) Nginx / Let's Encrypt |
| HTTPS         | TCP      | 443        | 0.0.0.0/0    | (Optional) Nginx with TLS        |

Outbound rules: Allow all traffic (default).

> **Security note:** After initial setup, consider restricting port 22 admin
> access to your IP only, while keeping port 22 open for gateway clients via a
> separate rule (or use a second Security Group). In practice the gateway SSH
> users (`gw-*`) are locked down by `ForceCommand` and cannot get a shell.

### Domain Setup (Optional but Recommended)

For wildcard subdomain routing (e.g., `myapp.tunnel.example.com`):

1. Register or use an existing domain.
2. Create DNS records:

```
A     tunnel.example.com        -> <EC2-PUBLIC-IP>
A     *.tunnel.example.com      -> <EC2-PUBLIC-IP>
```

If you do not have a domain, you can access the service by IP address directly.

### SSH Key Pair

Create an EC2 key pair in the AWS Console (or import your own):

```bash
# If generating locally:
ssh-keygen -t ed25519 -f ~/.ssh/tunnelvault-ec2 -C "tunnelvault-ec2"
```

Import the public key to AWS via the EC2 Console under **Key Pairs > Import Key Pair**.

---

## 2. EC2 Instance Setup (Step by Step)

### 2.1 Launch the EC2 Instance

1. Open the **EC2 Console** and click **Launch Instance**.
2. Set the name to `tunnelvault-gateway`.
3. Select **Ubuntu Server 22.04 LTS** AMI (64-bit x86).
4. Choose instance type: **t3.micro** (free tier eligible) or larger.
5. Select your key pair (e.g., `tunnelvault-ec2`).
6. Under **Network settings**, select the `tunnelvault-sg` Security Group.
7. Set storage to **20 GB gp3**.
8. Click **Launch Instance**.
9. Note the **Public IPv4 address** once the instance is running.

### 2.2 SSH Into the Instance

```bash
ssh -i ~/.ssh/tunnelvault-ec2 ubuntu@<EC2-PUBLIC-IP>
```

### 2.3 System Update

```bash
sudo apt update && sudo apt upgrade -y
sudo reboot
```

Wait 30 seconds and reconnect:

```bash
ssh -i ~/.ssh/tunnelvault-ec2 ubuntu@<EC2-PUBLIC-IP>
```

### 2.4 Install Git

```bash
sudo apt install -y git
```

### 2.5 Clone the Project

```bash
cd /home/ubuntu
git clone <YOUR-REPO-URL> tunnelvault
cd tunnelvault
```

Alternatively, upload the project via `scp`:

```bash
# Run from your local machine:
scp -i ~/.ssh/tunnelvault-ec2 -r /path/to/tunnelvault ubuntu@<EC2-PUBLIC-IP>:/home/ubuntu/tunnelvault
```

### 2.6 Build the Frontend

The setup script copies the built frontend to `/opt/tunnelvault`. Build it
before running setup:

```bash
cd /home/ubuntu/tunnelvault
```

Node.js may not be installed yet. The setup script installs Node.js 20.x, so
you can either run setup first (the frontend will be skipped with a warning) and
build later, or install Node.js manually first:

```bash
# Quick Node.js install for the build step:
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Install dependencies and build:
cd /home/ubuntu/tunnelvault/frontend
npm install
npm run build
cd /home/ubuntu/tunnelvault
```

### 2.7 Run the Gateway Setup Script

```bash
cd /home/ubuntu/tunnelvault/gateway
sudo bash setup.sh
```

Expected output:

```
==> Installing system dependencies...
==> Installing Node.js 20.x via NodeSource...   (or "already installed")
==> Creating gateway directory: /opt/tunnelvault
==> Copying gateway scripts...
==> Setting up TunnelVault backend...
==> Copying built frontend...
==> Initialising SQLite database...
==> Configuring sshd...
==> sshd restarted.
==> Creating systemd service for TunnelVault API...

+======================================================+
|        TunnelVault Gateway Setup Complete!            |
+======================================================+
|  Gateway IP:    <YOUR-EC2-IP>
|  SSH Port:      22
|  API/Dashboard: http://<YOUR-EC2-IP>:4000
|  Proxy Port:    4001
|  Logs:          tail -f /var/log/tunnelvault-gateway.log
|                 journalctl -u tunnelvault-api -f
|  DB:            /opt/tunnelvault/tokens.db
+------------------------------------------------------+
```

### 2.8 Verify Services Are Running

```bash
# Check the systemd service
sudo systemctl status tunnelvault-api

# Expected: Active: active (running)

# Check ports are listening
sudo ss -tlnp | grep -E '4000|4001'

# Expected:
# LISTEN  0  511  *:4000  *:*  users:(("node",pid=...,fd=...))
# LISTEN  0  511  *:4001  *:*  users:(("node",pid=...,fd=...))

# Quick API test
curl http://localhost:4000/api/health

# Expected: {"status":"ok","uptime":<milliseconds>}
```

---

## 3. Configuration

### 3.1 Environment Variables

The systemd service sets environment variables directly in the unit file at
`/etc/systemd/system/tunnelvault-api.service`. Here is every variable:

| Variable       | Default                      | Description                                                  |
|----------------|------------------------------|--------------------------------------------------------------|
| `PORT`         | `4000`                       | API + Dashboard + WebSocket server port                      |
| `PROXY_PORT`   | `4001`                       | Proxy server port (handles tunneled HTTP traffic)            |
| `DOMAIN`       | `tunnel.local`               | Base domain for subdomain routing (e.g., `tunnel.example.com`) |
| `AUTH_TOKEN`   | `tvault-dev-token-2024`      | API authentication token -- **CHANGE THIS IN PRODUCTION**    |
| `DB_PATH`      | `/opt/tunnelvault/tokens.db` | Path to the SQLite database                                  |
| `GATEWAY_DIR`  | `/opt/tunnelvault`           | Base directory for gateway files                             |
| `NODE_ENV`     | `production`                 | Node.js environment                                          |

To change any variable, edit the service file:

```bash
sudo systemctl edit tunnelvault-api
```

This opens an override file. Add your overrides:

```ini
[Service]
Environment=DOMAIN=tunnel.example.com
Environment=AUTH_TOKEN=your-secure-random-token-here
```

Then reload and restart:

```bash
sudo systemctl daemon-reload
sudo systemctl restart tunnelvault-api
```

Alternatively, edit the unit file directly:

```bash
sudo nano /etc/systemd/system/tunnelvault-api.service
sudo systemctl daemon-reload
sudo systemctl restart tunnelvault-api
```

### 3.2 Domain and DNS Configuration

If you own `example.com` and want to use `tunnel.example.com`:

1. Set DNS records (Route 53, Cloudflare, etc.):

```
A     tunnel.example.com        -> <EC2-PUBLIC-IP>     TTL 300
A     *.tunnel.example.com      -> <EC2-PUBLIC-IP>     TTL 300
```

2. Update the `DOMAIN` environment variable:

```bash
sudo systemctl edit tunnelvault-api
```

```ini
[Service]
Environment=DOMAIN=tunnel.example.com
```

```bash
sudo systemctl daemon-reload
sudo systemctl restart tunnelvault-api
```

### 3.3 TLS/SSL with Let's Encrypt

Install Certbot and Nginx:

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
```

Obtain a wildcard certificate (requires DNS-01 challenge):

```bash
# For a single domain (HTTP-01 challenge, simpler):
sudo certbot --nginx -d tunnel.example.com

# For wildcard (DNS-01 challenge, requires DNS provider plugin):
sudo certbot certonly --manual --preferred-challenges dns \
  -d tunnel.example.com \
  -d "*.tunnel.example.com"
```

For automated wildcard renewal with Route 53:

```bash
sudo apt install -y python3-certbot-dns-route53
sudo certbot certonly --dns-route53 \
  -d tunnel.example.com \
  -d "*.tunnel.example.com"
```

Verify auto-renewal works:

```bash
sudo certbot renew --dry-run
```

### 3.4 Nginx Reverse Proxy Configuration

Create the Nginx config:

```bash
sudo nano /etc/nginx/sites-available/tunnelvault
```

Paste the following (replace `tunnel.example.com` with your domain):

```nginx
# Upstream definitions
upstream tunnelvault_api {
    server 127.0.0.1:4000;
}

upstream tunnelvault_proxy {
    server 127.0.0.1:4001;
}

# Redirect HTTP to HTTPS
server {
    listen 80;
    server_name tunnel.example.com *.tunnel.example.com;
    return 301 https://$host$request_uri;
}

# Main server — API, Dashboard, WebSocket
server {
    listen 443 ssl;
    server_name tunnel.example.com;

    ssl_certificate     /etc/letsencrypt/live/tunnel.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/tunnel.example.com/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;

    client_max_body_size 10m;

    # API and Dashboard
    location / {
        proxy_pass http://tunnelvault_api;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # WebSocket endpoint
    location /ws {
        proxy_pass http://tunnelvault_api;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}

# Wildcard subdomains — Proxy tunnel traffic
server {
    listen 443 ssl;
    server_name *.tunnel.example.com;

    ssl_certificate     /etc/letsencrypt/live/tunnel.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/tunnel.example.com/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;

    client_max_body_size 10m;

    location / {
        proxy_pass http://tunnelvault_proxy;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Enable the site and restart Nginx:

```bash
sudo ln -sf /etc/nginx/sites-available/tunnelvault /etc/nginx/sites-enabled/tunnelvault
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl restart nginx
```

Expected output from `nginx -t`:

```
nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
nginx: configuration file /etc/nginx/nginx.conf test is successful
```

### 3.5 Firewall (UFW) Rules

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp      comment 'SSH (admin + gateway tunnels)'
sudo ufw allow 80/tcp      comment 'HTTP (Let'\''s Encrypt + redirect)'
sudo ufw allow 443/tcp     comment 'HTTPS (Nginx reverse proxy)'
sudo ufw enable
sudo ufw status verbose
```

Expected output:

```
Status: active
Logging: on (low)
Default: deny (incoming), allow (outgoing), disabled (routed)

To                         Action      From
--                         ------      ----
22/tcp                     ALLOW IN    Anywhere       # SSH
80/tcp                     ALLOW IN    Anywhere       # HTTP
443/tcp                    ALLOW IN    Anywhere       # HTTPS
```

> **Without Nginx:** If you are not using a reverse proxy, open ports 4000 and
> 4001 directly instead of 80/443:
>
> ```bash
> sudo ufw allow 4000/tcp comment 'TunnelVault API'
> sudo ufw allow 4001/tcp comment 'TunnelVault Proxy'
> ```

---

## 4. Post-Deployment Verification

Run these checks in order. Replace `<SERVER>` with your EC2 public IP or domain.

### 4.1 API Health Check

```bash
curl -s http://<SERVER>:4000/api/health | python3 -m json.tool
```

Expected:

```json
{
    "status": "ok",
    "uptime": 12345
}
```

### 4.2 List API Endpoints

```bash
# Tunnels (should return empty array initially)
curl -s http://<SERVER>:4000/api/tunnels | python3 -m json.tool

# Tokens
curl -s http://<SERVER>:4000/api/tokens | python3 -m json.tool

# Sessions
curl -s http://<SERVER>:4000/api/sessions | python3 -m json.tool

# Stats
curl -s http://<SERVER>:4000/api/stats | python3 -m json.tool
```

### 4.3 Dashboard (Frontend)

Open a browser and navigate to:

```
http://<SERVER>:4000
```

You should see the TunnelVault dashboard. If the frontend was not built before
setup, you will see a JSON response listing available API endpoints instead.

### 4.4 WebSocket Connection Test

```bash
# Install wscat if needed
sudo npm install -g wscat

# Test WebSocket connection
wscat -c ws://<SERVER>:4000/ws
```

Once connected, send a registration message:

```json
{"type":"register","name":"test-tunnel","localPort":3000}
```

Expected response:

```json
{"type":"registered","tunnelId":"<uuid>","publicUrl":"..."}
```

Press `Ctrl+C` to disconnect.

### 4.5 Token Creation Test

```bash
# Create a token via the API
curl -s -X POST http://<SERVER>:4000/api/tokens \
  -H "Content-Type: application/json" \
  -d '{
    "label": "Test Server",
    "target_ip": "10.0.1.42",
    "target_port": 22,
    "public_key": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI... user@host"
  }' | python3 -m json.tool
```

Expected:

```json
{
    "token": "<generated-20-char-token>",
    "linux_user": "gw-<token>"
}
```

Or create a token via the CLI script on the server:

```bash
sudo /opt/tunnelvault/register_token.sh \
  --token mytoken123 \
  --ip 10.0.1.42 \
  --port 22 \
  --label "Dev Server" \
  --pubkey "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI... user@host"
```

### 4.6 SSH Tunnel End-to-End Test

From a client machine, test the SSH tunnel (the target machine at `10.0.1.42`
must be reachable from the EC2 instance):

```bash
ssh -o StrictHostKeyChecking=no gw-mytoken123@<EC2-PUBLIC-IP>
```

If the token, target IP, and SSH keys are configured correctly, you will be
connected through the gateway to the target machine.

### 4.7 Verification Checklist

- [ ] `curl /api/health` returns `{"status":"ok",...}`
- [ ] `curl /api/tokens` returns `{"tokens":[...]}`
- [ ] `curl /api/stats` returns server statistics
- [ ] WebSocket connects on `ws://<SERVER>:4000/ws`
- [ ] Dashboard loads at `http://<SERVER>:4000`
- [ ] Token creation works (API or CLI)
- [ ] SSH tunnel connects through the gateway
- [ ] Proxy port 4001 responds to requests

---

## 5. Client Setup

### 5.1 SSH Config for Gateway Connections

On the client machine, add entries to `~/.ssh/config`:

```
# TunnelVault Gateway — Dev Server
Host dev-server
    HostName <EC2-PUBLIC-IP>
    User gw-mytoken123
    IdentityFile ~/.ssh/id_ed25519
    StrictHostKeyChecking no
    UserKnownHostsFile /dev/null

# TunnelVault Gateway — Staging Server
Host staging
    HostName <EC2-PUBLIC-IP>
    User gw-stagingtoken456
    IdentityFile ~/.ssh/id_ed25519
    StrictHostKeyChecking no
    UserKnownHostsFile /dev/null
```

Then connect with:

```bash
ssh dev-server
ssh staging
```

The gateway intercepts the connection, looks up the token (`mytoken123`) in the
database, and forwards the SSH session to the registered target IP via `netcat`.

### 5.2 TunnelVault CLI Client

The CLI client creates HTTP tunnels over WebSocket. Install and use it from the
`client/` directory:

```bash
cd /path/to/tunnelvault/client
npm install
```

**Expose a local port:**

```bash
# Expose local port 3000 through the tunnel server
node bin/tunnelvault.js connect 3000 --server ws://<EC2-PUBLIC-IP>:4000

# With a custom name and subdomain
node bin/tunnelvault.js connect 8080 \
  --name "my-app" \
  --subdomain myapp \
  --server ws://<EC2-PUBLIC-IP>:4000
```

If using TLS with Nginx:

```bash
node bin/tunnelvault.js connect 3000 --server wss://tunnel.example.com
```

**List active tunnels:**

```bash
node bin/tunnelvault.js list --server http://<EC2-PUBLIC-IP>:4000
```

**Check server status:**

```bash
node bin/tunnelvault.js status --server http://<EC2-PUBLIC-IP>:4000
```

### 5.3 Multiple Targets Setup

Register multiple tokens on the gateway, each pointing to a different internal
machine:

```bash
# Server A — Development
sudo /opt/tunnelvault/register_token.sh \
  --token devbox \
  --ip 10.0.1.10 \
  --port 22 \
  --label "Dev Box" \
  --pubkey "$(cat /path/to/user_pubkey.pub)"

# Server B — Database
sudo /opt/tunnelvault/register_token.sh \
  --token dbserver \
  --ip 10.0.2.20 \
  --port 22 \
  --label "Database Server" \
  --pubkey "$(cat /path/to/user_pubkey.pub)"

# Server C — Custom SSH port
sudo /opt/tunnelvault/register_token.sh \
  --token appserver \
  --ip 10.0.3.30 \
  --port 2222 \
  --label "App Server (port 2222)" \
  --pubkey "$(cat /path/to/user_pubkey.pub)"
```

List all registered tokens:

```bash
sudo /opt/tunnelvault/register_token.sh --list
```

Expected output:

```
TOKEN                    LABEL                IP              PORT  ACTIVE LAST SEEN
------------------------------------------------------------------------------------
devbox                   Dev Box              10.0.1.10       22    yes    2026-03-12 10:30:00
dbserver                 Database Server      10.0.2.20       22    yes    never
appserver                App Server (port 2222) 10.0.3.30     2222  yes    never
```

---

## 6. Operations

### 6.1 Viewing Logs

```bash
# TunnelVault API logs (systemd journal)
sudo journalctl -u tunnelvault-api -f

# Last 100 lines
sudo journalctl -u tunnelvault-api -n 100 --no-pager

# Logs since a specific time
sudo journalctl -u tunnelvault-api --since "2026-03-12 08:00:00"

# Gateway SSH router logs
sudo tail -f /var/log/tunnelvault-gateway.log

# Nginx access logs (if using reverse proxy)
sudo tail -f /var/log/nginx/access.log

# Nginx error logs
sudo tail -f /var/log/nginx/error.log
```

### 6.2 Restarting Services

```bash
# Restart the TunnelVault API
sudo systemctl restart tunnelvault-api

# Restart Nginx (if using reverse proxy)
sudo systemctl restart nginx

# Restart SSH daemon (caution: will briefly drop SSH connections)
sudo systemctl restart sshd

# Reload systemd after editing unit files
sudo systemctl daemon-reload
sudo systemctl restart tunnelvault-api
```

### 6.3 Backup the Database

The SQLite database at `/opt/tunnelvault/tokens.db` contains all tokens and
session history. Back it up regularly:

```bash
# One-time backup
sudo sqlite3 /opt/tunnelvault/tokens.db ".backup /opt/tunnelvault/backups/tokens-$(date +%Y%m%d-%H%M%S).db"

# Create a backup directory
sudo mkdir -p /opt/tunnelvault/backups

# Automated daily backup via cron
sudo crontab -e
```

Add this line:

```
0 2 * * * sqlite3 /opt/tunnelvault/tokens.db ".backup /opt/tunnelvault/backups/tokens-$(date +\%Y\%m\%d).db" && find /opt/tunnelvault/backups -name "tokens-*.db" -mtime +30 -delete
```

This creates a backup at 2:00 AM daily and deletes backups older than 30 days.

To restore from a backup:

```bash
sudo systemctl stop tunnelvault-api
sudo cp /opt/tunnelvault/backups/tokens-20260312.db /opt/tunnelvault/tokens.db
sudo systemctl start tunnelvault-api
```

### 6.4 Updating the Software

```bash
# On the EC2 instance
cd /home/ubuntu/tunnelvault
git pull origin main

# Rebuild frontend
cd frontend
npm install
npm run build

# Re-run setup to copy updated files
cd ../gateway
sudo bash setup.sh

# The setup script restarts the service automatically.
# Verify:
sudo systemctl status tunnelvault-api
curl -s http://localhost:4000/api/health
```

### 6.5 Monitoring the Health Endpoint

Set up a simple uptime check with cron:

```bash
sudo nano /opt/tunnelvault/health-check.sh
```

```bash
#!/bin/bash
RESPONSE=$(curl -s --max-time 5 http://localhost:4000/api/health)
if echo "$RESPONSE" | grep -q '"status":"ok"'; then
    exit 0
else
    echo "[$(date)] TunnelVault health check FAILED: $RESPONSE" >> /var/log/tunnelvault-health.log
    systemctl restart tunnelvault-api
fi
```

```bash
sudo chmod +x /opt/tunnelvault/health-check.sh
sudo crontab -e
```

Add:

```
*/5 * * * * /opt/tunnelvault/health-check.sh
```

---

## 7. Troubleshooting

### Problem 1: "Connection refused" on port 4000

**Symptoms:** `curl http://localhost:4000/api/health` returns "Connection refused".

**Causes and solutions:**

```bash
# Check if the service is running
sudo systemctl status tunnelvault-api

# If it shows "inactive" or "failed":
sudo journalctl -u tunnelvault-api -n 50 --no-pager

# Common causes:
# - Node.js not installed or wrong version
node -v   # should show v20.x

# - npm dependencies not installed
cd /opt/tunnelvault/backend && sudo npm install --omit=dev

# - Port already in use
sudo ss -tlnp | grep 4000
# Kill the conflicting process if needed:
sudo kill <PID>

# Restart the service
sudo systemctl restart tunnelvault-api
```

### Problem 2: WebSocket Connection Fails

**Symptoms:** CLI client shows "Failed to connect to server" or WebSocket
immediately closes.

**Solutions:**

```bash
# Verify WebSocket is listening
curl -i -N \
  -H "Connection: Upgrade" \
  -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  http://<SERVER>:4000/ws

# Should return HTTP 101 Switching Protocols

# If using Nginx, check the proxy config includes WebSocket headers:
grep -A5 "location /ws" /etc/nginx/sites-available/tunnelvault
# Must have: proxy_http_version 1.1; proxy_set_header Upgrade ...

# Check Security Group allows port 4000 (or 443 if behind Nginx)

# If using wss://, ensure the SSL certificate is valid:
openssl s_client -connect tunnel.example.com:443 -servername tunnel.example.com </dev/null 2>&1 | head -20
```

### Problem 3: SSH Tunnel Timeout

**Symptoms:** `ssh gw-mytoken@<SERVER>` hangs and eventually times out.

**Solutions:**

```bash
# Test basic SSH connectivity to the gateway
ssh -v gw-mytoken@<EC2-PUBLIC-IP>

# Check if sshd is running
sudo systemctl status sshd

# Verify the sshd config has the TunnelVault block
sudo grep -A8 "TUNNELVAULT-GATEWAY" /etc/ssh/sshd_config

# Verify the gateway user exists
id gw-mytoken

# Check if the target machine is reachable FROM the EC2 instance
nc -zv 10.0.1.42 22 -w 5
# If this fails, the target is unreachable. Check VPC routing, security
# groups on the target, and whether the target's SSH is running.

# Check the gateway log
sudo tail -20 /var/log/tunnelvault-gateway.log
```

### Problem 4: Token Not Working

**Symptoms:** SSH connection is denied with "Unknown token" or "Token disabled".

**Solutions:**

```bash
# Check if the token exists in the database
sudo sqlite3 /opt/tunnelvault/tokens.db "SELECT token, active, target_ip FROM tokens;"

# If the token is disabled (active=0), re-enable it:
sudo sqlite3 /opt/tunnelvault/tokens.db "UPDATE tokens SET active=1 WHERE token='mytoken';"

# If the token does not exist, register it:
sudo /opt/tunnelvault/register_token.sh \
  --token mytoken --ip 10.0.1.42 --label "My Server" \
  --pubkey "ssh-ed25519 AAAA..."

# Verify the Linux user was created:
id gw-mytoken
```

### Problem 5: "Permission denied" SSH Errors

**Symptoms:** `Permission denied (publickey)` when connecting via SSH.

**Solutions:**

```bash
# Verify the public key is in the authorized_keys file
sudo cat /home/gw-mytoken/.ssh/authorized_keys

# Compare it with the key stored in the database
sudo sqlite3 /opt/tunnelvault/tokens.db "SELECT public_key FROM tokens WHERE token='mytoken';"

# Check file permissions (must be exact)
sudo ls -la /home/gw-mytoken/.ssh/
# Expected:
# drwx------ ... .ssh
# -rw------- ... authorized_keys

# Fix permissions if needed
sudo chmod 700 /home/gw-mytoken/.ssh
sudo chmod 600 /home/gw-mytoken/.ssh/authorized_keys
sudo chown -R gw-mytoken:gw-mytoken /home/gw-mytoken/.ssh

# On the client side, verify you're using the correct key:
ssh -i ~/.ssh/id_ed25519 -v gw-mytoken@<SERVER>
# Look for "Offering public key" in the verbose output

# Check sshd auth log for detailed errors
sudo tail -30 /var/log/auth.log | grep gw-mytoken
```

### Problem 6: Database Locked Errors

**Symptoms:** API returns 500 errors with "SQLITE_BUSY" or "database is locked".

**Solutions:**

```bash
# The database uses WAL mode, which helps with concurrency.
# Check if another process is holding a lock:
sudo fuser /opt/tunnelvault/tokens.db

# Check for stale WAL/SHM files
ls -la /opt/tunnelvault/tokens.db*
# You should see: tokens.db, tokens.db-wal, tokens.db-shm

# If the database is corrupted, run an integrity check:
sudo sqlite3 /opt/tunnelvault/tokens.db "PRAGMA integrity_check;"
# Should output: ok

# Force a WAL checkpoint:
sudo sqlite3 /opt/tunnelvault/tokens.db "PRAGMA wal_checkpoint(TRUNCATE);"

# As a last resort, restore from backup (see Section 6.3)
```

### Problem 7: High Memory Usage

**Symptoms:** The EC2 instance becomes slow or unresponsive. Node process uses
excessive memory.

**Solutions:**

```bash
# Check memory usage
free -h
ps aux --sort=-%mem | head -10

# Check the Node.js process specifically
ps -o pid,rss,vsz,comm -p $(pgrep -f "server.js")

# If memory is over 80%, restart the service
sudo systemctl restart tunnelvault-api

# Add swap space if the instance is a t3.micro with only 1 GB RAM:
sudo fallocate -l 1G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile

# Make it permanent:
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# Set a memory limit in the systemd service:
sudo systemctl edit tunnelvault-api
```

```ini
[Service]
MemoryMax=512M
MemoryHigh=400M
```

```bash
sudo systemctl daemon-reload
sudo systemctl restart tunnelvault-api
```

### Problem 8: Service Not Starting After Reboot

**Symptoms:** After a reboot, `curl localhost:4000` fails.

**Solutions:**

```bash
# Check if the service is enabled for boot
sudo systemctl is-enabled tunnelvault-api
# Should output: enabled

# If not enabled:
sudo systemctl enable tunnelvault-api

# Check what failed during boot
sudo journalctl -u tunnelvault-api -b --no-pager

# Common cause: service started before network was ready
# The unit file includes "After=network.target" which should handle this.
# If the issue persists, add a delay:
sudo systemctl edit tunnelvault-api
```

```ini
[Service]
ExecStartPre=/bin/sleep 5
```

```bash
sudo systemctl daemon-reload
sudo reboot
# Wait and verify:
ssh ubuntu@<EC2-PUBLIC-IP>
sudo systemctl status tunnelvault-api
```

### Problem 9: Proxy Not Forwarding

**Symptoms:** Requests to `myapp.tunnel.example.com` return "Tunnel not found"
or 502 errors.

**Solutions:**

```bash
# Verify the tunnel is registered and active
curl -s http://localhost:4000/api/tunnels | python3 -m json.tool
# Look for a tunnel with the matching subdomain

# The proxy matches tunnels by subdomain from the Host header.
# Test directly against port 4001:
curl -s -H "Host: myapp.tunnel.example.com" http://localhost:4001/
# If this returns "Tunnel not found", the subdomain does not match any tunnel.

# Check the tunnel client is connected (status should be "active"):
curl -s http://localhost:4000/api/tunnels | python3 -m json.tool
# Look for: "status": "active"

# If using Nginx, ensure wildcard subdomain block forwards to port 4001
grep -B2 -A5 "tunnelvault_proxy" /etc/nginx/sites-available/tunnelvault

# Verify DNS resolves the subdomain:
dig myapp.tunnel.example.com +short
# Should return the EC2 public IP
```

### Problem 10: Let's Encrypt Certificate Renewal Fails

**Symptoms:** Certificate expires, HTTPS stops working.

**Solutions:**

```bash
# Check certificate expiry
sudo certbot certificates

# Test renewal
sudo certbot renew --dry-run

# If renewal fails due to port 80 conflict:
sudo systemctl stop nginx
sudo certbot renew
sudo systemctl start nginx

# For DNS-01 wildcard certs, ensure the DNS plugin credentials are valid:
sudo cat /root/.aws/credentials   # for Route 53
# or check the relevant provider config

# Force renewal:
sudo certbot renew --force-renewal

# Check the renewal timer:
sudo systemctl status certbot.timer
sudo systemctl list-timers | grep certbot

# If the timer is not active:
sudo systemctl enable --now certbot.timer
```

### Problem 11: DNS Not Resolving

**Symptoms:** `tunnel.example.com` does not resolve. Browser shows
"DNS_PROBE_FINISHED_NXDOMAIN".

**Solutions:**

```bash
# Check DNS from your local machine
dig tunnel.example.com
dig myapp.tunnel.example.com

# Verify the A record points to the correct IP
dig +short tunnel.example.com
# Should return the EC2 public IP

# Check if the EC2 public IP changed (e.g., after stop/start without Elastic IP)
curl -s http://169.254.169.254/latest/meta-data/public-ipv4
# Compare with your DNS records

# If the IP changed, either:
# 1. Update DNS records, OR
# 2. Allocate an Elastic IP and associate it with the instance:
#    AWS Console > EC2 > Elastic IPs > Allocate > Associate

# DNS propagation can take up to 48 hours. Check propagation:
# https://www.whatsmydns.net/#A/tunnel.example.com
```

### Problem 12: Session Not Tracked

**Symptoms:** SSH connections succeed but do not appear in the dashboard or
`/api/sessions`.

**Solutions:**

```bash
# Check if the ssh_router.sh script is running
# Look for recent entries in the gateway log:
sudo tail -20 /var/log/tunnelvault-gateway.log

# If you see "API_TRACK_SKIPPED", the API was unreachable when the SSH
# session started. Verify the API is running:
curl -s http://127.0.0.1:4000/api/health

# Check the sessions table directly:
sudo sqlite3 /opt/tunnelvault/tokens.db "SELECT * FROM sessions ORDER BY id DESC LIMIT 10;"

# Session tracking uses two mechanisms:
# 1. SQLite INSERT in ssh_router.sh (always works if DB is accessible)
# 2. API POST to /api/connections (requires API to be running)

# Verify ssh_router.sh has the correct API_URL:
grep API_URL /opt/tunnelvault/ssh_router.sh
# Should be: API_URL="http://127.0.0.1:4000"
```

### Problem 13: API Returns 500 Errors

**Symptoms:** API endpoints return `{"error":"..."}` with HTTP 500 status.

**Solutions:**

```bash
# Check the API logs for the stack trace
sudo journalctl -u tunnelvault-api -n 50 --no-pager

# Common causes:
# 1. Database file missing or corrupted
ls -la /opt/tunnelvault/tokens.db
sudo sqlite3 /opt/tunnelvault/tokens.db "PRAGMA integrity_check;"

# 2. Database schema mismatch (after an update)
# Re-run setup to reinitialise tables (CREATE TABLE IF NOT EXISTS is safe):
cd /home/ubuntu/tunnelvault/gateway
sudo bash setup.sh

# 3. Missing npm dependencies
cd /opt/tunnelvault/backend
sudo npm install --omit=dev

# 4. Native module (better-sqlite3) needs rebuild after Node.js upgrade
cd /opt/tunnelvault/backend
sudo npm rebuild better-sqlite3

# Restart after fixing:
sudo systemctl restart tunnelvault-api
```

### Problem 14: Frontend Shows Blank Page

**Symptoms:** Browser loads `http://<SERVER>:4000` but shows a blank white page.

**Solutions:**

```bash
# Check if the frontend was built and copied
ls -la /opt/tunnelvault/frontend/dist/
ls -la /opt/tunnelvault/frontend/dist/index.html

# If the dist/ directory is empty or missing, build the frontend:
cd /home/ubuntu/tunnelvault/frontend
npm install
npm run build

# Copy the built files to the gateway directory
sudo cp -r dist/ /opt/tunnelvault/frontend/dist/

# Or re-run setup:
cd /home/ubuntu/tunnelvault/gateway
sudo bash setup.sh

# Check browser developer console (F12) for JavaScript errors.
# Common issues:
# - API URL mismatch (frontend expects a different API host)
# - CORS errors (check the server logs for CORS warnings)
# - Mixed content (HTTP page loading HTTPS resources or vice versa)

# Verify the static files are being served:
curl -s http://localhost:4000/ | head -20
# Should return HTML content, not JSON
```

### Problem 15: Port Already in Use

**Symptoms:** Service fails to start with "EADDRINUSE" error.

**Solutions:**

```bash
# Find what is using the port
sudo ss -tlnp | grep 4000
sudo ss -tlnp | grep 4001

# Or use lsof:
sudo lsof -i :4000
sudo lsof -i :4001

# Kill the conflicting process
sudo kill <PID>

# If a zombie TunnelVault process is running:
sudo pkill -f "node.*server.js"

# Wait a moment, then restart the service
sudo systemctl restart tunnelvault-api

# If the port is stuck in TIME_WAIT, it will free up within 60 seconds.
# You can also allow reuse:
sudo sysctl -w net.ipv4.tcp_tw_reuse=1
```

### Problem 16: "No such user" When SSH Connecting

**Symptoms:** SSH returns "no matching user found" in sshd logs.

**Solutions:**

```bash
# The register_token.sh script creates a Linux user "gw-<TOKEN>".
# Verify the user exists:
id gw-mytoken

# If the user does not exist, re-register the token:
sudo /opt/tunnelvault/register_token.sh \
  --token mytoken --ip 10.0.1.42 \
  --label "My Server" \
  --pubkey "ssh-ed25519 AAAA..."

# Check that useradd did not fail:
grep gw-mytoken /etc/passwd
```

### Problem 17: Tunnel Client Disconnects Frequently

**Symptoms:** The CLI client reconnects every 30 seconds or drops intermittently.

**Solutions:**

```bash
# The WebSocket server pings every 30 seconds. If the client does not
# respond to a pong, it is terminated.

# Check for network issues between client and server
ping -c 10 <EC2-PUBLIC-IP>

# If using Nginx, ensure proxy timeout is long enough:
grep proxy_read_timeout /etc/nginx/sites-available/tunnelvault
# Should be: proxy_read_timeout 86400s;

# If not using Nginx, check if a load balancer or firewall is killing
# idle connections. AWS NLB has a 350-second idle timeout by default.

# Increase client-side keep-alive (if configurable)
```

---

## 8. Security Hardening Checklist

### 8.1 Change the Default AUTH_TOKEN

The default token `tvault-dev-token-2024` is public. Change it immediately:

```bash
# Generate a secure random token
openssl rand -hex 32

# Set it in the service
sudo systemctl edit tunnelvault-api
```

```ini
[Service]
Environment=AUTH_TOKEN=<paste-your-generated-token>
```

```bash
sudo systemctl daemon-reload
sudo systemctl restart tunnelvault-api
```

### 8.2 Restrict API Access

If the API should only be accessible from specific IPs, use iptables or
Security Group rules:

```bash
# Option A: Security Group — restrict port 4000 to your office IP
# In AWS Console, edit the Security Group inbound rule for port 4000:
# Source: <YOUR-OFFICE-IP>/32

# Option B: UFW (if not using Nginx)
sudo ufw delete allow 4000/tcp
sudo ufw allow from <YOUR-IP> to any port 4000 proto tcp
```

If using Nginx, add IP restrictions in the Nginx config:

```nginx
location /api/ {
    allow 10.0.0.0/8;
    allow <YOUR-IP>/32;
    deny all;
    proxy_pass http://tunnelvault_api;
    # ... other proxy headers ...
}
```

### 8.3 Enable TLS Everywhere

- Always use HTTPS for the API and dashboard (see Section 3.3 and 3.4).
- Use `wss://` instead of `ws://` for WebSocket connections.
- Ensure `ssl_protocols TLSv1.2 TLSv1.3;` in Nginx config (no TLSv1.0/1.1).

### 8.4 SSH Hardening

Edit `/etc/ssh/sshd_config`:

```bash
sudo nano /etc/ssh/sshd_config
```

Ensure these settings:

```
# Disable root login
PermitRootLogin no

# Disable password authentication (use key-based only)
PasswordAuthentication no

# Limit authentication attempts
MaxAuthTries 3

# Reduce login grace time
LoginGraceTime 30

# Disable empty passwords
PermitEmptyPasswords no
```

```bash
sudo sshd -t && sudo systemctl restart sshd
```

### 8.5 Firewall Rules

Ensure only necessary ports are open (see Section 3.5). Audit regularly:

```bash
sudo ufw status numbered
```

Remove any unnecessary rules.

### 8.6 Log Rotation

Prevent log files from filling the disk:

```bash
sudo nano /etc/logrotate.d/tunnelvault
```

```
/var/log/tunnelvault-gateway.log {
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    create 0644 root root
}

/var/log/tunnelvault-health.log {
    weekly
    rotate 4
    compress
    missingok
    notifempty
    create 0644 root root
}
```

Test the configuration:

```bash
sudo logrotate -d /etc/logrotate.d/tunnelvault
```

### 8.7 Fail2ban Setup

Protect against SSH brute-force attacks:

```bash
sudo apt install -y fail2ban
sudo nano /etc/fail2ban/jail.local
```

```ini
[DEFAULT]
bantime  = 3600
findtime = 600
maxretry = 5

[sshd]
enabled = true
port    = ssh
logpath = /var/log/auth.log
maxretry = 3
bantime = 7200
```

```bash
sudo systemctl enable --now fail2ban
sudo systemctl restart fail2ban

# Verify it is running
sudo fail2ban-client status sshd
```

Expected output:

```
Status for the jail: sshd
|- Filter
|  |- Currently failed: 0
|  |- Total failed:     0
|  `- File list:        /var/log/auth.log
`- Actions
   |- Currently banned: 0
   |- Total banned:     0
   `- Banned IP list:
```

### 8.8 Keep Software Updated

```bash
# Enable automatic security updates
sudo apt install -y unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades
```

### 8.9 Additional Recommendations

- **Elastic IP:** Allocate an Elastic IP so the public address does not change
  on instance stop/start.
- **VPC Peering / Private Subnets:** Place target machines in a private subnet.
  The gateway EC2 instance should be in a public subnet with access to the
  private subnet.
- **IAM Role:** If using Route 53 for DNS-01 Let's Encrypt challenges, attach
  an IAM role to the EC2 instance with minimal Route 53 permissions instead of
  storing AWS credentials on disk.
- **Secrets Management:** Consider using AWS Systems Manager Parameter Store or
  Secrets Manager for the AUTH_TOKEN instead of environment variables.
- **CloudWatch:** Send logs to CloudWatch for centralized monitoring and
  alerting.

---

## Quick Reference

| Action                          | Command                                                              |
|---------------------------------|----------------------------------------------------------------------|
| Check service status            | `sudo systemctl status tunnelvault-api`                              |
| View live API logs              | `sudo journalctl -u tunnelvault-api -f`                              |
| View gateway SSH logs           | `sudo tail -f /var/log/tunnelvault-gateway.log`                      |
| Restart the API                 | `sudo systemctl restart tunnelvault-api`                             |
| Health check                    | `curl -s http://localhost:4000/api/health`                           |
| Register a token                | `sudo /opt/tunnelvault/register_token.sh --token T --ip IP --pubkey K` |
| List all tokens                 | `sudo /opt/tunnelvault/register_token.sh --list`                     |
| Disable a token                 | `sudo /opt/tunnelvault/register_token.sh --disable TOKEN`            |
| Delete a token                  | `sudo /opt/tunnelvault/register_token.sh --delete TOKEN`             |
| Backup database                 | `sudo sqlite3 /opt/tunnelvault/tokens.db ".backup /tmp/backup.db"`   |
| Connect via SSH tunnel          | `ssh gw-TOKEN@<EC2-IP>`                                             |
| Open HTTP tunnel (client CLI)   | `node bin/tunnelvault.js connect 3000 --server ws://<EC2-IP>:4000`   |

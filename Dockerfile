# syntax=docker/dockerfile:1
#
# TunnelVault server (API, dashboard, device WebSocket, HTTP proxy, TCP tunnels).
#
#   docker build -t tunnelvault .
#   docker compose up -d            (see docker-compose.yml)
#
# The container serves plain HTTP: put a TLS reverse proxy in front of it for
# anything reachable from the internet (DEPLOYMENT.md, "Docker").
# Not included: the legacy SSH gateway (gw-* users, sshd ForceCommand) — it needs
# the host's sshd and is only installed by install-server.sh.

# Debian 12 (glibc): better-sqlite3 ships prebuilt binaries for it; the build
# tools in the deps stage are the fallback when no prebuilt binary matches.
ARG NODE_IMAGE=node:22-bookworm-slim

# ── 1. Dashboard (Vite build) ────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS frontend
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ── 2. Backend production dependencies (native module: better-sqlite3) ──────
FROM ${NODE_IMAGE} AS backend-deps
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
 && npm cache clean --force \
 && node -e "new (require('better-sqlite3'))(':memory:').close()"

# ── 3. Runtime ───────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime

LABEL org.opencontainers.image.title="TunnelVault" \
      org.opencontainers.image.description="Self-hosted SSH/TCP tunneling server" \
      org.opencontainers.image.source="https://github.com/TrainABit/ssh-tunnel" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production \
    PORT=4000 \
    PROXY_PORT=4001 \
    DB_PATH=/data/tunnelvault.db

# Application files belong to root and are read-only for the service user
# (same rule as /opt/tunnelvault on an installed server).
WORKDIR /app
COPY --from=backend-deps /app/backend/node_modules ./backend/node_modules
COPY backend/package.json backend/package-lock.json ./backend/
COPY backend/src ./backend/src
COPY --from=frontend /src/frontend/dist ./frontend/dist
COPY VERSION ./VERSION

# /data holds the SQLite database (tokens, tunnel owner secrets, encrypted keys).
RUN mkdir -p /data \
 && chown node:node /data \
 && chmod 0700 /data

# Unprivileged user of the official Node image (uid/gid 1000).
USER node
VOLUME ["/data"]

# 4000 dashboard + API + /ws + /ws/ssh, 4001 HTTP tunnel proxy,
# 10000-10999 default TCP tunnel range (TCP_PORT_MIN / TCP_PORT_MAX).
EXPOSE 4000 4001 10000-10999

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "const tls=!!process.env.TLS_CERT;require(tls?'https':'http').get({host:'127.0.0.1',port:process.env.PORT||4000,path:'/api/health',timeout:4000,rejectUnauthorized:false},(r)=>process.exit(r.statusCode===200?0:1)).on('timeout',function(){this.destroy()}).on('error',()=>process.exit(1))"]

# server.js handles SIGTERM (graceful shutdown: flushes tunnel stats, closes the DB).
# Exit code 78 = configuration error (e.g. AUTH_TOKEN missing): fix the environment.
CMD ["node", "backend/src/server.js"]

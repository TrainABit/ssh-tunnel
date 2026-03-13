import WebSocket from 'ws';
import http from 'node:http';
import net from 'node:net';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { exec } from 'node:child_process';
import { Display } from './display.js';

const INITIAL_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 30000;
const HEARTBEAT_TIMEOUT = 35000;

const STATE_DIR = join(homedir(), '.tunnelvault');
const STATE_FILE = join(STATE_DIR, 'state.json');

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveState(state) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch {
    // Non-fatal — state persistence is best-effort
  }
}

export class TunnelClient {
  constructor(options) {
    // Support both single-tunnel (legacy) and multi-tunnel config
    if (options.tunnels && options.tunnels.length > 0) {
      this.tunnels = options.tunnels.map(t => ({
        port: t.port,
        protocol: t.protocol || 'tcp',
        name: t.name || `tunnel-${t.port}`,
        subdomain: t.subdomain || '',
      }));
    } else {
      this.tunnels = [{
        port: options.port,
        protocol: options.protocol || 'http',
        name: options.name || '',
        subdomain: options.subdomain || '',
      }];
    }

    this.serverUrl = options.server || 'ws://localhost:4000';
    this.authToken = options.authToken || '';
    this.ws = null;
    this.display = new Display();
    this.reconnectDelay = INITIAL_RECONNECT_DELAY;
    this.reconnectAttempt = 0;
    this.shouldReconnect = true;
    this.heartbeatTimer = null;
    this.tcpConns = new Map(); // connId -> socket

    // Per-tunnel state keyed by port: { tunnelId, ownerSecret, publicUrl, allocatedPort }
    const saved = loadState();
    // Migrate legacy single-tunnel state
    if (saved.tunnelId && !saved.byPort) {
      this.stateByPort = { [this.tunnels[0].port]: { tunnelId: saved.tunnelId, ownerSecret: saved.ownerSecret } };
    } else {
      this.stateByPort = saved.byPort || {};
    }
  }

  connect() {
    this.display.startSpinner(`Connecting to ${this.serverUrl}...`);
    this._doConnect();
  }

  _doConnect() {
    try {
      const wsOptions = {};
      if (this.authToken) {
        wsOptions.headers = { 'Authorization': `Bearer ${this.authToken}` };
      }
      let wsUrl = this.serverUrl;
      if (!wsUrl.endsWith('/ws')) {
        wsUrl = wsUrl.replace(/\/$/, '') + '/ws';
      }
      this.ws = new WebSocket(wsUrl, wsOptions);
    } catch (err) {
      this.display.stopSpinner(false, `Failed to connect: ${err.message}`);
      this._scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      this.reconnectDelay = INITIAL_RECONNECT_DELAY;
      this.reconnectAttempt = 0;
      this._resetHeartbeat();

      // Register or reconnect each tunnel
      for (const t of this.tunnels) {
        const saved = this.stateByPort[t.port];
        if (saved?.tunnelId && saved?.ownerSecret) {
          this.ws.send(JSON.stringify({
            type: 'reconnect',
            tunnelId: saved.tunnelId,
            ownerSecret: saved.ownerSecret,
          }));
        } else {
          this.ws.send(JSON.stringify({
            type: 'register',
            name: t.name,
            localPort: t.port,
            subdomain: t.subdomain,
            protocol: t.protocol,
          }));
        }
      }
    });

    this.ws.on('message', (data) => {
      this._resetHeartbeat();
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      this._handleMessage(msg);
    });

    this.ws.on('ping', () => { this._resetHeartbeat(); });
    this.ws.on('pong', () => { this._resetHeartbeat(); });

    this.ws.on('close', (code, reason) => {
      this._clearHeartbeat();
      const msg = reason ? reason.toString() : `code ${code}`;
      this.display.setDisconnected(msg);
      this._scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      this._clearHeartbeat();
      this.display.stopSpinner(false, `Connection error: ${err.message}`);
    });
  }

  _handleMessage(msg) {
    switch (msg.type) {
      case 'registered': {
        // Match by localPort echoed from server
        const port = msg.localPort;
        this.stateByPort[port] = {
          tunnelId: msg.tunnelId,
          ownerSecret: msg.ownerSecret,
          publicUrl: msg.publicUrl,
          allocatedPort: msg.allocatedPort,
        };
        this._persistState();
        const label = msg.protocol === 'tcp' && msg.allocatedPort
          ? `port ${msg.allocatedPort}`
          : msg.publicUrl;
        this.display.setConnectedMulti(this._buildTunnelLines());
        break;
      }

      case 'reconnected': {
        const port = msg.localPort;
        if (this.stateByPort[port]) {
          this.stateByPort[port].publicUrl = msg.publicUrl;
          this.stateByPort[port].allocatedPort = msg.allocatedPort;
        }
        this.display.setConnectedMulti(this._buildTunnelLines());
        break;
      }

      case 'request':
        this._proxyRequest(msg);
        break;

      case 'ping':
        this._send({ type: 'pong' });
        break;

      case 'tcp-open':
        this._openTcpConn(msg.connId, msg.localPort);
        break;

      case 'tcp-data':
        this._forwardTcpData(msg.connId, msg.data);
        break;

      case 'tcp-close':
        this._closeTcpConn(msg.connId);
        break;

      case 'reboot':
        this.display.setDisconnected('rebooting device…');
        setTimeout(() => {
          exec('sudo systemctl reboot', (err) => {
            if (err) exec('sudo reboot', () => {});
          });
        }, 500);
        break;

      case 'standby':
        this.display.setDisconnected('paused (resume from dashboard)');
        break;

      case 'error':
        if (msg.message === 'Tunnel not found for reconnect') {
          // Stale state — find which tunnel this was and re-register
          // We can't easily tell which one failed, so clear all and re-register
          this.stateByPort = {};
          this._persistState();
          for (const t of this.tunnels) {
            this.ws.send(JSON.stringify({
              type: 'register',
              name: t.name,
              localPort: t.port,
              subdomain: t.subdomain,
              protocol: t.protocol,
            }));
          }
        } else {
          this.display.stopSpinner(false, `Server error: ${msg.message}`);
        }
        break;

      default:
        break;
    }
  }

  _buildTunnelLines() {
    return this.tunnels.map(t => {
      const s = this.stateByPort[t.port];
      if (!s) return { name: t.name, port: t.port, status: 'registering…' };
      const pub = s.allocatedPort ? `EC2 port ${s.allocatedPort}` : (s.publicUrl || '—');
      return { name: t.name, port: t.port, public: pub };
    });
  }

  _persistState() {
    saveState({ byPort: this.stateByPort });
  }

  _openTcpConn(connId, localPort) {
    const socket = net.createConnection({ port: localPort, host: 'localhost' });
    this.tcpConns.set(connId, socket);
    socket.on('data', (chunk) => {
      this._send({ type: 'tcp-data', connId, data: chunk.toString('base64') });
    });
    const cleanup = () => {
      this.tcpConns.delete(connId);
      this._send({ type: 'tcp-close', connId });
    };
    socket.on('end', cleanup);
    socket.on('error', () => { socket.destroy(); });
    socket.on('close', () => this.tcpConns.delete(connId));
  }

  _forwardTcpData(connId, data) {
    const socket = this.tcpConns.get(connId);
    if (socket && !socket.destroyed) socket.write(Buffer.from(data, 'base64'));
  }

  _closeTcpConn(connId) {
    const socket = this.tcpConns.get(connId);
    if (socket && !socket.destroyed) socket.end();
    this.tcpConns.delete(connId);
  }

  _proxyRequest(msg) {
    const startTime = Date.now();
    const { id, method, path, headers, body, localPort } = msg;

    // Use localPort from message if provided, else fall back to first tunnel
    const port = localPort || this.tunnels[0].port;
    const url = new URL(path, `http://localhost:${port}`);

    const reqOptions = {
      hostname: 'localhost',
      port,
      path: url.pathname + url.search,
      method: method || 'GET',
      headers: headers || {},
    };

    const proxyReq = http.request(reqOptions, (proxyRes) => {
      const chunks = [];
      proxyRes.on('data', (chunk) => chunks.push(chunk));
      proxyRes.on('end', () => {
        const duration = Date.now() - startTime;
        const responseBody = Buffer.concat(chunks).toString('base64');
        const resHeaders = {};
        for (const [key, val] of Object.entries(proxyRes.headers)) {
          resHeaders[key] = val;
        }
        this._send({ type: 'response', id, statusCode: proxyRes.statusCode, headers: resHeaders, body: responseBody, bodyEncoding: 'base64' });
        this.display.logRequest(method || 'GET', path || '/', proxyRes.statusCode, http.STATUS_CODES[proxyRes.statusCode] || '', duration);
        this.display.render();
      });
    });

    proxyReq.on('error', (err) => {
      const duration = Date.now() - startTime;
      this._send({ type: 'response', id, statusCode: 502, headers: { 'content-type': 'text/plain' }, body: Buffer.from(`Bad Gateway: ${err.message}`).toString('base64'), bodyEncoding: 'base64' });
      this.display.logRequest(method || 'GET', path || '/', 502, 'Bad Gateway', duration);
      this.display.render();
    });

    if (body) proxyReq.write(Buffer.from(body, 'base64'));
    proxyReq.end();
  }

  _send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  _resetHeartbeat() {
    this._clearHeartbeat();
    this.heartbeatTimer = setTimeout(() => {
      if (this.ws) this.ws.terminate();
    }, HEARTBEAT_TIMEOUT);
  }

  _clearHeartbeat() {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  _scheduleReconnect() {
    if (!this.shouldReconnect) return;
    this.reconnectAttempt++;
    this.display.setReconnecting(this.reconnectAttempt);
    setTimeout(() => {
      if (!this.shouldReconnect) return;
      this.display.startSpinner(`Reconnecting (attempt ${this.reconnectAttempt})...`);
      this._doConnect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY);
  }

  disconnect() {
    this.shouldReconnect = false;
    this._clearHeartbeat();
    this.display.destroy();
    for (const socket of this.tcpConns.values()) socket.destroy();
    this.tcpConns.clear();
    if (this.ws) {
      this.ws.close(1000, 'Client disconnecting');
      this.ws = null;
    }
  }
}

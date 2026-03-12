import WebSocket from 'ws';
import http from 'node:http';
import { Display } from './display.js';

const INITIAL_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 30000;
const HEARTBEAT_TIMEOUT = 35000;

export class TunnelClient {
  constructor(options) {
    this.localPort = options.port;
    this.name = options.name || '';
    this.subdomain = options.subdomain || '';
    this.serverUrl = options.server || 'ws://localhost:4000';
    this.authToken = options.authToken || '';
    this.ws = null;
    this.display = new Display();
    this.reconnectDelay = INITIAL_RECONNECT_DELAY;
    this.reconnectAttempt = 0;
    this.shouldReconnect = true;
    this.heartbeatTimer = null;
    this.publicUrl = '';
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

      // Send registration message
      this.ws.send(JSON.stringify({
        type: 'register',
        name: this.name,
        localPort: this.localPort,
        subdomain: this.subdomain,
      }));
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

    this.ws.on('ping', () => {
      this._resetHeartbeat();
      // ws library auto-responds with pong
    });

    this.ws.on('pong', () => {
      this._resetHeartbeat();
    });

    this.ws.on('close', (code, reason) => {
      this._clearHeartbeat();
      const msg = reason ? reason.toString() : `code ${code}`;
      this.display.setDisconnected(msg);
      this._scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      this._clearHeartbeat();
      this.display.stopSpinner(false, `Connection error: ${err.message}`);
      // The 'close' event will fire after this, triggering reconnect
    });
  }

  _handleMessage(msg) {
    switch (msg.type) {
      case 'registered':
        this.publicUrl = msg.publicUrl;
        this.display.setConnected(msg.publicUrl, `http://localhost:${this.localPort}`);
        break;

      case 'request':
        this._proxyRequest(msg);
        break;

      case 'ping':
        // Server-level ping (JSON), respond with pong
        this._send({ type: 'pong' });
        break;

      case 'error':
        this.display.stopSpinner(false, `Server error: ${msg.message}`);
        break;

      default:
        break;
    }
  }

  _proxyRequest(msg) {
    const startTime = Date.now();
    const { id, method, path, headers, body } = msg;

    const url = new URL(path, `http://localhost:${this.localPort}`);

    const reqOptions = {
      hostname: 'localhost',
      port: this.localPort,
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

        // Clean up response headers
        const resHeaders = {};
        for (const [key, val] of Object.entries(proxyRes.headers)) {
          resHeaders[key] = val;
        }

        this._send({
          type: 'response',
          id,
          statusCode: proxyRes.statusCode,
          headers: resHeaders,
          body: responseBody,
          bodyEncoding: 'base64',
        });

        const statusText = http.STATUS_CODES[proxyRes.statusCode] || '';
        this.display.logRequest(
          method || 'GET',
          path || '/',
          proxyRes.statusCode,
          statusText,
          duration,
        );
        this.display.render();
      });
    });

    proxyReq.on('error', (err) => {
      const duration = Date.now() - startTime;
      this._send({
        type: 'response',
        id,
        statusCode: 502,
        headers: { 'content-type': 'text/plain' },
        body: Buffer.from(`Bad Gateway: ${err.message}`).toString('base64'),
        bodyEncoding: 'base64',
      });

      this.display.logRequest(
        method || 'GET',
        path || '/',
        502,
        'Bad Gateway',
        duration,
      );
      this.display.render();
    });

    if (body) {
      const decoded = Buffer.from(body, 'base64');
      proxyReq.write(decoded);
    }
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
      // No heartbeat received, connection may be dead
      if (this.ws) {
        this.ws.terminate();
      }
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

    // Exponential backoff
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY);
  }

  disconnect() {
    this.shouldReconnect = false;
    this._clearHeartbeat();
    this.display.destroy();
    if (this.ws) {
      this.ws.close(1000, 'Client disconnecting');
      this.ws = null;
    }
  }
}

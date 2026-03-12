const net = require('net');
const { v4: uuidv4 } = require('uuid');
const { createLogger } = require('./logger');
const log = createLogger('tcp-proxy');

class TcpProxy {
  constructor() {
    this.servers = new Map();    // tunnelId -> { server, port, connections: Map<connId, socket> }
    this.connTunnel = new Map(); // connId -> tunnelId
    this.usedPorts = new Set();
    this.portMin = parseInt(process.env.TCP_PORT_MIN, 10) || 10000;
    this.portMax = parseInt(process.env.TCP_PORT_MAX, 10) || 10999;
  }

  _allocatePort() {
    for (let p = this.portMin; p <= this.portMax; p++) {
      if (!this.usedPorts.has(p)) {
        this.usedPorts.add(p);
        return p;
      }
    }
    return null;
  }

  startListener(tunnelId, ws, localPort) {
    const port = this._allocatePort();
    if (port === null) {
      log.error('No TCP ports available', { tunnelId });
      return null;
    }

    const connections = new Map();

    const server = net.createServer((socket) => {
      const connId = uuidv4();
      connections.set(connId, socket);
      this.connTunnel.set(connId, tunnelId);

      log.debug('TCP connection opened', { tunnelId, connId });

      if (ws.readyState !== 1) { socket.destroy(); return; }
      ws.send(JSON.stringify({ type: 'tcp-open', connId, tunnelId, localPort }));

      socket.on('data', (chunk) => {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'tcp-data', connId, data: chunk.toString('base64') }));
        } else {
          socket.destroy();
        }
      });

      const cleanup = () => {
        this.connTunnel.delete(connId);
        connections.delete(connId);
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'tcp-close', connId }));
      };
      socket.on('end', cleanup);
      socket.on('error', (err) => {
        log.warn('TCP socket error', { connId, error: err.message });
        socket.destroy();
      });
      socket.on('close', () => { this.connTunnel.delete(connId); connections.delete(connId); });
    });

    server.listen(port, () => log.info('TCP listener started', { tunnelId, port }));
    server.on('error', (err) => {
      log.error('TCP server error', { tunnelId, port, error: err.message });
      this.stopListener(tunnelId);
    });

    this.servers.set(tunnelId, { server, port, connections });
    return port;
  }

  forwardData(connId, data) {
    const tunnelId = this.connTunnel.get(connId);
    if (!tunnelId) return;
    const entry = this.servers.get(tunnelId);
    const socket = entry?.connections.get(connId);
    if (socket && !socket.destroyed) socket.write(Buffer.from(data, 'base64'));
  }

  closeConn(connId) {
    const tunnelId = this.connTunnel.get(connId);
    if (!tunnelId) return;
    const entry = this.servers.get(tunnelId);
    const socket = entry?.connections.get(connId);
    if (socket && !socket.destroyed) socket.end();
    this.connTunnel.delete(connId);
    entry?.connections.delete(connId);
  }

  stopListener(tunnelId) {
    const entry = this.servers.get(tunnelId);
    if (!entry) return;
    for (const [connId, socket] of entry.connections) {
      socket.destroy();
      this.connTunnel.delete(connId);
    }
    entry.connections.clear();
    this.usedPorts.delete(entry.port);
    entry.server.close(() => log.info('TCP listener stopped', { tunnelId, port: entry.port }));
    this.servers.delete(tunnelId);
  }

  getPort(tunnelId) { return this.servers.get(tunnelId)?.port ?? null; }

  destroy() {
    for (const tunnelId of [...this.servers.keys()]) this.stopListener(tunnelId);
  }
}

module.exports = TcpProxy;

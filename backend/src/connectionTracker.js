const { v4: uuidv4 } = require('uuid');

class ConnectionTracker {
  constructor() {
    this.activeConnections = new Map();
    this.completedCount = 0;
    this.totalBytesIn = 0;
    this.totalBytesOut = 0;

    // Time-series data: keep last 24 data points (one per interval)
    this.history = [];
    this.maxHistoryPoints = 24;

    // Record a data point every 60 seconds
    this._historyInterval = setInterval(() => {
      this._recordHistoryPoint();
    }, 60_000);

    // Record an initial point
    this._recordHistoryPoint();
  }

  /**
   * Start tracking a new connection.
   * Returns the connectionId.
   */
  startConnection(tunnelId, sourceIp) {
    const id = uuidv4();
    this.activeConnections.set(id, {
      connectionId: id,
      tunnelId,
      sourceIp: sourceIp || 'unknown',
      startTime: new Date().toISOString(),
      bytesIn: 0,
      bytesOut: 0,
    });
    return id;
  }

  /**
   * Update byte counts for an active connection.
   */
  updateBytes(connectionId, bytesIn, bytesOut) {
    const conn = this.activeConnections.get(connectionId);
    if (conn) {
      conn.bytesIn += bytesIn;
      conn.bytesOut += bytesOut;
    }
  }

  /**
   * Mark a connection as completed and clean it up.
   */
  completeConnection(connectionId) {
    const conn = this.activeConnections.get(connectionId);
    if (conn) {
      this.totalBytesIn += conn.bytesIn;
      this.totalBytesOut += conn.bytesOut;
      this.completedCount++;
      this.activeConnections.delete(connectionId);
    }
  }

  /**
   * Remove all connections for a given tunnel.
   */
  removeByTunnel(tunnelId) {
    for (const [id, conn] of this.activeConnections) {
      if (conn.tunnelId === tunnelId) {
        this.totalBytesIn += conn.bytesIn;
        this.totalBytesOut += conn.bytesOut;
        this.completedCount++;
        this.activeConnections.delete(id);
      }
    }
  }

  /**
   * Get all active connections, optionally filtered by tunnelId.
   */
  getConnections(tunnelId) {
    const result = [];
    for (const conn of this.activeConnections.values()) {
      if (!tunnelId || conn.tunnelId === tunnelId) {
        result.push({ ...conn });
      }
    }
    return result;
  }

  /**
   * Return aggregated stats.
   */
  getStats() {
    let activeBytesIn = 0;
    let activeBytesOut = 0;
    for (const conn of this.activeConnections.values()) {
      activeBytesIn += conn.bytesIn;
      activeBytesOut += conn.bytesOut;
    }

    return {
      activeConnections: this.activeConnections.size,
      completedConnections: this.completedCount,
      totalConnections: this.activeConnections.size + this.completedCount,
      bytesIn: this.totalBytesIn + activeBytesIn,
      bytesOut: this.totalBytesOut + activeBytesOut,
      bytesTransferred: this.totalBytesIn + this.totalBytesOut + activeBytesIn + activeBytesOut,
    };
  }

  /**
   * Get connection history for charts.
   */
  getHistory() {
    return [...this.history];
  }

  // ---- private ----

  _recordHistoryPoint() {
    this.history.push({
      time: new Date().toISOString(),
      count: this.activeConnections.size,
    });
    if (this.history.length > this.maxHistoryPoints) {
      this.history.shift();
    }
  }

  destroy() {
    clearInterval(this._historyInterval);
  }
}

module.exports = ConnectionTracker;

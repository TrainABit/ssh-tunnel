const { createLogger } = require('./logger');
const log = createLogger('notifier');

const WEBHOOK_URL = process.env.WEBHOOK_URL;
const WEBHOOK_TYPE = (process.env.WEBHOOK_TYPE || 'json').toLowerCase();

/**
 * Build a human-readable message for a tunnel event.
 */
function buildText(event, data) {
  const name = data.tunnelName || 'unknown';
  if (event === 'tunnel:connected') {
    const portInfo = data.allocatedPort ? ` (port ${data.allocatedPort})` : '';
    return `Tunnel connected: ${name}${portInfo}`;
  }
  if (event === 'tunnel:disconnected') return `Tunnel disconnected: ${name}`;
  if (event === 'tunnel:paused') return `Tunnel paused: ${name}`;
  return `TunnelVault: ${event} — ${name}`;
}

/**
 * Send a webhook notification for a tunnel event.
 * Silently no-ops if WEBHOOK_URL is not configured.
 *
 * Supported WEBHOOK_TYPE values:
 *   ntfy    — POST plain text to a ntfy topic URL
 *   slack   — POST { text } to a Slack Incoming Webhook
 *   discord — POST { content } to a Discord Webhook
 *   json    — POST { event, text, timestamp, ... } (default)
 */
async function notify(event, data) {
  if (!WEBHOOK_URL) return;

  const text = buildText(event, data);
  let headers;
  let body;

  if (WEBHOOK_TYPE === 'ntfy') {
    headers = {
      'Content-Type': 'text/plain',
      'Title': 'TunnelVault',
      'Priority': 'default',
      'Tags': event === 'tunnel:connected' ? 'white_check_mark' : 'warning',
    };
    body = text;
  } else if (WEBHOOK_TYPE === 'slack') {
    headers = { 'Content-Type': 'application/json' };
    body = JSON.stringify({ text });
  } else if (WEBHOOK_TYPE === 'discord') {
    headers = { 'Content-Type': 'application/json' };
    body = JSON.stringify({ content: text });
  } else {
    // Generic JSON
    headers = { 'Content-Type': 'application/json' };
    body = JSON.stringify({
      event,
      text,
      tunnelName: data.tunnelName,
      tunnelId: data.tunnelId,
      allocatedPort: data.allocatedPort || null,
      timestamp: new Date().toISOString(),
    });
  }

  try {
    const res = await fetch(WEBHOOK_URL, { method: 'POST', headers, body });
    if (!res.ok) {
      log.warn('Webhook returned non-2xx', { status: res.status, event });
    }
  } catch (err) {
    log.warn('Webhook delivery failed', { error: err.message, event });
  }
}

module.exports = { notify };

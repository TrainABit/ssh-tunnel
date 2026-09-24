/**
 * Helpers that derive the URLs shown in install commands and SSH hints.
 *
 * The device client appends `/ws` itself, so the "server URL" is the bare
 * origin (plus an optional sub-path) with a ws:// or wss:// scheme.
 */

function trimPath(pathname) {
  return (pathname || '').replace(/\/+$/, '');
}

/**
 * Server URL for `install-client.sh --server …` / `tunnelvault connect --server …`.
 * Prefers the server's configured PUBLIC_URL (https -> wss, http -> ws); falls back
 * to the dashboard's own location (wss when the page is served over https, host
 * including any non-default port). Never hardcodes a port.
 *
 * @param {{ publicUrl?: string|null }|null|undefined} config  GET /api/config result
 * @param {{ protocol: string, host: string }} [loc]
 */
export function deviceServerUrl(config, loc = window.location) {
  const pub = config && typeof config.publicUrl === 'string' ? config.publicUrl.trim() : '';
  if (pub) {
    try {
      const u = new URL(pub);
      let proto = null;
      if (u.protocol === 'https:' || u.protocol === 'wss:') proto = 'wss';
      else if (u.protocol === 'http:' || u.protocol === 'ws:') proto = 'ws';
      if (proto && u.host) return `${proto}://${u.host}${trimPath(u.pathname)}`;
    } catch {
      // Malformed PUBLIC_URL: fall back to the page location below.
    }
  }
  const proto = loc.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${loc.host}`;
}

/** Hostname devices/users reach the server under (for `ssh -p PORT user@HOST` hints). */
export function publicHostname(config, loc = window.location) {
  const pub = config && typeof config.publicUrl === 'string' ? config.publicUrl.trim() : '';
  if (pub) {
    try {
      const u = new URL(pub);
      if (u.hostname) return u.hostname;
    } catch {
      // fall through
    }
  }
  return loc.hostname;
}

function isPrivateOrLocalHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1') return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h)) return true;
  return false;
}

/** True when the URL is plaintext (ws:// or http://) to a host that is not local/private. */
export function isInsecurePublicUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'ws:' && u.protocol !== 'http:') return false;
    return !isPrivateOrLocalHost(u.hostname);
  } catch {
    return false;
  }
}

/** Quote a value for a POSIX shell command line when it contains anything unusual. */
export function shellQuote(value) {
  const s = String(value);
  if (/^[A-Za-z0-9._:/@%+=,-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** True for absolute http(s) URLs — used before rendering server-provided links. */
export function isHttpUrl(value) {
  try {
    const u = new URL(String(value));
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * True when the dashboard is (or is published as) HTTPS. The backend then sends
 * HSTS for the host, and browsers that have seen it rewrite http://HOST:<any port>
 * to https:// — plain-HTTP services on TCP tunnel ports of that host become unreachable.
 */
export function isHttpsDashboard(config, loc = window.location) {
  if (loc && loc.protocol === 'https:') return true;
  const pub = config && typeof config.publicUrl === 'string' ? config.publicUrl.trim() : '';
  return /^https:/i.test(pub);
}

/** `host:port` address of a TCP tunnel (IPv6 literals in brackets). */
export function tcpAddress(config, port, loc = window.location) {
  const host = publicHostname(config, loc);
  const h = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `${h}:${port}`;
}

/**
 * Clickable "Open" URL for a plain-HTTP service behind a TCP tunnel, or null when
 * no working link can be offered: over HTTPS (HSTS forces https:// on every port
 * of the host) or without a valid port.
 */
export function tcpOpenUrl(config, port, loc = window.location) {
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) return null;
  if (isHttpsDashboard(config, loc)) return null;
  return `http://${tcpAddress(config, p, loc)}`;
}

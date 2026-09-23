#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { TunnelClient, resolveAllowReboot } from '../src/tunnel.js';
import { CLIENT_VERSION, isInsecureRemoteUrl } from '../src/protocol.js';

/**
 * Config file: $TUNNELVAULT_CONFIG, else ~/.tunnelvault/config.json, else the system-wide
 * /etc/tunnelvault/config.json written by install-client.sh (first one that exists).
 * Keys: server, tunnels[], allow_reboot (and legacy auth_token).
 * Priority: CLI flag > env var > config.json > hardcoded default
 */
const SYSTEM_CONFIG = '/etc/tunnelvault/config.json';

function configPath() {
  if (process.env.TUNNELVAULT_CONFIG) return process.env.TUNNELVAULT_CONFIG;
  const userConfig = join(homedir(), '.tunnelvault', 'config.json');
  if (!existsSync(userConfig) && existsSync(SYSTEM_CONFIG)) return SYSTEM_CONFIG;
  return userConfig;
}

function loadConfig() {
  const path = configPath();
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      // Never echo the parser message: it can quote file content (tokens).
      console.error(chalk.yellow(`Warning: ignoring ${path} (${err.code || 'invalid JSON'})`));
    }
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  if (parsed.auth_token) {
    try {
      if ((statSync(path).mode & 0o077) !== 0) {
        console.error(chalk.yellow(`Warning: ${path} contains auth_token and is readable by other users — run: chmod 600 ${path}`));
      }
    } catch { /* ignore */ }
  }
  return parsed;
}

const config = loadConfig();

/**
 * Resolve a value with priority: explicit > env > config > fallback.
 * "explicit" is the CLI-provided value; if it equals the Commander default
 * we treat it as not explicitly set.
 */
function resolve(explicit, envKey, configKey, fallback, commanderDefault) {
  // If the explicit value differs from Commander's own default, the user typed it
  if (explicit !== undefined && explicit !== commanderDefault) return explicit;
  const envVal = process.env[envKey];
  if (envVal) return envVal;
  if (config[configKey] !== undefined) return config[configKey];
  return fallback;
}

const DEFAULT_WS_SERVER  = 'ws://localhost:4000';
const DEFAULT_HTTP_SERVER = 'http://localhost:4000';

const program = new Command();

program
  .name('tunnelvault')
  .description('TunnelVault — expose local servers to the internet')
  .version(CLIENT_VERSION)
  .option(
    '--auth-token <token>',
    'auth token for the tunnel server (visible in the process list — prefer the TUNNELVAULT_AUTH_TOKEN env var)',
  );

/**
 * Build fetch headers including auth token if available.
 */
function authHeaders() {
  const token = resolve(
    program.opts().authToken,
    'TUNNELVAULT_AUTH_TOKEN',
    'auth_token',
    undefined,
    undefined,
  );
  if (token) {
    return { 'Authorization': `Bearer ${token}` };
  }
  return {};
}

/** ws(s)://host:4000[/ws] -> http(s)://host:4000 for the REST API. */
function apiBase(serverUrl) {
  let u;
  try {
    u = new URL(String(serverUrl));
  } catch {
    // Never echo query strings or userinfo (they may carry a token).
    const shown = clean(String(serverUrl).split(/[?#]/)[0].replace(/\/\/[^/@]*@/, '//')).slice(0, 100);
    console.error(chalk.red(`Error: invalid server URL: ${shown}`));
    process.exit(1);
  }
  if (u.protocol === 'ws:') u.protocol = 'http:';
  else if (u.protocol === 'wss:') u.protocol = 'https:';
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    console.error(chalk.red('Error: server URL must start with ws://, wss://, http:// or https://'));
    process.exit(1);
  }
  if (isInsecureRemoteUrl(u.toString())) {
    console.error(chalk.yellow(`Warning: ${u.host} is reached over plain HTTP — the auth token is sent unencrypted.`));
  }
  const path = u.pathname.replace(/\/ws\/?$/, '').replace(/\/+$/, '');
  return `${u.origin}${path}`;
}

program
  .command('connect [port]')
  .description('Connect local port(s) to the tunnel server. Omit port to use tunnels[] from config.')
  .option('-n, --name <name>', 'tunnel name (single-port mode)')
  .option('-s, --subdomain <sub>', 'requested subdomain (single-port mode)')
  .option('--server <url>', 'tunnel server URL (or TUNNELVAULT_SERVER env var)', DEFAULT_WS_SERVER)
  .option('--protocol <proto>', 'tunnel protocol: http or tcp', 'tcp')
  .action((port, options) => {
    const serverUrl = resolve(
      options.server,
      'TUNNELVAULT_SERVER',
      'server',
      DEFAULT_WS_SERVER,
      DEFAULT_WS_SERVER,
    );
    const authToken = resolve(program.opts().authToken, 'TUNNELVAULT_AUTH_TOKEN', 'auth_token', undefined, undefined);
    if (!authToken) {
      console.error(chalk.yellow('Warning: no auth token configured (set TUNNELVAULT_AUTH_TOKEN); the server will likely refuse the connection.'));
    }

    let clientOptions;

    if (port) {
      // Single-port mode (legacy / manual)
      const portNum = Number(port);
      if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
        console.error(chalk.red('Error: port must be a number between 1 and 65535'));
        process.exit(1);
      }
      if (options.protocol !== 'http' && options.protocol !== 'tcp') {
        console.error(chalk.red('Error: --protocol must be http or tcp'));
        process.exit(1);
      }
      clientOptions = {
        port: portNum,
        name: options.name,
        subdomain: options.subdomain,
        protocol: options.protocol,
      };
    } else {
      // Multi-tunnel mode — read tunnels[] from config
      const tunnels = config.tunnels;
      if (!Array.isArray(tunnels) || tunnels.length === 0) {
        console.error(chalk.red(`Error: no port given and no tunnels[] found in ${configPath()}`));
        console.error(chalk.dim('  Either run: tunnelvault connect <port>'));
        console.error(chalk.dim('  Or add tunnels to your config.json'));
        process.exit(1);
      }
      clientOptions = { tunnels };
    }

    let client;
    try {
      client = new TunnelClient({
        ...clientOptions,
        server: serverUrl,
        authToken,
        // Remote reboot from the dashboard is opt-in: config.json "allow_reboot": true
        // or TUNNELVAULT_ALLOW_REBOOT=1.
        allowReboot: resolveAllowReboot(config),
        stateDir: process.env.TUNNELVAULT_STATE_DIR || undefined,
      });
    } catch (err) {
      console.error(chalk.red(`Error: ${err.message}`));
      process.exit(1);
    }

    let stopping = false;
    const shutdown = async () => {
      if (stopping) return;
      stopping = true;
      console.log(chalk.dim('\n  Shutting down...'));
      await client.disconnect();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    client.connect();
  });

program
  .command('list')
  .description('List active tunnels')
  .option('--server <url>', 'tunnel server URL', DEFAULT_HTTP_SERVER)
  .action(async (options) => {
    const serverUrl = resolve(
      options.server,
      'TUNNELVAULT_SERVER',
      'server',
      DEFAULT_HTTP_SERVER,
      DEFAULT_HTTP_SERVER,
    );
    // Replace options.server so downstream code uses resolved value
    options.server = apiBase(serverUrl);
    const spinner = ora('Fetching active tunnels...').start();
    try {
      const res = await fetch(`${options.server}/api/tunnels`, { headers: authHeaders() });
      if (!res.ok) {
        spinner.fail(`Server responded with ${res.status} ${res.statusText}`);
        process.exit(1);
      }
      const data = await res.json();
      spinner.stop();

      // API returns { tunnels: [...] }, unwrap accordingly
      const tunnels = Array.isArray(data) ? data : (data.tunnels || []);

      if (tunnels.length === 0) {
        console.log(chalk.dim('  No active tunnels'));
        return;
      }

      console.log(chalk.cyan.bold('\n  Active Tunnels\n'));
      console.log(
        `  ${chalk.dim(pad('NAME', 20))} ${chalk.dim(pad('PUBLIC URL', 35))} ${chalk.dim(pad('FORWARD', 25))}`
      );
      console.log(`  ${'─'.repeat(80)}`);

      for (const t of tunnels) {
        const name = pad(clean(t.name || '(unnamed)'), 20);
        const url = pad(clean(t.publicUrl || t.url || '—'), 35);
        const fwd = pad(clean(t.forward || `localhost:${t.localPort || '?'}`), 25);
        console.log(`  ${chalk.white(name)} ${chalk.green(url)} ${chalk.dim(fwd)}`);
      }
      console.log('');
    } catch (err) {
      spinner.fail(`Failed to connect to server: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('status')
  .description('Show tunnel server status')
  .option('--server <url>', 'tunnel server URL', DEFAULT_HTTP_SERVER)
  .action(async (options) => {
    const serverUrl = resolve(
      options.server,
      'TUNNELVAULT_SERVER',
      'server',
      DEFAULT_HTTP_SERVER,
      DEFAULT_HTTP_SERVER,
    );
    options.server = apiBase(serverUrl);
    const spinner = ora('Checking server status...').start();
    try {
      const res = await fetch(`${options.server}/api/stats`, { headers: authHeaders() });
      if (!res.ok) {
        spinner.fail(`Server responded with ${res.status} ${res.statusText}`);
        process.exit(1);
      }
      const status = await res.json();
      spinner.succeed('Server is reachable');

      console.log(chalk.cyan.bold('\n  Server Status\n'));
      console.log(`  ${chalk.dim('Server:')}     ${options.server}`);
      console.log(`  ${chalk.dim('Uptime:')}     ${clean(status.uptime ?? '—')}`);
      console.log(`  ${chalk.dim('Tunnels:')}    ${clean(status.activeTunnels ?? '—')}`);
      console.log(`  ${chalk.dim('Connections:')} ${clean(status.totalConnections ?? '—')}`);
      console.log(`  ${chalk.dim('Bytes:')}      ${clean(status.bytesTransferred ?? '—')}`);
      if (status.total_tokens !== undefined) {
        console.log(`  ${chalk.dim('Tokens:')}     ${clean(status.total_tokens)} (${clean(status.active_tokens)} active)`);
        console.log(`  ${chalk.dim('Sessions:')}   ${clean(status.total_sessions)} total, ${clean(status.live_sessions)} live`);
      }
      console.log('');
    } catch (err) {
      spinner.fail(`Failed to connect to server: ${err.message}`);
      process.exit(1);
    }
  });

function pad(str, len) {
  if (str.length >= len) return str.slice(0, len);
  return str + ' '.repeat(len - str.length);
}

/** Strip control characters (terminal escape injection) from server-supplied values. */
function clean(value) {
  // eslint-disable-next-line no-control-regex
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
}


program.parse();

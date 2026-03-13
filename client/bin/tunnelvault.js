#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { TunnelClient } from '../src/tunnel.js';

/**
 * Load config from ~/.tunnelvault/config.json (if it exists).
 * Priority: CLI flag > env var > config.json > hardcoded default
 */
function loadConfig() {
  const configPath = join(homedir(), '.tunnelvault', 'config.json');
  try {
    const raw = readFileSync(configPath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
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
  .version('1.0.0')
  .option('--auth-token <token>', 'auth token for the tunnel server (or set TUNNELVAULT_AUTH_TOKEN env var)');

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

program
  .command('connect [port]')
  .description('Connect local port(s) to the tunnel server. Omit port to use tunnels[] from config.')
  .option('-n, --name <name>', 'tunnel name (single-port mode)')
  .option('-s, --subdomain <sub>', 'requested subdomain (single-port mode)')
  .option('--server <url>', 'tunnel server URL', DEFAULT_WS_SERVER)
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

    let clientOptions;

    if (port) {
      // Single-port mode (legacy / manual)
      const portNum = parseInt(port, 10);
      if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
        console.error(chalk.red('Error: port must be a number between 1 and 65535'));
        process.exit(1);
      }
      clientOptions = {
        port: portNum,
        name: options.name,
        subdomain: options.subdomain,
        server: serverUrl,
        authToken,
        protocol: options.protocol === 'http' ? 'http' : 'tcp',
      };
    } else {
      // Multi-tunnel mode — read tunnels[] from config
      const tunnels = config.tunnels;
      if (!tunnels || tunnels.length === 0) {
        console.error(chalk.red('Error: no port given and no tunnels[] found in ~/.tunnelvault/config.json'));
        console.error(chalk.dim('  Either run: tunnelvault connect <port>'));
        console.error(chalk.dim('  Or add tunnels to your config.json'));
        process.exit(1);
      }
      clientOptions = {
        tunnels,
        server: serverUrl,
        authToken,
      };
    }

    const client = new TunnelClient(clientOptions);

    const shutdown = () => {
      console.log(chalk.dim('\n  Shutting down...'));
      client.disconnect();
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
    options.server = serverUrl.replace(/^ws:\/\//, 'http://').replace(/^wss:\/\//, 'https://');
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
        const name = pad(t.name || '(unnamed)', 20);
        const url = pad(t.publicUrl || t.url || '—', 35);
        const fwd = pad(t.forward || `localhost:${t.localPort || '?'}`, 25);
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
    options.server = serverUrl.replace(/^ws:\/\//, 'http://').replace(/^wss:\/\//, 'https://');
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
      console.log(`  ${chalk.dim('Uptime:')}     ${status.uptime || '—'}`);
      console.log(`  ${chalk.dim('Tunnels:')}    ${status.activeTunnels ?? '—'}`);
      console.log(`  ${chalk.dim('Connections:')} ${status.totalConnections ?? '—'}`);
      console.log(`  ${chalk.dim('Bytes:')}      ${status.bytesTransferred ?? '—'}`);
      if (status.total_tokens !== undefined) {
        console.log(`  ${chalk.dim('Tokens:')}     ${status.total_tokens} (${status.active_tokens} active)`);
        console.log(`  ${chalk.dim('Sessions:')}   ${status.total_sessions} total, ${status.live_sessions} live`);
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


program.parse();

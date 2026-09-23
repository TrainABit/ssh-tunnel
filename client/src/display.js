import chalk from 'chalk';
import ora from 'ora';
import { CLIENT_VERSION, sanitizeText } from './protocol.js';

const BOX_WIDTH = 56;
const MAX_NOTICES = 4;

function clean(value, maxLength = 200) {
  return sanitizeText(value, maxLength);
}

/**
 * Terminal UI for `tunnelvault connect`.
 *
 * interactive (default: stdout is a TTY): spinner + a live status box.
 * non-interactive (systemd/journald, pipes): plain log lines, printed only when
 * something changes — no screen clearing and no once-per-second redraws.
 *
 * Every string that reaches the terminal is stripped of control characters because
 * much of it (public URLs, error messages, request paths) comes from the server.
 */
export class Display {
  constructor({ interactive = Boolean(process.stdout.isTTY), out = process.stdout, err = process.stderr } = {}) {
    this.interactive = interactive;
    this.out = out;
    this.err = err;
    this.status = 'connecting';
    this.publicUrl = '';
    this.localTarget = '';
    this.tunnelLines = null;
    this.requests = [];
    this.maxRequests = 20;
    this.notices = [];
    this.spinner = null;
    this.renderInterval = null;
    this.lastPrintedLines = '';
  }

  _line(text, stream = this.out) {
    stream.write(`${text}\n`);
  }

  startSpinner(text) {
    if (!this.interactive) {
      this._line(clean(text));
      return;
    }
    if (this.spinner) this.spinner.stop();
    this.spinner = ora({ text: clean(text), color: 'cyan' }).start();
  }

  stopSpinner(success, text) {
    if (!this.interactive) {
      if (!success && text) this._line(clean(text, 300), this.err);
      return;
    }
    if (!this.spinner) {
      if (!success && text) this._line(chalk.red(`  ${clean(text, 300)}`), this.err);
      return;
    }
    if (success) this.spinner.succeed(clean(text));
    else this.spinner.fail(clean(text, 300));
    this.spinner = null;
  }

  setConnected(publicUrl, localTarget) {
    this.status = 'online';
    this.publicUrl = publicUrl;
    this.localTarget = localTarget;
    this.tunnelLines = null;
    this.stopSpinner(true, 'Connected to tunnel server');
    if (!this.interactive) {
      this._line(`Tunnel online: ${clean(publicUrl)} -> ${clean(localTarget)}`);
      return;
    }
    this.render();
    this.startLiveRender();
  }

  // Multi-tunnel: lines = [{name, port, public?, status?}]
  setConnectedMulti(lines) {
    const wasOnline = this.status === 'online';
    this.status = 'online';
    this.tunnelLines = lines;
    this.publicUrl = '';
    this.localTarget = '';
    if (!this.interactive) {
      const text = lines
        .map((t) => `  ${clean(t.name, 40)} :${t.port} -> ${clean(t.public || t.status || 'connecting…')}`)
        .join('\n');
      if (!wasOnline) this._line('Connected to tunnel server');
      if (!wasOnline || text !== this.lastPrintedLines) {
        this._line(text);
        this.lastPrintedLines = text;
      }
      return;
    }
    this.stopSpinner(true, 'Connected to tunnel server');
    this.render();
    this.startLiveRender();
  }

  setDisconnected(reason) {
    this.status = 'offline';
    this.lastPrintedLines = '';
    if (!this.interactive) {
      this._line(`Disconnected: ${clean(reason)}`);
      return;
    }
    if (this.spinner) {
      this.spinner.stop();
      this.spinner = null;
    }
    this.stopLiveRender();
    this.render();
    console.log(chalk.red(`\n  Disconnected: ${clean(reason)}`));
  }

  setReconnecting(attempt, delayMs) {
    this.status = 'reconnecting';
    const when = typeof delayMs === 'number' ? ` in ${Math.max(1, Math.round(delayMs / 1000))}s` : '';
    if (!this.interactive) {
      this._line(`Reconnecting (attempt ${attempt})${when}...`);
      return;
    }
    this.stopLiveRender();
    this.render();
    console.log(chalk.yellow(`\n  Reconnecting (attempt ${attempt})${when}...`));
  }

  logRequest(method, path, statusCode, statusText, durationMs) {
    const entry = {
      method: clean(method, 10),
      path: clean(path, 200),
      statusCode,
      statusText: clean(statusText, 40),
      durationMs,
      time: new Date(),
    };
    if (!this.interactive) {
      this._line(`${entry.method} ${entry.path} ${statusCode} ${entry.statusText} ${durationMs}ms`);
      return;
    }
    this.requests.unshift(entry);
    if (this.requests.length > this.maxRequests) this.requests.pop();
  }

  _notice(level, message, stream) {
    const text = clean(message, 300);
    if (!this.interactive) {
      this._line(`${level === 'info' ? '' : `${level.toUpperCase()}: `}${text}`, stream);
      return;
    }
    this.notices.unshift({ level, text, time: new Date() });
    if (this.notices.length > MAX_NOTICES) this.notices.pop();
    if (this.renderInterval) {
      this.render();
    } else {
      const colour = level === 'error' ? chalk.red : level === 'warn' ? chalk.yellow : chalk.dim;
      this._line(colour(`  ${text}`), stream);
    }
  }

  info(message) { this._notice('info', message, this.out); }

  warn(message) { this._notice('warn', message, this.err); }

  error(message) { this._notice('error', message, this.err); }

  startLiveRender() {
    if (!this.interactive || this.renderInterval) return;
    this.renderInterval = setInterval(() => this.render(), 1000);
  }

  stopLiveRender() {
    if (this.renderInterval) {
      clearInterval(this.renderInterval);
      this.renderInterval = null;
    }
  }

  pad(str, len) {
    if (str.length >= len) return str.slice(0, len);
    return str + ' '.repeat(len - str.length);
  }

  stripAnsi(str) {
    // eslint-disable-next-line no-control-regex
    return str.replace(/\x1b\[[0-9;]*m/g, '');
  }

  boxLine(content) {
    const inner = BOX_WIDTH - 4; // 2 for borders, 2 for padding
    const plain = this.stripAnsi(content);
    const padding = Math.max(0, inner - plain.length);
    return `║ ${content}${' '.repeat(padding)} ║`;
  }

  render() {
    if (!this.interactive) return;
    const top    = '╔' + '═'.repeat(BOX_WIDTH - 2) + '╗';
    const mid    = '╠' + '═'.repeat(BOX_WIDTH - 2) + '╣';
    const bottom = '╚' + '═'.repeat(BOX_WIDTH - 2) + '╝';

    const statusColor = this.status === 'online'
      ? chalk.green(this.status)
      : this.status === 'reconnecting'
        ? chalk.yellow(this.status)
        : chalk.red(this.status);

    const lines = [];

    // Clear screen and move cursor to top
    lines.push('\x1b[2J\x1b[H');

    lines.push(top);
    const version = `v${CLIENT_VERSION}`;
    lines.push(this.boxLine(`${chalk.cyan.bold('TunnelVault')}${' '.repeat(Math.max(1, BOX_WIDTH - 4 - 11 - version.length))}${chalk.dim(version)}`));
    lines.push(mid);
    lines.push(this.boxLine(`${chalk.dim('Status:')}    ${statusColor}`));
    if (this.tunnelLines && this.tunnelLines.length > 0) {
      for (const t of this.tunnelLines) {
        const pub = t.public ? chalk.bold(clean(t.public, 30)) : chalk.dim(clean(t.status || 'connecting…', 30));
        lines.push(this.boxLine(`${chalk.dim(this.pad(clean(t.name, 12), 12))}  :${t.port} → ${pub}`));
      }
    } else {
      lines.push(this.boxLine(`${chalk.dim('Public:')}    ${chalk.bold(clean(this.publicUrl, 38) || '—')}`));
      lines.push(this.boxLine(`${chalk.dim('Forward:')}   ${clean(this.localTarget, 38) || '—'}`));
    }
    if (this.notices.length > 0) {
      lines.push(mid);
      for (const n of this.notices) {
        const colour = n.level === 'error' ? chalk.red : n.level === 'warn' ? chalk.yellow : chalk.dim;
        lines.push(this.boxLine(colour(this.pad(n.text, BOX_WIDTH - 4))));
      }
    }
    lines.push(mid);
    lines.push(this.boxLine(chalk.dim('Connections')));

    if (this.requests.length === 0) {
      lines.push(this.boxLine(chalk.dim('  No requests yet')));
    } else {
      for (const req of this.requests.slice(0, 12)) {
        const method = this.pad(req.method, 6);
        const path = this.pad(req.path, 20);
        const code = req.statusCode < 400
          ? chalk.green(`${req.statusCode} ${req.statusText}`)
          : chalk.red(`${req.statusCode} ${req.statusText}`);
        const dur = chalk.dim(`${req.durationMs}ms`);
        lines.push(this.boxLine(`  ${method} ${path} ${code}  ${dur}`));
      }
    }

    lines.push(bottom);
    lines.push('');
    lines.push(chalk.dim('  Press Ctrl+C to disconnect'));

    this.out.write(lines.join('\n') + '\n');
  }

  destroy() {
    this.stopLiveRender();
    if (this.spinner) {
      this.spinner.stop();
      this.spinner = null;
    }
  }
}

/**
 * Display that prints nothing (tests, embedding). Log-level messages can be
 * observed through the optional `onLog(level, message)` callback.
 */
export class QuietDisplay {
  constructor({ onLog } = {}) {
    this.onLog = typeof onLog === 'function' ? onLog : null;
    this.status = 'connecting';
    this.tunnelLines = null;
  }

  _log(level, message) { if (this.onLog) this.onLog(level, String(message)); }

  startSpinner(text) { this._log('debug', text); }

  stopSpinner(success, text) { if (!success && text) this._log('error', text); }

  setConnected() { this.status = 'online'; }

  setConnectedMulti(lines) { this.status = 'online'; this.tunnelLines = lines; }

  setDisconnected(reason) { this.status = 'offline'; this._log('debug', `Disconnected: ${reason}`); }

  setReconnecting(attempt) { this.status = 'reconnecting'; this._log('debug', `Reconnecting (attempt ${attempt})`); }

  logRequest(method, path, statusCode) { this._log('debug', `${method} ${path} ${statusCode}`); }

  info(message) { this._log('info', message); }

  warn(message) { this._log('warn', message); }

  error(message) { this._log('error', message); }

  render() {}

  destroy() {}
}

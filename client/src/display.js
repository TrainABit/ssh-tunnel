import chalk from 'chalk';
import ora from 'ora';

const BOX_WIDTH = 56;

export class Display {
  constructor() {
    this.status = 'connecting';
    this.publicUrl = '';
    this.localTarget = '';
    this.requests = [];
    this.maxRequests = 20;
    this.spinner = null;
    this.renderInterval = null;
  }

  startSpinner(text) {
    this.spinner = ora({ text, color: 'cyan' }).start();
  }

  stopSpinner(success, text) {
    if (!this.spinner) return;
    if (success) {
      this.spinner.succeed(text);
    } else {
      this.spinner.fail(text);
    }
    this.spinner = null;
  }

  setConnected(publicUrl, localTarget) {
    this.status = 'online';
    this.publicUrl = publicUrl;
    this.localTarget = localTarget;
    this.stopSpinner(true, 'Connected to tunnel server');
    this.render();
    this.startLiveRender();
  }

  setDisconnected(reason) {
    this.status = 'offline';
    this.stopLiveRender();
    this.render();
    console.log(chalk.red(`\n  Disconnected: ${reason}`));
  }

  setReconnecting(attempt) {
    this.status = 'reconnecting';
    this.stopLiveRender();
    this.render();
    console.log(chalk.yellow(`\n  Reconnecting (attempt ${attempt})...`));
  }

  logRequest(method, path, statusCode, statusText, durationMs) {
    this.requests.unshift({ method, path, statusCode, statusText, durationMs, time: new Date() });
    if (this.requests.length > this.maxRequests) {
      this.requests.pop();
    }
  }

  startLiveRender() {
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
    lines.push(this.boxLine(`${chalk.cyan.bold('TunnelVault')}                         ${chalk.dim('v1.0.0')}`));
    lines.push(mid);
    lines.push(this.boxLine(`${chalk.dim('Status:')}    ${statusColor}`));
    lines.push(this.boxLine(`${chalk.dim('Public:')}    ${chalk.bold(this.publicUrl || '—')}`));
    lines.push(this.boxLine(`${chalk.dim('Forward:')}   ${this.localTarget || '—'}`));
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

    process.stdout.write(lines.join('\n') + '\n');
  }

  destroy() {
    this.stopLiveRender();
    if (this.spinner) {
      this.spinner.stop();
      this.spinner = null;
    }
  }
}

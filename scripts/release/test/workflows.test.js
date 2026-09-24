'use strict';
// Structural checks of the GitHub workflows (no YAML dependency: the workflows use
// a plain block style, parsed here line by line for the parts that matter).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT } = require('./helpers');

/**
 * Steps of one job: [{ name, workingDirectory, run }] in file order.
 * Handles `run: cmd` and `run: |` blocks, `working-directory:` and `defaults.run`.
 */
function jobSteps(file, job) {
  const lines = fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', file), 'utf8').split('\n');
  const jobStart = lines.findIndex((l) => l === `  ${job}:`);
  assert.ok(jobStart >= 0, `${file}: job ${job} not found`);
  let jobEnd = lines.findIndex((l, i) => i > jobStart && /^ {2}[A-Za-z0-9_-]+:\s*$/.test(l));
  if (jobEnd < 0) jobEnd = lines.length;
  const body = lines.slice(jobStart + 1, jobEnd);
  const stepsAt = body.findIndex((l) => /^ {4}steps:\s*$/.test(l));
  assert.ok(stepsAt >= 0, `${file}: job ${job} has no steps`);
  let defaultWd = '';
  const dm = body.slice(0, stepsAt).join('\n').match(/^ {4}defaults:\n {6}run:\n {8}working-directory:\s*(\S+)/m);
  if (dm) defaultWd = dm[1];

  const steps = [];
  let cur = null;
  let inRun = false;
  for (const line of body.slice(stepsAt + 1)) {
    const start = line.match(/^ {6}- (.*)$/);
    if (start) {
      cur = { name: '', workingDirectory: defaultWd, run: '' };
      steps.push(cur);
      inRun = false;
    }
    if (!cur) continue;
    const content = start ? `        ${start[1]}` : line;
    if (inRun) {
      if (/^ {10}/.test(content) || content.trim() === '') { cur.run += `${content.trim()}\n`; continue; }
      inRun = false;
    }
    const kv = content.match(/^ {8}([A-Za-z-]+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, value] = kv;
    if (key === 'name') cur.name = value.trim();
    else if (key === 'working-directory') cur.workingDirectory = value.trim();
    else if (key === 'run') {
      if (/^[|>]-?\s*$/.test(value)) inRun = true; else cur.run = `${value.trim()}\n`;
    }
  }
  return steps;
}

/** Commands of a step, with `cd DIR &&` prefixes resolved into a directory. */
function commands(step) {
  const out = [];
  for (const raw of step.run.split('\n')) {
    let dir = step.workingDirectory || '.';
    for (const part of raw.split('&&').map((p) => p.trim()).filter(Boolean)) {
      const cd = part.match(/^cd\s+(\S+)$/);
      if (cd) { dir = cd[1]; continue; }
      out.push({ dir: dir.replace(/^\.\//, '').replace(/\/$/, ''), cmd: part });
    }
  }
  return out;
}

function firstIndex(steps, pred) {
  return steps.findIndex((s) => commands(s).some(pred));
}

const npmCiIn = (dir) => (c) => c.dir === dir && /^npm ci\b/.test(c.cmd);
const npmTestIn = (dir) => (c) => c.dir === dir && /^npm (test|run test)\b/.test(c.cmd);

for (const [file, job] of [['release.yml', 'build'], ['ci.yml', 'backend']]) {
  test(`${file} (${job}): client dependencies are installed before the backend tests run (e2e-stack imports the client)`, () => {
    const steps = jobSteps(file, job);
    const backendTest = firstIndex(steps, npmTestIn('backend'));
    assert.ok(backendTest >= 0, `${file}: no step runs npm test in backend/`);
    const clientCi = firstIndex(steps, npmCiIn('client'));
    assert.ok(clientCi >= 0, `${file}: no step runs npm ci in client/`);
    assert.ok(clientCi < backendTest,
      `${file}: "${steps[clientCi].name}" (npm ci in client/) must come before "${steps[backendTest].name}"`);
    const backendCi = firstIndex(steps, npmCiIn('backend'));
    assert.ok(backendCi >= 0 && backendCi <= backendTest, `${file}: backend npm ci before its tests`);
  });
}

test('the workflow step parser sees the order it is given', () => {
  const tmp = { run: 'cd backend && npm ci && npm test\n', workingDirectory: '' };
  assert.deepEqual(commands(tmp), [{ dir: 'backend', cmd: 'npm ci' }, { dir: 'backend', cmd: 'npm test' }]);
  const steps = jobSteps('release.yml', 'build');
  assert.ok(steps.length >= 5);
  assert.ok(steps.some((s) => s.name === 'Release tooling tests'));
});

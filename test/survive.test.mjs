// A deploy restarts the dashboard: a CI job it started keeps going, and the
// next dashboard takes it up and records its result (lib/sandboxci.mjs
// adoptSandboxCi, lib/ci.mjs adoptJob).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adoptSandboxCi, ownWorker } from '../lib/sandboxci.mjs';
import { createCi } from '../lib/ci.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'miu-survive-'));
const check = { label: 'CI', sandbox_ci: { workflow: '.github/workflows/test.yml', job: 'a', timeout_minutes: 5 } };
const PASSED = JSON.stringify({ ok: true, cells: [{ label: 'a', status: 'passed', exit_code: 0, output: '[t/a]   🏁  Job succeeded' }] });
const script = (file, body) => fs.writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const SANDBOXCI = fileURLToPath(new URL('../lib/sandboxci.mjs', import.meta.url));

function repo() {
  const dir = fs.mkdtempSync(path.join(tmp, 'repo-'));
  fs.mkdirSync(path.join(dir, '.github/workflows'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.github/workflows/test.yml'), 'jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps: [{ run: id }]\n');
  const git = (...a) => spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a]);
  git('init', '-q'); git('add', '-A'); git('commit', '-qm', 'x');
  return dir;
}

// sudo runs the worker as given; the worker takes the tar, waits, then
// prints a passing report (and a token, which must not reach the result).
function server(sleep) {
  const bin = fs.mkdtempSync(path.join(tmp, 'bin-'));
  script(path.join(bin, 'sudo'), 'shift 4\nexec "$@"');
  const worker = path.join(bin, 'worker');
  script(worker, `cat > /dev/null\nsleep ${sleep}\necho 'token ghs_${'a'.repeat(36)}' >&2\necho '${PASSED}'`);
  return { ...process.env, PATH: `${bin}:${process.env.PATH}`, MIU_SANDBOX_USER: 'ubuntu', MIU_SANDBOX_WORKER: worker, MIU_CI_MIRRORS_CONF: path.join(tmp, 'none') };
}

test('a worker outlives the dashboard that started it, and the next one reads its result', { timeout: 30000 }, async () => {
  const spool = path.join(fs.mkdtempSync(path.join(tmp, 'ci-')), '0.spool');
  const env = server(3);
  // The "dashboard": starts the job with a spool, says the worker's pid, and is killed.
  const code = `const { runSandboxCi } = await import(${JSON.stringify(SANDBOXCI)});
    runSandboxCi(${JSON.stringify(check)}, ${JSON.stringify(repo())}, process.env, { spool: ${JSON.stringify(spool)}, mint: async () => null, onStart: (pid) => console.log('pid', pid) });`;
  const dash = spawn(process.execPath, ['--input-type=module', '-e', code], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  const pid = await new Promise((resolve) => dash.stdout.on('data', (d) => { const m = /pid (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); }));
  dash.kill('SIGKILL');
  await new Promise((r) => dash.on('exit', r));
  assert.ok(alive(pid), 'the worker goes on without the dashboard');
  const startedAt = Date.now();
  const r = await adoptSandboxCi(check, { pid, live: true, spool, startedAt, pollMs: 100 });
  assert.equal(r.status, 0, JSON.stringify(r));
  assert.ok(Date.now() - startedAt > 1000, 'waited for the worker to end');
  assert.ok(!fs.existsSync(`${spool}.out`) && !fs.existsSync(`${spool}.err`), 'the raw output goes');
});

test('nothing to take up: no spool, or a dead worker that left no report', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'ci-'));
  assert.equal(adoptSandboxCi(check, { pid: 999999, live: false, spool: path.join(dir, 'none') }), null);
  const spool = path.join(dir, '1.spool');
  fs.writeFileSync(`${spool}.out`, 'half a line');
  fs.writeFileSync(`${spool}.err`, 'Killed');
  assert.equal(adoptSandboxCi(check, { pid: 999999, live: false, spool }), null);
  assert.ok(!fs.existsSync(`${spool}.out`));
});

test('a worker that finished while no dashboard ran: its report counts, its token does not show', async () => {
  const spool = path.join(fs.mkdtempSync(path.join(tmp, 'ci-')), '0.spool');
  fs.writeFileSync(`${spool}.out`, `${PASSED}\n`);
  fs.writeFileSync(`${spool}.err`, `x-access-token ${Buffer.from(`x-access-token:ghs_${'b'.repeat(36)}`).toString('base64')}\n`);
  const r = await adoptSandboxCi({ ...check, sandbox_ci: { ...check.sandbox_ci } }, { pid: 999999, live: false, spool });
  assert.equal(r.status, 0);
  assert.doesNotMatch(JSON.stringify(r), /ghs_|eC1hY2Nlc3MtdG9rZW46/);
});

test('a taken-up job still keeps its time limit: its group is stopped', { timeout: 30000 }, async () => {
  const spool = path.join(fs.mkdtempSync(path.join(tmp, 'ci-')), '0.spool');
  fs.writeFileSync(`${spool}.out`, '');
  fs.writeFileSync(`${spool}.err`, '');
  const p = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
  const r = await adoptSandboxCi(check, { pid: p.pid, live: true, spool, startedAt: Date.now() - 10 * 60 * 1000, limitMs: 1000, pollMs: 50 });
  assert.match(r.notRun, /time limit/);
  await new Promise((res) => (p.exitCode !== null || p.signalCode ? res() : p.on('exit', res)));
  assert.equal(p.signalCode, 'SIGTERM');
  await new Promise((res) => setTimeout(res, 200));
  assert.ok(!fs.existsSync(`${spool}.out`), 'the raw output goes after a time limit too');
});

test('a release runs its own copy of the worker when one is installed', () => {
  const lib = fs.mkdtempSync(path.join(tmp, 'lib-'));
  const sha = 'd'.repeat(40);
  const worker = path.join(lib, 'sandbox-ci');
  assert.equal(ownWorker(worker, sha), worker, 'none installed: the shared one');
  fs.mkdirSync(path.join(lib, 'versions', sha), { recursive: true });
  fs.writeFileSync(path.join(lib, 'versions', sha, 'sandbox-ci'), '');
  assert.equal(ownWorker(worker, sha), worker, 'the sudo rule does not allow the copies yet');
  fs.writeFileSync(path.join(lib, 'versions', '.per-release'), '');
  assert.equal(ownWorker(worker, sha), path.join(lib, 'versions', sha, 'sandbox-ci'));
  assert.equal(ownWorker(worker, ''), worker, 'a checkout with no REVISION');
});

const settle = () => new Promise((r) => setTimeout(r, 30));
const workflows = { '.github/workflows/ci.yml': { on: 'pull_request', jobs: { a: { 'runs-on': 'ubuntu-latest', steps: [{ run: 'true' }] } } } };
const SHA = 'c'.repeat(40);
function line({ dir, adoptJob, started = [] }) {
  return createCi({
    dir, adoptJob, now: Date.now,
    prepare: async () => ({ gitDir: '/x', workflows: Object.entries(workflows).map(([p, d]) => ({ path: p, text: JSON.stringify(d) })) }),
    parse: (files) => files.map((f) => ({ path: f.path, doc: JSON.parse(f.text) })),
    runJob: (c, g, s, opts) => new Promise((resolve) => { started.push({ resolve, opts }); opts.onStart?.(process.pid + 100000); }),
  });
}

test('the line: a restarted dashboard waits for a job it can take up, and records its end', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'line-'));
  const started = [];
  const a = line({ dir, started });
  a.ensure('o/r', 1, SHA);
  await settle();
  assert.equal(started.length, 1);
  assert.match(started[0].opts.spool, /\.spool$/, 'the job writes to files, so it outlives the dashboard');
  // The dashboard restarts; this one can take the job up.
  let finish; const asked = [];
  const b = line({ dir, adoptJob: (c, job) => { asked.push(job); return new Promise((r) => { finish = r; }); } });
  assert.equal(asked.length, 1);
  assert.equal(asked[0].spool, started[0].opts.spool);
  assert.equal(b.view(b.get('o/r', 1, SHA)).jobs[0].status, 'running');
  assert.equal(b.running(), 1);
  finish({ status: 0, out: '1 of 1 passed' });
  await settle();
  const j = b.view(b.get('o/r', 1, SHA)).jobs[0];
  assert.equal(j.status, 'passed');
  assert.equal(j.attempts, 1, 'not run again');
  // One it cannot take up runs again, as before.
  const dir2 = fs.mkdtempSync(path.join(tmp, 'line-'));
  const c = line({ dir: dir2 });
  c.ensure('o/r', 1, SHA); await settle();
  const d = line({ dir: dir2, adoptJob: () => null, started: [] });
  assert.equal(d.view(d.get('o/r', 1, SHA)).jobs[0].attempts, 1);
  assert.match(d.view(d.get('o/r', 1, SHA)).jobs[0].waitReason ?? '', /restarted/);
});

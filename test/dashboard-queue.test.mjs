// The queue's switches on a real dashboard: through the API and bin/miu-queue,
// and still set after the dashboard restarts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'miu-dash-'));
const runs = path.join(tmp, 'runs');
const profilesDir = path.join(tmp, 'profiles');
fs.mkdirSync(profilesDir);
fs.writeFileSync(path.join(profilesDir, 'project.json'), JSON.stringify({ owner: 'acme' }));
const port = 40000 + Math.floor(Math.random() * 20000);
const env = { ...process.env, HOME: tmp, MIU_PROFILES: profilesDir, MIU_AUTH: '', MIU_HOST: '127.0.0.1', MIU_SANDBOX_USER: '', MIU_SANDBOX_WORKER: '' };

function startDashboard() {
  const child = spawn(process.execPath, [path.join(ROOT, 'bin/qa-dashboard'), '--port', String(port), '--runs', runs], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no start in 20 s:\n${out}`)), 20000);
    const seen = (d) => { out += d; if (/listening on/.test(out)) { clearTimeout(timer); resolve(child); } };
    child.stdout.on('data', seen); child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (c) => { clearTimeout(timer); reject(new Error(`exited ${c}:\n${out}`)); });
  });
}
const stop = (child) => new Promise((r) => { child.removeAllListeners('exit'); child.on('exit', r); child.kill('SIGTERM'); });
const api = (p, body) => fetch(`http://127.0.0.1:${port}${p}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-QA-Dashboard': '1' }, body: JSON.stringify(body) });
const cli = (...args) => new Promise((resolve) => {
  const c = spawn(process.execPath, [path.join(ROOT, 'bin/miu-queue'), ...args, '--runs', runs], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
  c.on('close', (code) => resolve({ code, out }));
});

test('auto/manual and pause through the API and the CLI survive a restart', { timeout: 90000 }, async () => {
  let dash = await startDashboard();
  try {
    let q = await (await api('/api/queue')).json();
    assert.equal(q.mode, 'auto');
    assert.equal(q.paused, false);

    q = await (await api('/api/queue/control', { paused: true })).json();
    assert.equal(q.paused, true);
    // A write without the dashboard's own header is refused.
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/queue/control`, { method: 'POST', body: '{"paused":false}' })).status, 403);

    const m = await cli('manual', '--json');
    assert.equal(m.code, 0, m.out);
    assert.equal(JSON.parse(m.out).result.mode, 'manual');

    const s = await cli('status');
    assert.equal(s.code, 0, s.out);
    assert.match(s.out, /Mode: manual, PAUSED/);
    assert.match(s.out, /CI: 0 running, 0 queued, up to 2 at once/);

    // Only repos Miu tests can be started, from either place.
    assert.match((await (await api('/api/queue/start', { prs: [{ repo: 'evil/repo', pr: 1 }] })).json()).error, /not a pull request Miu tests/);
    const bad = await cli('start', 'evil/repo#1');
    assert.equal(bad.code, 1);
    assert.match(bad.out, /not a pull request Miu tests/);
    assert.equal((await cli('pause', 'extra')).code, 2, 'usage');

    // A CI log name cannot leave the CI folder.
    assert.equal((await api('/api/ci/log?key=..%2F.config&n=0')).status, 404);
    assert.equal((await (await api('/api/ci?repo=acme/x&pr=1')).json()), null);
  } finally { await stop(dash); }

  const inbox = fs.statSync(path.join(runs, '.inbox'));
  assert.equal(inbox.mode & 0o777, 0o700, 'only Miu\'s account can write requests');

  dash = await startDashboard();
  try {
    const q = await (await api('/api/queue')).json();
    assert.equal(q.mode, 'manual');
    assert.equal(q.paused, true);
    assert.ok(q.pausedBy);
    const r = await cli('resume', '--json');
    assert.equal(JSON.parse(r.out).result.paused, false);
    const a = await (await api('/api/queue/control', { mode: 'auto' })).json();
    assert.equal(a.mode, 'auto');
    assert.match((await (await api('/api/queue/control', { mode: 'sometimes' })).json()).error, /auto or manual/);
  } finally { await stop(dash); }
});

test('the CLI says so when no dashboard answers', { timeout: 30000 }, () => {
  const lone = fs.mkdtempSync(path.join(tmp, 'lone-'));
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin/miu-queue'), 'status', '--runs', lone], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /is the dashboard running/);
});

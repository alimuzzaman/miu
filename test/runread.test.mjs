// bin/miu-run-read: a run's outputs, read-only, with every credential refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const READ = fileURLToPath(new URL('../bin/miu-run-read', import.meta.url));
const linux = { skip: process.platform === 'linux' ? false : 'needs /proc and GNU tools' };

function runs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miu-runread-'));
  const runsDir = path.join(root, 'runs');
  const r = path.join(runsDir, 'xspeed-1-run');
  const put = (rel, body = 'x') => { fs.mkdirSync(path.dirname(path.join(r, rel)), { recursive: true }); fs.writeFileSync(path.join(r, rel), body); };
  put('run.log', 'the log\n');
  put('context/pr.json', '{}');
  put('evidence/ev-1.log', 'ev');
  put('env/qa-network-guard/hosts.txt');
  put('private/hub-pr-admin.json', 'cookie');
  put('.hidden', 'h');
  put('context/.env', 'E=1');
  put('pr-hub-1.totp', 's');
  put('deploy_key', 'k');
  put('context/github-token.txt', 't');
  put('client_secret.json', 's');
  put('API_KEY.md', 'k');
  fs.mkdirSync(path.join(runsDir, '.stacks'));
  fs.writeFileSync(path.join(runsDir, '.stacks', 'pr-hub-1.totp'), 's');
  fs.writeFileSync(path.join(runsDir, '.config.json'), '{}');
  fs.mkdirSync(path.join(runsDir, '.ci'));
  fs.writeFileSync(path.join(root, 'outside.txt'), 'outside');
  fs.mkdirSync(path.join(root, 'elsewhere'));
  fs.writeFileSync(path.join(root, 'elsewhere', 'run.log'), 'not a run');
  const env = { ...process.env, MIU_RUN_READ_ROOT: runsDir };
  delete env.SUDO_UID;
  const read = (...args) => spawnSync(READ, args, { env, encoding: 'utf8' });
  return { root, runsDir, r, put, read, env };
}

const refused = (res, re) => {
  assert.equal(res.status, 2, `${res.stdout}${res.stderr}`);
  assert.equal(res.stdout, '');
  assert.match(res.stderr, re);
};

test('cat reads a run file; ls lists what it would read, and nothing it refuses', linux, () => {
  const s = runs();
  const c = s.read('cat', 'xspeed-1-run', 'run.log');
  assert.equal(c.status, 0, c.stderr);
  assert.equal(c.stdout, 'the log\n');
  assert.equal(s.read('cat', 'xspeed-1-run', 'context/pr.json').stdout, '{}');
  const l = s.read('ls', 'xspeed-1-run');
  assert.equal(l.status, 0, l.stderr);
  const lines = l.stdout.trim().split('\n').map((x) => JSON.parse(x));
  assert.deepEqual(lines.find((x) => x.path === 'run.log'), { type: 'f', size: 8, path: 'run.log' });
  assert.deepEqual(lines.find((x) => x.path === 'context'), { type: 'd', path: 'context' });
  assert.ok(lines.some((x) => x.path === 'context/pr.json' && x.size === 2));
  assert.ok(lines.some((x) => x.path === 'evidence/ev-1.log'));
  assert.doesNotMatch(l.stdout, /env|private|hidden|\.env|totp|deploy_key|token|secret|API_KEY/);
});

test('a run name that is not one, a dot run or a run outside the runs folder is refused', linux, () => {
  const s = runs();
  for (const name of ['../elsewhere', 'a/b', '.stacks', '.ci', '.', '..', 'x y', '', 'run;rm']) {
    refused(s.read('ls', name), /not a run name/);
  }
  fs.symlinkSync(path.join(s.root, 'elsewhere'), path.join(s.runsDir, 'escape'));
  refused(s.read('ls', 'escape'), /not a folder of the runs directory/);
  refused(s.read('cat', 'escape', 'run.log'), /not a folder of the runs directory/);
  fs.symlinkSync(s.r, path.join(s.runsDir, 'alias'));
  refused(s.read('ls', 'alias'), /not a folder of the runs directory/);
  refused(s.read('ls', 'nope'), /no such run/);
});

test('paths that leave the run are refused, by .. or by a symbolic link', linux, () => {
  const s = runs();
  for (const p of ['../../outside.txt', '/etc/passwd', 'context/../../x', './run.log', 'context//pr.json', '']) refused(s.read('cat', 'xspeed-1-run', p), /not a path inside the run/);
  fs.symlinkSync(path.join(s.root, 'outside.txt'), path.join(s.r, 'out.log'));
  refused(s.read('cat', 'xspeed-1-run', 'out.log'), /leaves the run/);
  fs.symlinkSync(path.join(s.root), path.join(s.r, 'up'));
  refused(s.read('cat', 'xspeed-1-run', 'up/outside.txt'), /leaves the run/);
  assert.doesNotMatch(s.read('ls', 'xspeed-1-run').stdout, /out\.log|"up/, 'ls never follows or lists a link');
});

test('a link inside the run that resolves to a refused file is refused', linux, () => {
  const s = runs();
  fs.symlinkSync(path.join(s.r, 'private/hub-pr-admin.json'), path.join(s.r, 'state.json'));
  refused(s.read('cat', 'xspeed-1-run', 'state.json'), /private/);
  fs.symlinkSync(path.join(s.r, 'pr-hub-1.totp'), path.join(s.r, 'plain.txt'));
  refused(s.read('cat', 'xspeed-1-run', 'plain.txt'), /totp/);
});

test('every credential kind is refused', linux, () => {
  const s = runs();
  const cases = [
    ['env/qa-network-guard/hosts.txt', /env\//],
    ['private/hub-pr-admin.json', /private\//],
    ['.hidden', /dotfile/],
    ['context/.env', /dotfile/],
    ['pr-hub-1.totp', /totp/],
    ['deploy_key', /key, token or secret/],
    ['context/github-token.txt', /key, token or secret/],
    ['client_secret.json', /key, token or secret/],
    ['API_KEY.md', /key, token or secret/],
  ];
  for (const [p, re] of cases) refused(s.read('cat', 'xspeed-1-run', p), re);
});

test('only regular files of at most 50 MB are read', linux, () => {
  const s = runs();
  const big = path.join(s.r, 'evidence/big.log');
  fs.writeFileSync(big, '');
  fs.truncateSync(big, 50 * 1024 * 1024 + 1);
  refused(s.read('cat', 'xspeed-1-run', 'evidence/big.log'), /over 50 MB/);
  fs.truncateSync(big, 50 * 1024 * 1024);
  const ok = spawnSync(READ, ['cat', 'xspeed-1-run', 'evidence/big.log'], { env: s.env, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  refused(s.read('cat', 'xspeed-1-run', 'context'), /not a regular file/);
  const fifo = spawnSync('mkfifo', [path.join(s.r, 'pipe.log')]);
  assert.equal(fifo.status, 0);
  refused(s.read('cat', 'xspeed-1-run', 'pipe.log'), /not a regular file/);
});

test('it writes nothing, takes only its two verbs, and under sudo ignores the test root', linux, () => {
  const s = runs();
  const before = spawnSync('find', [s.root, '-printf', '%p %s %T@\n'], { encoding: 'utf8' }).stdout;
  s.read('ls', 'xspeed-1-run'); s.read('cat', 'xspeed-1-run', 'run.log');
  assert.equal(spawnSync('find', [s.root, '-printf', '%p %s %T@\n'], { encoding: 'utf8' }).stdout, before);
  refused(s.read('rm', 'xspeed-1-run'), /usage/);
  refused(s.read('cat', 'xspeed-1-run'), /usage/);
  refused(s.read('ls', 'xspeed-1-run', 'extra'), /usage/);
  const sudo = spawnSync(READ, ['cat', 'xspeed-1-run', 'run.log'], { env: { ...s.env, SUDO_UID: '1000' }, encoding: 'utf8' });
  assert.notEqual(sudo.stdout, 'the log\n', 'MIU_RUN_READ_ROOT is not honoured under sudo');
});

test('a second name for a file is refused, and ls leaves it out', linux, () => {
  const s = runs();
  fs.linkSync(path.join(s.r, 'private/hub-pr-admin.json'), path.join(s.r, 'evidence/session.json'));
  refused(s.read('cat', 'xspeed-1-run', 'evidence/session.json'), /more than one link/);
  assert.doesNotMatch(s.read('ls', 'xspeed-1-run').stdout, /session\.json/);
});

test('ls cannot forge a line or send a control character to the terminal', linux, () => {
  const s = runs();
  s.put('evidence/a\nf 1 fake\u001b[2J.log', 'x');
  const l = s.read('ls', 'xspeed-1-run');
  assert.equal(l.status, 0, l.stderr);
  assert.doesNotMatch(l.stdout, /\u001b/);
  const lines = l.stdout.trim().split('\n');
  for (const x of lines) JSON.parse(x);
  assert.ok(lines.map((x) => JSON.parse(x)).some((x) => x.path === 'evidence/a\nf 1 fake\u001b[2J.log'));
});

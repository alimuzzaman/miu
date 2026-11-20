// bin/miu-pr-stack, the one command Miu runs as Sandbox's account for PR
// stacks: it must build every Sandbox argument itself and refuse anything else.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'miu-pr-stack');

function harness({ fail = '', list = '' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miu-pr-stack-'));
  const log = path.join(dir, 'calls');
  const sb = path.join(dir, 'sb');
  // Records each call's argv as one JSON line; FAIL names a verb that fails.
  fs.writeFileSync(sb, `#!${process.execPath}
const fs = require('fs'); const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + '\\n');
if (process.env.LIST && a.join(' ').includes('stack list')) { console.log(process.env.LIST); process.exit(0); }
if (process.env.FAIL && a.join(' ').includes(process.env.FAIL)) { console.log('{"ok":false,"code":"' + process.env.FAIL_CODE + '"}'); process.exit(1); }
console.log('{"ok":true}');
`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'meminfo'), 'MemTotal:       24608768 kB\nMemAvailable:   13963264 kB\n');
  const root = path.join(dir, 'follow');
  fs.mkdirSync(path.join(root, 'work'), { recursive: true });
  const run = (...args) => spawnSync('bash', [WORKER, ...args], {
    encoding: 'utf8',
    env: { ...process.env, MIU_PR_STACK_SB: sb, MIU_PR_STACK_FOLLOW_ROOT: root, MIU_PR_STACK_MEMINFO: path.join(dir, 'meminfo'), FAIL: fail.split(':')[0] ?? '', FAIL_CODE: fail.split(':')[1] ?? '', LIST: list },
  });
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  return { run, calls, root };
}

test('mem reports MemAvailable in MB', () => {
  const h = harness();
  const r = h.run('mem');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), String(Math.floor(13963264 / 1024)));
});

test('add (WordPress only): the fixed org, setup main, licensing, template and ref; the PR names only branches', () => {
  const h = harness();
  const r = h.run('add', 'wp-pr-free-412', 'wp', 'free=fix/thing', 'pro=dev');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(h.calls(), [['host', 'follow', 'add', '--name', 'wp-pr-free-412',
    '--repo', 'setup=WPDevelopers/xspeed-dev-setup@main',
    '--repo', 'free=WPDevelopers/xspeed@fix/thing',
    '--repo', 'pro=WPDevelopers/xspeed-pro@dev',
    '--repo', 'licensing=WPDevelopers/licensing@main',
    '--stack-template', '{dir}/stage/sandbox.hosting.yml', '--ref', 'stack/wp-pr-free-412',
    '--prepare', '{repo:setup}/stacks/follow-prepare.sh wp {name}', '--prepare-timeout', '3600',
    '--owner', 'miu', '--generate', '--here', '--json']]);
});

test('add (full): the Hub follows too, with the overlay template', () => {
  const h = harness();
  const r = h.run('add', 'pr-hub-88', 'full', 'free=dev', 'pro=dev', 'hub=feat/x');
  assert.equal(r.status, 0, r.stderr);
  const a = h.calls()[0];
  assert.ok(a.includes('hub=WPDevelopers/xspeed-hub@feat/x'));
  assert.equal(a[a.indexOf('--stack-template') + 1], '{dir}/hub-pr-hub-88/sandbox.full.hosting.yml');
  assert.equal(a[a.indexOf('--ref') + 1], 'sandbox-env/pr-hub-88');
  assert.equal(a[a.indexOf('--prepare') + 1], '{repo:setup}/stacks/follow-prepare.sh full {name}');
});

test('add refuses names, kinds and branches it did not make, before calling Sandbox', () => {
  const h = harness();
  const bad = [
    ['dev', 'wp', 'free=a', 'pro=b'],                           // not a PR stack
    ['wp-pr-free-1', 'full', 'free=a', 'pro=b', 'hub=c'],       // kind and name disagree
    ['pr-hub-1', 'wp', 'free=a', 'pro=b'],
    ['wp-pr-free-1', 'wp', 'free=--upload-pack=x', 'pro=b'],    // an option
    ['wp-pr-free-1', 'wp', 'free=a b', 'pro=b'],
    ['wp-pr-free-1', 'wp', 'free=a/../../x', 'pro=b'],
    ['wp-pr-free-1', 'wp', 'free=a;id', 'pro=b'],
    ['wp-pr-free-1', 'wp', 'free=a', 'pro=b', 'hub=c'],         // no Hub in a WordPress-only stack
    ['pr-hub-1', 'full', 'free=a', 'pro=b'],                    // a full stack needs one
    ['wp-pr-free-1', 'wp', 'free=a'],                           // pro missing
    ['wp-pr-free-1', 'wp', 'free=a', 'free=b', 'pro=c'],
    ['wp-pr-free-1', 'wp', 'setup=evil', 'free=a', 'pro=b'],    // the setup repo is not the caller's
    ['wp-pr-free-1', 'wp', 'free=HEAD', 'pro=b'],
  ];
  for (const args of bad) assert.equal(h.run('add', ...args).status, 2, args.join(' '));
  assert.deepEqual(h.calls(), [], 'Sandbox was never called');
  assert.equal(h.run('status', '../x').status, 2);
  assert.equal(h.run('remove', 'pr-free-1/..').status, 2);
  assert.equal(h.run('exec', 'x').status, 2);
});

test('remove: pause, remove, stack down, then the clones', () => {
  const h = harness();
  fs.mkdirSync(path.join(h.root, 'work', 'wp-pr-free-9', 'repos'), { recursive: true });
  const r = h.run('remove', 'wp-pr-free-9');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(h.calls().map((a) => a.slice(0, 3)), [['host', 'follow', 'pause'], ['host', 'follow', 'remove'], ['host', 'stack', 'down']]);
  assert.ok(h.calls()[2].includes('--confirm'));
  assert.equal(fs.existsSync(path.join(h.root, 'work', 'wp-pr-free-9')), false);
});

test('remove while an attempt runs stops before the stack goes, and is asked again later', () => {
  const h = harness({ fail: 'follow remove:follow_attempt_running' });
  const r = h.run('remove', 'wp-pr-free-9');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /follow_attempt_running/);
  assert.deepEqual(h.calls().map((a) => a.slice(0, 3)), [['host', 'follow', 'pause'], ['host', 'follow', 'remove']]);
});

test('remove of a follow already gone still takes the stack down (safe to repeat)', () => {
  const h = harness({ fail: 'follow remove:follow_not_found' });
  assert.equal(h.run('remove', 'pr-hub-3').status, 0);
  assert.deepEqual(h.calls().at(-1).slice(0, 3), ['host', 'stack', 'down']);
});

test('remove of a stack already gone (reaped, taken down) finishes: no retry loop', () => {
  const h = harness({ fail: 'stack down:stack_not_found' });
  fs.mkdirSync(path.join(h.root, 'work', 'pr-hub-5'), { recursive: true });
  assert.equal(h.run('remove', 'pr-hub-5').status, 0);
  assert.equal(fs.existsSync(path.join(h.root, 'work', 'pr-hub-5')), false);
});

test('any other stack down failure is reported and asked again', () => {
  const h = harness({ fail: 'stack down:host_target_busy' });
  const r = h.run('remove', 'pr-hub-6');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /host_target_busy/);
});

test('under sudo the test-only paths are ignored', () => {
  const h = harness();
  const r = spawnSync('bash', [WORKER, 'status', 'pr-hub-7'], { encoding: 'utf8', env: { ...process.env, SUDO_USER: 'miu', MIU_PR_STACK_SB: '/bin/echo-should-not-run', HOME: os.tmpdir() } });
  assert.notEqual(r.stdout.trim(), 'host follow status --name pr-hub-7 --here --json');
  assert.deepEqual(h.calls(), []);
});

test('a symlinked work folder is left alone', () => {
  const h = harness();
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-'));
  fs.symlinkSync(target, path.join(h.root, 'work', 'pr-hub-4'));
  assert.equal(h.run('remove', 'pr-hub-4').status, 2);
  assert.ok(fs.existsSync(target));
});

test('ports: a stack\'s ports and incarnation from stack list, through --here; unknown stacks and bad names refused', () => {
  const list = JSON.stringify({ ok: true, stacks: [
    { slug: 'pr-hub-base', created_at: '2026-11-17T07:00:00Z', copy_id: 'ab12', ports: { mailpit: 18123 }, hostnames: ['x'], owner: { label: 'miu' } },
    { slug: 'pr-hub-9', created_at: 'other', copy_id: 'cd34', ports: {} },
  ] });
  const h = harness({ list });
  const r = h.run('ports', 'pr-hub-base');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').pop()), { ok: true, slug: 'pr-hub-base', created_at: '2026-11-17T07:00:00Z', copy_id: 'ab12', ports: { mailpit: 18123 } });
  assert.deepEqual(h.calls().at(-1), ['host', 'stack', 'list', '--here', '--json']);
  const missing = h.run('ports', 'pr-hub-77');
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /stack_not_found/);
  assert.notEqual(h.run('ports', 'guided-setup').status, 0, 'only PR stack names');
  assert.notEqual(h.run('ports', 'pr-hub-base;id').status, 0);
});

test('add: pr-hub-base is a full stack name; a WordPress-only base is refused', () => {
  const h = harness();
  assert.equal(h.run('add', 'pr-hub-base', 'full', 'free=dev', 'pro=dev', 'hub=dev').status, 0);
  assert.notEqual(h.run('add', 'pr-hub-base', 'wp', 'free=dev', 'pro=dev').status, 0);
});

// wp-session: Docker stands in for the stack's wp-setup container. It records
// each call's argv and stdin, lists IDS for `ps`, and answers `exec` with ANSWER.
function dockerHarness({ ids = 'c0ffee', answer = '{"ok":true}' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miu-pr-stack-docker-'));
  const log = path.join(dir, 'calls');
  const docker = path.join(dir, 'docker');
  fs.writeFileSync(docker, `#!${process.execPath}
const fs = require('fs'); const a = process.argv.slice(2);
let stdin = ''; if (a[0] === 'exec') { try { stdin = fs.readFileSync(0, 'utf8'); } catch {} }
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ a, stdin }) + '\\n');
if (a[0] === 'ps') { if (process.env.IDS) console.log(process.env.IDS); process.exit(0); }
// HOLD_MS: how long an exec takes, with its start and end logged, to see overlap.
if (process.env.HOLD_MS) { fs.appendFileSync(${JSON.stringify(log)} + '.spans', 'start ' + Date.now() + '\\n'); const until = Date.now() + Number(process.env.HOLD_MS); while (Date.now() < until) {} fs.appendFileSync(${JSON.stringify(log)} + '.spans', 'end ' + Date.now() + '\\n'); }
console.log(process.env.ANSWER);
`, { mode: 0o755 });
  const env = { ...process.env, MIU_PR_STACK_DOCKER: docker, MIU_PR_STACK_SB: '/nonexistent-sb', MIU_PR_STACK_LOCKS: path.join(dir, 'locks'), IDS: ids, ANSWER: answer };
  const run = (args, input) => spawnSync('bash', [WORKER, ...args], { encoding: 'utf8', input, env });
  const spawnRun = (args, input, extra = {}) => new Promise((resolve) => {
    const c = spawn('bash', [WORKER, ...args], { env: { ...env, ...extra } });
    let out = ''; c.stdout.on('data', (d) => { out += d; });
    c.on('close', (code) => resolve({ code, out }));
    c.stdin.end(input);
  });
  const spans = () => fs.readFileSync(`${log}.spans`, 'utf8').trim().split('\n').map((l) => l.split(' '));
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  return { run, calls, spawnRun, spans };
}
const TOKEN = 'Abcdefghij0123456789Abcdefghij0123456789Abc';

test('wp-session: the token goes to the stack\'s wp-setup on stdin, never in argv, and the answer comes back as it is', () => {
  const h = dockerHarness({ answer: '{"ok":true,"host":"wp-pr-hub-7.xspeedcdn.online"}' });
  const r = h.run(['wp-session', 'pr-hub-7', 'xspeed-hub-7-run'], `${TOKEN}\n`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '{"ok":true,"host":"wp-pr-hub-7.xspeedcdn.online"}');
  const [ps, ex] = h.calls();
  assert.deepEqual(ps.a, ['ps', '-q', '--filter', 'label=com.docker.compose.project=sandbox-host-xspeed-hub-pr-hub-7-sandbox', '--filter', 'label=com.docker.compose.service=wp-setup']);
  assert.deepEqual(ex.a.slice(0, 10), ['exec', '-i', '-u', '33:33', '-w', '/var/www/html', '-e', 'HOME=/tmp', '-e', 'MIU_RUN=xspeed-hub-7-run']);
  assert.deepEqual(ex.a.slice(10, 15), ['c0ffee', 'wp', 'eval', '--skip-plugins', '--skip-themes']);
  assert.match(ex.a[15], /session_tokens/);
  assert.equal(ex.stdin, `${TOKEN}\n`);
  assert.ok(!JSON.stringify(h.calls().map((c) => c.a)).includes(TOKEN), 'the token is in no argv');
  assert.ok(!r.stdout.includes(TOKEN) && !r.stderr.includes(TOKEN));
});

test('wp-session-end: no stdin, the same container and run', () => {
  const h = dockerHarness({ answer: '{"ok":true,"ended":1}' });
  const r = h.run(['wp-session-end', 'pr-hub-base', 'run-1'], 'ignored\n');
  assert.equal(r.status, 0, r.stderr);
  const ex = h.calls()[1];
  assert.equal(ex.stdin, '');
  assert.ok(ex.a.includes('MIU_RUN=run-1'));
  assert.match(ex.a.at(-1), /delete_user_meta|update_user_meta/);
});

test('wp-session refuses a bad stack, run or token, and says when there is no one container', () => {
  const h = dockerHarness();
  for (const [args, input] of [
    [['wp-session', 'wp-pr-free-3', 'run'], `${TOKEN}\n`],
    [['wp-session', 'pr-hub-7', '.hidden'], `${TOKEN}\n`],
    [['wp-session', 'pr-hub-7', 'a/b'], `${TOKEN}\n`],
    [['wp-session', 'pr-hub-7'], `${TOKEN}\n`],
    [['wp-session', 'pr-hub-7', 'run'], 'short\n'],
    [['wp-session', 'pr-hub-7', 'run'], `${TOKEN}|x\n`],
    [['wp-session', 'pr-hub-7', 'run'], ''],
  ]) {
    const r = h.run(args, input);
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.ok(!h.calls().some((c) => c.a[0] === 'exec'), 'nothing ran in the container');
  }
  const none = dockerHarness({ ids: '' }).run(['wp-session', 'pr-hub-7', 'run'], `${TOKEN}\n`);
  assert.equal(none.status, 1);
  assert.equal(none.stdout.trim(), '{"ok":false,"code":"wp_container_not_found"}');
  const two = dockerHarness({ ids: 'a1\nb2' }).run(['wp-session-end', 'pr-hub-7', 'run'], '');
  assert.equal(two.status, 1);
  assert.equal(two.stdout.trim(), '{"ok":false,"code":"wp_container_ambiguous"}');
});

test('session changes on one stack run one at a time, so an end is never undone by a start beside it', async () => {
  const h = dockerHarness({ answer: '{"ok":true}' });
  const [a, b, c] = await Promise.all([
    h.spawnRun(['wp-session', 'pr-hub-7', 'run-a'], `${TOKEN}\n`, { HOLD_MS: '400' }),
    h.spawnRun(['wp-session-end', 'pr-hub-7', 'run-b'], '', { HOLD_MS: '400' }),
    h.spawnRun(['wp-session', 'pr-hub-7', 'run-c'], `${TOKEN}\n`, { HOLD_MS: '400' }),
  ]);
  assert.deepEqual([a.code, b.code, c.code], [0, 0, 0]);
  const s = h.spans();
  assert.equal(s.length, 6);
  for (let i = 0; i < s.length; i += 2) assert.deepEqual([s[i][0], s[i + 1][0]], ['start', 'end'], 'each exec ends before the next starts');
});

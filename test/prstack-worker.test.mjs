// bin/miu-pr-stack, the one command Miu runs as Sandbox's account for PR
// stacks: it must build every Sandbox argument itself and refuse anything else.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'miu-pr-stack');

function harness({ fail = '' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miu-pr-stack-'));
  const log = path.join(dir, 'calls');
  const sb = path.join(dir, 'sb');
  // Records each call's argv as one JSON line; FAIL names a verb that fails.
  fs.writeFileSync(sb, `#!${process.execPath}
const fs = require('fs'); const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + '\\n');
if (process.env.FAIL && a.join(' ').includes(process.env.FAIL)) { console.log('{"ok":false,"code":"' + process.env.FAIL_CODE + '"}'); process.exit(1); }
console.log('{"ok":true}');
`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'meminfo'), 'MemTotal:       24608768 kB\nMemAvailable:   13963264 kB\n');
  const root = path.join(dir, 'follow');
  fs.mkdirSync(path.join(root, 'work'), { recursive: true });
  const run = (...args) => spawnSync('bash', [WORKER, ...args], {
    encoding: 'utf8',
    env: { ...process.env, MIU_PR_STACK_SB: sb, MIU_PR_STACK_FOLLOW_ROOT: root, MIU_PR_STACK_MEMINFO: path.join(dir, 'meminfo'), FAIL: fail.split(':')[0] ?? '', FAIL_CODE: fail.split(':')[1] ?? '' },
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

test('a symlinked work folder is left alone', () => {
  const h = harness();
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-'));
  fs.symlinkSync(target, path.join(h.root, 'work', 'pr-hub-4'));
  assert.equal(h.run('remove', 'pr-hub-4').status, 2);
  assert.ok(fs.existsSync(target));
});

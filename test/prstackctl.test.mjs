import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStacks, fromStatus } from '../lib/prstackctl.mjs';
import { CAP } from '../lib/prstacks.mjs';

const pr = (n, extra = {}) => ({ headRepo: 'WPDevelopers/xspeed', headRefName: `fix/${n}`, headRefOid: `sha${n}`, ...extra });

function setup({ mem = '8000', answers = {} } = {}) {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miu-stacks-'));
  const calls = [];
  let t = Date.UTC(2026, 10, 16);
  const run = async (args) => {
    calls.push(args);
    if (args[0] === 'mem') return { code: 0, out: mem };
    const a = answers[args.join(' ')] ?? answers[args[0]];
    return a ?? { code: 0, out: '{"ok":true}' };
  };
  const st = createStacks({ runsDir, run, now: () => t, log: () => {} });
  return { st, calls, runsDir, tick: (ms) => { t += ms; } };
}

test('a queued same-org PR gets a WordPress-only stack on the next scan', async () => {
  const { st, calls } = setup();
  st.want('WPDevelopers/xspeed', 7, 'free', pr(7));
  await st.scan({ open: new Map([['WPDevelopers/xspeed#7', 'sha7']]) });
  assert.deepEqual(calls.at(-1), ['add', 'wp-pr-free-7', 'wp', 'free=fix/7', 'pro=dev']);
  assert.equal(st.view('WPDevelopers/xspeed#7').state, 'following');
  assert.equal(st.view('WPDevelopers/xspeed#7').urls.site, 'https://wp-pr-free-7.xspeedcdn.online');
});

test('a fork is refused and Sandbox is never asked', async () => {
  const { st, calls } = setup();
  st.want('WPDevelopers/xspeed', 8, 'free', pr(8, { headRepo: 'someone/xspeed' }));
  await st.scan({ open: new Map([['WPDevelopers/xspeed#8', 'sha8']]) });
  assert.deepEqual(calls, []);
  assert.match(st.view('WPDevelopers/xspeed#8').text, /fork/);
});

test('low memory: the PR waits, and is added when memory comes back', async () => {
  const s = setup({ mem: '2000' });
  s.st.want('WPDevelopers/xspeed', 9, 'free', pr(9));
  const open = new Map([['WPDevelopers/xspeed#9', 'sha9']]);
  await s.st.scan({ open });
  assert.equal(s.st.view('WPDevelopers/xspeed#9').why, 'memory');
  assert.ok(!s.calls.some((c) => c[0] === 'add'));
});

test('state survives a restart of the dashboard', async () => {
  const s = setup();
  s.st.want('WPDevelopers/xspeed', 3, 'free', pr(3));
  await s.st.scan({ open: new Map([['WPDevelopers/xspeed#3', 'sha3']]) });
  const again = createStacks({ runsDir: s.runsDir, run: async () => ({ code: 0, out: '{}' }), log: () => {} });
  assert.equal(again.view('WPDevelopers/xspeed#3').state, 'following');
});

test('a merged PR: its stack is removed; a failed remove is tried again next scan', async () => {
  const s = setup({ answers: { remove: { code: 1, out: '{"ok":false,"code":"follow_attempt_running"}' } } });
  s.st.want('WPDevelopers/xspeed', 4, 'free', pr(4));
  await s.st.scan({ open: new Map([['WPDevelopers/xspeed#4', 'sha4']]) });
  await s.st.scan({ open: new Map() });
  assert.equal(s.st.view('WPDevelopers/xspeed#4').state, 'removing');
  const removes = () => s.calls.filter((c) => c[0] === 'remove').length;
  assert.equal(removes(), 1);
  await s.st.scan({ open: new Map() });
  assert.equal(removes(), 2, 'asked again');
});

test(`at ${CAP}, the oldest idle one is evicted before the next is added`, async () => {
  const s = setup({ answers: { status: { code: 0, out: JSON.stringify({ ok: true, applied: { free: 'x', pro: 'y' } }) } } });
  const open = new Map();
  for (let i = 1; i <= CAP + 1; i++) {
    s.st.want('WPDevelopers/xspeed', i, 'free', pr(i));
    open.set(`WPDevelopers/xspeed#${i}`, `sha${i}`);
  }
  // One add per scan; the next scan reads its status (applied) before adding another.
  for (let i = 0; i < CAP; i++) { await s.st.scan({ open }); s.tick(6 * 60 * 1000); }
  assert.equal(s.st.list().filter((x) => x.state === 'following').length, CAP);
  assert.ok(!s.calls.some((c) => c[0] === 'remove'));
  await s.st.scan({ open });
  assert.deepEqual(s.calls.filter((c) => c[0] === 'remove'), [['remove', 'wp-pr-free-1']], 'the oldest one goes, and only it');
  assert.equal(s.st.view(`WPDevelopers/xspeed#${CAP + 1}`).why, 'cap', 'the new one waits for the room');
  await s.st.scan({ open });
  assert.ok(s.calls.some((c) => c[0] === 'add' && c[1] === `wp-pr-free-${CAP + 1}`), 'then it is added');
});

test('a failed add is removed when its PR closes (the follow may exist)', async () => {
  const s = setup({ answers: { add: { code: 1, out: '{"ok":false,"code":"server_cli_acceptance_unknown"}' } } });
  s.st.want('WPDevelopers/xspeed', 5, 'free', pr(5));
  await s.st.scan({ open: new Map([['WPDevelopers/xspeed#5', 'sha5']]) });
  assert.equal(s.st.view('WPDevelopers/xspeed#5').state, 'failed');
  await s.st.scan({ open: new Map() });
  assert.deepEqual(s.calls.filter((c) => c[0] === 'remove'), [['remove', 'wp-pr-free-5']]);
  assert.equal(s.st.view('WPDevelopers/xspeed#5').state, 'removed');
});

test('fromStatus: ready, building, failed, licensing key missing', () => {
  assert.deepEqual(
    (({ applied, appliedHead, attemptRunning, failed }) => ({ applied, appliedHead, attemptRunning, failed }))(fromStatus({ ok: true, applied: { free: 'a', pro: 'b' }, attempt: { status: 'succeeded' } }, 'free')),
    { applied: true, appliedHead: 'a', attemptRunning: false, failed: false });
  assert.equal(fromStatus({ applied: null, attempt: { status: 'running', job_id: 'j1' } }, 'free').attemptRunning, true);
  const f = fromStatus({ applied: { free: 'a' }, failed_heads: { free: 'b' }, attempt: { status: 'failed', reason: 'stack_up_failed' }, last_check: { reason: 'waiting_after_failure' } }, 'free');
  assert.equal(f.failed, true);
  assert.equal(f.failedReason, 'stack_up_failed');
  const k = fromStatus({ applied: null, last_check: { reason: 'fetch_failed', error: 'fetch of WPDevelopers/licensing main failed: Permission denied (publickey)' } }, 'free');
  assert.match(k.failedReason, /licensing deploy key missing/);
});

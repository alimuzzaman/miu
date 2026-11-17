import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStacks, fromStatus, totpPath } from '../lib/prstackctl.mjs';
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

const hubPr = (n, extra = {}) => ({ repo: 'WPDevelopers/xspeed-hub', number: n, headRepo: 'WPDevelopers/xspeed-hub', headRefName: `feat/h${n}`, headRefOid: `hsha${n}`, ...extra });

test('a Free PR that names a Hub PR shares the Hub PR\'s stack, pr-hub-<n>', async () => {
  const s = setup();
  s.st.want('WPDevelopers/xspeed', 21, 'free', pr(21), { hub: hubPr(88) });
  await s.st.scan({ open: new Map([['WPDevelopers/xspeed#21', 'sha21'], ['WPDevelopers/xspeed-hub#88', 'hsha88']]) });
  assert.deepEqual(s.calls.at(-1), ['add', 'pr-hub-88', 'full', 'free=fix/21', 'pro=dev', 'hub=feat/h88']);
  assert.equal(s.st.view('WPDevelopers/xspeed#21').name, 'pr-hub-88', 'the Free PR\'s run page shows the shared stack');
  assert.equal(s.st.view('WPDevelopers/xspeed-hub#88').name, 'pr-hub-88');
  assert.equal(s.st.list().length, 1, 'one stack, not two');
});

test('a partner that arrives later re-declares the follow; one that closes goes back to dev', async () => {
  const s = setup();
  s.st.want('WPDevelopers/xspeed-hub', 88, 'hub', hubPr(88));
  const both = new Map([['WPDevelopers/xspeed-hub#88', 'hsha88'], ['WPDevelopers/xspeed#21', 'sha21']]);
  await s.st.scan({ open: both });
  assert.deepEqual(s.calls.at(-1), ['add', 'pr-hub-88', 'full', 'free=dev', 'pro=dev', 'hub=feat/h88']);
  s.st.want('WPDevelopers/xspeed', 21, 'free', pr(21), { hub: hubPr(88) });
  await s.st.scan({ open: both });
  assert.deepEqual(s.calls.filter((c) => c[0] === 'add').at(-1), ['add', 'pr-hub-88', 'full', 'free=fix/21', 'pro=dev', 'hub=feat/h88']);
  await s.st.scan({ open: new Map([['WPDevelopers/xspeed-hub#88', 'hsha88']]) });
  assert.deepEqual(s.calls.filter((c) => c[0] === 'add').at(-1), ['add', 'pr-hub-88', 'full', 'free=dev', 'pro=dev', 'hub=feat/h88']);
  assert.equal(s.st.view('WPDevelopers/xspeed-hub#88').state, 'following');
  assert.ok(!s.calls.some((c) => c[0] === 'remove'), 'the Hub PR is still open: its stack stays');
});

test('the Hub authenticator file goes with its stack, and a new stack of that name never inherits one', async () => {
  const s = setup();
  const file = totpPath(s.runsDir, 'pr-hub-88');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"left":"over"}', { mode: 0o600 });
  s.st.want('WPDevelopers/xspeed-hub', 88, 'hub', hubPr(88));
  await s.st.scan({ open: new Map([['WPDevelopers/xspeed-hub#88', 'hsha88']]) });
  assert.equal(fs.existsSync(file), false, 'deleted when the stack is created');
  fs.writeFileSync(file, '{"stack":"pr-hub-88"}', { mode: 0o600 });
  await s.st.scan({ open: new Map() });
  assert.equal(s.st.view('WPDevelopers/xspeed-hub#88').state, 'removed');
  assert.equal(fs.existsSync(file), false, 'deleted when the stack is removed');
});

test('pr-hub-base: added first, never removed as closed, counted toward the cap, never evicted', async () => {
  const s = setup({ answers: { status: { code: 0, out: JSON.stringify({ ok: true, applied: { free: 'x', pro: 'y', hub: 'z' } }) } } });
  s.st.wantBase();
  s.st.want('WPDevelopers/xspeed', 1, 'free', pr(1));
  const open = new Map([['WPDevelopers/xspeed#1', 'sha1']]);
  await s.st.scan({ open });
  assert.deepEqual(s.calls.find((c) => c[0] === 'add'), ['add', 'pr-hub-base', 'full', 'free=dev', 'pro=dev', 'hub=dev'], 'the base goes first');
  for (let i = 2; i <= CAP; i++) { s.st.want('WPDevelopers/xspeed', i, 'free', pr(i)); open.set(`WPDevelopers/xspeed#${i}`, `sha${i}`); }
  for (let i = 0; i < CAP + 2; i++) { s.tick(6 * 60 * 1000); await s.st.scan({ open }); }
  const live = s.st.list().filter((x) => x.state === 'following');
  assert.equal(live.length, CAP, `never more than ${CAP}: the base and ${CAP - 1} PR stacks`);
  assert.ok(live.some((x) => x.name === 'pr-hub-base'));
  assert.deepEqual(s.calls.filter((c) => c[0] === 'remove'), [['remove', 'wp-pr-free-1']], `PR ${CAP} needed room: the oldest PR stack went, not the base`);
  await s.st.scan({ open: new Map() });
  assert.ok(!s.calls.some((c) => c[0] === 'remove' && c[1] === 'pr-hub-base'), 'not removed when every PR closes');
  assert.equal(s.st.list().find((x) => x.name === 'pr-hub-base').state, 'following');
});

test('a failed pr-hub-base add is tried again after 15 minutes, and PR stacks are added meanwhile', async () => {
  let fail = true;
  let t = Date.UTC(2026, 10, 17);
  const s = setup();
  const st = createStacks({ runsDir: s.runsDir, now: () => t, log: () => {}, run: async (args) => {
    s.calls.push(args);
    if (args[0] === 'mem') return { code: 0, out: '8000' };
    if (args[0] === 'add' && fail) { fail = false; return { code: 1, out: '{"ok":false,"code":"x"}' }; }
    return { code: 0, out: '{"ok":true}' };
  } });
  st.wantBase();
  st.want('WPDevelopers/xspeed', 5, 'free', pr(5));
  const open = new Map([['WPDevelopers/xspeed#5', 'sha5']]);
  await st.scan({ open });
  const base = () => st.list().find((x) => x.name === 'pr-hub-base');
  assert.equal(base().state, 'failed');
  t += 2 * 60 * 1000;
  await st.scan({ open });
  assert.equal(base().state, 'failed', 'not yet');
  assert.equal(st.view('WPDevelopers/xspeed#5').state, 'following', 'the PR stack got the add meanwhile');
  t += 15 * 60 * 1000;
  await st.scan({ open });
  assert.equal(base().state, 'following');
});

test('a PR that gets paired later gives up its own stack, and its page shows the shared one', async () => {
  const s = setup();
  s.st.want('WPDevelopers/xspeed', 21, 'free', pr(21));
  const open = new Map([['WPDevelopers/xspeed#21', 'sha21'], ['WPDevelopers/xspeed-hub#88', 'hsha88']]);
  await s.st.scan({ open });
  assert.equal(s.st.view('WPDevelopers/xspeed#21').name, 'wp-pr-free-21');
  s.st.want('WPDevelopers/xspeed', 21, 'free', pr(21), { hub: hubPr(88) });
  await s.st.scan({ open });
  assert.ok(s.calls.some((c) => c[0] === 'remove' && c[1] === 'wp-pr-free-21'), 'its own stack goes');
  assert.equal(s.st.view('WPDevelopers/xspeed#21').name, 'pr-hub-88');
});

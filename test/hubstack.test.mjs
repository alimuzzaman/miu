import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { waitApplied, prepareHubStacks, dropSessions, expectedHeads, prStackName, signInsFor } from '../lib/hubstack.mjs';

const clock = () => { let t = Date.UTC(2026, 10, 17, 7); return { now: () => t, sleep: async (ms) => { t += ms; } }; };
const status = (applied, extra = {}) => ({ code: 0, out: JSON.stringify({ ok: true, follows: [{ applied, ...extra }] }) });
// The worker's wp-session answer for a stack (lib/wpsession.mjs), signatures only.
const wpAnswer = (stack) => ({ code: 0, out: JSON.stringify({ ok: true, host: `wp-${stack}.xspeedcdn.online`, login: 'miu-qa', expires: 1795100000,
  cookies: [{ name: `wordpress_logged_in_${'0'.repeat(32)}`, path: '/', sig: 'c'.repeat(64) }] }) });

test('the pr side waits for the PR head and each partner head; the dev side for any build', () => {
  assert.deepEqual(expectedHeads({ selfRole: 'hub', sha: 'h1' }), { hub: 'h1' });
  assert.deepEqual(expectedHeads({ selfRole: 'free', sha: 'f1', partners: { hub: { number: 9, headRefOid: 'h9' } } }), { free: 'f1', hub: 'h9' });
  assert.equal(prStackName({ selfRole: 'hub', pr: 621 }), 'pr-hub-621');
  assert.equal(prStackName({ selfRole: 'free', pr: 21, partners: { hub: { number: 88 } } }), 'pr-hub-88');
});

test('waitApplied: waits through an older commit, stops at a failed build of this one, and times out', async () => {
  const c = clock();
  const seq = [status({ hub: 'old' }), status(null, { attempt: { status: 'running' } }), status({ hub: 'new', free: 'f' })];
  const ok = await waitApplied({ run: async () => seq.shift() ?? seq.at(-1), name: 'pr-hub-9', want: { hub: 'new' }, ...c });
  assert.equal(ok.ok, true);
  const failed = await waitApplied({ run: async () => status({ hub: 'old' }, { failed_heads: { hub: 'new' }, attempt: { status: 'failed', reason: 'stack_apply_failed: exit 1', heads: { hub: 'new' } }, last_check: { reason: 'waiting_after_failure' } }), name: 'pr-hub-9', want: { hub: 'new' }, ...c });
  assert.equal(failed.ok, false);
  assert.match(failed.why, /build of this commit failed: stack_apply_failed/);
  const late = await waitApplied({ run: async () => status({ hub: 'old' }), name: 'pr-hub-9', want: { hub: 'new' }, timeoutMs: 5 * 60 * 1000, ...c });
  assert.equal(late.ok, false);
  assert.match(late.why, /did not reach this commit in time \(at hub old/);
});

test('prepareHubStacks writes both sides, signs in through the helper, and dropSessions removes the states', async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miu-hubstack-'));
  const calls = [];
  const run = async (args) => {
    if (args[0] === 'wp-session') return wpAnswer(args[1]);
    calls.push(args.join(' '));
    if (args[0] === 'status') return status(args[1] === 'pr-hub-base' ? { hub: 'devsha', free: 'a', pro: 'b' } : { hub: 'h1', free: 'a', pro: 'b' });
    if (args[0] === 'ports') return { code: 0, out: JSON.stringify({ ok: true, slug: args[1], created_at: '2026-11-17T07:00:00Z', copy_id: 'c1', ports: { mailpit: args[1] === 'pr-hub-base' ? 18101 : 18102 } }) };
    return { code: 1, out: '' };
  };
  const signed = [];
  const signin = async (args) => {
    signed.push(args);
    const at = (k) => args[args.indexOf(k) + 1];
    for (const k of ['--admin-out', '--app-out']) if (args.includes(k)) fs.writeFileSync(at(k), '{}', { mode: 0o600 });
    return { code: 0, out: JSON.stringify({ ok: true, stack: at('--stack'), enrolled: true }) };
  };
  const { hubs, infra } = await prepareHubStacks({ run, signin, selfRole: 'hub', pr: 621, sha: 'h1', runDir, runsDir: runDir, ...clock() });
  assert.deepEqual(infra, []);
  assert.equal(hubs.pr.stack, 'pr-hub-621');
  assert.equal(hubs.pr.admin, 'https://admin-pr-hub-621.xspeedcdn.online');
  assert.equal(hubs.dev.stack, 'pr-hub-base');
  assert.equal(hubs.dev.commit, 'devsha');
  assert.ok(fs.existsSync(hubs.pr.admin_state) && fs.existsSync(hubs.dev.app_state));
  assert.ok(signed.some((a) => a.includes('2026-11-17T07:00:00Z/c1') && a.includes('18102')), 'incarnation and Mailpit port from ports');
  assert.equal(fs.statSync(path.join(runDir, 'private')).mode & 0o777, 0o700);
  const ended = [];
  assert.deepEqual(dropSessions(runDir, { endWp: (stack) => { ended.push(stack); return true; } }), []);
  assert.deepEqual(ended.sort(), ['pr-hub-621', 'pr-hub-base'], 'each stack\'s wp-admin session is ended');
  assert.equal(fs.existsSync(path.join(runDir, 'private')), false);
});

test('a stack that is not ready blocks the run; a failed sign-in leaves the states null and says why', async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miu-hubstack-'));
  const run = async (args) => {
    if (args[0] === 'wp-session') return wpAnswer(args[1]);
    if (args[0] === 'status') return args[1] === 'pr-hub-base' ? status({ hub: 'd' }) : status({ hub: 'old' });
    return { code: 0, out: JSON.stringify({ ok: true, created_at: 'x', copy_id: 'y', ports: { mailpit: 18100 } }) };
  };
  const signin = async () => ({ code: 1, out: JSON.stringify({ ok: false, error: 'hub sign-in: link answered 429 rate_limited' }) });
  const { hubs, infra } = await prepareHubStacks({ run, signin, selfRole: 'hub', pr: 7, sha: 'new', runDir, runsDir: runDir, timeoutMs: 60_000, ...clock() });
  assert.ok(infra.some((i) => i.blocking && /pr Hub stack pr-hub-7 is not ready/.test(i.what)));
  assert.equal(hubs.dev.admin_state, null);
  assert.ok(infra.some((i) => !i.blocking && /could not sign in to pr-hub-base admin: hub sign-in: link answered 429/.test(i.what)));
});

test('no stack coming: a refused plan or a missing follow ends the wait at once', async () => {
  const c = clock();
  let asked = 0;
  const notFound = async () => { asked++; return { code: 1, out: '{"ok":false,"code":"follow_not_found"}' }; };
  const r1 = await waitApplied({ run: notFound, name: 'pr-hub-7', want: { hub: 'x' }, ...c });
  assert.equal(r1.ok, false);
  assert.match(r1.why, /no test stack follows it/);
  assert.equal(asked, 1);
  const r2 = await waitApplied({ run: notFound, name: 'pr-hub-7', want: { hub: 'x' }, planned: { state: 'refused', why: 'fork' }, ...c });
  assert.match(r2.why, /no test stack: .*fork/);
  assert.equal(asked, 1, 'not even asked');
  const queued = await waitApplied({ run: notFound, name: 'pr-hub-7', want: { hub: 'x' }, planned: { state: 'waiting' }, timeoutMs: 3 * 60 * 1000, ...c });
  assert.match(queued.why, /in time/, 'a stack the dashboard is about to add is waited for');
});

test('the staff console is signed in to only when the pull request touches it (the Hub caps staff links at 5 an hour)', async () => {
  assert.deepEqual(signInsFor({ hub: true, admin: false }), { admin: false, app: true });
  assert.deepEqual(signInsFor({ admin: true }), { admin: true, app: true });
  assert.deepEqual(signInsFor({ hub: true }), { admin: true, app: true }, 'a profile with no admin area always signs in to the console');
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miu-hubstack-'));
  const run = async (args) => {
    if (args[0] === 'wp-session') return wpAnswer(args[1]);
    if (args[0] === 'status') return status(args[1] === 'pr-hub-base' ? { hub: 'd' } : { hub: 'h1' });
    return { code: 0, out: JSON.stringify({ ok: true, created_at: 'x', copy_id: 'y', ports: { mailpit: 18100 } }) };
  };
  const signed = [];
  const signin = async (args) => {
    signed.push(args);
    const i = args.indexOf('--app-out');
    if (i > -1) fs.writeFileSync(args[i + 1], '{}', { mode: 0o600 });
    return { code: 0, out: JSON.stringify({ ok: true, enrolled: false }) };
  };
  const { hubs, infra } = await prepareHubStacks({ run, signin, selfRole: 'hub', pr: 7, sha: 'h1', runDir, runsDir: runDir, need: signInsFor({ hub: true, admin: false }), ...clock() });
  assert.deepEqual(infra, []);
  assert.equal(signed.length, 2);
  assert.ok(signed.every((a) => !a.includes('--admin-out') && a.includes('--app-out')), 'no staff link is asked for');
  for (const side of ['pr', 'dev']) {
    assert.equal(hubs[side].admin_state, null);
    assert.match(hubs[side].admin_skipped, /does not touch the admin console/);
    assert.ok(fs.existsSync(hubs[side].app_state));
  }
});

test('admin failing and app signing in: the app state is used, and the admin failure is reported with its code', async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miu-hubstack-'));
  const run = async (args) => {
    if (args[0] === 'wp-session') return wpAnswer(args[1]);
    if (args[0] === 'status') return status(args[1] === 'pr-hub-base' ? { hub: 'd' } : { hub: 'h1' });
    return { code: 0, out: JSON.stringify({ ok: true, created_at: 'x', copy_id: 'y', ports: { mailpit: 18100 } }) };
  };
  const signin = async (args) => ({ code: 0, out: JSON.stringify({ ok: true, stack: args[args.indexOf('--stack') + 1], enrolled: false,
    admin: { ok: false, code: 'staff_factor_without_secret', error: 'hub sign-in: miu-qa@wpdeveloper.com already has an authenticator on pr-hub-7' }, app: { ok: true } }) });
  const { hubs, infra } = await prepareHubStacks({ run, signin, selfRole: 'hub', pr: 7, sha: 'h1', runDir, runsDir: runDir, ...clock() });
  for (const side of ['pr', 'dev']) {
    assert.equal(hubs[side].admin_state, null);
    assert.match(hubs[side].app_state, /hub-.*-app\.json$/);
  }
  assert.ok(infra.some((i) => !i.blocking && /could not sign in to pr-hub-7 admin \(staff_factor_without_secret\)/.test(i.what) && /admin console needs a manual sign-in/.test(i.impact)));
  assert.ok(!infra.some((i) => / app/.test(i.what)), 'the app side signed in');
});

test('each stack\'s WordPress gets a wp-admin session on its own; one refused is reported and leaves the others', async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miu-hubstack-'));
  const asked = [];
  const run = async (args, opts) => {
    if (args[0] === 'wp-session') { asked.push({ args, input: opts?.input }); return args[1] === 'pr-hub-base' ? { code: 1, out: '{"ok":false,"code":"wp_qa_user_missing"}' } : wpAnswer(args[1]); }
    if (args[0] === 'status') return status(args[1] === 'pr-hub-base' ? { hub: 'd' } : { hub: 'h1' });
    return { code: 0, out: JSON.stringify({ ok: true, created_at: 'x', copy_id: 'y', ports: { mailpit: 18100 } }) };
  };
  const signin = async () => ({ code: 0, out: JSON.stringify({ ok: true, admin: { ok: true }, app: { ok: true } }) });
  const { hubs, infra } = await prepareHubStacks({ run, signin, selfRole: 'hub', pr: 7, sha: 'h1', runDir, runsDir: runDir, ...clock() });
  assert.equal(hubs.pr.wp, 'https://wp-pr-hub-7.xspeedcdn.online');
  assert.equal(hubs.pr.wp_state, path.join(runDir, 'private', 'wp-pr-hub-7.json'));
  assert.equal(hubs.dev.wp_state, null);
  assert.ok(hubs.dev.admin_state && hubs.dev.app_state, 'the Hub sign-ins do not wait on WordPress');
  assert.ok(infra.some((i) => !i.blocking && /could not sign in to pr-hub-base wp-admin \(wp_qa_user_missing\)/.test(i.what)));
  assert.deepEqual(asked.map((a) => a.args[0] + ' ' + a.args[1]).sort(), ['wp-session pr-hub-7', 'wp-session pr-hub-base']);
  assert.ok(asked.every((a) => /^[A-Za-z0-9]{43}\n$/.test(a.input) && !a.args.join(' ').includes(a.input.trim())));
  assert.ok(!JSON.stringify(hubs).includes(asked[0].input.trim()), 'hubs.json never holds a token');
});

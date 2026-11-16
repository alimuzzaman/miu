import test from 'node:test';
import assert from 'node:assert/strict';
import { stackName, kindFor, refusal, followBranches, urls, plan, describe, CAP, IDLE_MS, BRANCH } from '../lib/prstacks.mjs';

const H = 60 * 60 * 1000;
const now = Date.UTC(2026, 10, 16, 12);
const pr = (n, extra = {}) => ({ headRepo: 'WPDevelopers/xspeed', headRefName: `fix/thing-${n}`, ...extra });
const live = (i, extra = {}) => ({ key: `WPDevelopers/xspeed#${i}`, state: 'following', applied: true, createdAt: now - 10 * H, lastPushAt: now - (20 - i) * H, ...extra });
const openOf = (stacks, more = []) => new Map([...stacks.map((s) => [s.key, s.head ?? 'h']), ...more.map((k) => [k, 'h'])]);

test('names: WordPress-only is wp-pr-<role>-<n>, full is pr-<role>-<n>', () => {
  assert.equal(stackName('free', 412, 'wp'), 'wp-pr-free-412');
  assert.equal(stackName('hub', 88, 'full'), 'pr-hub-88');
  assert.throws(() => stackName('evil', 1, 'wp'));
  assert.throws(() => stackName('free', 0, 'wp'));
});

test('the Hub is in the stack for a Hub PR or a pair with one', () => {
  assert.equal(kindFor('free'), 'wp');
  assert.equal(kindFor('pro', { free: {} }), 'wp');
  assert.equal(kindFor('hub'), 'full');
  assert.equal(kindFor('free', { hub: {} }), 'full');
});

test('forks never get a stack, nor a pair with a fork, nor another org', () => {
  assert.equal(refusal('WPDevelopers/xspeed', pr(1)), null);
  assert.equal(refusal('WPDevelopers/xspeed', pr(1, { headRepo: 'someone/xspeed' })), 'fork');
  assert.equal(refusal('WPDevelopers/xspeed', pr(1, { headRepo: null })), 'fork', 'a deleted fork has no head repo');
  assert.equal(refusal('WPDevelopers/xspeed', pr(1), { pro: { repo: 'WPDevelopers/xspeed-pro', headRepo: 'x/xspeed-pro', headRefName: 'a' } }), 'fork');
  assert.equal(refusal('Other/xspeed', pr(1, { headRepo: 'Other/xspeed' })), 'fork');
});

test('branch names that could be read as options or escape a path are refused', () => {
  for (const b of ['-x', 'a..b', 'a b', 'a;b', 'a/', 'x.lock', '$(id)', '']) assert.equal(BRANCH.test(b), false, b);
  for (const b of ['dev', 'feature/x-1', 'fix/PR_2.3']) assert.equal(BRANCH.test(b), true, b);
  assert.equal(refusal('WPDevelopers/xspeed', pr(1, { headRefName: '--upload-pack=x' })), 'branch');
});

test('each role follows the PR, its partner, or dev; no Hub in a WordPress-only stack', () => {
  assert.deepEqual(followBranches('free', pr(1)), { free: 'fix/thing-1', pro: 'dev' });
  assert.deepEqual(followBranches('pro', pr(2), { free: { headRefName: 'feat/a' } }), { free: 'feat/a', pro: 'fix/thing-2' });
  assert.deepEqual(followBranches('hub', pr(3)), { free: 'dev', pro: 'dev', hub: 'fix/thing-3' });
});

test('urls: the site, the Hub it uses, and the panel page for sign-in', () => {
  assert.deepEqual(urls('wp-pr-free-412', 'wp'), { site: 'https://wp-pr-free-412.xspeedcdn.online', hub: 'https://hub-dev.xspeedcdn.online', panel: 'https://sandbox.xspeedcdn.online/hosting/xspeed-dev/wp-pr-free-412' });
  const f = urls('pr-hub-88', 'full');
  assert.equal(f.site, 'https://wp-pr-hub-88.xspeedcdn.online');
  assert.equal(f.hub, 'https://hub-pr-hub-88.xspeedcdn.online');
  assert.equal(f.admin, 'https://admin-pr-hub-88.xspeedcdn.online');
});

test('a waiting PR is added when there is room and memory; one per scan', () => {
  const stacks = [{ key: 'a#1', state: 'waiting', at: 2 }, { key: 'a#2', state: 'waiting', at: 1 }];
  const r = plan({ stacks, open: openOf(stacks), memMb: 8000, now });
  assert.equal(r.add, 'a#2', 'first in, first added');
  assert.equal(r.waits['a#1'], 'queued');
});

test('under 3 GB free, or memory unknown, nothing is added', () => {
  const stacks = [{ key: 'a#1', state: 'waiting', at: 1 }];
  assert.equal(plan({ stacks, open: openOf(stacks), memMb: 3071, now }).waits['a#1'], 'memory');
  assert.equal(plan({ stacks, open: openOf(stacks), memMb: 3072, now }).add, 'a#1');
  assert.equal(plan({ stacks, open: openOf(stacks), memMb: null, now }).waits['a#1'], 'memory_unknown');
});

test('no add while another stack is still building its first head', () => {
  const stacks = [live(1, { applied: false }), { key: 'a#9', state: 'waiting', at: 1 }];
  const r = plan({ stacks, open: openOf(stacks), memMb: 8000, now });
  assert.equal(r.add, null);
  assert.equal(r.waits['a#9'], 'building');
});

test(`at ${CAP}, the oldest idle stack goes first and the new one waits for the room`, () => {
  const stacks = [...Array.from({ length: CAP }, (_, i) => live(i)), { key: 'n#1', state: 'waiting', at: 1 }];
  const r = plan({ stacks, open: openOf(stacks), memMb: 8000, now });
  assert.deepEqual(r.remove, [{ key: 'WPDevelopers/xspeed#0', why: 'evicted' }], 'stack 0 had the oldest push');
  assert.equal(r.add, null);
  assert.equal(r.waits['n#1'], 'cap');
});

test('a verdict counts as use: the oldest of push and verdict decides', () => {
  const stacks = [...Array.from({ length: CAP }, (_, i) => live(i)), { key: 'n#1', state: 'waiting', at: 1 }];
  stacks[0].verdictAt = now - H; stacks[0].verdictHead = 'h';
  const r = plan({ stacks, open: openOf(stacks), memMb: 8000, now });
  assert.equal(r.remove[0].key, 'WPDevelopers/xspeed#1');
});

test('a busy stack (building, or the live run\'s PR) is never evicted; none idle means wait', () => {
  const stacks = [...Array.from({ length: CAP }, (_, i) => live(i, { attemptRunning: i % 2 === 0 })), { key: 'n#1', state: 'waiting', at: 1 }];
  const liveKeys = new Set(stacks.filter((_, i) => i % 2 === 1).map((s) => s.key));
  const r = plan({ stacks, open: openOf(stacks), liveKeys, memMb: 8000, now });
  assert.deepEqual(r.remove, []);
  assert.equal(r.waits['n#1'], 'cap');
});

test('a removal in progress still counts against the cap', () => {
  const stacks = [...Array.from({ length: CAP - 1 }, (_, i) => live(i)), live(99, { state: 'removing' }), { key: 'n#1', state: 'waiting', at: 1 }];
  const r = plan({ stacks, open: openOf(stacks), memMb: 8000, now });
  assert.equal(r.add, null);
  assert.equal(r.remove.length, 1, 'one more is evicted, not the one already going');
  assert.notEqual(r.remove[0].key, 'WPDevelopers/xspeed#99');
});

test('merged or closed PRs lose their stack, but only when the listing worked', () => {
  const stacks = [live(1), live(2)];
  const open = new Map([[stacks[1].key, 'h']]);
  assert.deepEqual(plan({ stacks, open, memMb: 8000, now }).remove, [{ key: stacks[0].key, why: 'closed' }]);
  assert.deepEqual(plan({ stacks, open: null, memMb: 8000, now }).remove, [], 'a failed GitHub listing removes nothing');
});

test('48 hours after the verdict with no push, the stack goes; a push keeps it', () => {
  const s = live(1, { verdictAt: now - IDLE_MS, verdictHead: 'aaa' });
  assert.deepEqual(plan({ stacks: [s], open: new Map([[s.key, 'aaa']]), memMb: 8000, now }).remove, [{ key: s.key, why: 'idle' }]);
  assert.deepEqual(plan({ stacks: [s], open: new Map([[s.key, 'bbb']]), memMb: 8000, now }).remove, [], 'a new commit since the verdict');
  assert.deepEqual(plan({ stacks: [s], open: new Map([[s.key, 'aaa']]), memMb: 8000, now: now - 1 }).remove, [], 'not yet 48 h');
  assert.deepEqual(plan({ stacks: [s], open: new Map([[s.key, 'aaa']]), liveKeys: new Set([s.key]), memMb: 8000, now }).remove, [], 'Miu is testing it again');
});

test('a closed PR that was still waiting is not added', () => {
  const stacks = [{ key: 'a#1', state: 'waiting', at: 1 }];
  assert.equal(plan({ stacks, open: new Map(), memMb: 8000, now }).add, null);
});

test('describe says what a tester needs to know', () => {
  assert.match(describe({ state: 'refused', why: 'fork' }), /fork/);
  assert.match(describe({ state: 'waiting', why: 'memory' }), /3 GB/);
  assert.equal(describe({ state: 'following', applied: true, appliedHead: 'a', head: 'a' }), 'Ready.');
  assert.match(describe({ state: 'following', applied: true, appliedHead: 'a', head: 'b' }), /older commit/);
  assert.match(describe({ state: 'following', failed: true, failedReason: 'stack_up_failed' }), /failed: stack_up_failed/);
  assert.match(describe({ state: 'removed', why: 'evicted' }), /newer pull request/);
});

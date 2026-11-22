import test from 'node:test';
import assert from 'node:assert/strict';
import { modeOf, holdReason, nextIndex, pick, dismissal, labelDismissed, labelOf, labelGone, takeNext, stackKeys, stackWaited, requeueWaited, stackHold, stackComing, STACK_HOLD_MS } from '../lib/queuectl.mjs';

const auto = { mode: 'auto', paused: false };
const manual = { mode: 'manual', paused: false };

test('auto-test on is auto mode, off is manual', () => {
  assert.equal(modeOf({ autoTest: true }), 'auto');
  assert.equal(modeOf({}), 'auto');
  assert.equal(modeOf({ autoTest: false }), 'manual');
});

test('auto mode starts what Miu queued; manual mode starts only a person\'s pick', () => {
  const line = [{ repo: 'a/b', pr: 1, by: 'auto' }, { repo: 'a/b', pr: 2, by: 'github' }, { repo: 'a/b', pr: 3, by: 'person' }, { repo: 'a/b', pr: 4 }];
  assert.equal(nextIndex(line, auto), 0);
  assert.equal(nextIndex(line, manual), 2, 'a label or /miu comment waits in manual mode, like Miu\'s own scan');
  assert.equal(holdReason(line[0], manual), 'manual');
  assert.equal(holdReason(line[1], manual), 'manual', 'the label scan\'s entries do not start on their own in manual mode');
  assert.equal(holdReason(line[1], auto), null);
  assert.equal(holdReason(line[2], manual), null);
  assert.equal(holdReason(line[3], manual), null, 'an entry saved before "by" existed was asked for (auto-test off queued nothing)');
});

test('paused starts nothing, a person\'s pick included; a held entry waits in either mode', () => {
  const line = [{ repo: 'a/b', pr: 1, by: 'person', held: true }, { repo: 'a/b', pr: 2, by: 'person' }];
  assert.equal(nextIndex(line, { ...auto, paused: true }), -1);
  assert.equal(holdReason(line[1], { ...manual, paused: true }), 'paused');
  assert.equal(nextIndex(line, auto), 1);
  assert.equal(holdReason(line[0], auto), 'held');
});

test('pick puts the chosen pull requests first, in order, as a person\'s, and releases a held one', () => {
  const line = [{ repo: 'a/b', pr: 1, by: 'auto' }, { repo: 'a/b', pr: 2, by: 'auto', held: true }, { repo: 'a/b', pr: 3, by: 'auto' }];
  const front = pick(line, [{ repo: 'a/b', pr: 3 }, { repo: 'a/b', pr: 2 }, { repo: 'a/b', pr: 9 }, { repo: 'a/b', pr: 3 }], { full: true, now: 5 });
  assert.deepEqual(line.map((q) => q.pr), [3, 2, 9, 1]);
  assert.equal(front.length, 3);
  assert.ok(front.every((q) => q.by === 'person' && q.held === false && q.full === true));
  assert.equal(line[2].at, 5);
  assert.equal(nextIndex(line, manual), 0);
});

test('a person removing a waiting entry keeps it out at this commit: Miu\'s own and a label\'s', () => {
  assert.deepEqual(dismissal({ by: 'auto' }, 'h1'), { baseline: 'h1' });
  assert.deepEqual(dismissal({ by: 'github' }, 'h1'), { baseline: 'h1', label: 'h1' }, 'the label stays on the PR, so the label scan must skip it');
  assert.equal(dismissal({ by: 'person' }, 'h1'), null);
  assert.equal(dismissal({ by: 'github' }, undefined), null);
  const cfg = { labelDismissed: { 'a/b#2': 'h1' } };
  assert.equal(labelDismissed(cfg, 'a/b#2', 'h1'), true);
  assert.equal(labelDismissed(cfg, 'a/b#2', 'h2'), false, 'a new commit asks again');
  assert.equal(labelDismissed({}, 'a/b#2', 'h1'), false);
});

const asks = ['Needs Testing', 'Needs Re-Test'];
const st = () => auto;

test('a label\'s entry whose label came off while it waited is dropped, and the next one starts', async () => {
  const line = [
    { repo: 'a/b', pr: 822, why: 'labelled Needs Re-Test', by: 'github', label: 'Needs Re-Test' },
    { repo: 'a/b', pr: 831, why: 'labelled Needs Re-Test', by: 'github', label: 'Needs Re-Test' },
  ];
  const now = { 822: { state: 'OPEN', labels: ['Miu Tested'] }, 831: { state: 'OPEN', labels: ['Needs Re-Test'] } };
  const read = [];
  const took = await takeNext(line, st, { readPr: async (repo, pr) => { read.push(pr); return now[pr]; }, asks });
  assert.deepEqual(read, [822, 831]);
  assert.equal(took.next.pr, 831, 'the PR that still asks starts');
  assert.deepEqual(took.dropped.map((d) => [d.pr, d.dropWhy]), [[822, 'label removed while queued']]);
  assert.equal(line.length, 0, 'both left the line: one dropped, one started');
});

test('a label\'s entry whose label is still there starts', async () => {
  const line = [{ repo: 'a/b', pr: 7, why: 'labelled Needs Testing', by: 'github', label: 'Needs Testing' }];
  const took = await takeNext(line, st, { readPr: async () => ({ state: 'OPEN', labels: [{ name: 'Needs Testing' }] }), asks });
  assert.equal(took.next.pr, 7);
  assert.deepEqual(took.dropped, []);
});

test('a closed PR\'s label entry goes; an unreadable PR starts as before', async () => {
  const closed = [{ repo: 'a/b', pr: 1, by: 'github', label: 'Needs Testing', why: 'labelled Needs Testing' }];
  const t1 = await takeNext(closed, st, { readPr: async () => ({ state: 'CLOSED', labels: ['Needs Testing'] }), asks });
  assert.equal(t1.next, null);
  assert.equal(t1.dropped[0].dropWhy, 'closed while queued');
  const logs = [];
  const unread = [{ repo: 'a/b', pr: 2, by: 'github', label: 'Needs Testing', why: 'labelled Needs Testing' }];
  const t2 = await takeNext(unread, st, { readPr: async () => { throw new Error('GitHub 502'); }, asks, log: (m) => logs.push(m) });
  assert.equal(t2.next.pr, 2);
  assert.match(logs[0], /unread \(GitHub 502\); starting it/);
});

test('a person\'s pick, a /miu comment and Miu\'s own scan are not checked against labels', async () => {
  let reads = 0;
  const readPr = async () => { reads += 1; return { state: 'OPEN', labels: [] }; };
  for (const q of [
    { repo: 'a/b', pr: 1, by: 'person', label: 'Needs Testing', why: 'labelled Needs Testing' },
    { repo: 'a/b', pr: 2, by: 'github', label: null, why: 'labelled Needs Testing' },
    { repo: 'a/b', pr: 3, by: 'github', why: '/miu from someone' },
    { repo: 'a/b', pr: 4, by: 'auto', why: 'new commits' },
  ]) {
    const took = await takeNext([q], st, { readPr, asks });
    assert.equal(took.next?.pr, q.pr, `entry ${q.pr} starts`);
  }
  assert.equal(reads, 0, 'no GitHub read for entries no label decides');
});

test('an entry saved before q.label existed is a label\'s entry by its why', () => {
  assert.equal(labelOf({ by: 'github', why: 'labelled Needs Re-Test' }), 'Needs Re-Test');
  assert.equal(labelOf({ by: 'github', why: '/miu from x' }), null);
  assert.equal(labelOf({ by: 'github', why: 'labelled Needs Re-Test', label: null }), null, 'a /miu comment or a person cleared it');
  assert.equal(labelGone({ by: 'github', why: 'labelled Needs Re-Test' }, { state: 'OPEN', labels: [] }, asks), 'label removed while queued');
});

test('a run that started meanwhile stops the pick before anything leaves the line', async () => {
  let running = false;
  const line = [{ repo: 'a/b', pr: 9, by: 'github', label: 'Needs Testing', why: 'labelled Needs Testing' }];
  const took = await takeNext(line, st, { readPr: async () => { running = true; return { state: 'OPEN', labels: ['Needs Testing'] }; }, asks, busy: () => running });
  assert.equal(took.next, null);
  assert.equal(line.length, 1, 'it keeps its place for the next pump');
});

test('a stack goes to the live run, its pair and what a person queued', () => {
  const queue = [
    { repo: 'a/free', pr: 1, by: 'person', why: 'asked from the dashboard' },
    { repo: 'a/free', pr: 2, by: 'auto', why: 'new commits' },
    { repo: 'a/pro', pr: 3, by: 'github', why: 'labelled Needs Testing', label: 'Needs Testing' },
    { repo: 'a/hub', pr: 4, by: 'github', why: '/miu from x' },
  ];
  // The terminal and the dashboard's Start pick the entry, which makes it a person's.
  pick(queue, [{ repo: 'a/free', pr: 5 }]);
  const keys = stackKeys(queue, ['a/free#9', 'a/pro#10']);
  assert.deepEqual([...keys].sort(), ['a/free#1', 'a/free#5', 'a/free#9', 'a/pro#10']);
});

test('auto-queued entries waiting for a person get no stack', () => {
  const queue = Array.from({ length: 24 }, (_, i) => ({ repo: 'a/free', pr: 100 + i, by: 'auto', why: 'new commits' }));
  assert.equal(stackKeys(queue, []).size, 0, 'no live run, nothing a person asked for: no stacks');
  assert.deepEqual([...stackKeys(queue, ['a/free#100'])], ['a/free#100'], 'only the live run, even when it is also in the line');
});

test('a run that waited for its test stack is found by the stack name it waited for', () => {
  assert.deepEqual(stackWaited(['The pr Hub stack pr-hub-276 is not ready: no test stack: Being removed: 48 hours after the verdict with no new commits.']), ['pr-hub-276']);
  assert.deepEqual(stackWaited(['rexenv is not ready: x', 'The dev Hub stack pr-hub-base is not ready: building']), ['pr-hub-base']);
  assert.deepEqual(stackWaited(['The pr Hub stack pr-hub-276 is not ready: x', 'The dev Hub stack pr-hub-base is not ready: y']), ['pr-hub-276', 'pr-hub-base'], 'both sides');
  assert.deepEqual(stackWaited(['rexenv is not ready: x']), []);
  assert.deepEqual(stackWaited(undefined), []);
});

// 2026-11-22: #696 went into waiting on pr-hub-276 and exited; the dashboard
// took that as a free slot and started #276, a person's later entry.
test('a waiting run keeps its turn: it goes first and nothing else starts while its stack comes', () => {
  const t = Date.UTC(2026, 10, 22, 9, 25);
  const queue = [{ repo: 'WPDevelopers/xspeed-hub', pr: 276, by: 'person' }];
  requeueWaited(queue, { repo: 'WPDevelopers/xspeed', pr: 696, by: 'person' }, 'pr-hub-276', t);
  assert.deepEqual(queue.map((q) => q.pr), [696, 276]);
  assert.equal(nextIndex(queue, auto), 0, 'once it may start, the waited run starts first');
  const stack = { name: 'pr-hub-276', state: 'adding' };
  const of = (name) => (name === stack.name ? stack : null);
  assert.match(stackHold(queue, of, t + 60_000), /696 keeps its turn/);
  stack.state = 'following'; stack.applied = false;
  assert.match(stackHold(queue, of, t + 120_000) ?? '', /keeps its turn/, 'still building');
  // Its stack is wanted while it waits, even if Miu queued it by itself.
  queue[0].by = 'auto';
  assert.ok(stackKeys(queue).has('WPDevelopers/xspeed#696'));
  stack.applied = true;
  assert.equal(stackHold(queue, of, t + 180_000), null, 'ready: the hold ends');
  assert.equal(queue[0].stackWait, undefined, 'and its mark goes');
  assert.ok(!stackKeys(queue).has('WPDevelopers/xspeed#696'), 'an auto entry no longer pins a stack once its hold ends');
});

test('a hold ends when the stack cannot come, or after an hour', () => {
  const t = Date.UTC(2026, 10, 22, 9, 25);
  for (const s of [null, { state: 'refused' }, { state: 'failed' }, { state: 'following', applied: false, failed: true }]) {
    const q = [];
    requeueWaited(q, { repo: 'a/b', pr: 1 }, 'pr-hub-1', t);
    assert.equal(stackHold(q, () => s, t + 1000), null, JSON.stringify(s));
  }
  const q = [];
  requeueWaited(q, { repo: 'a/b', pr: 1 }, 'pr-hub-1', t);
  assert.ok(stackHold(q, () => ({ state: 'adding' }), t + STACK_HOLD_MS - 1));
  assert.equal(stackHold(q, () => ({ state: 'adding' }), t + STACK_HOLD_MS), null);
});

test('requeueing moves an entry already in line instead of adding a second', () => {
  const queue = [{ repo: 'a/b', pr: 2 }, { repo: 'a/b', pr: 1, why: 'x', held: true }];
  requeueWaited(queue, { repo: 'a/b', pr: 1 }, 'pr-hub-1', 0);
  assert.deepEqual(queue.map((q) => q.pr), [1, 2]);
  assert.equal(queue[0].why, 'x');
  assert.equal(queue[0].held, false);
});

// Sol review 2026-11-22: a stack that never comes must not hold the line for
// ever, by an hour granted again on each retry or by retries with no hold.
test('the hour counts from the first wait: a run that waits again after it goes to the back', () => {
  const t = 0;
  const adding = () => ({ state: 'adding' });
  const queue = [{ repo: 'a/b', pr: 2 }];
  const first = requeueWaited(queue, { repo: 'a/b', pr: 1 }, ['pr-hub-1'], t, adding);
  assert.equal(first.deferred, false);
  assert.equal(stackHold(queue, adding, t + STACK_HOLD_MS), null, 'the hour is up');
  // It starts again (the pump keeps waitedSince on the entry it starts from) and waits again.
  const { stackWait, ...entry } = queue.shift();
  const again = requeueWaited(queue, entry, ['pr-hub-1'], t + STACK_HOLD_MS + 1000, adding);
  assert.equal(again.deferred, true);
  assert.deepEqual(queue.map((q) => q.pr), [2, 1], 'the next PR starts');
  assert.equal(queue[1].stackWait, undefined);
  assert.equal(queue[1].waitedSince, undefined, 'its next turn may wait an hour again');
});

test('a run whose stack cannot come goes to the back instead of holding the line', () => {
  for (const s of [null, { state: 'refused' }, { state: 'failed' }, { state: 'following', applied: false, failed: true }]) {
    const queue = [{ repo: 'a/b', pr: 2 }];
    const r = requeueWaited(queue, { repo: 'a/b', pr: 1 }, ['pr-hub-1'], 0, () => s);
    assert.equal(r.deferred, true, JSON.stringify(s));
    assert.deepEqual(queue.map((q) => q.pr), [2, 1]);
    assert.equal(stackHold(queue, () => s, 1), null);
  }
});

test('the hold lasts until every stack the run waited for is ready, at the head it was asked for', () => {
  const st = { 'pr-hub-1': { state: 'following', applied: true, head: 'b', appliedHead: 'a' }, 'pr-hub-base': { state: 'adding' } };
  const of = (n) => st[n] ?? null;
  const queue = [];
  requeueWaited(queue, { repo: 'a/b', pr: 1 }, ['pr-hub-1', 'pr-hub-base'], 0, of);
  assert.match(stackHold(queue, of, 1), /pr-hub-1 and pr-hub-base/, 'an older commit applied is not ready');
  st['pr-hub-1'].appliedHead = 'b';
  assert.match(stackHold(queue, of, 2), /pr-hub-base/, 'the dev stack still builds');
  st['pr-hub-base'] = { state: 'following', applied: true, head: null, appliedHead: null };
  assert.equal(stackHold(queue, of, 3), null);
  assert.equal(stackComing({ state: 'following', applied: true }), false);
  assert.equal(stackComing({ state: 'removed' }), false);
});

test('an old mark with one name still holds', () => {
  const queue = [{ repo: 'a/b', pr: 1, stackWait: { name: 'pr-hub-1', until: 10 } }];
  assert.ok(stackHold(queue, () => ({ state: 'adding' }), 1));
});

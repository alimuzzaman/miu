import test from 'node:test';
import assert from 'node:assert/strict';
import { modeOf, holdReason, nextIndex, pick, dismissal, labelDismissed, labelOf, labelGone, takeNext } from '../lib/queuectl.mjs';

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

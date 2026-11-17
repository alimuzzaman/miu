import test from 'node:test';
import assert from 'node:assert/strict';
import { modeOf, holdReason, nextIndex, pick } from '../lib/queuectl.mjs';

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

import test from 'node:test';
import assert from 'node:assert/strict';
import { needsReply, waitsReply, waitsMarker } from '../lib/cmdreply.mjs';

const github = { repo: 'a/b', pr: 1, by: 'github' };

test('a /miu comment gets the manual-mode reply once, and only when its test waits for a person', () => {
  assert.equal(needsReply({ entry: github, mode: 'manual', replied: [], commentId: 7 }), true);
  assert.equal(needsReply({ entry: github, mode: 'manual', replied: [7], commentId: 7 }), false, 'a rescan or restart does not post again');
  assert.equal(needsReply({ entry: { ...github, by: 'person' }, mode: 'manual', replied: [], commentId: 7 }), false, 'a person already picked it: it starts');
  assert.equal(needsReply({ entry: { ...github, held: true }, mode: 'manual', replied: [], commentId: 7 }), false, 'a person held it on purpose');
  assert.equal(needsReply({ entry: github, mode: 'auto', replied: [], commentId: 7 }), false, 'auto mode starts it');
  assert.equal(needsReply({ entry: undefined, mode: 'manual', replied: [], commentId: 7 }), false);
});

test('the reply says it waits for a manual start, links an https dashboard only, and carries its own marker', () => {
  const body = waitsReply({ publicUrl: 'https://miu.example.test/', marker: 'miu', commentId: 123 });
  assert.equal(body.split('\n')[0], 'Queued. Miu is in manual mode, so this test waits until someone starts it from the dashboard: https://miu.example.test/');
  assert.ok(body.endsWith(waitsMarker('miu', 123)));
  assert.equal(waitsMarker('miu', 123), '<!-- miu-waits=123 -->');
  assert.doesNotMatch(body, /<!-- miu pr=/, 'never the report marker, so the report finder ignores it');
  const local = waitsReply({ publicUrl: 'http://localhost:4747', marker: 'miu', commentId: 1 });
  assert.doesNotMatch(local, /localhost/, 'no link nobody else can open');
  assert.match(local, /starts it from the dashboard\./);
  assert.match(waitsReply({ publicUrl: 'https://m.test', marker: 'miu', commentId: 1, paused: true }), /The queue is paused for now as well\./);
});

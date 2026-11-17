import test from 'node:test';
import assert from 'node:assert/strict';
import { needsReply, waitsReply, waitsMarker } from '../lib/cmdreply.mjs';

test('a /miu comment gets the manual-mode reply once, and only when its test waits for a person', () => {
  assert.equal(needsReply({ mode: 'manual', waits: 'manual', replied: [], commentId: 7 }), true);
  assert.equal(needsReply({ mode: 'manual', waits: 'paused', replied: [], commentId: 7 }), true, 'paused in manual mode still waits for a person');
  assert.equal(needsReply({ mode: 'manual', waits: 'manual', replied: [7], commentId: 7 }), false, 'a rescan or restart does not post again');
  assert.equal(needsReply({ mode: 'manual', waits: null, replied: [], commentId: 7 }), false, 'a person already picked it: it starts');
  assert.equal(needsReply({ mode: 'manual', waits: 'held', replied: [], commentId: 7 }), false);
  assert.equal(needsReply({ mode: 'auto', waits: null, replied: [], commentId: 7 }), false, 'auto mode starts it');
  assert.equal(needsReply({ mode: 'auto', waits: 'paused', replied: [], commentId: 7 }), false);
});

test('the reply says it waits for a manual start, links the dashboard, and carries its own marker', () => {
  const body = waitsReply({ publicUrl: 'https://miu.example.test/', marker: 'miu', commentId: 123 });
  assert.match(body, /^Queued for a manual start\./);
  assert.match(body, /Dashboard: https:\/\/miu\.example\.test\/\n/);
  assert.ok(body.endsWith(waitsMarker('miu', 123)));
  assert.equal(waitsMarker('miu', 123), '<!-- miu-waits=123 -->');
  assert.doesNotMatch(body, /<!-- miu pr=/, 'never the report marker, so the report finder ignores it');
});

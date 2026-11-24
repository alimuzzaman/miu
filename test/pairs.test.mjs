import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testTogether } from '../lib/pairs.mjs';

test('a body without a "Test together" heading keeps the old pairing', () => {
  assert.equal(testTogether('Fixes #1\n\n## Related PRs\n\n| xspeed | #896 |'), null);
  assert.equal(testTogether(''), null);
  assert.equal(testTogether(undefined), null);
});

test('the "Test together" section ends at the next heading of its level or higher', () => {
  const body = ['Intro names Pro #9.', '', '## Test together', '', '- WPDevelopers/xspeed#896', '### Why', 'Free first.', '', '## Related PRs', '', '| WPDevelopers/xspeed-pro | #366 |'].join('\n');
  const s = testTogether(body);
  assert.match(s, /xspeed#896/);
  assert.match(s, /Free first/);
  assert.doesNotMatch(s, /#366/);
  assert.doesNotMatch(s, /Pro #9/);
});

test('an empty "Test together" section is an empty list, not a missing one', () => {
  assert.equal(testTogether('## Test together\n\nNone.\n\n## Related PRs\n\n| xspeed | #896 |').trim(), 'None.');
});

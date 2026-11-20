import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'miu-warm-'));
process.env.QA_REX_SITES = path.join(tmp, 'Sites');
process.env.QA_CACHE_DIR = path.join(tmp, 'cache');
const { mount, webFresh, SITES } = await import('../lib/warmsites.mjs');

// A fake PHP: answers each probe from a script of states.
const fakePhp = (answers) => {
  const calls = [];
  return { calls, probe: async (which, reset) => { calls.push(reset ? 'reset' : 'status'); return answers.shift() ?? { opcache: true, reset: null, pending: false, in_progress: false }; } };
};
const clock = () => { let t = 0; return { now: () => t, sleep: async (ms) => { t += ms; } }; };

test('mount re-points a plugin link at the new worktree', () => {
  const plugins = path.join(process.env.QA_REX_SITES, SITES.pr, 'wp-content', 'plugins');
  fs.mkdirSync(plugins, { recursive: true });
  const dev = path.join(tmp, 'wt', 'plugin-dev'); const pr = path.join(tmp, 'wt', 'plugin-pr');
  fs.mkdirSync(dev, { recursive: true }); fs.mkdirSync(pr, { recursive: true });
  mount('pr', { plugin: dev });
  assert.equal(fs.readlinkSync(path.join(plugins, 'plugin')), dev);
  mount('pr', { plugin: pr });
  assert.equal(fs.readlinkSync(path.join(plugins, 'plugin')), pr);
});

test('a scheduled reset is not done until PHP has run the restart', async () => {
  const php = fakePhp([
    { opcache: true, reset: true, pending: true, in_progress: false },
    { opcache: true, reset: null, pending: true, in_progress: false },
    { opcache: true, reset: null, pending: false, in_progress: true },
    { opcache: true, reset: null, pending: false, in_progress: false },
  ]);
  const r = await webFresh('pr', { probe: php.probe, ...clock() });
  assert.deepEqual(r, { opcache: true, restarted: true });
  assert.deepEqual(php.calls, ['reset', 'status', 'status', 'status']);
});

test("another lane's pending restart: retry the reset, then wait for ours", async () => {
  const php = fakePhp([
    { opcache: true, reset: false, pending: true, in_progress: false },
    { opcache: true, reset: false, pending: false, in_progress: true },
    { opcache: true, reset: true, pending: true, in_progress: false },
    { opcache: true, reset: null, pending: false, in_progress: false },
  ]);
  await webFresh('dev', { probe: php.probe, ...clock() });
  assert.deepEqual(php.calls, ['reset', 'reset', 'reset', 'status']);
});

test('a reset that never finishes fails after the timeout, naming the site', async () => {
  const php = fakePhp(Array.from({ length: 1000 }, (_, i) => ({ opcache: true, reset: i === 0 ? true : null, pending: true, in_progress: false })));
  await assert.rejects(webFresh('pr', { probe: php.probe, timeoutMs: 5000, ...clock() }), new RegExp(`did not finish its restart for ${SITES.pr.replace(/\./g, '\\.')}`));
});

test('with opcache off there is nothing to reset', async () => {
  const php = fakePhp([{ opcache: false }]);
  assert.deepEqual(await webFresh('pr', { probe: php.probe, ...clock() }), { opcache: false });
});

test('a standalone reset (no mount in this process) still resets and waits', async () => {
  const php = fakePhp([{ opcache: true, reset: true, pending: true, in_progress: false }, { opcache: true, reset: null, pending: false, in_progress: false }]);
  await webFresh('fix', { probe: php.probe, ...clock() });
  assert.deepEqual(php.calls, ['reset', 'status']);
});

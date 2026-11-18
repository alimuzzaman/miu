// Lanes (lib/lane.mjs): a second run on the same server gets its own cache,
// run lock and QA sites; without a lane every name stays as it was. Each case
// runs in a fresh node, since the lane is read once when the module loads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'miu-lane-test-'));

// Runs `code` (an async function body with `m` = the imported module) in a new node.
function inNode(mod, code, { env = {}, args = [] } = {}) {
  const src = `const m = await import(${JSON.stringify(path.join(ROOT, mod))}); console.log(JSON.stringify(await (async () => { ${code} })()));`;
  const base = { ...process.env, QA_CACHE_DIR: path.join(tmp, 'cache') };
  delete base.QA_LANE;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', src, ...args], { encoding: 'utf8', env: { ...base, ...env } });
  if (r.status !== 0) return { error: (r.stderr || r.stdout).trim() };
  return { value: JSON.parse(r.stdout.trim().split('\n').pop()) };
}

test('without a lane every name is the old one', () => {
  const sites = inNode('lib/warmsites.mjs', 'return m.SITES;').value;
  assert.deepEqual(sites, { pr: 'qa-pr.rex', dev: 'qa-dev.rex', fix: 'qa-fix.rex' });
  assert.equal(inNode('lib/worktrees.mjs', 'return m.CACHE;').value, path.join(tmp, 'cache'));
});

test('QA_LANE gives the run its own sites and cache folder', () => {
  const env = { QA_LANE: '2' };
  assert.deepEqual(inNode('lib/warmsites.mjs', 'return m.SITES;', { env }).value, { pr: 'qa-pr-2.rex', dev: 'qa-dev-2.rex', fix: 'qa-fix-2.rex' });
  assert.equal(inNode('lib/worktrees.mjs', 'return m.CACHE;', { env }).value, path.join(tmp, 'cache', 'lanes', '2'));
});

test('a child that already has the lane cache does not nest it again', () => {
  const env = { QA_LANE: '2', QA_CACHE_DIR: path.join(tmp, 'cache', 'lanes', '2') };
  assert.equal(inNode('lib/worktrees.mjs', 'return m.CACHE;', { env }).value, path.join(tmp, 'cache', 'lanes', '2'));
});

test('--lane= picks the lane for qasite, whose wrapper keeps no QA_LANE', () => {
  const r = inNode('lib/lane.mjs', "return [m.LANE, m.siteDomain('dev'), m.plainArgs(['reset', 'dev', '--lane=b'])];", { args: ['reset', 'dev', '--lane=b'] });
  assert.deepEqual(r.value, ['b', 'qa-dev-b.rex', ['reset', 'dev']]);
});

test('a lane name that is not short letters or digits is refused', () => {
  for (const bad of ['../x', 'Lane', 'a b', '123456789']) {
    const r = inNode('lib/lane.mjs', 'return m.LANE;', { env: { QA_LANE: bad } });
    assert.match(r.error ?? '', /A lane is 1 to 8 lowercase letters or digits/, bad);
  }
});

test('the agent qasite shim passes the lane only on a call that names a site', () => {
  const r = inNode('lib/lane.mjs', "return [m.qasiteShim('/x/qasite-as-qa', ''), m.qasiteShim('/x/qasite-as-qa', '2')];").value;
  assert.equal(r[0], '#!/usr/bin/env bash\nexec "/x/qasite-as-qa" "$@"\n');
  const shim = path.join(tmp, 'qasite');
  const target = path.join(tmp, 'target');
  fs.writeFileSync(target, '#!/usr/bin/env bash\necho "$@"\n', { mode: 0o755 });
  fs.writeFileSync(shim, r[1].replaceAll('/x/qasite-as-qa', target), { mode: 0o755 });
  assert.equal(spawnSync(shim, ['reset', 'pr'], { encoding: 'utf8' }).stdout.trim(), 'reset pr --lane=2');
  // The root-owned wrapper allows "info" with nothing after it.
  assert.equal(spawnSync(shim, ['info'], { encoding: 'utf8' }).stdout.trim(), 'info');
});

test("a lane's QA site folder may be read like the others", async () => {
  const { toolRule } = await import('../lib/rules.mjs');
  assert.equal(toolRule('Read', { file_path: '/home/miu/rexenv/Sites/qa-pr-2.rex/wp-content/debug.log' }), null);
  assert.equal(toolRule('Read', { file_path: '/home/miu/rexenv/Sites/qa-pr.rex/wp-content/debug.log' }), null);
  assert.match(toolRule('Read', { file_path: '/home/miu/rexenv/Sites/mysite.rex/wp-content/debug.log' }), /Only the QA sites/);
});

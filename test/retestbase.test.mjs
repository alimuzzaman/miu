import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { retestBase, filesSeenBy } from '../lib/retestbase.mjs';

const patch = (file, line) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n+${line}\n`;
function run(root, name, { url, head, pair = [], verdict, files = {}, mtime }) {
  const d = path.join(root, name);
  fs.mkdirSync(path.join(d, 'context/pair'), { recursive: true });
  fs.writeFileSync(path.join(d, 'context/pr.json'), JSON.stringify({ url, headRefOid: head }));
  fs.writeFileSync(path.join(d, 'context/pair.json'), JSON.stringify(pair));
  for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(d, 'context', f), body);
  if (verdict) { fs.writeFileSync(path.join(d, 'verdict.json'), JSON.stringify(verdict)); fs.writeFileSync(path.join(d, 'results.json'), '{}'); }
  if (mtime && verdict) fs.utimesSync(path.join(d, 'verdict.json'), mtime, mtime);
  return d;
}
const hub = 'https://github.com/o/xspeed-hub/pull/643';
const free = 'https://github.com/o/xspeed/pull/896';
const pairOfHub = (f, p) => [{ repo: 'o/xspeed', number: 896, headRefOid: f }, { repo: 'o/xspeed-pro', number: 366, headRefOid: p }];

test('a paired run of another PR is a re-test base for its member, at the member\'s commit and round', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-'));
  run(root, 'xspeed-896-r1', { url: free, head: 'f0', verdict: { verdict: 'ok', round: 1 }, files: { 'diff.patch': patch('a.php', 'one') }, mtime: 100 });
  run(root, 'xspeed-hub-643-r3', { url: hub, head: 'h3', pair: pairOfHub('f3', 'p3'), mtime: 200,
    verdict: { verdict: 'ok', round: 3, members: [{ key: 'o/xspeed-hub#643', sha: 'h3', round: 3, verdict: 'ok' }, { key: 'o/xspeed#896', sha: 'f3', round: 3, verdict: 'ok' }, { key: 'o/xspeed-pro#366', sha: 'p3', round: 3, verdict: 'ok' }] },
    files: { 'diff.patch': patch('src/x.ts', 'hub'), 'pair/xspeed-896.patch': patch('a.php', 'three'), 'pair/xspeed-pro-366.patch': patch('b.php', 'pro') } });
  const me = run(root, 'xspeed-896-now', { url: free, head: 'f4', pair: [] });
  const prev = retestBase(root, me, { key: 'o/xspeed#896', sha: 'f4', pair: [{ repo: 'o/xspeed-hub', number: 643, headRefOid: 'h3' }, { repo: 'o/xspeed-pro', number: 366, headRefOid: 'p3' }] });
  assert.equal(path.basename(prev.dir), 'xspeed-hub-643-r3');
  assert.deepEqual([prev.sha, prev.round], ['f3', 3]);
  const seen = filesSeenBy(prev.dir, 'o/xspeed#896');
  assert.deepEqual([...seen.keys()].sort(), ['a.php', 'xspeed-hub:src/x.ts', 'xspeed-pro:b.php']);
  assert.deepEqual(seen.get('a.php'), ['+three']);
});

test('the same heads again is a re-run: the base is the round before', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-'));
  run(root, 'xspeed-896-r1', { url: free, head: 'f0', verdict: { verdict: 'ok', round: 1 }, files: { 'diff.patch': patch('a.php', 'one') }, mtime: 100 });
  run(root, 'xspeed-hub-643-r3', { url: hub, head: 'h3', pair: pairOfHub('f3', 'p3'), mtime: 200,
    verdict: { verdict: 'ok', round: 3, members: [{ key: 'o/xspeed-hub#643', sha: 'h3', round: 3, verdict: 'ok' }, { key: 'o/xspeed#896', sha: 'f3', round: 3, verdict: 'ok' }] },
    files: { 'diff.patch': patch('src/x.ts', 'hub'), 'pair/xspeed-896.patch': patch('a.php', 'three') } });
  const me = run(root, 'xspeed-896-now', { url: free, head: 'f3' });
  const prev = retestBase(root, me, { key: 'o/xspeed#896', sha: 'f3', pair: [{ repo: 'o/xspeed-hub', number: 643, headRefOid: 'h3' }, { repo: 'o/xspeed-pro', number: 366, headRefOid: 'p3' }] });
  assert.equal(path.basename(prev.dir), 'xspeed-896-r1');
});

test('an own run still counts, and an inconclusive member or a run with no patch for the PR does not', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-'));
  run(root, 'xspeed-896-r1', { url: free, head: 'f0', verdict: { verdict: 'ok', round: 1 }, files: { 'diff.patch': patch('a.php', 'one') }, mtime: 100 });
  run(root, 'hub-unsure', { url: hub, head: 'h2', mtime: 300, verdict: { verdict: 'ok', members: [{ key: 'o/xspeed-hub#643', sha: 'h2', verdict: 'ok' }, { key: 'o/xspeed#896', sha: 'f2', verdict: 'inconclusive' }] }, files: { 'diff.patch': '', 'pair/xspeed-896.patch': '' } });
  run(root, 'hub-nopatch', { url: hub, head: 'h1', mtime: 400, verdict: { verdict: 'ok', members: [{ key: 'o/xspeed-hub#643', sha: 'h1', verdict: 'ok' }, { key: 'o/xspeed#896', sha: 'f1', verdict: 'ok' }] }, files: { 'diff.patch': '' } });
  const me = run(root, 'now', { url: free, head: 'f4' });
  const prev = retestBase(root, me, { key: 'o/xspeed#896', sha: 'f4' });
  assert.deepEqual([path.basename(prev.dir), prev.sha, prev.round], ['xspeed-896-r1', 'f0', 1]);
  assert.deepEqual([...filesSeenBy(prev.dir, 'o/xspeed#896').keys()], ['a.php']);
});

test('a member posted as ok counts even when the run\'s own PR was inconclusive; a run without members is no base for a member', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-'));
  run(root, 'xspeed-896-r1', { url: free, head: 'f0', verdict: { verdict: 'ok', round: 1 }, files: { 'diff.patch': patch('a.php', 'one') }, mtime: 100 });
  run(root, 'hub-old', { url: hub, head: 'h1', mtime: 150, verdict: { verdict: 'ok', round: 1 }, files: { 'diff.patch': '', 'pair/xspeed-896.patch': patch('a.php', 'old') } });
  run(root, 'hub-r3', { url: hub, head: 'h3', mtime: 200, verdict: { verdict: 'inconclusive', round: 3, members: [{ key: 'o/xspeed-hub#643', sha: 'h3', round: 3, verdict: 'inconclusive' }, { key: 'o/xspeed#896', sha: 'f3', round: 3, verdict: 'ok' }] }, files: { 'diff.patch': '', 'pair/xspeed-896.patch': patch('a.php', 'three') } });
  const me = run(root, 'now', { url: free, head: 'f4' });
  const prev = retestBase(root, me, { key: 'o/xspeed#896', sha: 'f4' });
  assert.deepEqual([path.basename(prev.dir), prev.sha, prev.round], ['hub-r3', 'f3', 3]);
});

test('an own run is found when --repo differs from GitHub only in case', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-'));
  run(root, 'xspeed-896-r1', { url: free, head: 'f0', verdict: { verdict: 'ok', round: 1 }, files: { 'diff.patch': patch('a.php', 'one') }, mtime: 100 });
  const me = run(root, 'now', { url: free, head: 'f4' });
  const prev = retestBase(root, me, { key: 'O/XSpeed#896', sha: 'f4' });
  assert.equal(path.basename(prev.dir), 'xspeed-896-r1');
  assert.deepEqual([...filesSeenBy(prev.dir, 'O/XSpeed#896').keys()], ['a.php']);
});

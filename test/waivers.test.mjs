import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { issueId, parseWaive, mayCommand, applyCommand, forPr, readStore, writeStore, markWaived, ID_RE } from '../lib/waivers.mjs';
import { validate, computeVerdict, renderComment, renderFull, loadLedger } from '../lib/report.mjs';
import { findings } from '../lib/fix.mjs';

const RULE = 'A guided switch never replaces another plugin\'s drop-in';
const business = (extra = {}) => ({ kind: 'business', severity: 'blocker', title: 'The guided switch replaces another plugin\'s object-cache.php', rule: RULE, evidence: ['ev-001', 'ev-002'], ...extra });

function runDir(waivers) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-waive-'));
  fs.mkdirSync(path.join(dir, 'evidence'));
  const rows = ['ev-001', 'ev-002'].map((id) => { fs.writeFileSync(path.join(dir, 'evidence', `${id}.log`), 'x'); return JSON.stringify({ id, kind: 'cmd', label: 'x', file: `${id}.log`, exit: 0 }); });
  fs.writeFileSync(path.join(dir, 'evidence', 'index.jsonl'), rows.join('\n') + '\n');
  if (waivers) fs.writeFileSync(path.join(dir, 'waivers.json'), JSON.stringify(waivers));
  return dir;
}
const passing = [{ id: 1, claim: 'x', visible: false, baseline: { status: 'reproduced', evidence: ['ev-001'] }, results: { A: { status: 'pass', evidence: ['ev-001'] } } }];
const results = (issues) => ({ repo: 'acme/shop', pr: 7, head_sha: 'abcdef1234', environments: [{ id: 'A', label: 'A' }], criteria: structuredClone(passing), issues });
function judge(issues, waivers) {
  const dir = runDir(waivers);
  const v = validate(results(issues), loadLedger(dir), dir);
  return { ...v, dir, verdict: computeVerdict(v.results) };
}
const waiverFor = (issue, extra = {}) => ({ id: issueId(issue), by: 'alim', reason: 'owner-approved exception', url: 'https://github.com/acme/shop/pull/7#issuecomment-1', at: '2026-11-22T00:00:00Z', ...extra });

test('ids are short, stable across rounds and follow the rule for a business issue', () => {
  const id = issueId(business());
  assert.match(id, ID_RE);
  // Another round words the title differently; the rule decides.
  assert.equal(issueId(business({ title: 'Switching overwrites the other plugin\'s drop-in', severity: 'major' })), id);
  // Case, spacing, quotes and a trailing full stop are not a new rule.
  assert.equal(issueId(business({ rule: `  a guided switch never  replaces another plugin's drop-in.` })), id);
  assert.notEqual(issueId(business({ rule: 'Connect AI never names AI clients' })), id);
  // Others: the kind and the claim it breaks, then the title.
  const bug = { severity: 'major', title: 'Save fails', claim_broken: 'Settings save on the first click' };
  assert.equal(issueId({ ...bug, title: 'The save button does nothing' }), issueId(bug));
  assert.notEqual(issueId({ ...bug, kind: 'ci' }), issueId(bug));
  assert.equal(issueId({ title: 'Save fails' }), issueId({ title: 'save fails.' }));
});

test('parsing: ids and a reason line; a missing reason or a bad id changes nothing', () => {
  assert.equal(parseWaive('/miu retest'), null);
  assert.equal(parseWaive('Looks fine to me'), null);
  assert.deepEqual(parseWaive('/miu waive m3f9a m7c21\nReason: owner-approved, DESIGN.md §24.28'), { op: 'waive', ids: ['m3f9a', 'm7c21'], reason: 'owner-approved, DESIGN.md §24.28' });
  assert.deepEqual(parseWaive('Thanks.\n\n/MIU Waive M3F9A, m3f9a\nreason:   approved  '), { op: 'waive', ids: ['m3f9a'], reason: 'approved' });
  assert.deepEqual(parseWaive('/miu waive m3f9a'), { op: 'waive', error: 'no reason line' });
  assert.deepEqual(parseWaive('/miu waive m3f9a\nReason:   '), { op: 'waive', error: 'no reason line' });
  assert.equal(parseWaive('/miu waive\nReason: x').error, 'no finding id');
  assert.match(parseWaive('/miu waive F1 m3f9a\nReason: x').error, /not a finding id: f1/);
  assert.deepEqual(parseWaive('/miu unwaive m3f9a'), { op: 'unwaive', ids: ['m3f9a'] });
});

test('authorization: only the owner, org members and collaborators may command', () => {
  for (const a of ['OWNER', 'MEMBER', 'COLLABORATOR']) assert.equal(mayCommand({ author_association: a }), true);
  for (const a of ['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'NONE', undefined]) assert.equal(mayCommand({ author_association: a }), false);
});

test('the store keeps waivers per repo#pr across commands, and unwaive removes them', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-store-')), '.waivers.json');
  assert.deepEqual(readStore(file), {});
  const who = { by: 'alim', url: 'u1', at: 't1' };
  let s = applyCommand({}, 'Acme/Shop', 7, { op: 'waive', ids: ['m3f9a', 'm7c21'], reason: 'r1' }, who);
  s = applyCommand(s, 'acme/shop', 8, { op: 'waive', ids: ['m3f9a'], reason: 'other pr' }, who);
  // A second waive of the same id takes the newer reason, once.
  s = applyCommand(s, 'acme/shop', 7, { op: 'waive', ids: ['m3f9a'], reason: 'r2' }, { by: 'sam', url: 'u2', at: 't2' });
  writeStore(file, s);
  s = readStore(file);
  assert.deepEqual(forPr(s, 'acme/shop', 7).map((w) => [w.id, w.reason, w.by]).sort(), [['m3f9a', 'r2', 'sam'], ['m7c21', 'r1', 'alim']]);
  s = applyCommand(s, 'acme/shop', 7, { op: 'unwaive', ids: ['m3f9a', 'm7c21'] }, who);
  assert.deepEqual(forPr(s, 'acme/shop', 7), []);
  assert.equal(s['acme/shop#7'], undefined);
  assert.equal(forPr(s, 'acme/shop', 8).length, 1);
});

test('a waived blocker no longer decides the verdict, and is still reported', () => {
  const b = business();
  assert.equal(judge([business()]).verdict, 'not_ok');
  const { results: r, verdict } = judge([b], [waiverFor(b)]);
  assert.equal(verdict, 'ok');
  assert.equal(r.issues.length, 1);
  assert.equal(r.issues[0].waived.by, 'alim');
  // A major one would have made it partial.
  const m = business({ severity: 'major' });
  assert.equal(judge([m], [waiverFor(m)]).verdict, 'ok');
  // Other findings still count.
  const other = { severity: 'major', title: 'Save fails', evidence: ['ev-001', 'ev-002'] };
  assert.equal(judge([b, other], [waiverFor(b)]).verdict, 'partial');
});

test('a CI failure is never waived', () => {
  const ci = { kind: 'ci', severity: 'blocker', title: 'PHPUnit fails on the PR, passes on dev', evidence: ['ev-001', 'ev-002'] };
  const { results: r, verdict } = judge([ci], [waiverFor(ci)]);
  assert.equal(verdict, 'not_ok');
  assert.equal(r.issues[0].waived, undefined);
  assert.deepEqual(r.waivers_unmatched, [issueId(ci)]);
});

test('only qa-run\'s waivers.json counts; nothing in results.json waives', () => {
  const b = business({ waived: { by: 'agent', reason: 'self-approved' } });
  assert.equal(judge([b]).verdict, 'not_ok');
});

test('a reworded rule is a new finding and the waiver no longer covers it', () => {
  const b = business();
  const { verdict, results: r } = judge([business({ rule: 'Never touch other plugins\' files' })], [waiverFor(b)]);
  assert.equal(verdict, 'not_ok');
  assert.deepEqual(r.waivers_unmatched, [issueId(b)]);
});

test('the comment and the full report list waived findings with who, why and a link', () => {
  const b = business();
  const open = { severity: 'major', title: 'Save fails', evidence: ['ev-001', 'ev-002'] };
  const { results: r, verdict, problems, dir } = judge([b, open], [waiverFor(b)]);
  const md = renderComment(r, verdict, { problems });
  assert.match(md, /\*\*Waived, tested and not counted:\*\*/);
  assert.ok(md.includes(`- ${b.title} \`${issueId(b)}\`, waived by [alim](https://github.com/alim): owner-approved exception ([comment](https://github.com/acme/shop/pull/7#issuecomment-1))`));
  // Not under "Goes against the product" or the numbered issues.
  assert.doesNotMatch(md, /Goes against the product/);
  assert.match(md, /1\. \*\*Save fails\*\* `waive: m[0-9a-f]{4}`/);
  assert.match(md, /waive an approved exception with `\/miu waive <id>`/);
  const full = renderFull(r, verdict, { problems, ledger: loadLedger(dir), runDir: dir });
  assert.match(full, /Waived \(1\), tested and not counted in the verdict/);
  assert.match(full, /Verdict: FAIL, 0 blocker \+ 1 other/);
  assert.ok(full.includes('waived by [alim](https://github.com/alim)'));
});

test('a CI failure prints no waive id', () => {
  const ci = { kind: 'ci', severity: 'major', title: 'Lint fails', evidence: ['ev-001', 'ev-002'] };
  const { results: r, verdict, problems } = judge([ci]);
  assert.doesNotMatch(renderComment(r, verdict, { problems }), /waive/);
});

test('a waived finding is not sent to the fixer', () => {
  const b = business();
  const r = { issues: [{ ...b, waived: { by: 'alim' } }], business: [{ rule: RULE, status: 'conflicts' }], criteria: [] };
  assert.deepEqual(findings(r), []);
  markWaived(r, []);
  assert.equal(findings(r).length, 1);
});

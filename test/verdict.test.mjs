// The blocker-only verdict (docs/methodology.md section 2), for a whole run
// and for each PR of a paired run, as bin/qa-run computes them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validate, computeVerdict, forMember, renderComment, renderFull, loadLedger, summary } from '../lib/report.mjs';
import { issueId, memberMatcher, writeRunWaivers } from '../lib/waivers.mjs';
import { endLabels, LABELS } from '../lib/publish.mjs';
import { findings } from '../lib/fix.mjs';

const MEMBERS = [{ key: 'acme/shop#7', repo: 'acme/shop', pr: 7, label: 'Free' }, { key: 'acme/shop-pro#3', repo: 'acme/shop-pro', pr: 3, label: 'Pro' }];
const EV = ['ev-001', 'ev-002'];
const RULE = 'Never modify another plugin settings, drop-ins or .htaccess.';
const handover = (extra = {}) => ({ kind: 'business', severity: 'blocker', title: 'The guided switch replaces the other cache plugin file.', rule: RULE, evidence: EV, ...extra });
const crit = (id, status, extra = {}) => ({ id, claim: `claim ${id}`, visible: false, baseline: { status: 'reproduced', evidence: ['ev-001'] }, results: { A: { status, ...(status === 'pass' || status === 'fail' ? { evidence: EV } : {}) } }, ...extra });

function run({ criteria, issues = [], waivers = null, members = [] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-verdict-'));
  fs.mkdirSync(path.join(dir, 'evidence'));
  fs.writeFileSync(path.join(dir, 'evidence', 'index.jsonl'), EV.map((id) => { fs.writeFileSync(path.join(dir, 'evidence', `${id}.log`), 'x'); return JSON.stringify({ id, kind: 'cmd', label: id, file: `${id}.log`, exit: 0 }); }).join('\n') + '\n');
  if (waivers) writeRunWaivers(dir, { members, waivers });
  const { results, problems } = validate({ repo: 'acme/shop', pr: 7, head_sha: 'abcdef1234', environments: [{ id: 'A', label: 'A' }], criteria, issues }, loadLedger(dir), dir);
  const match = memberMatcher(members);
  return {
    results, problems, dir, verdict: computeVerdict(results),
    member: (key) => { const sub = forMember(results, key, match); return { results: sub, verdict: computeVerdict(sub) }; },
  };
}
const waiver = (issue, extra = {}) => ({ id: issueId(issue), by: 'alim', reason: 'owner-approved handover', url: 'https://github.com/acme/shop/pull/7#issuecomment-1', at: '2026-11-23T00:00:00Z', severity: issue.severity, ...extra });

test('only a confirmed blocker fails the PR; majors, failed and open claims pass with a count', () => {
  const majors = run({ criteria: [crit(1, 'pass'), crit(2, 'fail'), crit(3, 'blocked')], issues: [{ severity: 'major', title: 'Names the client', evidence: EV }] });
  assert.equal(majors.verdict, 'ok');
  assert.deepEqual(summary(majors.results), { majors: 1, failed: 1, open: 1, leads: 0 });
  const md = renderComment(majors.results, majors.verdict, { problems: majors.problems });
  assert.match(md, /^## ✅ FOUND OK\n\nNo release blockers found\. Passed with 1 major finding, 1 failed criterion and 1 unverified criterion, listed below\./);
  assert.match(md, /- \[ \] claim 2 _\(fails: A: fails\)_/);
  assert.match(md, /- \[ \] claim 3 _\(not proven: A: blocked\)_/);
  // Failed claims and no issues: never "No issues found".
  const onlyFailed = run({ criteria: [crit(1, 'pass'), crit(2, 'fail')] });
  assert.doesNotMatch(renderComment(onlyFailed.results, onlyFailed.verdict, { problems: [] }), /No issues found/);
  assert.match(renderFull(majors.results, majors.verdict, { problems: [], ledger: loadLedger(majors.dir), runDir: majors.dir }), /## Verdict: PASS, no blockers/);
  const blocker = run({ criteria: [crit(1, 'pass')], issues: [{ severity: 'blocker', title: 'Deletes the posts', evidence: EV }] });
  assert.equal(blocker.verdict, 'not_ok');
  // A blocker seen once is a lead, not a verdict, and the comment says so.
  const lead = run({ criteria: [crit(1, 'pass')], issues: [{ severity: 'blocker', title: 'Maybe deletes posts', evidence: ['ev-001'] }] });
  assert.equal(lead.verdict, 'ok');
  assert.match(renderComment(lead.results, lead.verdict, { problems: [] }), /No release blockers found\. 1 unconfirmed blocker to check by hand\./);
  // A clean pass says nothing extra.
  const clean = run({ criteria: [crit(1, 'pass')] });
  assert.match(renderComment(clean.results, clean.verdict, { problems: [] }), /^## ✅ FOUND OK\n\n- \[x\]/);
});

test('member verdicts: each PR fails only on its own or a shared blocker', () => {
  const r = run({
    members: MEMBERS,
    criteria: [crit(1, 'pass', { pr: 'acme/shop#7' }), crit(2, 'fail', { pr: 'acme/shop-pro#3' }), crit(3, 'pass')],
    issues: [{ severity: 'blocker', title: 'Pro loses the licence', pr: 'acme/shop-pro#3', evidence: EV }, { severity: 'major', title: 'Free copy', pr: 'acme/shop#7', evidence: EV }],
  });
  assert.equal(r.verdict, 'not_ok');
  assert.equal(r.member('acme/shop#7').verdict, 'ok');
  assert.equal(r.member('acme/shop-pro#3').verdict, 'not_ok');
  // A shared blocker fails both.
  const shared = run({ members: MEMBERS, criteria: [crit(1, 'pass', { pr: 'acme/shop#7' }), crit(2, 'pass', { pr: 'acme/shop-pro#3' })], issues: [{ severity: 'blocker', title: 'Activation fatal', evidence: EV }] });
  assert.deepEqual([shared.member('acme/shop#7').verdict, shared.member('acme/shop-pro#3').verdict], ['not_ok', 'not_ok']);
});

test('a waived blocker and the criterion that only restates it pass; an independent failure is still counted', () => {
  const b = handover();
  const id = issueId(b);
  const r = run({ criteria: [crit(1, 'pass'), crit(3, 'fail', { restates: id }), crit(4, 'fail')], issues: [b], waivers: [waiver(b)] });
  assert.equal(r.verdict, 'ok');
  assert.equal(r.results.criteria[1].waived_with, id);
  assert.equal(r.results.criteria[1].results.A.status, 'fail', 'the observed result is kept');
  assert.equal(r.results.criteria[2].waived_with, undefined);
  assert.equal(summary(r.results).failed, 1);
  assert.match(renderComment(r.results, r.verdict, { problems: [] }), new RegExp(`claim 3 _\\(fails: A: fails\\)_ _\\(restates waived \`${id}\`, not counted\\)_`));
  assert.match(renderFull(r.results, r.verdict, { problems: [], ledger: loadLedger(r.dir), runDir: r.dir }), new RegExp(`claim 3 _\\(restates waived \`${id}\`, not counted\\)_`));
  assert.deepEqual(findings(r.results).map((f) => f.title), ['Claim 4 fails: claim 4']);
  // Not waived: the same criterion counts and the blocker fails the PR.
  const none = run({ criteria: [crit(1, 'pass'), crit(3, 'fail', { restates: id })], issues: [handover()] });
  assert.equal(none.verdict, 'not_ok');
  assert.equal(none.results.criteria[1].waived_with, undefined);
  // Escalated past the waiver: a new decision, nothing is waived.
  const up = run({ criteria: [crit(1, 'pass'), crit(3, 'fail', { restates: id })], issues: [handover()], waivers: [waiver(handover({ severity: 'major' }))] });
  assert.equal(up.verdict, 'not_ok');
  assert.equal(up.results.criteria[1].waived_with, undefined);
  // In a pair, waived on its own PR: that PR passes.
  const pair = run({ members: MEMBERS, criteria: [crit(1, 'pass', { pr: 'acme/shop#7' }), crit(3, 'fail', { pr: 'acme/shop#7', restates: id })], issues: [handover({ pr: 'acme/shop#7' })], waivers: [{ ...waiver(b), key: 'acme/shop#7' }] });
  assert.equal(pair.member('acme/shop#7').verdict, 'ok');
  assert.equal(summary(pair.member('acme/shop#7').results).failed, 0);
});

test('a CI failure at major or above fails the PR, and no waiver lifts it', () => {
  const ci = { kind: 'ci', severity: 'major', title: 'PHPUnit fails on PHP 7.4 on the PR, passes on dev', evidence: EV };
  const r = run({ criteria: [crit(1, 'pass')], issues: [ci], waivers: [waiver(ci)] });
  assert.equal(r.verdict, 'not_ok');
  assert.equal(r.results.issues[0].waived, undefined);
  // Named only in the title, without the kind: still CI.
  assert.equal(run({ criteria: [crit(1, 'pass')], issues: [{ severity: 'major', title: 'The PHPUnit suite fails on the PR', evidence: EV }] }).verdict, 'not_ok');
  // Recorded as minor, or with the one suite run behind it: still a CI failure.
  const low = run({ criteria: [crit(1, 'pass')], issues: [{ kind: 'ci', severity: 'minor', title: 'phpcs fails on the PR', evidence: ['ev-001'] }] });
  assert.equal(low.verdict, 'not_ok');
  assert.equal(low.results.issues[0].severity, 'major');
  assert.equal(low.results.issues[0].unconfirmed, undefined);
  // With no captured run at all it is a lead, as any other finding.
  assert.equal(run({ criteria: [crit(1, 'pass')], issues: [{ kind: 'ci', severity: 'major', title: 'PHPUnit fails' }] }).verdict, 'ok');
  const pair = run({ members: MEMBERS, criteria: [crit(1, 'pass', { pr: 'acme/shop#7' }), crit(2, 'pass', { pr: 'acme/shop-pro#3' })], issues: [{ ...ci, pr: 'acme/shop-pro#3' }] });
  assert.deepEqual([pair.member('acme/shop#7').verdict, pair.member('acme/shop-pro#3').verdict], ['ok', 'not_ok']);
});

test('no usable evidence is NO RESULT, never a pass', () => {
  assert.equal(run({ criteria: [] }).verdict, 'no_result');
  const open = run({ criteria: [crit(1, 'blocked'), crit(2, 'unverified')] });
  assert.equal(open.verdict, 'no_result');
  assert.match(renderComment(open.results, open.verdict, { problems: [] }), /No claim was proven either way/);
  // A pass claimed without captured evidence is not evidence.
  assert.equal(run({ criteria: [{ ...crit(1, 'pass'), results: { A: { status: 'pass' } } }] }).verdict, 'no_result');
  // A confirmed finding is evidence: it is judged.
  assert.equal(run({ criteria: [crit(1, 'blocked')], issues: [{ severity: 'blocker', title: 'Fatal on activation', evidence: EV }] }).verdict, 'not_ok');
  assert.equal(run({ criteria: [crit(1, 'blocked')], issues: [{ severity: 'major', title: 'Notice on save', evidence: EV }] }).verdict, 'ok');
  // A minor note alone is not enough to judge by.
  assert.equal(run({ criteria: [crit(1, 'blocked')], issues: [{ severity: 'nit', title: 'Typo', evidence: EV }] }).verdict, 'no_result');
  // A PR of a pair with only open claims of its own and none shared.
  const pair = run({ members: MEMBERS, criteria: [crit(1, 'pass', { pr: 'acme/shop#7' }), crit(2, 'blocked', { pr: 'acme/shop-pro#3' })] });
  assert.deepEqual([pair.verdict, pair.member('acme/shop#7').verdict, pair.member('acme/shop-pro#3').verdict], ['ok', 'ok', 'no_result']);
});

test('a pass with majors gets the same labels as a clean pass', () => {
  const clean = run({ criteria: [crit(1, 'pass')] });
  const majors = run({ criteria: [crit(1, 'pass'), crit(2, 'fail')], issues: [{ severity: 'major', title: 'Names the client', evidence: EV }] });
  assert.deepEqual(endLabels(majors.verdict, majors.results, []), endLabels(clean.verdict, clean.results, []));
  assert.ok(endLabels(majors.verdict, majors.results, []).add.includes(LABELS.miuOk));
  assert.ok(endLabels('not_ok', majors.results, []).add.includes(LABELS.miuBugs));
});

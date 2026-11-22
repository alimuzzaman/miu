// Waivers: a person accepts a finding as an approved exception from a PR
// comment, so it stops lowering the verdict from the next round on.
//
//   /miu waive m3f9a m7c21
//   Reason: owner-approved exception, DESIGN.md §24.28
//
//   /miu unwaive m3f9a
//
// Miu checks product rules against the base branch, so an exception that
// lives only in the PR branch fails every round; a waiver is how a person
// says so. Everything here is deterministic, no model judgement:
//   - Each issue gets a stable id (issueId): a business issue from its rule,
//     any other from its kind, the claim it breaks and its title.
//   - bin/qa-dashboard scanCommands() reads the command from anyone who may
//     command Miu (mayCommand) and stores it in runs/.waivers.json by repo#pr,
//     with the finding's severity then.
//   - bin/qa-run takes the waivers of every PR it reports on when the round
//     starts, shows them to the agent (context/waivers.json) and, after the
//     agent, writes them to <run>/waivers.json, closed to the agent account,
//     which is what validate() reads. A waiver given during a round counts
//     from the next.
//   - A waiver covers its own PR's issues; an issue shared by a pair only
//     when every PR waived it; and never the same finding grown more severe.
//   - The waived issue is still tested and shown, under "Waived".
// A CI failure is fixed in code and never waived.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// The same check as /miu retest: an org member or a collaborator.
export const MAY_COMMAND = ['OWNER', 'MEMBER', 'COLLABORATOR'];
export const mayCommand = (comment) => MAY_COMMAND.includes(comment?.author_association);

export const ID_RE = /^m[0-9a-f]{4}$/;
const SEVERITIES = ['blocker', 'major', 'minor', 'nit'];
// A CI failure: "kind": "ci", or a finding that names the repo's own suites.
const CI_TEXT = /fast-checks\.md|\btest[- ]suite\b|\bunit tests?\b|\b(phpunit|phpcs|phpstan|psalm|eslint|stylelint|jest|vitest)\b|\bCI\b|\bworkflow (job|run)\b/i;
export function waivable(issue) {
  if (!issue || issue.kind === 'ci') return false;
  if (issue.kind === 'business') return true;
  return !CI_TEXT.test([issue.title, issue.claim_broken, issue.actual, issue.code_ref, ...(issue.steps ?? [])].filter(Boolean).join('\n'));
}

export const norm = (s) => String(s ?? '').toLowerCase().replace(/[`*_"'“”‘’]/g, '').replace(/\s+/g, ' ').trim().replace(/[.:;,!]+$/, '');

export function issueId(issue) {
  const kind = norm(issue.kind || 'defect');
  const basis = kind === 'business' && norm(issue.rule) ? norm(issue.rule) : `${norm(issue.claim_broken)}\n${norm(issue.title)}`;
  return `m${crypto.createHash('sha1').update(`${kind}\n${basis}`).digest('hex').slice(0, 4)}`;
}

// The example is indented, not a line of its own, so Miu never reads its own
// reply as a command (and parseWaive skips quoted and fenced lines as well).
export const FORMAT = [
  'To waive findings, post a new comment with their ids (the `waive: m…` next to each finding in the report) and a reason on the next line, like this:',
  '',
  '> `/miu waive m3f9a m7c21`',
  '> `Reason: why this is an approved exception`',
  '',
  '`/miu unwaive m3f9a` removes a waiver. A waiver counts from the next round; CI failures cannot be waived. An edited comment is not read again.',
].join('\n');

// The comment's own words: no fenced block, quote or indented example.
const ownLines = (body) => String(body).replace(/^\s*(```|~~~)[\s\S]*?^\s*\1.*$/gm, '').split('\n').filter((l) => !/^\s*>/.test(l) && !/^( {4}|\t)/.test(l)).join('\n');

// null: not a waive command. { op, ids, reason } or { op, error } otherwise.
export function parseWaive(body = '') {
  const text = ownLines(body);
  const m = text.match(/^\s*\/miu\s+(waive|unwaive)\b(.*)$/im);
  if (!m) return null;
  const op = m[1].toLowerCase();
  const words = m[2].trim().split(/[\s,]+/).filter(Boolean);
  const ids = [...new Set(words.map((w) => w.toLowerCase()))];
  if (!ids.length) return { op, error: 'no finding id' };
  const bad = ids.filter((x) => !ID_RE.test(x));
  if (bad.length) return { op, error: `not a finding id: ${plain(bad.join(', ').slice(0, 80))}` };
  const reason = (text.match(/^\s*reason\s*:\s*(.*\S)\s*$/im)?.[1] ?? '').slice(0, 500);
  if (op === 'waive' && !reason) return { op, error: 'no reason line' };
  return { op, ids, ...(reason ? { reason } : {}) };
}

// A person's words in Miu's comments: no HTML (an open <!-- hides the rest),
// no markers, links, code or @mentions and #refs that ping.
export const plain = (s) => String(s ?? '').replace(/[<>`[\]|]/g, '').replace(/@(?=\w)/g, '@​').replace(/#(?=\d)/g, '#​').replace(/\s+/g, ' ').trim().slice(0, 500);
export const login = (s) => (/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(\[bot\])?$/.test(String(s ?? '')) ? String(s) : 'someone');
export const commentUrl = (s) => (/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+#issuecomment-\d+$/.test(String(s ?? '')) ? String(s) : null);

export const prKey = (repo, pr) => `${String(repo).toLowerCase()}#${Number(pr)}`;

export function readStore(file) {
  try { const s = JSON.parse(fs.readFileSync(file, 'utf8')); return s && typeof s === 'object' && !Array.isArray(s) ? s : {}; } catch { return {}; }
}

export function writeStore(file, store) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, file);
}

export const forPr = (store, repo, pr) => (Array.isArray(store[prKey(repo, pr)]) ? store[prKey(repo, pr)] : []);

// The store with this command applied. A waive of an id already waived takes
// the newer reason; an unwaive of one not waived changes nothing. what(id)
// gives the finding as it was ({ kind, title, rule, severity }).
export function applyCommand(store, repo, pr, cmd, { by, url, at = new Date().toISOString(), what = () => ({}) }) {
  const key = prKey(repo, pr);
  let list = forPr(store, repo, pr).filter((w) => !cmd.ids.includes(w.id));
  if (cmd.op === 'waive') list = [...list, ...cmd.ids.map((id) => ({ id, by, reason: cmd.reason, url, at, ...what(id) }))];
  const next = { ...store };
  if (list.length) next[key] = list; else delete next[key];
  return next;
}

// Which PR of a run a reference names ("#5", "acme/shop-pro#5", "Pro #5");
// null when none or the run's shared part.
export function memberMatcher(members) {
  return (ref) => {
    const str = String(ref ?? '').toLowerCase();
    const n = Number(str.match(/#\s*(\d+)/)?.[1] ?? str.match(/(\d+)\s*$/)?.[1]);
    const hits = members.filter((m) => m.pr === n);
    if (hits.length <= 1) return hits[0]?.key ?? null;
    // Plugin #5 and its add-on #5: the longer repo name first, since "plugin" is in "plugin-pro".
    return hits.sort((x, y) => y.repo.length - x.repo.length).find((m) => str.includes(m.repo.split('/')[1]) || str.includes(String(m.label ?? '').toLowerCase()))?.key ?? null;
  };
}

// Gives every issue its id (waive_id) and marks each one its waivers cover
// with waived: { by, reason, url, at }. run is <run>/waivers.json:
// { members: [{ key, repo, pr, label }], waivers: [{ id, key, severity, ... }] }.
// Returns the ids that were waived but cover nothing this round.
export function markWaived(results, run = {}) {
  const members = run.members ?? [];
  const waivers = (run.waivers ?? []).filter((w) => w && ID_RE.test(w.id));
  const match = memberMatcher(members);
  const used = new Set();
  for (const i of results.issues ?? []) {
    delete i.waived;
    i.waive_id = issueId(i);
    if (!waivable(i)) continue;
    const mine = (key) => waivers.find((w) => w.id === i.waive_id && (!members.length || w.key === key)
      // The same finding grown more severe is a new decision.
      && !(SEVERITIES.includes(w.severity) && SEVERITIES.indexOf(i.severity) < SEVERITIES.indexOf(w.severity)));
    const own = members.length > 1 && i.pr ? match(i.pr) : null;
    // One PR, its own issue, or a shared one every PR of the pair waived.
    const hits = members.length <= 1 ? [mine(members[0]?.key)] : own ? [mine(own)] : members.map((m) => mine(m.key));
    if (!hits.length || hits.some((w) => !w)) continue;
    const w = hits[0];
    i.waived = { by: login(w.by), reason: plain(w.reason), url: commentUrl(w.url), at: w.at };
    for (const h of hits) used.add(h);
  }
  return [...new Set(waivers.filter((w) => !used.has(w)).map((w) => w.id))];
}

// <run>/waivers.json, written by qa-run after the agent. Only a plain file of
// Miu's own counts: the agent account may write in the run folder.
const WAIVERS = 'waivers.json';
export function loadRunWaivers(runDir) {
  try {
    const file = path.join(runDir, WAIVERS);
    const st = fs.lstatSync(file);
    if (!st.isFile() || (process.getuid && st.uid !== process.getuid())) return {};
    const w = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(w) ? { waivers: w } : w && typeof w === 'object' ? w : {};
  } catch { return {}; }
}

// Written fresh, then closed to the agent account (the run folder's default
// ACL would give it write access), before anything goes in.
export function writeRunWaivers(runDir, data, { rm = (p) => fs.rmSync(p, { force: true }) } = {}) {
  const file = path.join(runDir, WAIVERS);
  rm(file);
  const fd = fs.openSync(file, 'wx', 0o644);
  try {
    const acl = spawnSync('setfacl', ['-b', file], { encoding: 'utf8' });
    if (acl.error?.code !== 'ENOENT' && acl.status !== 0) throw new Error(`setfacl -b ${WAIVERS}: ${(acl.stderr || '').trim()}`);
    fs.fchmodSync(fd, 0o644);
    fs.writeSync(fd, JSON.stringify(data, null, 2));
  } finally { fs.closeSync(fd); }
}

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
//     any other from its kind and the claim it breaks (or its title).
//   - bin/qa-dashboard scanCommands() reads the command from anyone who may
//     command Miu (mayCommand) and stores it in runs/.waivers.json by repo#pr.
//   - bin/qa-run takes the PR's waivers when the round starts, shows them to
//     the agent (context/waivers.json) and, after the agent, writes the same
//     list to <run>/waivers.json, which is what validate() reads (the agent
//     cannot add one). A waiver given during a round counts from the next.
//   - The waived issue is still tested and shown, under "Waived".
// A CI failure (kind "ci") is fixed in code and never waived.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// The same check as /miu retest: an org member or a collaborator.
export const MAY_COMMAND = ['OWNER', 'MEMBER', 'COLLABORATOR'];
export const mayCommand = (comment) => MAY_COMMAND.includes(comment?.author_association);

export const ID_RE = /^m[0-9a-f]{4}$/;
export const NOT_WAIVABLE = ['ci'];
export const waivable = (issue) => !NOT_WAIVABLE.includes(issue?.kind);

const norm = (s) => String(s ?? '').toLowerCase().replace(/[`*_"'“”‘’]/g, '').replace(/\s+/g, ' ').trim().replace(/[.:;,!]+$/, '');

export function issueId(issue) {
  const kind = norm(issue.kind || 'defect');
  const basis = kind === 'business' && norm(issue.rule) ? norm(issue.rule) : norm(issue.claim_broken) || norm(issue.title);
  return `m${crypto.createHash('sha1').update(`${kind}\n${basis}`).digest('hex').slice(0, 4)}`;
}

export const FORMAT = [
  'To waive findings, put their ids (the `waive: m…` next to each finding in the report) and a reason on the next line:',
  '',
  '```',
  '/miu waive m3f9a m7c21',
  'Reason: why this is an approved exception',
  '```',
  '',
  '`/miu unwaive m3f9a` removes a waiver. A waiver counts from the next round; CI failures cannot be waived.',
].join('\n');

// null: not a waive command. { op, ids, reason } or { op, error } otherwise.
export function parseWaive(body = '') {
  const m = String(body).match(/^\s*\/miu\s+(waive|unwaive)\b(.*)$/im);
  if (!m) return null;
  const op = m[1].toLowerCase();
  const words = m[2].trim().split(/[\s,]+/).filter(Boolean);
  const ids = [...new Set(words.map((w) => w.toLowerCase()))];
  if (!ids.length) return { op, error: 'no finding id' };
  const bad = ids.filter((x) => !ID_RE.test(x));
  if (bad.length) return { op, error: `not a finding id: ${bad.join(', ').slice(0, 80)}` };
  const reason = (String(body).match(/^\s*reason\s*:\s*(.*\S)\s*$/im)?.[1] ?? '').slice(0, 1000);
  if (op === 'waive' && !reason) return { op, error: 'no reason line' };
  return { op, ids, ...(reason ? { reason } : {}) };
}

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
// the newer reason; an unwaive of one not waived changes nothing.
export function applyCommand(store, repo, pr, cmd, { by, url, at = new Date().toISOString() }) {
  const key = prKey(repo, pr);
  let list = forPr(store, repo, pr).filter((w) => !cmd.ids.includes(w.id));
  if (cmd.op === 'waive') list = [...list, ...cmd.ids.map((id) => ({ id, by, reason: cmd.reason, url, at }))];
  const next = { ...store };
  if (list.length) next[key] = list; else delete next[key];
  return next;
}

// Gives every issue its id (waive_id) and marks each one a waiver covers with
// waived: { by, reason, url, at }. Returns the ids that were waived but matched nothing.
export function markWaived(results, waivers = []) {
  const byId = new Map(waivers.filter((w) => w && ID_RE.test(w.id)).map((w) => [w.id, w]));
  const used = new Set();
  for (const i of results.issues ?? []) {
    delete i.waived;
    i.waive_id = issueId(i);
    const w = byId.get(i.waive_id);
    if (w && waivable(i)) { i.waived = { by: w.by, reason: w.reason, url: w.url, at: w.at }; used.add(w.id); }
  }
  return [...byId.keys()].filter((id) => !used.has(id));
}

// What a run uses: <run>/waivers.json, written by qa-run after the agent.
export function loadRunWaivers(runDir) {
  try { const w = JSON.parse(fs.readFileSync(path.join(runDir, 'waivers.json'), 'utf8')); return Array.isArray(w) ? w : []; } catch { return []; }
}

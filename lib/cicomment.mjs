// The CI section of a result comment: for each pull request of the run (the
// tested one and its linked Free, Pro or Hub pull requests), each CI job Miu
// ran in its Sandbox CI (lib/ci.mjs) and what came of it, with the commit it
// ran on. CI runs beside the QA run, so it may still be going when the
// comment is posted: the comment then says so, and the dashboard edits the
// same comment's section when CI is done (sweepCiComments). Nothing here
// posts a comment.
import fs from 'node:fs';
import path from 'node:path';
import { rest as githubRest } from './github.mjs';
import { collaborator as githubCollaborator } from './ghuser.mjs';

export const CI_START = '<!-- miu-ci -->';
export const CI_END = '<!-- /miu-ci -->';
// How long a comment waits for CI before its section says CI did not finish.
export const CI_WAIT_MS = 4 * 3600 * 1000;
// The section stays well inside a GitHub comment (65,536 characters): the
// report around it is cut to leave this much (lib/publish.mjs).
export const CI_MAX = 12000;

// Text from the pull request's own run (test names, messages, job labels,
// reasons) is one line with no < or >, so it can never hold an HTML comment
// (Miu's own markers are those), and no @mention. Test names go in a code span.
const clean = (s, max) => String(s ?? '').replace(/[\r\n]+/g, ' ').replace(/</g, '‹').replace(/>/g, '›').replace(/@/g, '@\u200b').trim().slice(0, max);
const code = (s, max = 200) => `\`${clean(s, max).replace(/`+/g, ' ')}\``;
const plain = (s, max = 300) => clean(s, max);
const short = (sha) => (typeof sha === 'string' && sha ? `\`${sha.slice(0, 7)}\`` : 'an unknown commit');

// Still going: no record yet, still reading the workflows, a read that is
// tried again, or a job in the line or running.
const going = (rec) => !rec || rec.state === 'detecting' || (rec.state === 'not_run' && rec.transient) || (rec.state === 'ready' && (rec.jobs ?? []).some((j) => j.status === 'queued' || j.status === 'running'));

function jobLine(j, MAX_NAMES) {
  const t = j.tests;
  if (j.status === 'passed') return `- ✅ ${plain(j.label, 120)}: passed${t?.total ? ` (${t.passed ?? t.total} of ${t.total} tests)` : ''}`;
  if (j.status === 'failed') {
    const count = t?.failedCount ?? t?.failed?.length ?? 0;
    const head = `- ❌ ${plain(j.label, 120)}: failed${count ? `, ${count}${t.total ? ` of ${t.total}` : ''} test${count === 1 && !t.total ? '' : 's'} failed` : ''}`;
    const names = (t?.failed ?? []).slice(0, MAX_NAMES).map((f) => `  - ${code(f.name)}${f.file ? ` in ${code(f.file, 120)}` : ''}${f.message ? `: ${code(f.message, 160)}` : ''}`);
    const more = count > names.length && t?.failed?.length ? [`  - ${names.length ? `and ${count - names.length} more` : `${count} failing tests, named on the dashboard's CI tab`}`] : [];
    return [head, ...names, ...more, ...(!t?.failed?.length ? ['  - No test report names the failing tests; the job\'s log is on the dashboard\'s CI tab.'] : [])].join('\n');
  }
  if (j.status === 'running') return `- ⏳ ${plain(j.label, 120)}: running`;
  if (j.status === 'queued') return `- ⏳ ${plain(j.label, 120)}: waiting for a CI slot`;
  return `- ⚪ ${plain(j.label, 120)}: not run${j.reason ? `: ${plain(j.reason)}` : ''}`;
}

function entryText({ label, repo, pr, sha, rec }, names) {
  const name = `**${plain(label || repo, 60)} #${pr}**`;
  if (!rec) return `${name} at ${short(sha)}: CI has not started yet.`;
  const at = `${name} at ${short(rec.sha ?? sha)}`;
  if (rec.state === 'detecting') return `${at}: reading the workflows.`;
  if (rec.state === 'none') return `${at}: no PR CI. ${plain(rec.reason)}`;
  if (rec.state === 'not_run') return `${at}: CI did not run${rec.transient ? ' yet, it is tried again' : ''}: ${plain(rec.reason)}`;
  const jobs = rec.jobs ?? [];
  if (!jobs.length) return `${at}: no CI job.`;
  const n = (s) => jobs.filter((j) => j.status === s).length;
  const counts = [['passed', n('passed')], ['failed', n('failed')], ['running', n('running') + n('queued')], ['not run', n('not_run') + n('skipped')]].filter(([, k]) => k).map(([w, k]) => `${k} ${w}`).join(', ');
  return [`${at}: ${counts}`, ...jobs.map((j) => jobLine(j, names))].join('\n');
}

// entries: [{ label, repo, pr, sha, rec }], rec the CI record lib/ci.mjs keeps
// (null when CI has not started). gaveUp: CI did not finish in CI_WAIT_MS.
// { text, pending }: text is the whole section, markers included.
export function ciBlock(entries, opts = {}) {
  // Fewer failing test names until it fits; the counts always stay.
  for (const names of [10, 3, 0]) {
    const out = render(entries, { ...opts, names });
    if (out.text.length <= CI_MAX) return out;
  }
  const out = render(entries, { ...opts, names: 0 });
  return { ...out, text: `${out.text.slice(0, CI_MAX - 200).replace(/\n[^\n]*$/, '')}\n\n_The rest is on the dashboard's CI tab._\n${CI_END}` };
}
function render(entries, { gaveUp = false, names = 10 } = {}) {
  const pending = entries.some((e) => going(e.rec));
  const lines = [CI_START, '**CI**, in Miu\'s Sandbox CI on this server (GitHub Actions is not run)', ''];
  if (pending && !gaveUp) lines.push('_CI is still running. This comment is updated when it finishes._', '');
  if (pending && gaveUp) lines.push(`_CI did not finish within ${CI_WAIT_MS / 3600000} hours of this comment. The dashboard's CI tab shows where it stands._`, '');
  for (const e of entries) lines.push(entryText(e, names), '');
  lines.push(CI_END);
  return { text: lines.join('\n'), pending: pending && !gaveUp };
}

// The members of a run, with each one's CI record: at the commit the run
// tested, else the pull request's newest (its head moved on).
export function ciEntries(members, lookup) {
  return members.map((m) => ({ label: m.label, repo: m.repo, pr: m.pr, sha: m.sha, rec: lookup(m.repo, m.pr, m.sha) ?? lookup(m.repo, m.pr) ?? null }));
}

// The comment with its CI section put in (or replaced): before the footer,
// where the comment has one, else at the end. An empty text takes it out.
export function putCiBlock(body, text) {
  const s = String(body ?? '');
  const at = s.indexOf(CI_START), end = s.indexOf(CI_END, at);
  if (at !== -1 && end !== -1) return s.slice(0, at) + text + s.slice(end + CI_END.length);
  if (!text) return s;
  const foot = s.indexOf('\n<sub>Tested by Miu');
  return foot === -1 ? `${s}\n\n${text}` : `${s.slice(0, foot)}\n${text}\n${s.slice(foot)}`;
}

// What the dashboard needs to edit the comments later, written by whoever
// posted them (bin/qa-run, lib/postrun.mjs) when CI was still going:
// dir/<run>.json. comments: [{ repo, id, fallback }], fallback when it was
// posted without the App.
// One file per run; a comment is waited for by one file only, the newest (a
// rerun at the same commit edits the same comment).
export function savePending(dir, run, { members, comments, text, now = Date.now() }) {
  if (!/^[\w.-]+$/.test(run) || !comments.length) return;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const ids = new Set(comments.map((c) => `${c.repo}#${c.id}`));
  for (const f of fs.readdirSync(dir).filter((x) => /^[\w.-]+\.json$/.test(x) && x !== `${run}.json`)) {
    let p; try { p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    if (!Array.isArray(p?.comments) || !p.comments.some((c) => ids.has(`${c.repo}#${c.id}`))) continue;
    p.comments = p.comments.filter((c) => !ids.has(`${c.repo}#${c.id}`));
    if (p.comments.length) writeAtomic(path.join(dir, f), p); else fs.rmSync(path.join(dir, f), { force: true });
  }
  writeAtomic(path.join(dir, `${run}.json`), { at: now, run, members, comments, last: text });
}
// Never half a file: the sweep may read it at any moment.
function writeAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}
export const commentId = (url) => Number(String(url ?? '').match(/#issuecomment-(\d+)$/)?.[1]) || null;

// Each waiting comment whose CI changed gets its section edited in place;
// once CI is done (or CI_WAIT_MS passed) its file goes. lookup(repo, pr,
// sha?) gives a CI record. rest and collaborator stand in for GitHub in tests.
export async function sweepCiComments({ dir, lookup, rest = githubRest, collaborator = githubCollaborator, now = Date.now(), log = () => {} }) {
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /^[\w.-]+\.json$/.test(f)); } catch { return 0; }
  let edited = 0;
  for (const f of files) {
    const file = path.join(dir, f);
    let p; try { p = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { p = null; }
    if (!Array.isArray(p?.members) || !Array.isArray(p?.comments)) {
      // Not a file this writes (writeAtomic): kept a while in case, then gone.
      try { if (now - fs.statSync(file).mtimeMs > 10 * 60 * 1000) fs.rmSync(file, { force: true }); } catch { /* gone */ }
      continue;
    }
    // Long past its wait (a comment that cannot be edited, kept failing): given up.
    if (now - (p.at ?? 0) > 2 * CI_WAIT_MS) { log(`${f}: given up`); fs.rmSync(file, { force: true }); continue; }
    const entries = ciEntries(p.members, lookup);
    const gaveUp = now - (p.at ?? 0) > CI_WAIT_MS;
    const { text, pending } = ciBlock(entries, { gaveUp });
    if (pending && text === p.last) continue;
    const collab = collaborator();
    let failed = false;
    for (const c of p.comments) {
      if (c.done || !/^[\w.-]+\/[\w.-]+$/.test(c.repo ?? '') || !Number.isInteger(c.id)) continue;
      try {
        const got = await rest('GET', `repos/${c.repo}/issues/comments/${c.id}`, { fallback: !!c.fallback });
        const body = String(got?.body ?? '');
        // A later round folded it, or a person took the section out: left alone.
        if (/<!-- [\w-]+-superseded -->/.test(body) || !body.includes(CI_START)) { c.done = true; continue; }
        const next = putCiBlock(body, text);
        if (next === body) continue;
        // Only a comment's author can edit it: the collaborator when it posted it.
        const asCollab = collab && got?.user?.login && got.user.login.toLowerCase() === collab.login.toLowerCase();
        await rest('PATCH', `repos/${c.repo}/issues/comments/${c.id}`, { body: { body: next }, ...(asCollab ? { token: collab.token } : { fallback: !!c.fallback }) });
        edited++;
        log(`${c.repo} comment ${c.id}: CI section ${pending ? 'updated' : 'final'}`);
      } catch (e) {
        // Deleted, or no longer ours to edit: nothing to wait for.
        if (/HTTP (404|410)\b/.test(String(e.message))) { c.done = true; log(`${c.repo} comment ${c.id}: gone`); continue; }
        failed = true; log(`${c.repo} comment ${c.id}: not updated: ${String(e.message).split('\n')[0]}`);
      }
    }
    // A failed edit is tried again on the next sweep, with the same text.
    if (!failed) p.last = text;
    if (!pending && !failed) fs.rmSync(file, { force: true });
    else writeAtomic(file, p);
  }
  return edited;
}

// PR test stacks, carried out: the state file (runs/.stacks.json), the calls
// to bin/miu-pr-stack, and what a follow's status means for the run page.
// lib/prstacks.mjs decides; this does. Off unless Settings turns it on and
// install.sh put the worker in place (--sandbox-user).
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { plan, stackName, kindFor, refusal, followBranches, urls, describe, LIVE } from './prstacks.mjs';

export const WORKER = '/usr/local/lib/miu/pr-stack';
const STATUS_EVERY_MS = 5 * 60 * 1000; // Sandbox's follow polls every 5 minutes
const KEEP_REMOVED_MS = 14 * 24 * 60 * 60 * 1000;
const CALL_MS = 10 * 60 * 1000;

// The worker, as the account that owns Sandbox. Resolves { code, out }.
export function sudoRunner(user, worker = WORKER) {
  return (args) => new Promise((resolve) => {
    execFile('sudo', ['-n', '-H', '-u', user, worker, ...args], { timeout: CALL_MS, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: `${stdout}`.trim(), err: `${stderr}`.trim().slice(-500) });
    });
  });
}

const lastJson = (text) => {
  for (const line of String(text ?? '').trim().split('\n').reverse()) {
    if (!line.trim().startsWith('{')) continue;
    try { return JSON.parse(line); } catch { /* not this line */ }
  }
  return null;
};
const same = (a, b) => !!a && !!b && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => a[k] === b[k]);

// A follow's `status` view -> the fields the planner and the run page use.
// role is the PR's own role, whose repo's head is "the PR's commit".
export function fromStatus(view, role) {
  const st = view?.follow ?? view?.follows?.[0] ?? view;
  if (!st || typeof st !== 'object') return { statusError: 'no status' };
  const attempt = st.attempt ?? null;
  const check = st.last_check ?? null;
  const out = {
    applied: !!st.applied,
    appliedHead: st.applied?.[role] ?? null,
    attemptRunning: ['submitting', 'running'].includes(attempt?.status),
    failed: !!st.failed_heads && !same(st.failed_heads, st.applied) && (check?.reason === 'waiting_after_failure' || attempt?.status === 'failed'),
    failedReason: attempt?.status === 'failed' ? attempt.reason ?? null : null,
    attemptJob: attempt?.job_id ?? null,
    paused: !!st.paused,
    pauseReason: st.pause_reason ?? null,
    lastCheck: check ? { at: check.at ?? null, reason: check.reason ?? null } : null,
  };
  if (check?.reason === 'fetch_failed' || /fetch_failed|fetch of/.test(check?.error ?? '')) {
    out.failed = true;
    out.failedReason = /licensing/i.test(check?.error ?? '') ? 'licensing deploy key missing (WPDevelopers/licensing)' : `fetch failed: ${(check?.error ?? '').slice(0, 200)}`;
  }
  return out;
}

export function createStacks({ runsDir, run, now = () => Date.now(), log = console.error }) {
  const file = path.join(runsDir, '.stacks.json');
  const load = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
  let all = load();
  const save = () => { const tmp = `${file}.tmp`; fs.writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 }); fs.renameSync(tmp, file); };
  let busy = false;

  // A PR in Miu's queue (or its live run) wants a stack. pr: GitHub's open-PR
  // row (headRepo, headRefName, headRefOid); pair: lib/pairs.mjs partners.
  function want(repo, number, role, pr, pair = {}) {
    const key = `${repo}#${number}`;
    const have = all[key];
    if (have && have.state !== 'removed') { have.head = pr.headRefOid ?? have.head; return have; }
    const why = refusal(repo, pr, pair);
    const kind = kindFor(role, pair);
    const s = {
      key, repo, number, role, kind, name: stackName(role, number, kind),
      branches: why ? null : followBranches(role, pr, pair, kind),
      state: why ? 'refused' : 'waiting', why, at: now(), head: pr.headRefOid ?? null, lastPushAt: now(),
    };
    all[key] = s;
    save();
    return s;
  }

  // The head moved: a push. Verdict: Miu's last verdict on this PR and the commit it tested.
  function observe(key, { head, verdictAt, verdictHead } = {}) {
    const s = all[key];
    if (!s) return;
    if (head && head !== s.head) {
      s.head = head; s.lastPushAt = now();
      // An add Sandbox refused is tried again on the next commit.
      if (s.state === 'failed') Object.assign(s, { state: 'waiting', at: now(), why: null });
    }
    if (verdictAt && verdictAt !== s.verdictAt) { s.verdictAt = verdictAt; s.verdictHead = verdictHead ?? null; }
  }

  async function refresh(s) {
    if (s.state !== 'following' || now() - (s.statusAt ?? 0) < STATUS_EVERY_MS) return;
    const r = await run(['status', s.name]);
    s.statusAt = now();
    const v = lastJson(r.out);
    if (r.code !== 0 || !v || v.ok === false) { s.statusError = v?.code ?? (r.err || `exit ${r.code}`); return; }
    Object.assign(s, fromStatus(v, s.role), { statusError: null });
    // Someone took the stack down, or Sandbox reaped it: the follow paused itself.
    if (s.paused && ['stack_removed', 'stack_reaped'].includes(s.pauseReason)) Object.assign(s, { state: 'removing', why: s.pauseReason });
  }

  // One scan. open: Map key -> head of every open PR, or null when the
  // listing failed. liveKeys: the keys the running Miu run tests.
  async function scan({ open, liveKeys = new Set() }) {
    if (busy) return;
    busy = true;
    try {
      const stacks = Object.values(all);
      for (const s of stacks) await refresh(s).catch((e) => log(`stack ${s.name}: status: ${e.message}`));
      // A removal that did not finish is tried again.
      for (const s of stacks.filter((x) => x.state === 'removing')) await removeOne(s, s.why);
      // A failed add may still have made the follow: when its PR closes, remove it too.
      for (const s of stacks.filter((x) => x.state === 'failed' && open && !open.has(x.key))) await removeOne(s, 'closed');
      let mem = null;
      if (stacks.some((s) => s.state === 'waiting')) {
        const r = await run(['mem']);
        mem = r.code === 0 && /^\d+$/.test(r.out) ? Number(r.out) : null;
      }
      const p = plan({ stacks: Object.values(all), open, liveKeys, memMb: mem, now: now() });
      for (const { key, why } of p.remove) await removeOne(all[key], why);
      for (const [key, why] of Object.entries(p.waits)) if (all[key]?.state === 'waiting') all[key].why = why;
      if (p.add) await addOne(all[p.add]);
      // A closed PR's waiting or refused entry goes; removed ones are kept a while for the run page.
      for (const s of Object.values(all)) {
        if (open && !open.has(s.key) && ['waiting', 'refused'].includes(s.state)) delete all[s.key];
        else if (s.state === 'removed' && now() - (s.removedAt ?? 0) > KEEP_REMOVED_MS) delete all[s.key];
      }
      save();
    } finally { busy = false; }
  }

  async function addOne(s) {
    s.state = 'adding';
    save();
    const b = s.branches;
    const r = await run(['add', s.name, s.kind, `free=${b.free}`, `pro=${b.pro}`, ...(b.hub ? [`hub=${b.hub}`] : [])]);
    const v = lastJson(r.out);
    if (r.code === 0 && v?.ok !== false) Object.assign(s, { state: 'following', createdAt: now(), applied: false, statusAt: 0, error: null, why: null });
    else { Object.assign(s, { state: 'failed', error: v?.code ?? (r.err || `exit ${r.code}`) }); log(`stack ${s.name}: add failed: ${s.error}`); }
  }

  async function removeOne(s, why) {
    if (!s) return;
    Object.assign(s, { state: 'removing', why });
    save();
    const r = await run(['remove', s.name]);
    if (r.code === 0) Object.assign(s, { state: 'removed', removedAt: now() });
    else { s.error = lastJson(r.out)?.code ?? (r.err || `exit ${r.code}`); log(`stack ${s.name}: remove: ${s.error}; tried again next scan`); }
  }

  // What the run page shows for a PR.
  function view(key) {
    const s = all[key];
    if (!s) return null;
    const ready = s.state === 'following' && s.applied;
    return {
      name: s.name, kind: s.kind, state: s.state, why: s.why ?? null, text: describe(s),
      urls: ready || s.state === 'following' ? urls(s.name, s.kind) : null,
      ready, appliedHead: s.appliedHead ?? null, head: s.head ?? null, branches: s.branches,
      failedReason: s.failedReason ?? null, attemptJob: s.attemptJob ?? null,
    };
  }

  return { want, observe, scan, view, list: () => Object.values(all), reload: () => { all = load(); } };
}

export { LIVE };

// A test stack per pull request in Miu's queue: a Sandbox stack on this
// server that follows the PR's head branch (Sandbox's `host follow`), so a
// tester always has a site at the PR's latest commit.
//
// This file decides; it runs nothing. bin/qa-dashboard calls plan() every scan
// and carries out what it returns through bin/miu-pr-stack, the one command
// Miu may run as the account that owns Sandbox.
//
// The rules (owner, 2026-11-16):
//   - Same-org branches only (WPDevelopers); a fork never gets a stack.
//   - At most CAP stacks. A new one past CAP removes the oldest idle one first.
//   - A stack goes when its PR is merged or closed, or IDLE_MS after Miu's
//     verdict with no new push.
//   - A PR that touches the Hub gets the full stack; others WordPress only.
//   - No new stack while the server has under MIN_FREE_MB of memory available.
//   - Hub PRs are compared with BASE (pr-hub-base): one full stack that
//     follows dev everywhere, kept for good. It counts toward CAP, so CAP - 1
//     are left for PR stacks, and nothing removes or evicts it.

export const ORG = 'WPDevelopers';
export const CAP = 10;
export const MIN_FREE_MB = 3072;
export const IDLE_MS = 48 * 60 * 60 * 1000;
export const ZONE = 'xspeedcdn.online';
export const REMOTE = 'xspeed-dev';
export const PANEL = 'https://sandbox.xspeedcdn.online';
// The branch a role's repo runs when the PR has no partner there.
export const DEFAULT_BRANCH = { free: 'dev', pro: 'dev', hub: 'dev' };
export const ROLES = ['free', 'pro', 'hub'];

// What Sandbox and git accept as a branch, and nothing a shell or argv could
// read as an option. bin/miu-pr-stack checks the same again.
export const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*\.lock$)[A-Za-z0-9._/-]{1,200}(?<![./])$/;
export const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// States a stack moves through. "live" ones hold memory on the server.
export const LIVE = new Set(['adding', 'following', 'removing']);

// pr-free-412; the WordPress-only stack is wp-pr-free-412 (its site is
// wp-<base>, as xspeed-dev-setup names them), the full one pr-hub-88.
export function stackName(role, number, kind) {
  if (!ROLES.includes(role) || !Number.isInteger(number) || number < 1) throw new Error('not a PR of a known role');
  const base = `pr-${role}-${number}`;
  return kind === 'full' ? base : `wp-${base}`;
}

// The "before" side for Hub PRs: a whole stack at dev (owner, 2026-11-17).
export const BASE = { key: 'base:WPDevelopers/xspeed-hub', name: 'pr-hub-base', kind: 'full', branches: { free: 'dev', pro: 'dev', hub: 'dev' } };

// The Hub is in the stack when the PR is a Hub PR or its pair has one.
export const kindFor = (role, pair = {}) => (role === 'hub' || pair.hub ? 'full' : 'wp');

// Why this PR may not have a stack, or null. headRepo is GitHub's head.repo.full_name.
export function refusal(repo, pr, pair = {}) {
  const same = (r, head) => r && head && r.toLowerCase() === head.toLowerCase() && r.split('/')[0].toLowerCase() === ORG.toLowerCase();
  if (!same(repo, pr.headRepo)) return 'fork';
  for (const p of Object.values(pair)) if (!same(p.repo, p.headRepo)) return 'fork';
  if (!BRANCH.test(pr.headRefName ?? '')) return 'branch';
  for (const p of Object.values(pair)) if (!BRANCH.test(p.headRefName ?? '')) return 'branch';
  return null;
}

// role -> branch the stack follows: the PR's own branch for its role, a
// partner's for theirs, else the default. A WordPress-only stack has no Hub.
export function followBranches(role, pr, pair = {}, kind = kindFor(role, pair)) {
  const out = {};
  for (const r of ROLES) {
    if (r === 'hub' && kind !== 'full') continue;
    out[r] = r === role ? pr.headRefName : pair[r]?.headRefName ?? DEFAULT_BRANCH[r];
  }
  return out;
}

// What a tester opens. Sign-in is the panel's WordPress admin button.
export function urls(name, kind) {
  const site = kind === 'full' ? `wp-${name}` : name;
  const out = { site: `https://${site}.${ZONE}`, panel: `${PANEL}/hosting/${REMOTE}/${name}` };
  if (kind === 'full') Object.assign(out, { hub: `https://hub-${name}.${ZONE}`, admin: `https://admin-${name}.${ZONE}`, renderer: `https://renderer-${name}.${ZONE}` });
  else out.hub = `https://hub-dev.${ZONE}`;
  return out;
}

// A stack no one is using: following, no attempt running, not the live run's PR.
const idle = (s, liveKeys) => s.state === 'following' && !s.permanent && !s.attemptRunning && !liveKeys.has(s.key);
// Oldest = the earliest of its last push and its verdict, whichever is later.
const lastUse = (s) => Math.max(s.lastPushAt ?? 0, s.verdictAt ?? 0, s.createdAt ?? 0);

// One scan's decisions.
//   stacks: [{ key, name, kind, state, at, head, lastPushAt, createdAt,
//              verdictAt, verdictHead, applied, attemptRunning, why }]
//   open:   Map key -> head sha of every open PR, or null when the listing failed
//   liveKeys: keys of the PRs the running Miu run tests
//   memMb:  memory available on the server, or null when unknown
// Returns { remove: [{ key, why }], add: key | null, waits: { key: why } }.
// At most one add per scan, and none while another stack has not applied yet,
// so that several new stacks cannot all pass the memory check before any builds.
export function plan({ stacks, open, liveKeys = new Set(), memMb, now = Date.now() }) {
  const remove = [];
  const going = new Set();
  for (const s of stacks) {
    if (!LIVE.has(s.state) || s.state === 'removing' || s.permanent) continue;
    if (open && !open.has(s.key)) { remove.push({ key: s.key, why: 'closed' }); going.add(s.key); continue; }
    const head = open?.get(s.key) ?? s.head;
    if (s.verdictAt && s.verdictHead === head && now - s.verdictAt >= IDLE_MS && !liveKeys.has(s.key)) {
      remove.push({ key: s.key, why: 'idle' }); going.add(s.key);
    }
  }
  const waits = {};
  let add = null;
  const live = stacks.filter((s) => LIVE.has(s.state));
  // The base stack goes first: every Hub PR's run needs it.
  const waiting = stacks.filter((s) => s.state === 'waiting' && (s.permanent || !open || open.has(s.key))).sort((a, b) => (b.permanent ? 1 : 0) - (a.permanent ? 1 : 0) || (a.at ?? 0) - (b.at ?? 0));
  // A follow whose build failed is not building: it waits for a new commit and must not hold up the others.
  const building = live.some((s) => s.state === 'adding' || (s.state === 'following' && !s.applied && !s.failed && !going.has(s.key)));
  let evicted = false;
  for (const s of waiting) {
    if (add || evicted) { waits[s.key] = waits[s.key] ?? 'queued'; continue; }
    // A removal this scan still holds memory until its stack is down.
    if (live.length >= CAP) {
      if (going.size) { waits[s.key] = 'cap'; continue; }
      const victim = live.filter((x) => idle(x, liveKeys)).sort((a, b) => lastUse(a) - lastUse(b))[0];
      if (victim) { remove.push({ key: victim.key, why: 'evicted' }); going.add(victim.key); evicted = true; }
      waits[s.key] = 'cap';
      continue;
    }
    if (building) { waits[s.key] = 'building'; continue; }
    if (!Number.isFinite(memMb)) { waits[s.key] = 'memory_unknown'; continue; }
    if (memMb < MIN_FREE_MB) { waits[s.key] = 'memory'; continue; }
    add = s.key;
  }
  return { remove, add, waits };
}

// What the run page says about a stack's state.
export function describe(s) {
  if (!s) return null;
  const W = {
    fork: 'No test stack: the branch is in a fork. Only WPDevelopers branches get one.',
    branch: 'No test stack: a branch name Sandbox does not accept.',
    cap: `Waiting: ${CAP} test stacks are up and none is idle.`,
    building: 'Waiting: another test stack is being built first.',
    memory: `Waiting: the server has under ${MIN_FREE_MB / 1024} GB of memory free.`,
    memory_unknown: 'Waiting: the server\'s free memory could not be read.',
    queued: 'Waiting for its turn.',
  };
  const R = { closed: 'the pull request was merged or closed', idle: '48 hours after the verdict with no new commits', evicted: 'a newer pull request needed the room', paired: 'it is tested on its Hub pull request\'s stack now' };
  switch (s.state) {
    case 'waiting': return W[s.why] ?? 'Waiting.';
    case 'refused': return W[s.why] ?? 'No test stack.';
    case 'adding': return 'Setting up the test stack.';
    case 'following':
      if (s.failed) return `The last build failed${s.failedReason ? `: ${s.failedReason}` : ''}. It tries again on the next commit.`;
      if (s.attemptRunning) return 'Building the latest commit.';
      if (!s.applied) return 'Building.';
      return s.appliedHead && s.head && s.appliedHead !== s.head ? 'Ready, at an older commit; the new one builds within 5 minutes.' : 'Ready.';
    case 'removing': return `Being removed: ${R[s.why] ?? s.why}.`;
    case 'removed': return `Removed: ${R[s.why] ?? s.why}.`;
    case 'failed': return `Could not set up the test stack${s.error ? `: ${s.error}` : ''}.`;
    default: return null;
  }
}

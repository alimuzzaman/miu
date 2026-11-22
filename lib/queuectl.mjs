// What may start from the test queue, and in what order.
//
// Two settings decide it, both kept in runs/.config.json so they survive a
// restart. autoTest true is auto mode: Miu starts what it queued by itself.
// autoTest false is manual mode: Miu still queues new pull requests and new
// commits, but only what a person picked starts. paused: nothing new starts in
// either mode; what is running goes on, and resuming takes the line as it was.
//
// A queue entry: { repo, pr, why, by, held, full, force, note, at, label? }.
// by is 'person' (the dashboard or the CLI), 'github' (a team member's /miu
// comment or request label) or 'auto' (Miu's own scan). Manual mode starts
// only what a person picked on the dashboard or the CLI: Miu's own entries and
// GitHub's (a label or a /miu comment) wait for a person too, so one run at a
// time is a person's choice. An entry saved before this field existed starts
// too. held: a person set this one aside; it keeps its place and does not
// start until released.

export const modeOf = (cfg) => (cfg.autoTest === false ? 'manual' : 'auto');

// Why an entry does not start now, or null when it may.
export function holdReason(q, { mode, paused }) {
  if (paused) return 'paused';
  if (q.held) return 'held';
  if (mode === 'manual' && (q.by === 'auto' || q.by === 'github')) return 'manual';
  return null;
}

export const startable = (q, st) => holdReason(q, st) === null;

// A person took this entry out of the line: what keeps it out at this commit.
// Miu's own entry: its head joins the baseline. A label's entry also: the
// label stays on the PR (Miu takes it off only when a run starts), so the
// label scan skips it at this head. A new commit asks again.
export function dismissal(q, head) {
  if (!head || (q.by !== 'auto' && q.by !== 'github')) return null;
  return { baseline: head, ...(q.by === 'github' ? { label: head } : {}) };
}
export const labelDismissed = (cfg, key, head) => !!head && cfg?.labelDismissed?.[key] === head;

// A label put this entry in the line (q.label, the request label's name), and
// labels can come off while it waits. An entry queued before q.label existed
// says so in its why ("labelled <name>"). null: no label decides (a person's
// pick, a /miu comment, Miu's own scan).
export function labelOf(q) {
  if (q?.label !== undefined) return q.label || null;
  return q?.by === 'github' && typeof q.why === 'string' && q.why.startsWith('labelled ') ? q.why.slice(9) : null;
}

// Why a label's entry should go instead of starting, or null when it may start.
// pr: the pull request as GitHub has it now ({ state, labels: [names] }), or
// null when that could not be read: then it starts as before. asks: the
// request label names.
export function labelGone(q, pr, asks) {
  if (!labelOf(q) || q.by === 'person' || !pr) return null;
  if (pr.state && pr.state !== 'OPEN') return 'closed while queued';
  const names = (pr.labels ?? []).map((l) => (typeof l === 'string' ? l : l?.name));
  if (!names.some((l) => asks.includes(l))) return 'label removed while queued';
  return null;
}

// Take the next entry that may start out of the line (in place). A label's
// entry is checked against GitHub first (readPr(repo, pr)); one whose label
// came off or whose PR closed goes, and the next is tried. state(): the
// queue's mode and pause, read again after each GitHub call. busy(): a run
// started meanwhile. -> { next: entry | null, dropped: [{ ...entry, dropWhy }] }
export async function takeNext(queue, state, { readPr, asks, busy = () => false, log = () => {} }) {
  const dropped = [];
  for (;;) {
    const at = nextIndex(queue, state());
    if (at < 0 || busy()) return { next: null, dropped };
    const cand = queue[at];
    let why = null;
    if (labelOf(cand) && cand.by !== 'person') {
      let now = null;
      try { now = await readPr(cand.repo, cand.pr); } catch (e) { log(`queue: labels of ${cand.repo}#${cand.pr} unread (${e.message}); starting it`); }
      why = labelGone(cand, now, asks);
    }
    if (busy()) return { next: null, dropped };
    const i = queue.indexOf(cand);
    if (i < 0) continue;
    queue.splice(i, 1);
    if (why) { dropped.push({ ...cand, dropWhy: why }); log(`queue: dropped ${cand.repo}#${cand.pr}: ${why}`); continue; }
    return { next: cand, dropped };
  }
}

// The first entry that may start, or -1.
export const nextIndex = (queue, st) => queue.findIndex((q) => startable(q, st));

// Put the picked pull requests at the front of the line, in the order given,
// as a person's pick: they start in either mode. Changes queue in place.
export function pick(queue, picks, { full = false, now = Date.now() } = {}) {
  const front = [];
  for (const { repo, pr } of picks) {
    if (front.some((q) => q.repo === repo && q.pr === pr)) continue;
    const i = queue.findIndex((q) => q.repo === repo && q.pr === pr);
    const q = i > -1 ? queue.splice(i, 1)[0] : { repo, pr, why: 'started from the dashboard', full: false, force: false, note: '', at: now };
    q.by = 'person';
    q.held = false;
    if (full) q.full = true;
    front.push(q);
  }
  queue.unshift(...front);
  return front;
}

// The pull requests that get a test stack: the live run and the members of
// its pair, and entries a person started or queued (the dashboard, the
// terminal or a pick: by 'person'). Entries the scan queued by itself
// (auto, a label, a /miu comment) wait without one: in manual mode the scan
// queues every pull request with new commits, and each stack is a full set
// of containers on the server.
export function stackKeys(queue, liveKeys = []) {
  // An entry keeping its turn for its stack (stackWait) wants that stack too.
  return new Set([...liveKeys, ...queue.filter((q) => q.by === 'person' || q.stackWait).map((q) => `${q.repo}#${q.pr}`)]);
}

// A run that stopped to wait for its test stack keeps its turn (owner,
// 2026-11-22): its entry goes back to the front of the line, and nothing
// else starts while that stack is still on its way. Without this, the
// waiting run's exit freed the slot and the next entry started in its place
// (#696 waited at 09:25, and #276 started at 09:25:29).
export const STACK_HOLD_MS = 60 * 60 * 1000;
// The stack a waiting run waited for, from its waiting.json reasons
// (lib/hubstack.mjs prepareHubStacks), or null when it waited for something else.
export function stackWaited(reasons = []) {
  for (const r of reasons) {
    const m = /^The (?:pr|dev) Hub stack ([a-z0-9-]+) is not ready/.exec(typeof r === 'string' ? r : '');
    if (m) return m[1];
  }
  return null;
}
// Put the waited run's entry back first in line, marked with the stack it
// waits for. entry: what the run was started from. Changes queue in place.
export function requeueWaited(queue, entry, name, now = Date.now()) {
  const i = queue.findIndex((q) => q.repo === entry.repo && q.pr === entry.pr);
  const q = i > -1 ? queue.splice(i, 1)[0] : { ...entry };
  q.stackWait = { name, until: now + STACK_HOLD_MS };
  q.held = false;
  queue.unshift(q);
  return q;
}
// Why nothing may start yet, or null. stackOf(name): the dashboard's entry for
// that stack (lib/prstackctl.mjs), or null. A hold ends (and its mark goes, in
// place) once the stack is ready, cannot come (refused, failed, removed, gone),
// or STACK_HOLD_MS has passed; the entry then starts first as usual.
export function stackHold(queue, stackOf, now = Date.now()) {
  for (const q of queue) {
    if (!q.stackWait) continue;
    const s = stackOf(q.stackWait.name);
    const coming = !!s && (['waiting', 'adding'].includes(s.state) || (s.state === 'following' && !s.applied && !s.failed));
    if (!coming || now >= q.stackWait.until) { delete q.stackWait; continue; }
    return `${q.repo}#${q.pr} keeps its turn until its test stack ${q.stackWait.name} is ready`;
  }
  return null;
}

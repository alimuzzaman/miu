// What may start from the test queue, and in what order.
//
// Two settings decide it, both kept in runs/.config.json so they survive a
// restart. autoTest true is auto mode: Miu starts what it queued by itself.
// autoTest false is manual mode: Miu still queues new pull requests and new
// commits, but only what a person picked starts. paused: nothing new starts in
// either mode; what is running goes on, and resuming takes the line as it was.
//
// A queue entry: { repo, pr, why, by, held, full, force, note, at }.
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

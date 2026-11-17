// The reply to a /miu comment that cannot start yet: in manual mode the run
// waits for a person (lib/queuectl.mjs), so the commenter is told where to
// start it. One reply per trigger comment, ever: bin/qa-dashboard records the
// trigger in runs/.commands.json before it posts (and scans never overlap), so
// a rescan, a restart or a failed post never posts twice. It goes out with
// Settings' "post" off too: it says the test waits, it is not a report.
//
// The marker is not Miu's report marker (<!-- <marker> pr=N -->, lib/publish.mjs),
// so the report finder never takes this reply for a run's comment.
import { holdReason } from './queuectl.mjs';

export const waitsMarker = (marker, commentId) => `<!-- ${marker}-waits=${Number(commentId)} -->`;

// Whether this trigger gets a reply: its entry waits because the queue is in
// manual mode (not a person's pick, not held), and it was never answered.
export function needsReply({ entry, mode, replied = [], commentId }) {
  return !!entry && holdReason(entry, { mode, paused: false }) === 'manual' && !replied.includes(commentId);
}

export function waitsReply({ publicUrl, marker, commentId, paused = false }) {
  const url = /^https:\/\//.test(publicUrl ?? '') ? `${publicUrl.replace(/\/+$/, '')}/` : null;
  return [
    `Queued. Miu is in manual mode, so this test waits until someone starts it${url ? ` from the dashboard: ${url}` : ' from the dashboard.'}${paused ? ' The queue is paused for now as well.' : ''}`,
    '',
    waitsMarker(marker, commentId),
  ].join('\n');
}

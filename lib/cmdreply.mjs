// The reply to a /miu comment that cannot start yet: in manual mode the run
// waits for a person (lib/queuectl.mjs), so the commenter is told where to
// start it. One reply per trigger comment, ever: bin/qa-dashboard records the
// trigger in runs/.commands.json before it posts, so a rescan, a restart or a
// failed post never posts twice.
//
// The marker is not Miu's report marker (<!-- <marker> pr=N -->, lib/publish.mjs),
// so the report finder never takes this reply for a run's comment.

export const waitsMarker = (marker, commentId) => `<!-- ${marker}-waits=${Number(commentId)} -->`;

// Whether this trigger gets a reply: the entry waits only because the queue is
// in manual mode, and it was never answered before.
export function needsReply({ mode, waits, replied = [], commentId }) {
  return mode === 'manual' && (waits === 'manual' || waits === 'paused') && !replied.includes(commentId);
}

export function waitsReply({ publicUrl, marker, commentId }) {
  const url = `${String(publicUrl ?? '').replace(/\/+$/, '')}/`;
  return [
    'Queued for a manual start. Miu is in manual mode, so this test waits until someone starts it from the dashboard.',
    '',
    `Dashboard: ${url}`,
    '',
    waitsMarker(marker, commentId),
  ].join('\n');
}

// A lane runs a test beside another one on the same server. Each lane has its
// own worktrees and run lock (under the cache folder) and its own QA sites
// (qa-pr-2.rex, qa-dev-2.rex, qa-fix-2.rex), so two runs never share a path
// or a site. Without a lane, every name stays as it was.
//
// The lane comes from QA_LANE, or from a --lane=NAME argument. The argument is
// for qasite: the agent account reaches it through a root-owned wrapper that
// keeps only Miu's own environment, but passes every argument on.

const ARG = '--lane=';

function parse(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if (!/^[a-z0-9]{1,8}$/.test(s)) throw new Error(`A lane is 1 to 8 lowercase letters or digits, not "${s.slice(0, 20)}".`);
  return s;
}

const fromArg = process.argv.find((a) => a.startsWith(ARG));
export const LANE = parse(fromArg ? fromArg.slice(ARG.length) : process.env.QA_LANE);

// The rexenv domain of a QA site in this lane.
export const siteDomain = (which, lane = LANE) => (lane ? `qa-${which}-${lane}.rex` : `qa-${which}.rex`);

// The cache folder of this lane, below the shared one.
// Idempotent: a child process gets QA_CACHE_DIR already set to the lane's folder.
export const laneCache = (base, lane = LANE) => (!lane || base.endsWith(`/lanes/${lane}`) ? base : `${base}/lanes/${lane}`);

// The command line arguments without --lane=..., for scripts that read them by position.
export const plainArgs = (argv) => argv.filter((a) => !a.startsWith(ARG));

// The agent's qasite shim: in a lane, a call with a site (reset pr, login dev)
// carries the lane on to the wrapper.
export function qasiteShim(exe, lane = LANE) {
  if (!lane) return `#!/usr/bin/env bash\nexec "${exe}" "$@"\n`;
  return `#!/usr/bin/env bash\nif [ "$#" -ge 2 ]; then exec "${exe}" "$@" ${ARG}${lane}; fi\nexec "${exe}" "$@"\n`;
}

export const laneArg = (lane = LANE) => (lane ? [`${ARG}${lane}`] : []);

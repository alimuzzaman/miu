// The earlier run a re-test compares with (bin/qa-run, methodology section 5).
//
// A pull request is tested in its own run, or as a member of another PR's
// paired run (Free, Pro and Hub together): that run's verdict.json lists every
// member with the commit it tested and its round, and context/pair/ holds each
// member's patch. Both count as an earlier round of the PR.
import fs from 'node:fs';
import path from 'node:path';

// A patch split by file, keeping its added and removed lines only: a merge of
// dev shifts line numbers and context, which is not the PR's own change.
export const perFile = (patch) => {
  const m = new Map();
  for (const part of patch.split(/^(?=diff --git )/m)) { const f = part.match(/^diff --git a\/(\S+) b\/(\S+)/); if (f) m.set(f[2], part.split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l))); }
  return m;
};

const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const keyOfUrl = (u) => { const m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(u ?? ''); return m ? `${m[1]}#${m[2]}` : null; };
// "owner/xspeed-pro#366" -> "xspeed-pro-366", the name of its file in context/pair/.
const fileName = (key) => { const [r, n] = key.split('#'); return `${r.split('/')[1]}-${n}`; };
const sig = (rows) => rows.map((x) => `${x.key}@${x.sha}`.toLowerCase()).sort().join(',');
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const SKIP = new Set(['inconclusive', 'no_result']);

// The files a run's patches touch, keyed as the PR `key` sees them: its own
// paths bare, a partner's as "<repo>:<path>".
export function filesSeenBy(dir, key) {
  const m = new Map();
  const own = fileName(key);
  const add = (patch, prefix) => { for (const [k, v] of perFile(patch)) m.set(prefix ? `${prefix}:${k}` : k, v); };
  const primary = keyOfUrl(read(path.join(dir, 'context/pr.json')).url);
  add(fs.readFileSync(path.join(dir, 'context/diff.patch'), 'utf8'), same(primary, key) ? null : fileName(primary).replace(/-\d+$/, ''));
  const pd = path.join(dir, 'context/pair');
  for (const f of fs.existsSync(pd) ? fs.readdirSync(pd).filter((x) => x.endsWith('.patch')) : []) {
    const name = f.replace(/\.patch$/, '');
    add(fs.readFileSync(path.join(pd, f), 'utf8'), same(name, own) ? null : name.replace(/-\d+$/, ''));
  }
  return m;
}

// The newest finished run that tested PR `key` at another set of heads (its
// own run, or a paired run it was a member of), or null. pair: this run's
// other PRs, [{ repo, number, headRefOid }]. The same heads again is a re-run,
// not a re-test. -> { dir, sha, round, at }
export function retestBase(runsDir, runDir, { key, sha, pair = [] }) {
  const now = sig([{ key, sha }, ...pair.map((x) => ({ key: `${x.repo}#${x.number}`, sha: x.headRefOid }))]);
  return fs.readdirSync(runsDir).map((d) => path.join(runsDir, d)).filter((d) => d !== runDir).map((d) => {
    try {
      const p = read(path.join(d, 'context/pr.json'));
      const v = read(path.join(d, 'verdict.json'));
      const primary = keyOfUrl(p.url);
      if (!primary) return null;
      const own = same(primary, key);
      // A member's result is posted on its own even when the run's PR was
      // inconclusive (lib/postrun.mjs): only the member's verdict counts.
      const m = own ? { sha: p.headRefOid, round: v.round, verdict: v.verdict } : (v.members ?? []).find((x) => same(x.key, key));
      if (!m?.sha || SKIP.has(m.verdict) || !fs.existsSync(path.join(d, 'results.json'))) return null;
      if (!own && !fs.existsSync(path.join(d, 'context/pair', `${fileName(key)}.patch`))) return null;
      let pairThen = [];
      try { pairThen = read(path.join(d, 'context/pair.json')); } catch { /* a run with no pair */ }
      if (sig([{ key: primary, sha: p.headRefOid }, ...pairThen.map((x) => ({ key: `${x.repo}#${x.number}`, sha: x.headRefOid }))]) === now) return null;
      return { dir: d, sha: m.sha, round: m.round ?? 1, at: fs.statSync(path.join(d, 'verdict.json')).mtimeMs };
    } catch { return null; }
  }).filter(Boolean).sort((a, b) => b.at - a.at)[0] ?? null;
}

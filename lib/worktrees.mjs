// Code for a run comes from git, not from a fresh clone and build.
//
// Layout, all inside .cache in Miu's folder and never in the user's own checkouts:
//   .cache/repos/<name>.git     one bare clone per repo, fetched before each run
//   .cache/wt/<name>-pr         worktree with the pull request's head
//   .cache/wt/<name>-dev        worktree with the base branch
//
// The worktrees are fixed slots and are reused: a run moves them to a commit
// with checkout + reset --hard + clean, so they never pile up. vendor/ and
// node_modules/ survive the clean and are reinstalled only when composer.lock
// or package-lock.json changes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { deployKeyRepos, lockKeyedRepos, lockWithoutDists, MIRRORS_FILE, MAX_BUNDLE } from './sandboxci.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CACHE = process.env.QA_CACHE_DIR ?? path.join(ROOT, '.cache');
const git = (args, opts = {}) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts }).trim();

const remoteUrl = (repo) => `https://github.com/${repo}.git`;
// authEnv comes from github.mjs gitAuthEnv(): the token travels in GIT_CONFIG_*
// environment variables, never in a URL or argument a process list shows.
const withAuth = (authEnv) => (authEnv ? { env: { ...process.env, ...authEnv } } : {});

// One bare clone per repo; created once, fetched every run.
export function ensureRepo(repo, authEnv, fallbackEnv) {
  const name = repo.split('/')[1];
  const bare = path.join(CACHE, 'repos', `${name}.git`);
  if (!fs.existsSync(path.join(bare, 'HEAD'))) {
    fs.mkdirSync(path.dirname(bare), { recursive: true });
    // The App may not be installed on this repo: then the person's token.
    try { git(['clone', '--bare', '--quiet', remoteUrl(repo), bare], withAuth(authEnv)); }
    catch (e) { if (!fallbackEnv) throw e; fs.rmSync(bare, { recursive: true, force: true }); git(['clone', '--bare', '--quiet', remoteUrl(repo), bare], withAuth(fallbackEnv)); }
  }
  git(['-C', bare, 'worktree', 'prune']);
  return bare;
}

// Fetch a ref (a branch name, or refs/pull/N/head) and return its commit.
export function fetchRef(repo, ref, authEnv, fallbackEnv) {
  const bare = ensureRepo(repo, authEnv, fallbackEnv);
  const local = ref.startsWith('refs/pull/') ? `refs/qa/pr-${ref.split('/')[2]}` : `refs/qa/${ref}`;
  const args = ['-C', bare, 'fetch', '--quiet', '--force', remoteUrl(repo), `+${ref}:${local}`];
  try { git(args, withAuth(authEnv)); } catch (e) { if (!fallbackEnv) throw e; git(args, withAuth(fallbackEnv)); }
  return git(['-C', bare, 'rev-parse', local]);
}

export const redact = (t) => String(t).replace(/\b(?![0-9a-f]{40}\b)[A-Za-z0-9_-]{30,}/g, '[secret removed]');

const hashFile = (f) => (fs.existsSync(f) ? crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex') : 'none');

// Move a worktree slot to a commit, creating the slot on first use.
export function checkoutSlot(repo, slot, sha) {
  const name = repo.split('/')[1];
  return checkoutAt(repo, path.join(CACHE, 'wt', `${name}-${slot}`), sha);
}

// A fast check's checkout: one folder per side (wt/check-pr, wt/check-dev)
// holding the repo's checkout and a link per sibling repo (siblings:
// { name: dir }, from checkSiblings), so a build that reads a sibling at
// ../<name> (Pro's tsconfig: ../xspeed/src) reads that side's tree. The PR and
// dev checks never share a link; runs take turns (run.lock in qa-run).
export function checkoutCheckSlot(repo, side, sha, siblings = {}) {
  if (side !== 'pr' && side !== 'dev') throw new Error(`a check side is pr or dev, not ${side}`);
  const name = repo.split('/')[1];
  const parent = path.join(CACHE, 'wt', `check-${side}`);
  const dir = checkoutAt(repo, path.join(parent, name), sha);
  const want = new Map(Object.entries(siblings).filter(([n]) => n !== name && /^[A-Za-z0-9_.-]+$/.test(n) && n !== '.' && n !== '..'));
  for (const f of fs.readdirSync(parent)) {
    if (!want.has(f) && fs.lstatSync(path.join(parent, f)).isSymbolicLink()) fs.rmSync(path.join(parent, f));
  }
  for (const [n, target] of want) {
    const link = path.join(parent, n);
    let now = null;
    try { now = fs.readlinkSync(link); } catch { /* none yet */ }
    if (now === target) continue;
    const tmp = `${link}.tmp-${process.pid}`;
    fs.rmSync(tmp, { force: true });
    fs.symlinkSync(target, tmp);
    fs.renameSync(tmp, link);
  }
  return dir;
}

// The trees a side's check sees as siblings, by repository name: on the PR
// side each other repo's PR checkout when the run pairs one, else its dev; on
// the dev side its dev. srcs: qa-run's checkouts by label (free-pr, pro-dev,
// ...); repos: { role: 'owner/name' }.
export function checkSiblings(srcs, side, repos, self) {
  const out = {};
  for (const [role, repo] of Object.entries(repos)) {
    if (!repo || repo === self) continue;
    const dir = side === 'pr' ? (srcs[`${role}-pr`] ?? srcs[`${role}-dev`]) : srcs[`${role}-dev`];
    if (dir) out[repo.split('/')[1]] = dir;
  }
  return out;
}

function checkoutAt(repo, dir, sha) {
  const name = repo.split('/')[1];
  const bare = path.join(CACHE, 'repos', `${name}.git`);
  if (!fs.existsSync(path.join(dir, '.git'))) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    git(['-C', bare, 'worktree', 'add', '--detach', '--force', dir, sha]);
  } else {
    git(['-C', dir, 'checkout', '--detach', '--force', '--quiet', sha]);
  }
  git(['-C', dir, 'reset', '--hard', '--quiet', sha]);
  // Untracked leftovers go; installed dependencies stay.
  git(['-C', dir, 'clean', '-ffdxq', '-e', 'vendor', '-e', 'node_modules']);
  return dir;
}

// A private Composer package that the App cannot read, but this server reads
// with its deploy key (/etc/miu/ci-mirrors), as CI does: bin/miu-ci-mirror's
// bundle (it runs as its own account; Miu never sees the key) becomes a bare
// copy in a temp folder, git reads it for the package's GitHub URLs (config in
// the environment), and Composer reads a copy of composer.json and of
// composer.lock without the package's dist (Composer does not try the source
// after a 404 dist). The worktree's own files are not changed, and no key or
// token goes into the build. Composer's git cache for the run lives in the
// temp folder too, so no copy outlives it. A listed package the helper cannot
// get fails the build: no token reads it either. null when the lock needs no
// deploy key, else { env, config, repos, notes, done }; throws with the reason
// it cannot. The folder's prefix is one the dashboard sweeps at start
// (sweepMirrorCopies), for a run stopped before its finally.
const DEPS_TMP = 'miu-ci-mirror-deps-';
// Git config pairs added after those the environment carries already.
const withGitConfig = (base, pairs) => {
  const n0 = /^\d+$/.test(String(base.GIT_CONFIG_COUNT ?? '')) ? Number(base.GIT_CONFIG_COUNT) : 0;
  const out = { GIT_CONFIG_COUNT: String(n0 + pairs.length) };
  pairs.forEach(([k, v], i) => { out[`GIT_CONFIG_KEY_${n0 + i}`] = k; out[`GIT_CONFIG_VALUE_${n0 + i}`] = v; });
  return out;
};
const deployKeyCopies = (dir, env) => {
  const lockFile = path.join(dir, 'composer.lock');
  if (!fs.existsSync(lockFile)) return null;
  const text = fs.readFileSync(lockFile, 'utf8');
  const keyed = lockKeyedRepos(text, deployKeyRepos(env.MIU_CI_MIRRORS_CONF ?? MIRRORS_FILE));
  if (!keyed.length) return null;
  const repos = keyed.map((k) => k.repo);
  const user = env.MIU_CI_MIRROR_USER, helper = env.MIU_CI_MIRROR_HELPER;
  if (!user || !helper) throw new Error(`this server reads ${repos.join(', ')} with a deploy key, but has no ci-mirror account; run install.sh again`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), DEPS_TMP));
  const done = () => fs.rmSync(tmp, { recursive: true, force: true });
  try {
    const config = [], notes = [];
    for (const [i, { repo, names, urls }] of keyed.entries()) {
      const got = spawnSync('sudo', ['-n', '-H', '-u', user, helper, repo], { env, maxBuffer: MAX_BUNDLE, timeout: 10 * 60 * 1000 });
      const err = String(got.stderr ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
      notes.push(...err.filter((l) => l.startsWith('ci-mirror: note: ')).map((l) => redact(l.slice(17))));
      if (got.status !== 0) throw new Error(err.at(-1) || `could not get ${repo} with the server's deploy key`);
      const bundle = path.join(tmp, 'r.bundle'), copy = path.join(tmp, `${i}.git`);
      fs.writeFileSync(bundle, got.stdout);
      try {
        git(['-c', 'core.hooksPath=/dev/null', 'clone', '--quiet', '--bare', bundle, copy], { stdio: 'pipe' });
        git(['-C', copy, 'remote', 'remove', 'origin'], { stdio: 'pipe' });
      } catch { throw new Error(`the server's copy of ${repo} is not a git bundle`); }
      fs.rmSync(bundle);
      const forms = [...new Set([repo, ...names])].flatMap((n) => [`git@github.com:${n}.git`, `ssh://git@github.com/${n}.git`, `https://github.com/${n}.git`]);
      for (const u of new Set([...urls, ...forms])) config.push([`url.${copy}.insteadOf`, u]);
    }
    fs.copyFileSync(path.join(dir, 'composer.json'), path.join(tmp, 'composer.json'));
    fs.writeFileSync(path.join(tmp, 'composer.lock'), lockWithoutDists(text, repos) ?? text);
    return { env: { COMPOSER: path.join(tmp, 'composer.json'), COMPOSER_CACHE_VCS_DIR: path.join(tmp, 'vcs') }, config, repos, notes, done };
  } catch (e) { done(); throw e; }
};

// A fast check's environment: its own empty temp folder, mode 700 and outside
// the run folder (which the agent account may write), removed by done() when
// the check ends. Test bootstraps build fixed paths under the system temp dir
// (Pro's sys_get_temp_dir()/xspeed-pro-tests), which another account's
// leftover folder there would break, and which runs would share.
export function checkEnv(base) {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'miu-check-'));
  return { env: { ...base, TMPDIR: t, TMP: t, TEMP: t }, done: () => fs.rmSync(t, { recursive: true, force: true }) };
}

// Install dependencies only when their lock files changed since last time.
// Returns what it did, for the run log.
export function ensureDeps(dir, { build = false, env = process.env, fallbackEnv = null } = {}) {
  // The stamp lives outside the worktree, so git status there stays clean.
  // A check side's checkout is named by its folder too (check-pr--xspeed-pro).
  const wt = path.relative(path.join(CACHE, 'wt'), dir);
  const stamp = path.join(CACHE, 'deps', `${!wt.startsWith('..') && !path.isAbsolute(wt) ? wt.split(path.sep).join('--') : path.basename(dir)}.json`);
  fs.mkdirSync(path.dirname(stamp), { recursive: true });
  const before = fs.existsSync(stamp) ? JSON.parse(fs.readFileSync(stamp, 'utf8')) : {};
  const now = { composer: hashFile(path.join(dir, 'composer.lock')), npm: hashFile(path.join(dir, 'package-lock.json')) };
  const did = [];
  // The node that runs the harness goes first on PATH: a login shell can pick
  // a different node whose npm fails without a word.
  const runEnv = { ...env, PATH: `${path.dirname(process.execPath)}:${env.PATH ?? ''}` };
  const runWith = (cmd, extra) => {
    const r = spawnSync('bash', ['-c', cmd], { cwd: dir, encoding: 'utf8', env: { ...runEnv, ...extra }, timeout: 15 * 60 * 1000 });
    if (r.status !== 0) {
      // The line that names the cause (Composer ends with its usage text).
      const lines = `${r.stdout || ''}\n${r.stderr || ''}`.split('\n').map((l) => l.trim()).filter(Boolean);
      const cause = lines.filter((l) => /could not|failed to|error|not found|denied|\b40[134]\b|unable to|requires/i.test(l) && !/^install \[|^\[--/.test(l)).slice(0, 2).join(' ') || lines.slice(-3).join(' ');
      // Composer can echo COMPOSER_AUTH back in an error: no token-like string
      // leaves here (this message reaches logs and reports). Commit shas stay.
      throw new Error(`${cmd.split(' ').slice(0, 2).join(' ')} failed in ${path.basename(dir)}: ${redact(cause).slice(0, 300)}`);
    }
  };
  const run = (cmd) => runWith(cmd, {});
  // Tracked files an install rewrites (Pro's post-install mozart run
  // regenerates its committed copy of a dependency) go back to the commit, so
  // the sites run what the PR ships and the diff shows only the PR's changes.
  const tracked = () => { try { return new Set(git(['-C', dir, 'diff', '--name-only', '-z']).split('\0').filter(Boolean)); } catch { return null; } };
  const clean = tracked();
  if (fs.existsSync(path.join(dir, 'composer.json')) && (now.composer !== before.composer || !fs.existsSync(path.join(dir, 'vendor')))) {
    const cmd = 'composer install --no-interaction --no-progress --prefer-dist';
    let keyed;
    try { keyed = deployKeyCopies(dir, runEnv); } catch (e) { throw new Error(`composer install failed in ${path.basename(dir)}: ${redact(e.message).slice(0, 300)}`); }
    try {
      // A private package in a repo the App cannot see: once more with the person's token.
      const plus = (extra) => (keyed ? { ...extra, ...keyed.env, ...withGitConfig({ ...runEnv, ...extra }, keyed.config) } : extra);
      try { runWith(cmd, plus({})); }
      catch (e) {
        if (!fallbackEnv || !/github|40[34]|could not be downloaded/i.test(e.message)) throw e;
        runWith(cmd, plus(fallbackEnv));
      }
    } finally { keyed?.done(); }
    did.push(keyed ? `composer install (${keyed.repos.join(', ')} by the server's deploy key)` : 'composer install');
    for (const n of keyed?.notes ?? []) did.push(`note: ${n}`);
  }
  if (fs.existsSync(path.join(dir, 'package.json')) && (now.npm !== before.npm || !fs.existsSync(path.join(dir, 'node_modules')))) {
    run('npm ci --no-audit --no-fund --loglevel=error'); did.push('npm ci');
  }
  const touched = clean && [...(tracked() ?? [])].filter((f) => !clean.has(f));
  if (touched?.length) {
    git(['--literal-pathspecs', '-C', dir, 'checkout', '-q', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: touched.join('\0') });
    did.push(`restored ${touched.length} committed file${touched.length === 1 ? '' : 's'} the install rewrote: ${touched.slice(0, 5).join(', ')}${touched.length > 5 ? ', …' : ''}`);
  }
  if (build) { run('npm run build --loglevel=error'); did.push('npm run build'); }
  fs.writeFileSync(stamp, JSON.stringify(now));
  return did;
}

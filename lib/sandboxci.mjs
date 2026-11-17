// A repository's GitHub Actions workflow as a fast check, run by the Sandbox
// CLI on the server Miu runs on (`sb ci run --local`). Miu's account has no
// Docker access, so it sends the commit to bin/miu-sandbox-ci, which runs as the
// account that owns Sandbox.
//
// The caller gets one of two answers. { status, out } means the workflow ran:
// status 0 passed, 1 failed. { notRun } means the server could not run it, and
// says why, so that a broken server is never reported as a broken pull request.
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseWorkflows } from './ci.mjs';

const WORKFLOW = /^\.github\/workflows\/[\w.-]+\.ya?ml$/;
const JOB = /^\w[\w-]*$/;
const MATRIX_KEY = /^\w[\w-]*$/;
const MATRIX_VALUE = /^[\w.-]+$/;
const EVENT = /^[a-z_]{1,64}$/;
// GitHub's owner/name: an owner has letters, digits and hyphens; a name is never . or ..
export const REPO = /^[A-Za-z0-9-]+\/(?!\.\.?$)[A-Za-z0-9_.-]+$/;
const MAX_REPOS = 10;
const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const DEFAULT_MINUTES = 30;
const MAX_MINUTES = 240;
// bin/miu-sandbox-ci stops Sandbox a minute after the limit; this is for when it cannot.
const GRACE_MS = 2 * 60 * 1000;
// A worker in another account may not stop when asked. Miu moves on regardless.
const STOP_WAIT_MS = 30 * 1000;

// What is wrong with a fast check's sandbox_ci block; null when nothing is.
export function sandboxCiProblem(check) {
  if (check.sandbox_ci === undefined) return null;
  const ci = check.sandbox_ci;
  const name = check.label ?? 'a fast check';
  if (!ci || typeof ci !== 'object' || Array.isArray(ci)) return `The "sandbox_ci" of ${name} must be an object.`;
  if (check.cmd !== undefined) return `${name} has both "cmd" and "sandbox_ci". Keep one.`;
  if (typeof ci.workflow !== 'string' || !WORKFLOW.test(ci.workflow)) return `The "sandbox_ci.workflow" of ${name} must be a file directly in .github/workflows, like .github/workflows/test.yml.`;
  if (typeof ci.job !== 'string' || !JOB.test(ci.job)) return `The "sandbox_ci.job" of ${name} must be one job id. Add one fast check per job.`;
  if (ci.matrix !== undefined && (!ci.matrix || typeof ci.matrix !== 'object' || Array.isArray(ci.matrix) || !Object.entries(ci.matrix).every(([k, v]) => MATRIX_KEY.test(k) && ['string', 'number'].includes(typeof v) && MATRIX_VALUE.test(String(v))))) return `The "sandbox_ci.matrix" of ${name} must map matrix names to plain values.`;
  if (ci.event !== undefined && (typeof ci.event !== 'string' || !EVENT.test(ci.event))) return `The "sandbox_ci.event" of ${name} must be a GitHub event name.`;
  if (ci.timeout_minutes !== undefined && !(Number.isInteger(ci.timeout_minutes) && ci.timeout_minutes >= 1 && ci.timeout_minutes <= MAX_MINUTES)) return `The "sandbox_ci.timeout_minutes" of ${name} must be a whole number from 1 to ${MAX_MINUTES}.`;
  if (ci.repos !== undefined && !(Array.isArray(ci.repos) && ci.repos.length <= MAX_REPOS && ci.repos.every((r) => typeof r === 'string' && REPO.test(r)))) return `The "sandbox_ci.repos" of ${name} must be a list of up to ${MAX_REPOS} repositories, like owner/name.`;
  return null;
}

// What decides what act runs: the workflows, act's options (.actrc), the
// values act reads from the folder (.env, .vars, .input, .secrets) and what
// git archive leaves out (.gitattributes). A pull request from the repository
// itself runs with its own copies, as on GitHub: it chooses its jobs, never
// what holds them in. The worker drops .actrc and links there and applies its
// workflow policy to whatever workflow it gets; the token's repositories and
// the server's CI secrets a workflow may name come from the base branch
// (repoNeeds, allowedSecrets). A sibling is never shipped over these.
export const CI_DEFINITION = ['.github', '.actrc', '.env', '.vars', '.input', '.secrets', '.gitattributes'];

const secondsOf = (ci) => (ci.timeout_minutes ?? DEFAULT_MINUTES) * 60;
const workerArgs = (ci) => [ci.workflow, ci.event ?? 'pull_request', String(secondsOf(ci)), ci.job, ...Object.entries(ci.matrix ?? {}).map(([k, v]) => `${k}=${v}`)];
// $2 is the commit to send: HEAD of a checkout, or a sha in a bare clone.
// Miu writes the secrets header (below) on this shell's stdin; it goes to
// the worker first, then the tar. No secret is in an argument or the environment.
// git archive may read a throwaway object store (withMirrors); the worker never.
const SEND_COMMIT = '{ cat; git -C "$1" archive --format=tar "$2"; } | env -u GIT_OBJECT_DIRECTORY -u GIT_ALTERNATE_OBJECT_DIRECTORIES sudo -n -H -u "$3" "$4" "${@:5}"';
const REF = /^(HEAD|[0-9a-f]{40})$/;

const lastLine = (text) => text.trim().split('\n').pop()?.trim().slice(0, 300) ?? '';

function reportIn(stdout) {
  for (const line of stdout.trim().split('\n').reverse()) {
    if (!line.startsWith('{')) continue;
    try { return JSON.parse(line); } catch { /* an unrelated line */ }
  }
  return null;
}

// act's own closing line for a job. A step's output and a workflow's labels
// appear in the log too, so it has to be the whole line, in act's form.
const closedWith = (cell, result) => new RegExp(`^\\[[^\\n]*\\]\\s+🏁\\s+Job ${result}\\s*$`, 'm').test(cell.output ?? '');
// act exits non-zero for a job that failed and also when Docker, the runner
// image or an action was not there. Only the first ends with that line.
const ranAndFailed = (cell) => cell.status === 'failed' && Number.isInteger(cell.exit_code) && cell.exit_code !== 0 && closedWith(cell, 'failed');
// act exits 0 when a matrix value selects nothing, so a pass needs a job that ran.
const passed = (cell) => cell.status === 'passed' && closedWith(cell, 'succeeded');

// Every job's own output, for the CI tab's log (the result keeps only failures).
const logOf = (cells) => cells.map((c) => [`## ${c.label}${c.matrix ? ` ${JSON.stringify(c.matrix)}` : ''} (${c.status}${Number.isInteger(c.exit_code) ? `, exit ${c.exit_code}` : ''})`, c.output ?? ''].join('\n')).join('\n\n');

function resultOf(io) {
  const r = outcomeOf(io);
  const cells = reportIn(io.stdout)?.cells;
  return Array.isArray(cells) && cells.length ? { ...r, log: logOf(cells) } : r;
}

function outcomeOf({ stdout, stderr }) {
  const report = reportIn(stdout);
  if (!report) return { notRun: lastLine(stderr) || 'the Sandbox CLI gave no result' };
  if (report.code === 'ci_preflight_blocked') {
    const ids = (report.preflight?.blocking ?? []).map((b) => b.id).join(', ');
    return { notRun: `Sandbox refused this workflow${ids ? `: ${ids}` : ''}` };
  }
  const cells = report.cells ?? [];
  if (!cells.length) return { notRun: 'the workflow has no jobs to run' };
  const failed = cells.filter(ranAndFailed);
  if (failed.length) {
    const out = failed.map((c) => [`## ${c.label}${c.matrix ? ` ${JSON.stringify(c.matrix)}` : ''} (exit ${c.exit_code})`, c.output ?? ''].join('\n')).join('\n\n');
    return { status: 1, out };
  }
  const stuck = cells.find((c) => !passed(c));
  if (stuck?.status === 'passed') return { notRun: `${stuck.label}: act reported success, but no job ran` };
  if (stuck) return { notRun: `${stuck.label}: ${lastLine(String(stuck.error ?? (stuck.output || stuck.status)))}` };
  return { status: 0, out: `${cells.length} of ${cells.length} passed` };
}

// ---- the repositories a run reaches over the network
//
// act runs the pull request from a tar, but a step can still reach GitHub: a
// checkout by name, a git clone, a gh call, a private Composer or npm
// dependency. Miu's GitHub App mints one token per run for those
// repositories (the pull request's own only when a step names it) and no
// others: contents read only, GitHub's one-hour expiry, never cached, and
// revoked when the run ends. A run that reaches none gets no token. The
// profile's sibling is shipped in the tar instead (bin/qa-dashboard), so a
// workflow that skips its own download under act (`if: ${{ !env.ACT }}`)
// needs none for it. The job gets it as GITHUB_TOKEN (act's github.token) and as each
// secret the workflow uses for a GitHub token. The pull request's code can
// read it. Only the App's owner's repositories go in it; a public repository
// of another owner is read with it as with any token, and a checkout of one
// that is not public is not run.

const SECRET_REF = /\bsecrets\s*(?:\.\s*([A-Za-z_]\w*)|\[\s*['"]([A-Za-z_]\w*)['"]\s*\])/g;
const EXPR = /\$\{\{([\s\S]*?)\}\}/g;
const needsOf = (job) => { const n = job?.needs ?? []; return typeof n === 'string' ? [n] : Array.isArray(n) ? n.filter((x) => typeof x === 'string') : []; };
const NAME = '[A-Za-z0-9_.-]+';
// What a run: script fetches from: a github.com URL, gh repo clone, gh api repos/..., gh -R/--repo.
const FETCHES = [
  new RegExp(`github\\.com[:/](${NAME})/(${NAME})`, 'g'),
  new RegExp(`\\bgh\\s+repo\\s+clone\\s+(${NAME})/(${NAME})`, 'g'),
  new RegExp(`\\bgh\\s+api\\s+/?repos/(${NAME})/(${NAME})`, 'g'),
  new RegExp(`\\bgh\\b[^\\n]*?\\s(?:-R|--repo)[=\\s]+(${NAME})/(${NAME})`, 'g'),
];
const repoName = (o, n) => `${o}/${n.replace(/\.git$/i, '')}`;
const ownSyntax = /\$\{\{\s*github\.repository\s*\}\}/g;
// A step act leaves out: its `if` is exactly `!env.ACT` (act sets ACT=true).
// Miu ships what such a step would download, like the profile's sibling.
const skippedUnderAct = (cond) => typeof cond === 'string' && /^\s*(?:\$\{\{\s*)?!\s*env\.ACT\s*(?:\}\})?\s*$/.test(cond);

// What the job, and the jobs it needs, reach:
// { checkouts, fetches: ['owner/name'], secrets: ['NAME'], composer, npm }, or { problem }.
// own stands in for ${{ github.repository }}.
export function reposNeeded(doc, job, own = '') {
  const jobs = doc && typeof doc === 'object' && doc.jobs && typeof doc.jobs === 'object' ? doc.jobs : {};
  const checkouts = new Set();
  const fetches = new Set();
  const secrets = new Set();
  let composer = false, npm = false;
  const seen = new Set();
  const todo = [job];
  // A secret beside github.token in one expression is a GitHub token too.
  const tokenSecrets = (text) => { for (const [, e] of String(text).matchAll(EXPR)) if (/\bgithub\.token\b/.test(e)) for (const m of e.matchAll(SECRET_REF)) secrets.add(m[1] ?? m[2]); };
  while (todo.length) {
    const id = todo.pop();
    if (seen.has(id) || !jobs[id] || typeof jobs[id] !== 'object') continue;
    seen.add(id);
    tokenSecrets(JSON.stringify(jobs[id].env ?? {}));
    for (const st of Array.isArray(jobs[id].steps) ? jobs[id].steps : []) {
      if (!st || typeof st !== 'object' || skippedUnderAct(st.if)) continue;
      tokenSecrets(JSON.stringify(st));
      if (typeof st.uses === 'string' && /^actions\/checkout@/i.test(st.uses)) {
        const w = st.with && typeof st.with === 'object' ? st.with : {};
        const r = typeof w.repository === 'string' ? w.repository.replace(ownSyntax, own) : w.repository;
        if (r !== undefined && r !== null && r !== '') {
          if (typeof r !== 'string' || !REPO.test(r)) return { problem: `a checkout in job ${id} names its repository with an expression or not as owner/name, so Miu cannot tell what to give it access to` };
          checkouts.add(r);
        }
        for (const m of String(w.token ?? '').matchAll(SECRET_REF)) secrets.add(m[1] ?? m[2]);
      }
      if (typeof st.run === 'string') {
        const run = st.run.replace(ownSyntax, own);
        for (const re of FETCHES) for (const m of run.matchAll(re)) fetches.add(repoName(m[1], m[2]));
        if (/\bcomposer\s+(?:install|update|require|create-project)\b/.test(run)) composer = true;
        if (/\b(?:npm\s+(?:ci|install|i)|yarn(?:\s+install)?|pnpm\s+(?:install|i))\b/.test(run)) npm = true;
      }
    }
    todo.push(...needsOf(jobs[id]));
  }
  return { checkouts: [...checkouts], fetches: [...fetches].filter((r) => REPO.test(r)), secrets: [...secrets], composer, npm };
}

// GitHub repositories a composer.json or package.json pulls from: Composer's
// vcs/git/github repositories, npm's github: and git URLs and owner/name.
export function manifestRepos(composerJson, packageJson) {
  const out = new Set();
  const fromUrl = (u) => { const m = String(u).match(new RegExp(`github\\.com[:/](${NAME})/(${NAME})`)); if (m) out.add(repoName(m[1], m[2])); };
  try {
    const c = composerJson ? JSON.parse(composerJson) : null;
    const repos = Array.isArray(c?.repositories) ? c.repositories : c?.repositories && typeof c.repositories === 'object' ? Object.values(c.repositories) : [];
    for (const r of repos) if (r && ['vcs', 'git', 'github'].includes(r.type)) fromUrl(r.url);
  } catch { /* not JSON: Composer fails on it by itself */ }
  try {
    const p = packageJson ? JSON.parse(packageJson) : null;
    for (const deps of [p?.dependencies, p?.devDependencies, p?.optionalDependencies]) {
      for (const v of Object.values(deps && typeof deps === 'object' ? deps : {})) {
        const s = String(v);
        const short = s.match(new RegExp(`^(?:github:)?(${NAME})/(${NAME})(?:#.*)?$`));
        if (short && !s.startsWith('.') && !/^(?:file|link|workspace|npm):/.test(s)) out.add(repoName(short[1], short[2]));
        else if (/^git/.test(s)) fromUrl(s);
      }
    }
  } catch { /* the same for npm */ }
  return [...out].filter((r) => REPO.test(r));
}

const gitShow = (dir, ref, file) => new Promise((resolve) => {
  execFile('git', ['-C', dir, 'show', `${ref}:${file}`], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 60000 }, (e, out) => resolve(e ? null : out));
});

async function defaultMint(owner, names, opts) {
  const { ciRepoToken } = await import('./ghapp.mjs');
  return ciRepoToken(owner, names, opts);
}
async function defaultRevoke(token) {
  const { revokeToken } = await import('./ghapp.mjs');
  return revokeToken(token);
}

// What one tree of the repository says the run reaches: its workflow, and
// its composer.json and package.json when a step runs Composer or npm.
async function needsAt(ci, dir, at, own) {
  const text = await gitShow(dir, at, ci.workflow);
  let found = { checkouts: [], fetches: [], secrets: [] };
  if (text !== null) {
    const [w] = await parseWorkflows([{ path: ci.workflow, text }]);
    if (w?.doc) found = reposNeeded(w.doc, ci.job, own);
  }
  if (found.problem) return found;
  const manifests = found.composer || found.npm
    ? manifestRepos(found.composer ? await gitShow(dir, at, 'composer.json') : null, found.npm ? await gitShow(dir, at, 'package.json') : null)
    : [];
  return { repos: [...found.checkouts, ...found.fetches, ...manifests], checkouts: found.checkouts, secrets: found.secrets };
}

// Sandbox fills every secrets.X inside ${{ }} of a step that reaches act from
// the server's ci_secrets (sandbox.local.yml), unless Miu gives it, with this
// pattern over the parsed step. These read the parsed workflow the same way.
const exprSecrets = (value, out) => { for (const [, e] of JSON.stringify(value ?? null).matchAll(EXPR)) for (const m of e.matchAll(SECRET_REF)) out.add(m[1] ?? m[2]); };
// The server's CI secrets a run may name: those the same job (and the jobs it
// needs) names in the workflow at `from`, the base branch's tip, in steps act
// runs. A pull request writes its own workflow, so it gets no secret that job
// does not already use. No `from`, or no such job: none.
async function allowedSecrets(dir, from, ci) {
  const out = new Set();
  if (!from) return out;
  const text = await gitShow(dir, from, ci.workflow);
  const [w] = text === null ? [] : await parseWorkflows([{ path: ci.workflow, text }]);
  const jobs = w?.doc?.jobs && typeof w.doc.jobs === 'object' ? w.doc.jobs : {};
  const seen = new Set(), todo = [ci.job];
  while (todo.length) {
    const id = todo.pop();
    if (seen.has(id) || !jobs[id] || typeof jobs[id] !== 'object') continue;
    seen.add(id);
    for (const st of Array.isArray(jobs[id].steps) ? jobs[id].steps : []) if (st && typeof st === 'object' && !skippedUnderAct(st.if)) exprSecrets(st, out);
    todo.push(...needsOf(jobs[id]));
  }
  return out;
}
// Every secret the run's workflow names anywhere, as parsed (YAML escapes
// decoded), but in a step act leaves out, or null when it cannot be read.
// More than Sandbox fills, never less.
async function namedSecrets(dir, ref, ci) {
  const text = await gitShow(dir, ref, ci.workflow);
  if (text === null) return null;
  const [w] = await parseWorkflows([{ path: ci.workflow, text }]);
  if (!w?.doc || typeof w.doc !== 'object') return null;
  const jobs = w.doc.jobs && typeof w.doc.jobs === 'object' ? w.doc.jobs : {};
  const kept = Object.fromEntries(Object.entries(jobs).map(([id, j]) => [id, j && typeof j === 'object' && Array.isArray(j.steps) ? { ...j, steps: j.steps.filter((st) => !(st && typeof st === 'object' && skippedUnderAct(st.if))) } : j]));
  const out = new Set();
  exprSecrets({ ...w.doc, jobs: kept }, out);
  return out;
}

const unique = (list) => [...new Map(list.map((r) => [r.toLowerCase(), r])).values()];
const ownerOf = (r) => r.split('/')[0].toLowerCase();

// The repositories a run may read, and what it will try to read.
// Granted: the profile's sandbox_ci.repos and what the base branch's tip
// (trustedRef) says the run reaches, the pull request's own repo included
// when a step names it. Without a
// trustedRef (a QA run's fast check) nothing is read from the repository
// for this: its workflow and manifests are the pull request's own.
// Needed: what the tree being run (ref) says, which the pull request may
// have changed. A need outside the grant is not run, never a wider token.
export async function repoNeeds(ci, dir, ref, own, trustedRef) {
  const trusted = trustedRef ? await needsAt(ci, dir, trustedRef, own) : { repos: [], checkouts: [], secrets: [] };
  if (trusted.problem) return trusted;
  const run = trustedRef === ref ? trusted : await needsAt(ci, dir, ref, own);
  if (run.problem) return run;
  // The pull request's own repo is in it only when a step fetches it by name.
  const granted = unique([...(ci.repos ?? []), ...trusted.repos]);
  const owner = ownerOf(own || granted[0] || run.repos[0] || '');
  const grantedKeys = new Set(granted.map((r) => r.toLowerCase()));
  const outside = unique(run.repos).filter((r) => ownerOf(r) === owner && !grantedKeys.has(r.toLowerCase()));
  return { repos: granted, checkouts: unique([...trusted.checkouts, ...run.checkouts]), secrets: [...new Set([...trusted.secrets, ...run.secrets])], outside };
}

// GITHUB_TOKEN and at most this many more names (the worker's header is one digit).
const MAX_ALIASES = 8;
const MAX_MIRRORS = 4;
export const MIRRORS_FILE = '/etc/miu/ci-mirrors';

// Repositories this server reads with a deploy key instead of the GitHub App:
// the first word of each line of the root-owned list bin/miu-sandbox-ci reads
// (repository, key file, the key's fingerprint). Miu only names them; the
// worker picks the key and checks it.
export function deployKeyRepos(file = MIRRORS_FILE) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  return text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => l.split(/\s+/)[0]).filter((r) => REPO.test(r));
}

// { secrets: [[name, value]], token, mirrors: ['owner/name'] } for the run, or { notRun }.
// mirrors: granted repos the run reads other than by actions/checkout (Composer,
// npm, git), which this server reads with a deploy key (deployKeyRepos).
async function accessFor(ci, dir, ref, own, trustedRef, mint, keyed = [], beforeMint = async () => ({}), secretsFrom = trustedRef) {
  const need = await repoNeeds(ci, dir, ref, own, trustedRef).catch((e) => ({ problem: `could not read what the workflow needs: ${String(e.message).slice(0, 200)}` }));
  if (need.problem) return { notRun: need.problem };
  if (need.outside.length) return { notRun: `no access to ${need.outside.join(', ')}: ${trustedRef ? 'the pull request needs it and its base branch does not' : 'a job its base branch does not run the same way gets only the repositories in the profile\'s repos'}` };
  const owner = (own || need.repos[0] || '').split('/')[0];
  const granted = need.repos.filter((r) => ownerOf(r) === owner.toLowerCase());
  // actions/checkout fetches with a token, so a checked-out repo is never read with a key.
  // The list's spelling: each sudo rule for bin/miu-ci-mirror names it exactly.
  const keyedAs = new Map(keyed.map((r) => [r.toLowerCase(), r]));
  const checkedOut = new Set(need.checkouts.map((r) => r.toLowerCase()));
  const viaKey = granted.filter((r) => keyedAs.has(r.toLowerCase()) && !checkedOut.has(r.toLowerCase()));
  const mirrors = [...new Set(viaKey.map((r) => keyedAs.get(r.toLowerCase())))];
  if (mirrors.length > MAX_MIRRORS) return { notRun: `the run reads ${mirrors.length} repositories with a deploy key; Miu gives at most ${MAX_MIRRORS}` };
  const mine = granted.filter((r) => !viaKey.includes(r));
  // Another owner's checkout must be public; its other mentions (downloads) are left alone.
  const elsewhere = need.checkouts.filter((r) => ownerOf(r) !== owner.toLowerCase());
  // actions/checkout wants a token even for a public repo: then one that reads no code.
  const names = ['GITHUB_TOKEN', ...need.secrets.filter((n) => n !== 'GITHUB_TOKEN' && SECRET_NAME.test(n))];
  if (names.length > MAX_ALIASES + 1) return { notRun: `the workflow uses ${names.length - 1} secrets as a GitHub token; Miu gives at most ${MAX_ALIASES}` };
  // Names Miu gives (the token) win over the server's; any other the workflow
  // names must be one the base branch's workflows name too.
  // The worker checks the same again on the files act reads (allow=, below).
  const given = mine.length || elsewhere.length || need.secrets.length ? new Set(names) : new Set();
  const allowed = await allowedSecrets(dir, secretsFrom, ci);
  const named = await namedSecrets(dir, ref, ci);
  if (named === null) return { notRun: `could not read ${ci.workflow} (missing, over 4 MB or not YAML) to check which CI secrets it names` };
  const fresh = [...named].filter((n) => !given.has(n) && !allowed.has(n));
  if (fresh.length) return { notRun: `the workflow names ${fresh.length === 1 ? 'a secret' : 'secrets'} (${fresh.slice(0, 5).join(', ')}) that job ${ci.job} on the base branch does not; a pull request's own workflow gets only the server's CI secrets the base branch's same job already uses` };
  const allow = [...allowed].filter((n) => !given.has(n) && SECRET_NAME.test(n)).sort();
  if (allow.join(',').length > 2048) return { notRun: 'the base branch\'s job names more CI secrets than Miu passes to the worker' };
  // The deploy-key copies, which can take minutes, before any token exists.
  const prepared = mirrors.length ? await beforeMint(mirrors) : {};
  if (prepared.notRun) return prepared;
  // Nothing to read with a token, and none named: none.
  if (!mine.length && !elsewhere.length && !need.secrets.length) return { secrets: [], mirrors, prepared, allow };
  // A workflow that names one anyway (Pro's COMPOSER_AUTH, after the deploy
  // key took its private package) gets one that reads no code, as below: on
  // GitHub github.token is always a real token, and Composer sends it with
  // every download, public ones too.
  if (!mine.length && !own) return { notRun: `the workflow ${elsewhere.length ? `checks out ${elsewhere.join(', ')}` : 'uses a GitHub token'}, and Miu does not know this pull request's repository to make a token with` };
  const opts = mine.length ? { publicRepos: elsewhere } : { publicRepos: elsewhere, permissions: { metadata: 'read' } };
  const wanted = mine.length || elsewhere.length ? [...mine, ...elsewhere] : [own];
  let got;
  try { got = await mint(owner, (mine.length ? mine : [own]).map((r) => r.split('/')[1]), opts); }
  catch (e) { return { notRun: `could not get access to ${wanted.join(', ')}: ${String(e.message).slice(0, 200)}` }; }
  if (!got?.token) return { notRun: `no access to ${(got?.missing?.length ? got.missing : wanted).join(', ')}: ${got?.missing?.every((r) => ownerOf(r) !== owner.toLowerCase()) ? 'it is not public' : 'install the Miu GitHub App there, or give this server a deploy key for it (docs/install.md; a deploy key serves Composer, npm and git, not actions/checkout)'}` };
  return { token: got.token, secrets: names.map((n) => [n, got.token]), mirrors, prepared, allow };
}

// The first thing on the worker's stdin: how many secrets, then NAME=value lines.
// ---- deploy-key repositories: the job's copy

const run = (cmd, args, { input, env, maxBuffer = 16 * 1024 * 1024 } = {}) => new Promise((resolve) => {
  const child = execFile(cmd, args, { encoding: 'buffer', maxBuffer, timeout: 600000, env }, (e, stdout, stderr) => resolve({ ok: !e, stdout, stderr: String(stderr ?? ''), error: e }));
  if (input !== undefined) child.stdin.end(input);
});
export const MAX_BUNDLE = 512 * 1024 * 1024;
const GITHUB_URL = /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/i;

// composer.lock without the dist of each deploy-key package: Composer tries
// the zip from GitHub's API first, which the key cannot open, and does not fall
// back to the git source then. null when nothing changes.
export function lockWithoutDists(text, repos) {
  let lock;
  try { lock = JSON.parse(text); } catch { return null; }
  const want = new Set(repos.map((r) => r.toLowerCase()));
  let changed = false;
  for (const key of ['packages', 'packages-dev']) {
    for (const p of Array.isArray(lock?.[key]) ? lock[key] : []) {
      const m = String(p?.source?.url ?? '').match(GITHUB_URL);
      if (m && want.has(m[1].toLowerCase()) && p.dist !== undefined) { delete p.dist; changed = true; }
    }
  }
  return changed ? `${JSON.stringify(lock, null, 4)}\n` : null;
}

// The deploy-key repositories (the list's spelling, which the sudo rule names)
// that composer.lock installs from GitHub, each with the owner/name spellings
// its source URLs use, and those URLs as written: git's insteadOf matches a
// URL's start exactly.
export function lockKeyedRepos(text, repos) {
  let lock;
  try { lock = JSON.parse(text); } catch { return []; }
  const listed = new Map(repos.map((r) => [r.toLowerCase(), r]));
  const out = new Map();
  for (const key of ['packages', 'packages-dev']) {
    for (const p of Array.isArray(lock?.[key]) ? lock[key] : []) {
      const m = String(p?.source?.url ?? '').match(GITHUB_URL);
      const r = m && REPO.test(m[1]) && listed.get(m[1].toLowerCase());
      if (r) {
        const k = out.get(r) ?? { names: new Set(), urls: new Set() };
        k.names.add(m[1]); k.urls.add(String(p.source.url));
        out.set(r, k);
      }
    }
  }
  return [...out].map(([repo, k]) => ({ repo, names: [...k.names], urls: [...k.urls] }));
}

const MIRROR_TMP = 'miu-ci-mirror-';
// Copies a run left when Miu stopped mid-run (its finally never ran): older
// than the longest run, they belong to no run. The dashboard calls this at start.
export function sweepMirrorCopies(olderThanMs = (MAX_MINUTES + 30) * 60 * 1000, dir = os.tmpdir()) {
  let n = 0;
  for (const f of fs.readdirSync(dir).filter((x) => x.startsWith(MIRROR_TMP))) {
    try { if (Date.now() - fs.statSync(path.join(dir, f)).mtimeMs > olderThanMs) { fs.rmSync(path.join(dir, f), { recursive: true, force: true }); n++; } } catch { /* gone already */ }
  }
  return n;
}

// A commit on top of ref with each deploy-key repository's bare copy at
// .miu-ci/mirrors/<owner>/<name>.git and the lock change above, for the tar.
// bin/miu-ci-mirror fetches with the key, as its own account, and hands over
// only a bundle. The new objects go to a throwaway object store beside dir's
// (gitEnv, for git archive too), so dir's clone does not grow with each run;
// done() removes it. { ref, notes, gitEnv, done } or { notRun }.
async function withMirrors(dir, ref, mirrors, env) {
  const user = env.MIU_CI_MIRROR_USER, helper = env.MIU_CI_MIRROR_HELPER;
  if (!user || !helper) return { notRun: `this server reads ${mirrors.join(', ')} with a deploy key, but has no ci-mirror account; run install.sh again` };
  const objects = await run('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-path', 'objects']);
  if (!objects.ok) return { notRun: 'could not find the commit to run' };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), MIRROR_TMP));
  const done = () => fs.rmSync(tmp, { recursive: true, force: true });
  const gitEnv = { GIT_OBJECT_DIRECTORY: path.join(tmp, 'objects'), GIT_ALTERNATE_OBJECT_DIRECTORIES: String(objects.stdout).trim() };
  const git = (args, opts = {}) => run('git', ['-C', dir, '-c', 'core.hooksPath=/dev/null', ...args], { ...opts, env: { ...process.env, ...gitEnv, ...(opts.env ?? {}) } });
  const index = { GIT_INDEX_FILE: path.join(tmp, 'index') };
  const notes = [];
  let handed = false;
  try {
    fs.mkdirSync(path.join(tmp, 'objects'));
    if (!(await git(['read-tree', ref], { env: index })).ok) return { notRun: 'could not read the commit to run' };
    const add = async (file, at) => {
      const blob = await git(['hash-object', '-w', '--', file]);
      if (!blob.ok) throw new Error(`could not store ${at}`);
      if (!(await git(['update-index', '--add', '--cacheinfo', `100644,${String(blob.stdout).trim()},${at}`], { env: index })).ok) throw new Error(`could not add ${at}`);
    };
    for (const repo of mirrors) {
      const got = await run('sudo', ['-n', '-H', '-u', user, helper, repo], { maxBuffer: MAX_BUNDLE, env });
      notes.push(...got.stderr.split('\n').filter((l) => l.startsWith('ci-mirror: note: ')).map((l) => `Note: ${l.slice(17)}`));
      if (!got.ok) return { notRun: lastLine(got.stderr) || `could not get ${repo} with the server's deploy key` };
      const bundle = path.join(tmp, 'r.bundle'), bare = path.join(tmp, 'r.git');
      fs.rmSync(bare, { recursive: true, force: true });
      fs.writeFileSync(bundle, got.stdout);
      const ok = (await run('git', ['-c', 'core.hooksPath=/dev/null', 'clone', '--quiet', '--bare', bundle, bare])).ok
        && (await run('git', ['-C', bare, '-c', 'core.hooksPath=/dev/null', 'remote', 'remove', 'origin'])).ok
        && (await run('git', ['-C', bare, 'repack', '-a', '-d', '-q'])).ok
        && (await run('git', ['-C', bare, 'pack-refs', '--all'])).ok;
      if (!ok) return { notRun: `the server's copy of ${repo} is not a git bundle` };
      const at = `.miu-ci/mirrors/${repo.toLowerCase()}.git`;
      fs.writeFileSync(path.join(bare, 'refs', '.miu'), 'refs live in packed-refs\n');
      fs.mkdirSync(path.join(bare, 'objects', 'info'), { recursive: true });
      fs.writeFileSync(path.join(bare, 'objects', 'info', '.miu'), '');
      const files = ['HEAD', 'config', 'packed-refs', 'refs/.miu', 'objects/info/.miu', ...fs.readdirSync(path.join(bare, 'objects', 'pack')).filter((f) => /^pack-[0-9a-f]+\.(pack|idx)$/.test(f)).map((f) => `objects/pack/${f}`)];
      for (const f of files) if (fs.existsSync(path.join(bare, f))) await add(path.join(bare, f), `${at}/${f}`);
    }
    const lock = await git(['show', `${ref}:composer.lock`]);
    const changed = lock.ok ? lockWithoutDists(String(lock.stdout), mirrors) : null;
    if (changed) { fs.writeFileSync(path.join(tmp, 'composer.lock'), changed); await add(path.join(tmp, 'composer.lock'), 'composer.lock'); }
    const tree = await git(['write-tree'], { env: index });
    const who = { GIT_AUTHOR_NAME: 'Miu', GIT_AUTHOR_EMAIL: 'miu@localhost', GIT_COMMITTER_NAME: 'Miu', GIT_COMMITTER_EMAIL: 'miu@localhost' };
    const sha = tree.ok && await git(['commit-tree', String(tree.stdout).trim(), '-p', ref, '-m', `Miu CI: ${mirrors.join(', ')} from the server's deploy key`], { env: who });
    if (!sha?.ok) return { notRun: 'could not make the commit with the deploy-key copies' };
    // The bundle and the unpacked copy are in the new pack already.
    for (const f of ['r.bundle', 'r.git', 'composer.lock']) fs.rmSync(path.join(tmp, f), { recursive: true, force: true });
    handed = true;
    return { ref: String(sha.stdout).trim(), notes, gitEnv, done };
  } catch (e) {
    return { notRun: String(e.message) };
  } finally {
    if (!handed) done();
  }
}

// The first line may name the deploy-key repositories: ` mirrors=owner/name,...`.
const headerOf = (secrets, mirrors = [], allow = []) => `miu-ci-secrets ${secrets.length}${mirrors.length ? ` mirrors=${mirrors.join(',')}` : ''}${allow.length ? ` allow=${allow.join(',')}` : ''}\n${secrets.map(([n, v]) => `${n}=${v}\n`).join('')}`;

// The token, and the forms git and actions/checkout put it in, out of a text.
function hideToken(text, token) {
  if (!token) return text;
  let out = String(text);
  for (const s of [token, Buffer.from(`x-access-token:${token}`).toString('base64'), Buffer.from(token).toString('base64')]) out = out.split(s).join('[secret removed]');
  return out;
}

// ref: the commit to send, HEAD of the checkout at dir by default; a full sha
// sends that commit from a bare clone. onStart gets the process id, so that a
// restarted dashboard can stop a run it no longer waits for. repo: the pull
// request's own repository; trustedRef: the base branch's tip in the same
// clone. mint and revoke stand in for the GitHub App in tests.
export async function runSandboxCi(check, dir, env = process.env, { limitMs, stopWaitMs = STOP_WAIT_MS, ref = 'HEAD', onStart, repo = '', trustedRef = null, secretsFrom = trustedRef, mint = defaultMint, revoke = defaultRevoke } = {}) {
  const problem = sandboxCiProblem(check);
  if (problem) return { notRun: problem };
  if (!REF.test(ref)) return { notRun: 'not a commit to run' };
  const user = env.MIU_SANDBOX_USER;
  const worker = env.MIU_SANDBOX_WORKER;
  if (!user || !worker) return { notRun: 'Sandbox CI is not set up on this server; run install.sh with --sandbox-user' };
  if (trustedRef !== null && !REF.test(trustedRef)) return { notRun: 'not a commit to read the base branch from' };
  if (secretsFrom !== null && !REF.test(secretsFrom)) return { notRun: 'not a commit to read the base branch\'s secrets from' };
  // The deploy-key copies are made before any token (accessFor calls this
  // first), and their throwaway object store goes when the run ends.
  let copies = null;
  const access = await accessFor(check.sandbox_ci, dir, ref, repo, trustedRef, mint, deployKeyRepos(env.MIU_CI_MIRRORS_CONF ?? MIRRORS_FILE), async (mirrors) => (copies = await withMirrors(dir, ref, mirrors, env)), secretsFrom);
  if (access.notRun) { copies?.done?.(); return { notRun: access.notRun }; }
  try {
    const mirrors = access.mirrors ?? [];
    const notes = copies?.notes ?? [];
    const r = await sendToWorker(check, dir, { ...env, ...(copies?.gitEnv ?? {}) }, { limitMs, stopWaitMs, ref: copies?.ref ?? ref, onStart, user, worker, secrets: access.secrets, token: access.token, mirrors, allow: access.allow ?? [] });
    if (!notes.length || r.notRun) return r;
    const head = `${notes.join('\n')}\n\n`;
    return { ...r, out: head + (r.out ?? ''), ...(r.log !== undefined ? { log: head + r.log } : {}) };
  } finally {
    copies?.done?.();
    // The worker revokes it too when it ends (bin/miu-sandbox-ci), also when
    // Miu is gone; this is the second try, three times. A failure is logged,
    // without the token, and the token still expires within the hour.
    if (access.token) {
      let done = false;
      for (let i = 0; i < 3 && !done; i++) done = await revoke(access.token).then(() => true, () => false);
      if (!done) console.error(`ci: could not revoke the run's GitHub token for ${check.label ?? check.sandbox_ci.job}; it expires within the hour`);
    }
  }
}

function sendToWorker(check, dir, env, { limitMs, stopWaitMs, ref, onStart, user, worker, secrets, token, mirrors, allow }) {
  const limit = limitMs ?? secondsOf(check.sandbox_ci) * 1000 + GRACE_MS;
  return new Promise((resolve) => {
    // Its own process group, so that stopping it also stops what it started.
    const child = spawn('bash', ['-c', SEND_COMMIT, 'miu-sandbox-ci', dir, ref, user, worker, ...workerArgs(check.sandbox_ci)], { env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', () => {});
    child.stdin.end(headerOf(secrets, mirrors, allow));
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let giveUp;
    const TOO_LONG = { notRun: 'Sandbox CI passed its time limit and was stopped' };
    const finish = (result) => { clearTimeout(timer); clearTimeout(giveUp); resolve(result); };
    if (child.pid) onStart?.(child.pid);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
      giveUp = setTimeout(() => { child.unref(); child.stdout.destroy(); child.stderr.destroy(); finish(TOO_LONG); }, stopWaitMs);
    }, limit);
    child.on('close', () => finish(timedOut ? TOO_LONG : resultOf({ stdout: hideToken(stdout, token), stderr: hideToken(stderr, token) })));
    child.on('error', (e) => finish({ notRun: `could not start Sandbox CI: ${e.message}` }));
  });
}

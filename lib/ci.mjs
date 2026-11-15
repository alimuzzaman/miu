// CI for every pull request Miu tests, beside the QA run.
//
// A pull request has CI when its head has workflows in .github/workflows that
// run for pull requests (or pushes). Each job, and each matrix combination,
// that Sandbox CI can run (lib/sandboxci.mjs, bin/miu-sandbox-ci) is one CI
// job here. Jobs from all pull requests share one line and run a few at a
// time (`parallel`); the worker on the server has its own slots and refuses
// when the server is busy, and such a job waits in the line and is tried again.
//
// runs/.ci/<repo>-<pr>-<sha12>.json holds one commit's CI; its logs are in the
// folder of the same name. Nothing here reaches GitHub Actions: no workflow
// is dispatched or re-run there.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { sandboxCiProblem, CI_DEFINITION } from './sandboxci.mjs';

const RUNNERS = ['ubuntu-latest', 'ubuntu-22.04'];
const VALUE = /^[\w.-]+$/;
const KEY = /^\w[\w-]*$/;
const MAX_JOBS = 24;
const RETRY_MS = 60 * 1000;
const WAIT_LIMIT_MS = 2 * 3600 * 1000;
const KEEP_MS = 30 * 24 * 3600 * 1000;
// Raised when what qualifies changes: a record made under older rules is read again.
const CI_RULES = 2;
// The worker's answers that mean "not now", not "cannot".
const BUSY = /slots on this server are in use|this server is busy|host apply is in progress|could not take a Sandbox CI slot/;
// What lib/sandboxci.mjs says when act ran nothing: the job's own `if` was false.
const NO_JOB_RAN = /act reported success, but no job ran/;

// ---- reading workflows

// YAML in, plain JSON out, with PyYAML (install.sh adds python3-yaml for
// Sandbox CI). YAML 1.1 reads the key `on` as true, so it is put back. A
// float becomes its text (3.10 is 3.1, as on GitHub). A whole float such as
// an unquoted 8.0 is marked: Sandbox selects it as "8.0" and act as "8", so
// no run of it can be picked out (checked on the server, 2026-11-15).
const PARSE = `
import json, sys, yaml
def plain(x):
    if isinstance(x, float):
        return {"wholeFloat": str(x)} if x.is_integer() else str(x)
    if isinstance(x, dict):
        return {k: plain(v) for k, v in x.items()}
    if isinstance(x, list):
        return [plain(v) for v in x]
    return x
out = []
for f in json.load(sys.stdin):
    try:
        d = yaml.safe_load(f["text"])
        if isinstance(d, dict) and True in d and "on" not in d:
            d["on"] = d.pop(True)
        out.append({"path": f["path"], "doc": plain(d)})
    except Exception as e:
        out.append({"path": f["path"], "error": type(e).__name__})
print(json.dumps(out, default=str))
`;
export function parseWorkflows(files) {
  if (!files.length) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-I', '-c', PARSE], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`could not read the workflows: ${e.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(/No module named .?yaml/.test(err) ? 'python3-yaml is not installed on this server' : `could not read the workflows: ${err.trim().split('\n').pop() || `python3 exited ${code}`}`));
      try { resolve(JSON.parse(out)); } catch (e) { reject(new Error(`could not read the workflows: ${e.message}`)); }
    });
    child.stdin.end(JSON.stringify(files));
  });
}

// GitHub's filter patterns: * within a path segment, ** across them (and
// **/ also for none), ? and + on the character before (optional, one or
// more), [..] a set of letters, digits and -, ! in front to take a match
// back. The last pattern that matches wins.
function globRe(g) {
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') { if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; } }
    else if (c === '*') re += '[^/]*';
    else if ((c === '?' || c === '+') && re && !re.endsWith('(?:.*/)?')) re += c;
    else if (c === '[') { const end = g.indexOf(']', i); const set = end > i ? g.slice(i + 1, end) : null; if (!set || !/^[A-Za-z0-9-]+$/.test(set)) throw new Error(`not a filter pattern: ${g}`); re += `[${set}]`; i = end; }
    else re += c.replace(/[.^${}()|\\\]?+]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
export function filterMatch(patterns, value) {
  let hit = false;
  for (const p of [].concat(patterns ?? [])) {
    if (typeof p !== 'string') continue;
    const neg = p.startsWith('!');
    // A pattern Miu cannot read counts as matching: the workflow runs rather than silently not.
    let match; try { match = globRe(neg ? p.slice(1) : p).test(value); } catch { match = true; }
    if (match) hit = !neg;
  }
  return hit;
}
const PR_TYPES = ['opened', 'synchronize', 'reopened'];

// How a workflow runs for this pull request: { event }, { skip: why } when
// its trigger's filters leave this pull request out, or null when it is not
// a pull request or push workflow at all. base: the branch the pull request
// goes into. changed: its files, when known.
export function triggerOf(on, { base, changed } = {}) {
  const names = typeof on === 'string' ? [on] : Array.isArray(on) ? on : on && typeof on === 'object' ? Object.keys(on) : [];
  const cfg = (name) => (on && typeof on === 'object' && !Array.isArray(on) && on[name] && typeof on[name] === 'object' ? on[name] : {});
  const paths = (c) => {
    if (!Array.isArray(changed)) return null;
    if (c.paths && !changed.some((f) => filterMatch(c.paths, f))) return 'none of its changed files match the workflow\'s paths';
    if (c['paths-ignore'] && changed.length && changed.every((f) => filterMatch(c['paths-ignore'], f))) return 'all of its changed files are in the workflow\'s paths-ignore';
    return null;
  };
  const pull = () => {
    const c = cfg('pull_request');
    if (c.types && ![].concat(c.types).some((t) => PR_TYPES.includes(t))) return { skip: `it runs on pull requests only when ${[].concat(c.types).join(', ')}`, kind: 'trigger' };
    if (base && c.branches && !filterMatch(c.branches, base)) return { skip: `it runs on pull requests into ${[].concat(c.branches).join(', ')}, not ${base}`, kind: 'filter' };
    if (base && c['branches-ignore'] && filterMatch(c['branches-ignore'], base)) return { skip: `its branches-ignore leaves out pull requests into ${base}`, kind: 'filter' };
    const p = paths(c);
    return p ? { skip: p, kind: 'filter' } : { event: 'pull_request' };
  };
  const push = () => {
    const c = cfg('push');
    // A push to a named branch or a tag is a release or a deploy, not this pull request's CI.
    if (c.branches || c['branches-ignore'] || c.tags || c['tags-ignore']) return { skip: 'it runs on pushes to certain branches or tags only', kind: 'trigger' };
    const p = paths(c);
    return p ? { skip: p, kind: 'filter' } : { event: 'push' };
  };
  // A workflow on both runs if either would run for this pull request's branch.
  const a = names.includes('pull_request') ? pull() : null;
  if (a?.event) return a;
  const b = names.includes('push') ? push() : null;
  if (b?.event) return b;
  return a ?? b;
}

// Every combination of a job's matrix, the way GitHub makes them: the
// product of the lists, less `exclude`, plus `include`. Only plain values:
// a matrix built from an expression is not known before the run.
export function expandMatrix(matrix) {
  if (matrix === undefined || matrix === null) return { cells: [{}] };
  if (typeof matrix !== 'object' || Array.isArray(matrix)) return { error: 'its matrix comes from an expression' };
  const plain = (v) => (typeof v === 'string' || typeof v === 'number') && VALUE.test(String(v));
  const keys = Object.keys(matrix).filter((k) => k !== 'include' && k !== 'exclude');
  const whole = JSON.stringify(matrix).match(/"wholeFloat":"([^"]+)"/);
  if (whole) return { error: `its matrix has ${whole[1]} unquoted, which Sandbox CI cannot pick out (GitHub reads it as ${Number(whole[1])}); write "${whole[1]}" to run it here` };
  for (const k of keys) {
    if (!KEY.test(k)) return { error: `its matrix name ${k} is not plain` };
    if (!Array.isArray(matrix[k]) || !matrix[k].length) return { error: `its matrix ${k} is not a plain list` };
    if (!matrix[k].every(plain)) return { error: `its matrix ${k} has a value that is not plain text or a number` };
  }
  const rows = (k) => (matrix[k] === undefined ? [] : Array.isArray(matrix[k]) && matrix[k].every((r) => r && typeof r === 'object' && !Array.isArray(r)) ? matrix[k] : null);
  const include = rows('include'), exclude = rows('exclude');
  if (!include || !exclude) return { error: 'its matrix include or exclude is not a list of plain rows' };
  let product = keys.length ? [{}] : [];
  for (const k of keys) product = product.flatMap((c) => matrix[k].map((v) => ({ ...c, [k]: v })));
  const same = (a, b) => String(a) === String(b);
  product = product.filter((c) => !exclude.some((x) => Object.entries(x).every(([k, v]) => same(c[k], v))));
  // An include row joins every combination of the lists it agrees with (and
  // then adds nothing to the filter); one that joins none is its own
  // combination, filtered by all its values. Rows are matched against the
  // lists' combinations only, never against another include row.
  const extra = [];
  for (const row of include) {
    const own = Object.entries(row).filter(([k]) => keys.includes(k));
    if (keys.length && product.some((c) => own.every(([k, v]) => same(c[k], v)))) continue;
    if (!Object.entries(row).every(([k, v]) => KEY.test(k) && plain(v))) return { error: 'its matrix include has a value that is not plain' };
    extra.push({ ...row });
  }
  const cells = [...product, ...extra];
  return { cells: cells.length ? cells : [{}] };
}

// What bin/miu-sandbox-ci refuses for the whole file, so that none of its jobs
// waits in the line only to be refused.
function fileProblem(jobs) {
  const box = (what, c) => {
    if (!c || typeof c !== 'object' || Array.isArray(c)) return `${what} is not a mapping`;
    const extra = Object.keys(c).filter((k) => !['image', 'env', 'ports', 'credentials', 'options'].includes(k));
    if (extra.length) return `${what} sets ${extra.sort().join(', ')}`;
    if (c.options === undefined || c.options === null) return null;
    if (typeof c.options !== 'string' || c.options.includes('${{') || c.options.includes('\\')) return `${what} has options that are not plain text`;
    // Split like the worker's shlex: quoted words stay whole.
    const words = [...c.options.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
    const bad = words.find((w) => w.startsWith('-') && !w.startsWith('--health-'));
    return bad ? `${what} has the option ${bad}` : null;
  };
  for (const [id, job] of Object.entries(jobs)) {
    if (!job || typeof job !== 'object') return `job ${id} is not a mapping`;
    if (job.uses) return `job ${id} calls another workflow`;
    if (job.container && typeof job.container !== 'string') { const p = box(`job ${id} container`, job.container); if (p) return p; }
    if (job.services !== undefined) {
      if (!job.services || typeof job.services !== 'object') return `job ${id} services is not a mapping`;
      for (const [sid, s] of Object.entries(job.services)) { const p = box(`service ${sid}`, s); if (p) return p; }
    }
  }
  return null;
}

// ---- what never runs here, listed or not: anything that deploys, publishes,
// notifies or writes back to GitHub. Tests only.
const RELEASE_NAME = /(^|[^a-z])(deploy|release|publish|announce|sync|notify|slack|comment|summary|close-issues|label)/i;
const SIDE_EFFECT_RUN = /\b(curl|wget)\b[^\n;&|]*(-X\s*(POST|PUT|PATCH|DELETE)|--request[\s=]*(POST|PUT|PATCH|DELETE)|--data|\s-d\s?\S|\s-F\s|\s-T\s|--json\b|--upload-file|--post-(data|file)|--method[\s=]*(POST|PUT|PATCH|DELETE))|\b(npm|pnpm|yarn)(\s+npm)?\s+publish\b|\b(npm|pnpm|yarn)\s+(run\s+)?(deploy|release|publish)\b|semantic-release|changeset\s+publish|\btwine\s+upload|\bdocker\s+push|\baws\s+s3\s+(sync|cp|mv)|\b(firebase|netlify|vercel|wrangler)\s+(deploy|publish)|\bkubectl\s+apply|\bterraform\s+apply|\bgh\s+(api|pr|issue|release|workflow|run|repo)\b|\bgit\s+push\b|\bsvn\s+(ci|commit|import|cp|copy|mkdir|delete|rm)\b|\bnpm\s+publish\b|\b(rsync|scp|sftp)\s|\bssh\s|hooks\.slack\.com|pr-comment|\bdeploy\.sh\b/i;
const SIDE_EFFECT_USES = /deploy|release|publish|slack|comment|github-script|ftp|ssh|svn|create-pull-request|push|notify|label|codecov|coveralls|configure-aws-credentials|login-action|gh-pages/i;
// A job or step named for a release, a deploy or a notice.
const RELEASE_PART = /(^|[^a-z])(deploy|release|publish|announce|notify|slack|comment)/i;
// Why a workflow as a whole is not one Miu runs, or null.
export function releaseProblem(file, doc) {
  const name = `${path.basename(file)} ${typeof doc?.name === 'string' ? doc.name : ''}`;
  if (RELEASE_NAME.test(name)) return 'it is a release, deploy or notification workflow, which Miu never runs';
  const on = doc?.on;
  const names = typeof on === 'string' ? [on] : Array.isArray(on) ? on : on && typeof on === 'object' ? Object.keys(on) : [];
  const auto = names.filter((n) => ['pull_request_target', 'workflow_run', 'release', 'deployment', 'issues', 'issue_comment', 'pull_request_review'].includes(n));
  if (auto.length) return `it runs on ${auto.join(', ')}, which is automation rather than tests`;
  if (on && typeof on === 'object' && !Array.isArray(on) && on.push && typeof on.push === 'object' && on.push.tags) return 'it runs on tag pushes, as a release does';
  return null;
}
// Why one job writes somewhere, or null. doc: its workflow, whose
// permissions apply to a job that names none of its own.
function sideEffect(job, id = '', doc = {}) {
  if (!job || typeof job !== 'object') return null;
  if (job.environment) return 'it deploys to an environment';
  if (RELEASE_PART.test(`${id} ${typeof job.name === 'string' ? job.name : ''}`)) return 'its name says it releases, deploys or notifies';
  const perms = job.permissions ?? doc?.permissions;
  if (perms === 'write-all' || (perms && typeof perms === 'object' && Object.values(perms).some((v) => v === 'write'))) return 'it asks for write access to the repository or pull requests';
  for (const st of Array.isArray(job.steps) ? job.steps : []) {
    if (!st || typeof st !== 'object') continue;
    if (typeof st.uses === 'string' && SIDE_EFFECT_USES.test(st.uses.replace(/^actions\/(upload|download)-artifact@.*/, ''))) return `a step uses ${st.uses.slice(0, 60)}`;
    if (typeof st.name === 'string' && RELEASE_PART.test(st.name)) return `a step is named ${st.name.slice(0, 60)}`;
    const run = typeof st.run === 'string' ? st.run.replace(/\\\s*\n\s*/g, ' ') : null;
    if (run && SIDE_EFFECT_RUN.test(run)) return `a step posts, pushes or deploys (${(st.name ?? run.match(SIDE_EFFECT_RUN)?.[0] ?? '').toString().slice(0, 60)})`;
  }
  return null;
}

// A profile's pr_ci: the workflows (and jobs, and matrix values) to run on
// every pull request, whatever triggers them on GitHub. What is wrong with
// it, or null.
export function prCiProblem(list) {
  if (list === undefined) return null;
  if (!Array.isArray(list)) return '"pr_ci" must be a list';
  for (const e of list) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) return 'each "pr_ci" entry is an object with a "workflow"';
    if (typeof e.workflow !== 'string' || !/^\.github\/workflows\/[\w.-]+\.ya?ml$/.test(e.workflow)) return `"pr_ci" workflow ${String(e.workflow).slice(0, 60)} must be a file directly in .github/workflows`;
    if (e.jobs !== undefined && !(Array.isArray(e.jobs) && e.jobs.every((j) => typeof j === 'string' && KEY.test(j)))) return `"pr_ci" jobs of ${e.workflow} must be a list of job ids`;
    if (e.matrix !== undefined && !(e.matrix && typeof e.matrix === 'object' && !Array.isArray(e.matrix) && Object.entries(e.matrix).every(([k, v]) => KEY.test(k) && Array.isArray(v) && v.every((x) => VALUE.test(String(x)))))) return `"pr_ci" matrix of ${e.workflow} must map matrix names to lists of plain values`;
  }
  return null;
}

// How a listed workflow runs: { event } with the first of its triggers that
// act can play for a pull request's code, or { skip }.
function listedEvent(on) {
  const names = typeof on === 'string' ? [on] : Array.isArray(on) ? on : on && typeof on === 'object' ? Object.keys(on) : [];
  const push = on && typeof on === 'object' && !Array.isArray(on) && on.push && typeof on.push === 'object' ? on.push : {};
  const pushFiltered = !!(push.branches || push['branches-ignore'] || push.tags || push['tags-ignore']);
  if (names.includes('pull_request')) return { event: 'pull_request' };
  // Run by itself on pushes to some branches: that is how a deploy runs.
  if (names.includes('push') && pushFiltered) return { skip: 'it runs by itself on pushes to certain branches or tags, as a release or deploy does', kind: 'trigger' };
  if (names.includes('push')) return { event: 'push' };
  if (names.includes('workflow_dispatch')) return { event: 'workflow_dispatch' };
  if (names.includes('workflow_call')) return { skip: 'it runs only when another workflow calls it, so there is no event to run it with', kind: 'trigger' };
  return { skip: `it runs only on ${names.join(', ') || 'no event'}, which is not one Miu can play for a pull request`, kind: 'trigger' };
}

// The jobs of one workflow: a check for each that Sandbox CI can run, and a
// skip with the reason for each it cannot. ctx: { base, changed } for the
// trigger's filters (triggerOf), or { listed } for a profile's pr_ci entry,
// which runs whatever its trigger (and only its jobs and matrix values).
export function jobsOf(file, doc, ctx = {}) {
  const workflow = file;
  const name = (doc && typeof doc.name === 'string' ? doc.name : path.basename(file)).slice(0, 80);
  if (!doc || typeof doc !== 'object' || !doc.jobs || typeof doc.jobs !== 'object' || Array.isArray(doc.jobs)) return [{ label: name, workflow, skip: 'not a workflow with jobs' }];
  const { listed } = ctx;
  const trigger = listed ? listedEvent(doc.on) : triggerOf(doc.on, ctx);
  if (!trigger) return [];
  // Listed jobs only; the others are not shown.
  const jobs = listed?.jobs ? Object.fromEntries(Object.entries(doc.jobs).filter(([id]) => listed.jobs.includes(id))) : doc.jobs;
  if (listed?.jobs) for (const id of listed.jobs.filter((x) => !(x in doc.jobs))) jobs[id] = null;
  const allJobs = doc.jobs;
  const labelOf = (id, job) => `${name}: ${(job && typeof job.name === 'string' && !job.name.includes('${{') ? job.name : id).slice(0, 80)}`;
  const release = releaseProblem(file, doc);
  const whole = release ?? (trigger.skip ? `not run for this pull request: ${trigger.skip}` : fileProblem(allJobs) && `the Sandbox CI worker refuses this workflow: ${fileProblem(allJobs)}`);
  // A workflow that is not for pull requests is not a fault of the repo's CI: kind "trigger".
  if (whole) return Object.entries(jobs).map(([id, job]) => ({ label: labelOf(id, job), workflow, job: id, skip: whole, kind: release ? 'trigger' : trigger.skip ? trigger.kind ?? 'trigger' : undefined }));
  const { event } = trigger;
  const needsOf = (j) => { const n = allJobs[j]?.needs ?? []; return typeof n === 'string' ? [n] : Array.isArray(n) ? n.filter((x) => typeof x === 'string') : []; };
  const out = [];
  for (const [id, job] of Object.entries(jobs)) {
    const label = labelOf(id, job);
    const skip = (why) => out.push({ label, workflow, job: id, skip: why });
    if (job === null) { skip('the profile lists this job, but the workflow has none by that id'); continue; }
    if (!KEY.test(id)) { skip('its id is not plain'); continue; }
    const effect = sideEffect(job, id, doc);
    if (effect) { skip(`Miu runs tests only, and ${effect}`); continue; }
    // The job and every job it needs must run on a runner Sandbox maps.
    const seen = new Set(), todo = [id];
    let badRunner = null;
    while (todo.length) {
      const j = todo.pop();
      if (seen.has(j) || !allJobs[j]) continue;
      seen.add(j);
      if (j !== id && sideEffect(allJobs[j], j, doc)) badRunner ??= `the job it needs, ${j}, posts, pushes or deploys`;
      if (!RUNNERS.includes(allJobs[j]['runs-on'])) badRunner ??= `${j === id ? 'it' : `the job it needs, ${j},`} runs on ${typeof allJobs[j]['runs-on'] === 'string' ? allJobs[j]['runs-on'] : 'a runner list'}; Sandbox CI runs ${RUNNERS.join(' and ')}`;
      todo.push(...needsOf(j));
    }
    if (badRunner) { skip(badRunner); continue; }
    if (seen.size > 1 && [...seen].some((j) => 'if' in allJobs[j])) { skip('a job with needs cannot have a condition here'); continue; }
    const m = expandMatrix(job.strategy?.matrix);
    if (m.error) { skip(m.error); continue; }
    // A profile can run a few of the matrix values, for a cap of two jobs at a time.
    const pickOnly = listed?.matrix ? m.cells.filter((c) => Object.entries(listed.matrix).every(([k, vs]) => !(k in c) || vs.map(String).includes(String(c[k])))) : m.cells;
    if (!pickOnly.length) { skip('none of its matrix values is in the profile\'s list'); continue; }
    m.cells = pickOnly;
    const minutes = Number.isInteger(job['timeout-minutes']) && job['timeout-minutes'] >= 1 && job['timeout-minutes'] <= 240 ? job['timeout-minutes'] : undefined;
    for (const matrix of m.cells) {
      const keys = Object.keys(matrix);
      const check = {
        label: keys.length ? `${label} (${keys.map((k) => matrix[k]).join(', ')})` : label,
        sandbox_ci: { workflow, job: id, event, ...(keys.length ? { matrix } : {}), ...(minutes ? { timeout_minutes: minutes } : {}) },
        hasIf: 'if' in job,
      };
      const problem = sandboxCiProblem(check);
      if (problem) out.push({ label: check.label, workflow, job: id, skip: problem });
      else out.push({ label: check.label, workflow, job: id, check });
    }
  }
  // act runs a job's needs with it, so a job another runnable job needs runs
  // there, not a second time on its own.
  const runnable = new Set(out.filter((o) => o.check).map((o) => o.job));
  const needed = new Set();
  for (const j of runnable) { const todo = [...needsOf(j)]; while (todo.length) { const n = todo.pop(); if (needed.has(n)) continue; needed.add(n); todo.push(...needsOf(n)); } }
  // Credit each to a job that still runs on its own.
  const neededBy = new Map();
  for (const j of [...runnable].filter((x) => !needed.has(x))) {
    const todo = [...needsOf(j)], seen = new Set();
    while (todo.length) { const n = todo.pop(); if (seen.has(n)) continue; seen.add(n); if (!neededBy.has(n)) neededBy.set(n, j); todo.push(...needsOf(n)); }
  }
  return out.map((o) => (o.check && neededBy.has(o.job) ? { label: o.label, workflow, job: o.job, skip: `runs as part of ${neededBy.get(o.job)}, which needs it` } : o));
}

// The commit the worker runs: the pull request's top-level tree with the
// trusted branch's copies of what decides what act runs (CI_DEFINITION:
// .github, act's files, .gitattributes) in place of its own, or none where
// that branch has none, with the pull request's head as its parent. git(args, env,
// input) runs git in the bare clone. Same inputs, same commit.
export async function ciRunCommit(git, sha, trusted, message) {
  const entries = (t) => git(['ls-tree', '-z', t]).then((o) => o.split('\0').filter(Boolean));
  const ciOnly = (e) => CI_DEFINITION.includes(e.slice(e.indexOf('\t') + 1));
  const rows = [...(await entries(sha)).filter((e) => !ciOnly(e)), ...(await entries(trusted)).filter(ciOnly)];
  const tree = await git(['mktree', '-z'], null, rows.map((e) => `${e}\0`).join(''));
  const who = { GIT_AUTHOR_NAME: 'Miu', GIT_AUTHOR_EMAIL: 'miu@localhost', GIT_COMMITTER_NAME: 'Miu', GIT_COMMITTER_EMAIL: 'miu@localhost', GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' };
  return git(['commit-tree', tree, '-p', sha, '-m', message], who);
}

const sameCheck = (a, b) => a.workflow === b.workflow && a.job === b.job && JSON.stringify(a.matrix ?? {}) === JSON.stringify(b.matrix ?? {});

// ---- the line

const keyOf = (repo, pr, sha) => `${repo.split('/')[1]}-${pr}-${sha.slice(0, 12)}`;
// A process this module started and that still runs the worker: after a
// restart or a reboot a saved pid can belong to anything else.
const ourWorker = (pid) => {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return false;
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('miu-sandbox-ci'); } catch { return false; }
};

// One commit's CI in a word, for the pull request list.
export function summaryOf(rec) {
  if (!rec) return null;
  if (rec.state !== 'ready') return { state: rec.state, reason: rec.reason ?? null };
  const jobs = rec.jobs.filter((j) => j.status !== 'skipped');
  const n = (s) => jobs.filter((j) => j.status === s).length;
  const counts = { total: jobs.length, passed: n('passed'), failed: n('failed'), running: n('running'), queued: n('queued'), not_run: n('not_run'), skipped: rec.jobs.length - jobs.length };
  const state = !jobs.length ? 'no_jobs' : counts.running ? 'running' : counts.queued ? 'queued' : counts.failed ? 'failed' : counts.not_run ? 'not_run' : 'passed';
  return { state, ...counts };
}

// prepare(repo, pr, sha) -> { gitDir, sha, workflows: [{ path, text }], changesCi }
// runJob(check, gitDir, sha, { onStart }) -> what runSandboxCi gives
// coveredBy(repo) -> the repo's own fast checks, which run inside the QA run
// prCiFor(repo) -> the profile's pr_ci list, or undefined for the default rule
// prepare also gives runSha (the commit sent to the worker: the pull
// request's code with the base branch's .github), workflowsFrom (where the
// workflows were read), base and changed
// parse: parseWorkflows, or a stand-in in tests.
export function createCi({ dir, prepare, runJob, parallel = () => 2, isPaused = () => false, coveredBy = () => [], prCiFor = () => undefined, scrub = (t) => t, now = Date.now, log = () => {}, parse = parseWorkflows }) {
  const recs = new Map();
  const running = new Set();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = (key) => path.join(dir, `${key}.json`);
  const save = (rec) => { try { fs.writeFileSync(file(rec.key), JSON.stringify(rec, null, 2)); } catch (e) { log(`ci: could not save ${rec.key}: ${e.message}`); } };
  const logFile = (key, n) => path.join(dir, key, `${n}.log`);

  // A job left running by a dashboard that stopped: stop what is left of it
  // and put it back in the line.
  for (const f of fs.readdirSync(dir).filter((x) => /^[\w.-]+\.json$/.test(x))) {
    const name = f.slice(0, -5);
    let rec; try { rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    if (rec?.key !== name) continue;
    // A commit's CI record and its logs are kept for 30 days.
    if (now() - rec.at > KEEP_MS && !(rec.jobs ?? []).some((j) => j.status === 'running')) {
      fs.rmSync(path.join(dir, f), { force: true });
      fs.rmSync(path.join(dir, name), { recursive: true, force: true });
      continue;
    }
    let changed = false;
    // Tried again on the next scan, like a fetch that failed.
    if (rec.state === 'detecting') { Object.assign(rec, { state: 'not_run', transient: true, retryAt: 0, reason: 'Miu restarted while reading the workflows; it reads them again' }); changed = true; }
    for (const j of rec.jobs ?? []) {
      if (j.status !== 'running') continue;
      if (ourWorker(j.pid)) { try { process.kill(-j.pid, 'SIGTERM'); } catch { /* gone */ } }
      Object.assign(j, { status: 'queued', pid: null, startedAt: null, waitReason: 'Miu restarted during this job; it runs again' });
      changed = true;
    }
    // Lined up under older rules (what runs, and on which commit): nothing of
    // it starts; it is read again the next time it is asked for.
    if (rec.rules !== CI_RULES && rec.state === 'ready') {
      for (const j of rec.jobs ?? []) if (j.status === 'queued') Object.assign(j, { status: 'skipped', reason: 'lined up under older rules; read again' });
      Object.assign(rec, { state: 'not_run', transient: true, retryAt: 0, reason: 'Miu changed how it picks CI; it reads the workflows again' });
      changed = true;
    }
    recs.set(rec.key, rec);
    if (changed) save(rec);
  }

  function get(repo, pr, sha) { return sha ? recs.get(keyOf(repo, pr, sha)) ?? null : null; }
  function latest(repo, pr) {
    return [...recs.values()].filter((r) => r.repo === repo && r.pr === pr).sort((a, b) => b.at - a.at)[0] ?? null;
  }

  // Read the commit's workflows and line up its jobs, once per commit.
  // again: a person asked to run this commit's CI once more.
  function ensure(repo, pr, sha, { again = false, by = 'auto' } = {}) {
    if (!/^[0-9a-f]{40}$/.test(sha ?? '')) return null;
    const key = keyOf(repo, pr, sha);
    const have = recs.get(key);
    // A commit that could not be read (GitHub or git failed) is tried again two minutes later.
    const stale = have && have.rules !== CI_RULES;
    if (have && !again && !stale && !(have.transient && now() >= (have.retryAt ?? have.at + 2 * 60 * 1000))) return have;
    if (have && (have.state === 'detecting' || have.jobs?.some((j) => j.status === 'running'))) return have;
    const rec = { key, repo, pr, sha, at: now(), by, rules: CI_RULES, state: 'detecting', reason: null, jobs: [] };
    recs.set(key, rec);
    fs.rmSync(path.join(dir, key), { recursive: true, force: true });
    save(rec);
    (async () => {
      const got = await prepare(repo, pr, sha);
      rec.gitDir = got.gitDir;
      rec.runSha = got.runSha ?? null;
      rec.workflowsFrom = got.workflowsFrom ?? null;
      // Like GitHub with a fork's pull request: its code gets none of the server's CI secrets, so here it does not run at all.
      if (got.fork) return Object.assign(rec, { state: 'not_run', reason: `This pull request ${got.fork === 'dependabot' ? 'is from Dependabot' : 'comes from a fork'}. Its code would run with the server's CI secrets, so its CI runs on GitHub only.` });
      if (got.changesCi) return Object.assign(rec, { state: 'not_run', reason: 'This pull request changes .github/ or .actrc. A pull request must not choose what runs on Miu\'s server, so its CI runs on GitHub only.' });
      const list = prCiFor(repo);
      const bad = prCiProblem(list);
      if (bad) return Object.assign(rec, { state: 'not_run', reason: `The profile's pr_ci is not valid: ${bad}` });
      if (list && !list.length) return Object.assign(rec, { state: 'none', reason: 'The profile lists no workflows to run for pull requests (pr_ci is empty)' });
      const workflows = list ? got.workflows.filter((w) => list.some((e) => e.workflow === w.path)) : got.workflows;
      const missing = list ? list.filter((e) => !got.workflows.some((w) => w.path === e.workflow)).map((e) => ({ label: path.basename(e.workflow), workflow: e.workflow, skip: `the profile lists it, but ${got.workflowsFrom ?? 'the base branch'} has no such workflow` })) : [];
      if (!workflows.length && !missing.length) return Object.assign(rec, { state: 'none', reason: 'No workflows in .github/workflows' });
      const found = [...(await parse(workflows)).flatMap((w) => (w.error ? [{ label: path.basename(w.path), workflow: w.path, skip: `not readable as YAML (${w.error})` }] : jobsOf(w.path, w.doc, list ? { listed: list.find((e) => e.workflow === w.path) } : { base: got.base, changed: got.changed }))), ...missing];
      if (!found.length) return Object.assign(rec, { state: 'none', reason: 'No workflow here runs for pull requests' });
      const own = coveredBy(repo).filter((c) => c.sandbox_ci);
      let runnable = 0;
      rec.jobs = found.map((j, n) => {
        const base = { n, label: j.label, workflow: j.workflow, job: j.job ?? null, matrix: j.check?.sandbox_ci.matrix ?? null };
        if (j.skip) return { ...base, status: 'skipped', reason: j.skip };
        const same = own.find((c) => sameCheck(c.sandbox_ci, j.check.sandbox_ci));
        if (same) return { ...base, status: 'skipped', reason: `runs inside the QA run as the repo test suite "${same.label}"` };
        if (++runnable > MAX_JOBS) return { ...base, status: 'skipped', reason: `more than ${MAX_JOBS} jobs; only the first ${MAX_JOBS} run` };
        return { ...base, status: 'queued', check: j.check, queuedAt: now(), attempts: 0 };
      });
      // Nothing to run because no workflow is for pull requests (only
      // release, deploy or manual ones): that is a repo without PR CI, not a fault.
      rec.state = rec.jobs.every((j) => j.status === 'skipped' && found[j.n]?.kind === 'trigger')
        ? 'none' : 'ready';
      if (rec.state === 'none') rec.reason = 'No workflow here runs for pull requests';
    })().catch((e) => Object.assign(rec, { state: 'not_run', transient: true, reason: scrub(String(e.message)).slice(0, 300) }))
      .finally(() => { save(rec); log(`ci ${repo}#${pr} ${sha.slice(0, 7)}: ${rec.state}${rec.reason ? `, ${rec.reason}` : ''}${rec.jobs.length ? `, ${rec.jobs.filter((j) => j.status === 'queued').length} queued` : ''}`); tick(); });
    return rec;
  }

  function start(rec, j) {
    Object.assign(j, { status: 'running', startedAt: now(), finishedAt: null, attempts: (j.attempts ?? 0) + 1, waitReason: null });
    running.add(j);
    save(rec);
    Promise.resolve()
      .then(() => runJob(j.check, rec.gitDir, rec.runSha ?? rec.sha, { onStart: (pid) => { j.pid = pid; save(rec); } }))
      .catch((e) => ({ notRun: `could not start: ${e.message}` }))
      .then((r) => {
        running.delete(j);
        j.pid = null;
        // Not now: back in the line, tried again in a minute, for up to two
        // hours from the first time the server said so.
        if (r.notRun && BUSY.test(r.notRun) && now() - (j.busySince ?? now()) < WAIT_LIMIT_MS) {
          Object.assign(j, { status: 'queued', startedAt: null, busySince: j.busySince ?? now(), retryAt: now() + RETRY_MS, waitReason: scrub(r.notRun).slice(0, 200) });
        } else if (r.notRun && NO_JOB_RAN.test(r.notRun) && j.check?.hasIf) {
          // The job's own condition (if:) left it out, as it would on GitHub.
          Object.assign(j, { status: 'skipped', reason: 'act ran nothing: the job\'s condition (if:) left it out for this event', finishedAt: now() });
        } else {
          const text = scrub([r.log ?? r.out ?? '', r.notRun ? `\nNot run: ${r.notRun}` : ''].join('')).slice(-2 * 1024 * 1024);
          try { fs.mkdirSync(path.join(dir, rec.key), { recursive: true, mode: 0o700 }); fs.writeFileSync(logFile(rec.key, j.n), text); } catch (e) { log(`ci: could not write a log: ${e.message}`); }
          Object.assign(j, { status: r.notRun ? 'not_run' : r.status === 0 ? 'passed' : 'failed', reason: r.notRun ? scrub(r.notRun).slice(0, 300) : null, finishedAt: now(), hasLog: !!text.trim() });
          log(`ci ${rec.repo}#${rec.pr} ${j.label}: ${j.status}${j.reason ? `, ${j.reason}` : ''}`);
        }
        save(rec);
        tick();
      });
  }

  // Start what the line and the caps allow: oldest commit first. Paused: nothing new.
  function tick() {
    if (isPaused()) return;
    const room = Math.max(0, parallel() - running.size);
    if (!room) return;
    const t = now();
    const next = [...recs.values()].filter((r) => r.state === 'ready').sort((a, b) => a.at - b.at)
      .flatMap((r) => r.jobs.filter((j) => j.status === 'queued' && !(j.retryAt > t)).map((j) => [r, j]))
      .slice(0, room);
    for (const [r, j] of next) start(r, j);
  }

  // A job's position in the line, for "queued, 3rd".
  function waiting() {
    return [...recs.values()].filter((r) => r.state === 'ready').sort((a, b) => a.at - b.at).flatMap((r) => r.jobs.filter((j) => j.status === 'queued').map((j) => `${r.key}/${j.n}`));
  }

  // The record as the dashboard shows it: no check internals, no folders.
  function view(rec) {
    if (!rec) return null;
    const line = waiting();
    return {
      key: rec.key, repo: rec.repo, pr: rec.pr, sha: rec.sha, at: rec.at, state: rec.state, reason: rec.reason, summary: summaryOf(rec), workflowsFrom: rec.workflowsFrom ?? null, listed: !!prCiFor(rec.repo),
      jobs: rec.jobs.map((j) => ({ n: j.n, label: j.label, workflow: j.workflow, job: j.job, matrix: j.matrix, status: j.status, reason: j.reason ?? null, waitReason: j.waitReason ?? null, startedAt: j.startedAt ?? null, finishedAt: j.finishedAt ?? null, attempts: j.attempts ?? 0, hasLog: !!j.hasLog, place: j.status === 'queued' ? line.indexOf(`${rec.key}/${j.n}`) + 1 : null })),
    };
  }

  const readLog = (key, n) => {
    const rec = recs.get(key);
    if (!rec || !Number.isInteger(n) || !rec.jobs[n]) return null;
    try { return fs.readFileSync(logFile(key, n), 'utf8'); } catch { return null; }
  };

  return { ensure, get, latest, tick, view, readLog, running: () => running.size, queued: () => waiting().length, summary: summaryOf };
}

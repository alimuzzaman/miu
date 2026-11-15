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
import { spawnSync } from 'node:child_process';
import { sandboxCiProblem } from './sandboxci.mjs';

const RUNNERS = ['ubuntu-latest', 'ubuntu-22.04'];
const VALUE = /^[\w.-]+$/;
const KEY = /^\w[\w-]*$/;
const MAX_JOBS = 24;
const RETRY_MS = 60 * 1000;
const WAIT_LIMIT_MS = 2 * 3600 * 1000;
const KEEP_MS = 30 * 24 * 3600 * 1000;
// The worker's answers that mean "not now", not "cannot".
const BUSY = /slots on this server are in use|this server is busy|host apply is in progress|could not take a Sandbox CI slot/;

// ---- reading workflows

// YAML in, plain JSON out, with PyYAML (install.sh adds python3-yaml for
// Sandbox CI). YAML 1.1 reads the key `on` as true, so it is put back.
const PARSE = `
import json, sys, yaml
out = []
for f in json.load(sys.stdin):
    try:
        d = yaml.safe_load(f["text"])
        if isinstance(d, dict) and True in d and "on" not in d:
            d["on"] = d.pop(True)
        out.append({"path": f["path"], "doc": d})
    except Exception as e:
        out.append({"path": f["path"], "error": type(e).__name__})
print(json.dumps(out, default=str))
`;
export function parseWorkflows(files) {
  if (!files.length) return [];
  const r = spawnSync('python3', ['-I', '-c', PARSE], { input: JSON.stringify(files), encoding: 'utf8', timeout: 30000, maxBuffer: 32 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(/No module named .?yaml/.test(r.stderr || '') ? 'python3-yaml is not installed on this server' : `could not read the workflows: ${(r.stderr || r.error?.message || '').trim().split('\n').pop()}`);
  return JSON.parse(r.stdout);
}

// The event a workflow runs on for a pull request, or null.
function eventOf(on) {
  const names = typeof on === 'string' ? [on] : Array.isArray(on) ? on : on && typeof on === 'object' ? Object.keys(on) : [];
  if (names.includes('pull_request')) return 'pull_request';
  if (names.includes('push')) return 'push';
  return null;
}

// Every combination of a job's matrix, the way GitHub makes them: the
// product of the lists, less `exclude`, plus `include`. Only plain values:
// a matrix built from an expression is not known before the run.
export function expandMatrix(matrix) {
  if (matrix === undefined || matrix === null) return { cells: [{}] };
  if (typeof matrix !== 'object' || Array.isArray(matrix)) return { error: 'its matrix comes from an expression' };
  const plain = (v) => (typeof v === 'string' || typeof v === 'number') && VALUE.test(String(v));
  const keys = Object.keys(matrix).filter((k) => k !== 'include' && k !== 'exclude');
  for (const k of keys) {
    if (!KEY.test(k)) return { error: `its matrix name ${k} is not plain` };
    if (!Array.isArray(matrix[k]) || !matrix[k].length) return { error: `its matrix ${k} is not a plain list` };
    if (!matrix[k].every(plain)) return { error: `its matrix ${k} has a value that is not plain text or a number` };
  }
  const rows = (k) => (matrix[k] === undefined ? [] : Array.isArray(matrix[k]) && matrix[k].every((r) => r && typeof r === 'object' && !Array.isArray(r)) ? matrix[k] : null);
  const include = rows('include'), exclude = rows('exclude');
  if (!include || !exclude) return { error: 'its matrix include or exclude is not a list of plain rows' };
  let cells = keys.length ? [{}] : [];
  for (const k of keys) cells = cells.flatMap((c) => matrix[k].map((v) => ({ ...c, [k]: v })));
  const same = (a, b) => String(a) === String(b);
  cells = cells.filter((c) => !exclude.some((x) => Object.entries(x).every(([k, v]) => same(c[k], v))));
  for (const row of include) {
    const own = Object.entries(row).filter(([k]) => keys.includes(k));
    const matched = cells.some((c) => own.every(([k, v]) => same(c[k], v)));
    if (matched) continue;
    // A row that matches no combination is one of its own, filtered by all its values.
    if (!Object.entries(row).every(([k, v]) => KEY.test(k) && plain(v))) return { error: 'its matrix include has a value that is not plain' };
    cells.push({ ...row });
  }
  // A combination an include row grows keeps its original values as its
  // filter, so matched rows add nothing here.
  return { cells: cells.length ? cells : [{}] };
}

// The jobs of one workflow: a check for each that Sandbox CI can run, and a
// skip with the reason for each it cannot.
export function jobsOf(file, doc) {
  const workflow = file;
  const name = (doc && typeof doc.name === 'string' ? doc.name : path.basename(file)).slice(0, 80);
  if (!doc || typeof doc !== 'object' || !doc.jobs || typeof doc.jobs !== 'object') return [{ label: name, workflow, skip: 'not a workflow with jobs' }];
  const event = eventOf(doc.on);
  if (!event) return [];
  const jobs = doc.jobs;
  const out = [];
  for (const [id, job] of Object.entries(jobs)) {
    const label = `${name}: ${(job && typeof job.name === 'string' && !job.name.includes('${{') ? job.name : id).slice(0, 80)}`;
    const skip = (why) => out.push({ label, workflow, job: id, skip: why });
    if (!job || typeof job !== 'object') { skip('not a job'); continue; }
    if (!KEY.test(id)) { skip('its id is not plain'); continue; }
    if (job.uses) { skip('it calls another workflow'); continue; }
    // The job and every job it needs must run on a runner Sandbox maps.
    const seen = new Set(), todo = [id];
    let badRunner = null;
    while (todo.length) {
      const j = todo.pop();
      if (seen.has(j) || !jobs[j]) continue;
      seen.add(j);
      if (!RUNNERS.includes(jobs[j]['runs-on'])) badRunner ??= `${j === id ? 'it' : `the job it needs, ${j},`} runs on ${typeof jobs[j]['runs-on'] === 'string' ? jobs[j]['runs-on'] : 'a runner list'}; Sandbox CI runs ${RUNNERS.join(' and ')}`;
      const needs = jobs[j].needs ?? [];
      todo.push(...(typeof needs === 'string' ? [needs] : Array.isArray(needs) ? needs.filter((n) => typeof n === 'string') : []));
    }
    if (badRunner) { skip(badRunner); continue; }
    if (seen.size > 1 && [...seen].some((j) => 'if' in jobs[j])) { skip('a job with needs cannot have a condition here'); continue; }
    const m = expandMatrix(job.strategy?.matrix);
    if (m.error) { skip(m.error); continue; }
    const minutes = Number.isInteger(job['timeout-minutes']) && job['timeout-minutes'] >= 1 && job['timeout-minutes'] <= 240 ? job['timeout-minutes'] : undefined;
    for (const matrix of m.cells) {
      const keys = Object.keys(matrix);
      const check = {
        label: keys.length ? `${label} (${keys.map((k) => matrix[k]).join(', ')})` : label,
        sandbox_ci: { workflow, job: id, event, ...(keys.length ? { matrix } : {}), ...(minutes ? { timeout_minutes: minutes } : {}) },
      };
      const problem = sandboxCiProblem(check);
      if (problem) out.push({ label: check.label, workflow, job: id, skip: problem });
      else out.push({ label: check.label, workflow, job: id, check });
    }
  }
  return out;
}

const sameCheck = (a, b) => a.workflow === b.workflow && a.job === b.job && JSON.stringify(a.matrix ?? {}) === JSON.stringify(b.matrix ?? {});

// ---- the line

const keyOf = (repo, pr, sha) => `${repo.split('/')[1]}-${pr}-${sha.slice(0, 12)}`;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

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
// parse: parseWorkflows, or a stand-in in tests.
export function createCi({ dir, prepare, runJob, parallel = () => 2, isPaused = () => false, coveredBy = () => [], scrub = (t) => t, now = Date.now, log = () => {}, parse = parseWorkflows }) {
  const recs = new Map();
  const running = new Set();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = (key) => path.join(dir, `${key}.json`);
  const save = (rec) => { try { fs.writeFileSync(file(rec.key), JSON.stringify(rec, null, 2)); } catch (e) { log(`ci: could not save ${rec.key}: ${e.message}`); } };
  const logFile = (key, n) => path.join(dir, key, `${n}.log`);

  // A job left running by a dashboard that stopped: stop what is left of it
  // and put it back in the line.
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    let rec; try { rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    if (!rec?.key) continue;
    // A commit's CI record and its logs are kept for 30 days.
    if (now() - rec.at > KEEP_MS && !(rec.jobs ?? []).some((j) => j.status === 'running')) {
      fs.rmSync(path.join(dir, f), { force: true });
      fs.rmSync(path.join(dir, rec.key), { recursive: true, force: true });
      continue;
    }
    if (rec.state === 'detecting') { rec.state = 'not_run'; rec.reason = 'Miu restarted while reading the workflows; run CI again'; }
    let changed = rec.state === 'not_run' && rec.reason?.startsWith('Miu restarted');
    for (const j of rec.jobs ?? []) {
      if (j.status !== 'running') continue;
      if (j.pid && alive(j.pid)) { try { process.kill(-j.pid, 'SIGTERM'); } catch { /* not ours any more */ } }
      Object.assign(j, { status: 'queued', pid: null, startedAt: null, waitReason: 'Miu restarted during this job; it runs again' });
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
    // A commit that could not be read (GitHub or git failed) is tried again after ten minutes.
    if (have && !again && !(have.transient && now() - have.at > 10 * 60 * 1000)) return have;
    if (have && (have.state === 'detecting' || have.jobs?.some((j) => j.status === 'running'))) return have;
    const rec = { key, repo, pr, sha, at: now(), by, state: 'detecting', reason: null, jobs: [] };
    recs.set(key, rec);
    fs.rmSync(path.join(dir, key), { recursive: true, force: true });
    save(rec);
    (async () => {
      const got = await prepare(repo, pr, sha);
      rec.gitDir = got.gitDir;
      if (got.changesCi) return Object.assign(rec, { state: 'not_run', reason: 'This pull request changes .github/ or .actrc. A pull request must not choose what runs on Miu\'s server, so its CI runs on GitHub only.' });
      if (!got.workflows.length) return Object.assign(rec, { state: 'none', reason: 'No workflows in .github/workflows' });
      const found = parse(got.workflows).flatMap((w) => (w.error ? [{ label: path.basename(w.path), workflow: w.path, skip: `not readable as YAML (${w.error})` }] : jobsOf(w.path, w.doc)));
      if (!found.length) return Object.assign(rec, { state: 'none', reason: 'No workflow here runs for pull requests or pushes' });
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
      rec.state = 'ready';
    })().catch((e) => Object.assign(rec, { state: 'not_run', transient: true, reason: scrub(String(e.message)).slice(0, 300) }))
      .finally(() => { save(rec); log(`ci ${repo}#${pr} ${sha.slice(0, 7)}: ${rec.state}${rec.reason ? `, ${rec.reason}` : ''}${rec.jobs.length ? `, ${rec.jobs.filter((j) => j.status === 'queued').length} queued` : ''}`); tick(); });
    return rec;
  }

  function start(rec, j) {
    Object.assign(j, { status: 'running', startedAt: now(), finishedAt: null, attempts: (j.attempts ?? 0) + 1, waitReason: null });
    running.add(j);
    save(rec);
    const t0 = now();
    Promise.resolve()
      .then(() => runJob(j.check, rec.gitDir, rec.sha, { onStart: (pid) => { j.pid = pid; save(rec); } }))
      .catch((e) => ({ notRun: `could not start: ${e.message}` }))
      .then((r) => {
        running.delete(j);
        j.pid = null;
        // Not now: back in the line, tried again in a minute, for up to two hours.
        if (r.notRun && BUSY.test(r.notRun) && now() - (j.queuedAt ?? t0) < WAIT_LIMIT_MS) {
          Object.assign(j, { status: 'queued', startedAt: null, retryAt: now() + RETRY_MS, waitReason: scrub(r.notRun).slice(0, 200) });
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
      key: rec.key, repo: rec.repo, pr: rec.pr, sha: rec.sha, at: rec.at, state: rec.state, reason: rec.reason, summary: summaryOf(rec),
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

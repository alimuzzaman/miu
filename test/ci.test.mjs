import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { jobsOf, expandMatrix, parseWorkflows, createCi, summaryOf } from '../lib/ci.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'miu-ci-'));
const hasYaml = spawnSync('python3', ['-c', 'import yaml']).status === 0;
const SHA = 'a'.repeat(40);
const ubuntu = (extra = {}) => ({ 'runs-on': 'ubuntu-latest', steps: [{ run: 'true' }], ...extra });

test('a workflow on pull_request gives one check per job', () => {
  const jobs = jobsOf('.github/workflows/ci.yml', { name: 'CI', on: ['push', 'pull_request'], jobs: { lint: ubuntu({ name: 'Lint' }), unit: ubuntu({ 'timeout-minutes': 12 }) } });
  assert.deepEqual(jobs.map((j) => j.label), ['CI: Lint', 'CI: unit']);
  assert.deepEqual(jobs[1].check.sandbox_ci, { workflow: '.github/workflows/ci.yml', job: 'unit', event: 'pull_request', timeout_minutes: 12 });
});

test('push-only workflows run as push; release and schedule-only workflows are not CI for a pull request', () => {
  assert.equal(jobsOf('.github/workflows/a.yml', { on: { push: { branches: ['main'] } }, jobs: { a: ubuntu() } })[0].check.sandbox_ci.event, 'push');
  assert.deepEqual(jobsOf('.github/workflows/r.yml', { on: { release: {} }, jobs: { a: ubuntu() } }), []);
  assert.deepEqual(jobsOf('.github/workflows/s.yml', { on: 'schedule', jobs: { a: ubuntu() } }), []);
});

test('what the worker refuses is listed with the reason, not run', () => {
  const jobs = jobsOf('.github/workflows/ci.yml', { on: 'pull_request', jobs: {
    mac: { 'runs-on': 'macos-latest' },
    reuse: { uses: './.github/workflows/x.yml' },
    after: ubuntu({ needs: 'mac' }),
    cond: ubuntu({ needs: 'ok', if: 'always()' }),
    ok: ubuntu(),
    expr: ubuntu({ strategy: { matrix: '${{ fromJson(x) }}' } }),
  } });
  const by = Object.fromEntries(jobs.map((j) => [j.job, j]));
  assert.match(by.mac.skip, /runs on macos-latest/);
  assert.match(by.reuse.skip, /calls another workflow/);
  assert.match(by.after.skip, /the job it needs, mac,/);
  assert.match(by.cond.skip, /condition/);
  assert.match(by.expr.skip, /expression/);
  assert.ok(by.ok.check);
});

test('a matrix becomes one check per combination, with exclude and include', () => {
  const m = expandMatrix({ php: ['8.1', '8.2'], wp: [6.5], exclude: [{ php: '8.1' }], include: [{ php: '8.2', extra: 'x' }, { php: '7.4', wp: '6.0' }] });
  assert.deepEqual(m.cells, [{ php: '8.2', wp: 6.5 }, { php: '7.4', wp: '6.0' }]);
  assert.deepEqual(expandMatrix(undefined).cells, [{}]);
  assert.deepEqual(expandMatrix({ include: [{ a: 1 }] }).cells, [{ a: 1 }]);
  assert.match(expandMatrix({ on: [true] }).error, /not plain/);
  const jobs = jobsOf('.github/workflows/ci.yml', { on: 'pull_request', jobs: { t: ubuntu({ strategy: { matrix: { php: ['8.2', '8.3'] } } }) } });
  assert.deepEqual(jobs.map((j) => j.check.sandbox_ci.matrix), [{ php: '8.2' }, { php: '8.3' }]);
  assert.deepEqual(jobs.map((j) => j.label), [': t (8.2)', ': t (8.3)'].map((x) => 'ci.yml' + x));
});

test('reads YAML, with `on` kept as a key', { skip: hasYaml ? false : 'needs python3 with PyYAML' }, () => {
  const [w] = parseWorkflows([{ path: '.github/workflows/ci.yml', text: 'on: [pull_request]\njobs:\n  a:\n    runs-on: ubuntu-latest\n' }]);
  assert.deepEqual(w.doc.on, ['pull_request']);
  const [bad] = parseWorkflows([{ path: 'x.yml', text: 'a: [' }]);
  assert.ok(bad.error && !bad.doc);
});

// A CI line with stand-ins: workflows come as JSON, jobs finish when the test says.
function line({ workflows = {}, changesCi = false, parallel = 2, paused = { v: false }, covered = [], dir = fs.mkdtempSync(path.join(tmp, 'ci-')) } = {}) {
  const clock = { t: 1000 };
  const started = [];
  const ci = createCi({
    dir, parallel: () => parallel, isPaused: () => paused.v, now: () => clock.t, coveredBy: () => covered,
    scrub: (t) => String(t).replace(/s3cret/g, '[secret removed]'),
    parse: (files) => files.map((f) => ({ path: f.path, doc: JSON.parse(f.text) })),
    prepare: async () => ({ gitDir: '/bare', workflows: Object.entries(workflows).map(([p, d]) => ({ path: p, text: JSON.stringify(d) })), changesCi }),
    runJob: (check, gitDir, sha, { onStart }) => new Promise((resolve) => { onStart(999999999); started.push({ check, gitDir, sha, resolve }); }),
  });
  return { ci, clock, started, dir, paused };
}
const settle = () => new Promise((r) => setTimeout(r, 20));
const three = { '.github/workflows/ci.yml': { on: 'pull_request', jobs: { a: ubuntu(), b: ubuntu(), c: ubuntu() } } };

test('jobs from every pull request share the line, at most `parallel` at once, the rest queued', async () => {
  const l = line({ workflows: three, parallel: 2 });
  l.ci.ensure('o/r', 1, SHA);
  l.ci.ensure('o/r', 2, 'b'.repeat(40));
  await settle();
  assert.equal(l.started.length, 2);
  assert.equal(l.ci.running(), 2);
  assert.equal(l.ci.queued(), 4);
  const v = l.ci.view(l.ci.get('o/r', 1, SHA));
  assert.deepEqual(v.jobs.map((j) => j.status), ['running', 'running', 'queued']);
  assert.equal(v.jobs[2].place, 1);
  assert.deepEqual(l.started[0], { ...l.started[0], gitDir: '/bare', sha: SHA });
  l.started[0].resolve({ status: 0, out: '1 of 1 passed', log: 'all good s3cret' });
  await settle();
  assert.equal(l.started.length, 3, 'a free slot takes the next job');
  const done = l.ci.view(l.ci.get('o/r', 1, SHA)).jobs[0];
  assert.equal(done.status, 'passed');
  assert.equal(l.ci.readLog(l.ci.get('o/r', 1, SHA).key, 0), 'all good [secret removed]');
  assert.equal(summaryOf(l.ci.get('o/r', 1, SHA)).state, 'running');
});

test('a busy server puts the job back in the line and tries it a minute later', async () => {
  const l = line({ workflows: { '.github/workflows/ci.yml': { on: 'pull_request', jobs: { a: ubuntu() } } }, parallel: 1 });
  l.ci.ensure('o/r', 1, SHA);
  await settle();
  l.started[0].resolve({ notRun: 'not run: all 2 Sandbox CI slots on this server are in use; try again later' });
  await settle();
  let j = l.ci.view(l.ci.get('o/r', 1, SHA)).jobs[0];
  assert.equal(j.status, 'queued');
  assert.match(j.waitReason, /slots/);
  l.ci.tick();
  await settle();
  assert.equal(l.started.length, 1, 'not before the minute');
  l.clock.t += 61 * 1000;
  l.ci.tick();
  await settle();
  assert.equal(l.started.length, 2);
  l.started[1].resolve({ status: 1, out: '## a (exit 1)\nboom' });
  await settle();
  j = l.ci.view(l.ci.get('o/r', 1, SHA)).jobs[0];
  assert.equal(j.status, 'failed');
  assert.equal(j.attempts, 2);
  assert.equal(summaryOf(l.ci.get('o/r', 1, SHA)).state, 'failed');
});

test('paused: nothing new starts; resuming takes the line as it was', async () => {
  const l = line({ workflows: three, parallel: 3, paused: { v: true } });
  l.ci.ensure('o/r', 1, SHA);
  await settle();
  assert.equal(l.started.length, 0);
  assert.equal(l.ci.queued(), 3);
  l.paused.v = false;
  l.ci.tick();
  await settle();
  assert.equal(l.started.length, 3);
});

test('no workflows: "none"; a pull request that edits .github: not run; a fast check already covers a job', async () => {
  const a = line({});
  a.ci.ensure('o/r', 1, SHA); await settle();
  assert.equal(a.ci.get('o/r', 1, SHA).state, 'none');
  const b = line({ workflows: three, changesCi: true });
  b.ci.ensure('o/r', 1, SHA); await settle();
  assert.equal(b.ci.get('o/r', 1, SHA).state, 'not_run');
  assert.match(b.ci.get('o/r', 1, SHA).reason, /\.github/);
  assert.equal(b.started.length, 0);
  const c = line({ workflows: three, covered: [{ label: 'Unit', sandbox_ci: { workflow: '.github/workflows/ci.yml', job: 'b' } }] });
  c.ci.ensure('o/r', 1, SHA); await settle();
  const jb = c.ci.view(c.ci.get('o/r', 1, SHA)).jobs[1];
  assert.equal(jb.status, 'skipped');
  assert.match(jb.reason, /"Unit"/);
});

test('one commit is lined up once; again runs it anew; a new process puts a running job back in the line', async () => {
  const l = line({ workflows: { '.github/workflows/ci.yml': { on: 'pull_request', jobs: { a: ubuntu() } } } });
  const first = l.ci.ensure('o/r', 1, SHA);
  assert.equal(l.ci.ensure('o/r', 1, SHA), first);
  await settle();
  assert.equal(l.started.length, 1);
  assert.equal(l.ci.ensure('o/r', 1, SHA, { again: true }), first, 'not while a job of it runs');
  // The dashboard restarts with the job still marked running.
  const again = line({ dir: l.dir, parallel: 0 });
  const j = again.ci.view(again.ci.get('o/r', 1, SHA)).jobs[0];
  assert.equal(j.status, 'queued');
  assert.match(j.waitReason, /restarted/);
  l.started[0].resolve({ status: 0, out: 'ok' });
  await settle();
  const redo = l.ci.ensure('o/r', 1, SHA, { again: true });
  assert.notEqual(redo, first);
  await settle();
  assert.equal(l.started.length, 2);
});

test('a commit\'s CI older than 30 days goes when the line is read again', async () => {
  const l = line({ workflows: { '.github/workflows/ci.yml': { on: 'pull_request', jobs: { a: ubuntu() } } } });
  l.ci.ensure('o/r', 1, SHA); await settle();
  l.started[0].resolve({ status: 0, out: 'ok', log: 'ok' }); await settle();
  const later = line({ dir: l.dir });
  assert.ok(later.ci.get('o/r', 1, SHA), 'kept while recent');
  const rec = JSON.parse(fs.readFileSync(path.join(l.dir, `r-1-${SHA.slice(0, 12)}.json`), 'utf8'));
  fs.writeFileSync(path.join(l.dir, `r-1-${SHA.slice(0, 12)}.json`), JSON.stringify({ ...rec, at: 1000 - 31 * 24 * 3600 * 1000 }));
  const old = line({ dir: l.dir });
  assert.equal(old.ci.get('o/r', 1, SHA), null);
  assert.equal(fs.existsSync(path.join(l.dir, `r-1-${SHA.slice(0, 12)}`)), false);
});

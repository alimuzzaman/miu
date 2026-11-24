import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { jobsOf, expandMatrix, parseWorkflows, createCi, summaryOf, triggerOf, filterMatch, prCiProblem, releaseProblem, ciRunCommit } from '../lib/ci.mjs';

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
  assert.equal(jobsOf('.github/workflows/a.yml', { on: 'push', jobs: { a: ubuntu() } })[0].check.sandbox_ci.event, 'push');
  assert.match(jobsOf('.github/workflows/a.yml', { on: { push: { branches: ['main'] } }, jobs: { a: ubuntu() } })[0].skip, /certain branches or tags/);
  assert.match(jobsOf('.github/workflows/t.yml', { on: { push: { tags: ['*'] } }, jobs: { a: ubuntu() } })[0].skip, /tag pushes, as a release does/);
  assert.deepEqual(jobsOf('.github/workflows/r.yml', { on: { release: {} }, jobs: { a: ubuntu() } }), []);
  assert.deepEqual(jobsOf('.github/workflows/s.yml', { on: 'schedule', jobs: { a: ubuntu() } }), []);
});

test('what the worker refuses is listed with the reason, not run', () => {
  const jobs = jobsOf('.github/workflows/ci.yml', { on: 'pull_request', jobs: {
    mac: { 'runs-on': 'macos-latest' },
    after: ubuntu({ needs: 'mac' }),
    cond: ubuntu({ needs: 'ok', if: 'always()' }),
    ok: ubuntu(),
    expr: ubuntu({ strategy: { matrix: '${{ fromJson(x) }}' } }),
  } });
  const by = Object.fromEntries(jobs.map((j) => [j.job, j]));
  assert.match(by.mac.skip, /runs on macos-latest/);
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
  assert.deepEqual(expandMatrix({ include: [{ php: '7.4', wp: '5.9' }, { php: '8.2', wp: 'latest' }] }).cells, [{ php: '7.4', wp: '5.9' }, { php: '8.2', wp: 'latest' }], 'every include-only row is a run');
  assert.deepEqual(expandMatrix({ php: ['7.4'], include: [{ php: '8.2', wp: '6.4' }, { php: '8.2', wp: '6.5' }] }).cells, [{ php: '7.4' }, { php: '8.2', wp: '6.4' }, { php: '8.2', wp: '6.5' }], 'include rows are not matched against each other');
  assert.match(expandMatrix({ on: [true] }).error, /not plain/);
  const jobs = jobsOf('.github/workflows/ci.yml', { on: 'pull_request', jobs: { t: ubuntu({ strategy: { matrix: { php: ['8.2', '8.3'] } } }) } });
  assert.deepEqual(jobs.map((j) => j.check.sandbox_ci.matrix), [{ php: '8.2' }, { php: '8.3' }]);
  assert.deepEqual(jobs.map((j) => j.label), [': t (8.2)', ': t (8.3)'].map((x) => 'ci.yml' + x));
});

test('reads YAML, with `on` kept as a key', { skip: hasYaml ? false : 'needs python3 with PyYAML' }, async () => {
  const [w] = await parseWorkflows([{ path: '.github/workflows/ci.yml', text: 'on: [pull_request]\njobs:\n  a:\n    runs-on: ubuntu-latest\n    strategy:\n      matrix:\n        php: [8.0, 8.1, "8.2"]\n' }]);
  assert.deepEqual(w.doc.on, ['pull_request']);
  assert.deepEqual(w.doc.jobs.a.strategy.matrix.php, [{ wholeFloat: '8.0' }, '8.1', '8.2'], 'a whole float is marked; others keep their text');
  const [bad] = await parseWorkflows([{ path: 'x.yml', text: 'a: [' }]);
  assert.ok(bad.error && !bad.doc);
});

// A CI line with stand-ins: workflows come as JSON, jobs finish when the test says.
function line({ workflows = {}, parallel = 2, paused = { v: false }, covered = [], prCi, runSha, changed, dir = fs.mkdtempSync(path.join(tmp, 'ci-')) } = {}) {
  const clock = { t: 1000 };
  const started = [];
  const ci = createCi({
    dir, parallel: () => parallel, isPaused: () => paused.v, now: () => clock.t, coveredBy: () => covered, prCiFor: () => prCi,
    scrub: (t) => String(t).replace(/s3cret/g, '[secret removed]'),
    parse: (files) => files.map((f) => ({ path: f.path, doc: JSON.parse(f.text) })),
    prepare: async () => ({ gitDir: '/bare', runSha, workflowsFrom: 'dev@1234567', base: 'dev', changed, workflows: Object.entries(workflows).map(([p, d]) => ({ path: p, text: JSON.stringify(d) })) }),
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

test('no workflows: "none"; a fast check already covers a job', async () => {
  const a = line({});
  a.ci.ensure('o/r', 1, SHA); await settle();
  assert.equal(a.ci.get('o/r', 1, SHA).state, 'none');
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

test('a pull_request trigger\'s filters decide, as on GitHub', () => {
  assert.deepEqual(triggerOf({ pull_request: { types: ['closed'] } }), { skip: 'it runs on pull requests only when closed', kind: 'trigger' });
  assert.deepEqual(triggerOf({ pull_request: { types: ['opened', 'labeled'] } }), { event: 'pull_request' });
  assert.match(triggerOf({ pull_request: { branches: ['main'] } }, { base: 'dev' }).skip, /into main, not dev/);
  assert.deepEqual(triggerOf({ pull_request: { branches: ['release/**', 'dev'] } }, { base: 'release/2.1' }), { event: 'pull_request' });
  assert.match(triggerOf({ pull_request: { 'branches-ignore': ['dev'] } }, { base: 'dev' }).skip, /branches-ignore/);
  assert.match(triggerOf({ pull_request: { paths: ['src/**'] } }, { changed: ['docs/a.md'] }).skip, /paths/);
  assert.deepEqual(triggerOf({ pull_request: { paths: ['src/**', '!src/vendor/**'] } }, { changed: ['src/a/b.php'] }), { event: 'pull_request' });
  assert.match(triggerOf({ pull_request: { 'paths-ignore': ['**.md'] } }, { changed: ['README.md', 'docs/x.md'] }).skip, /paths-ignore/);
  assert.deepEqual(triggerOf({ pull_request: { paths: ['src/**'] } }, {}), { event: 'pull_request' }, 'changed files unknown: no path filter');
  assert.equal(triggerOf({ workflow_dispatch: {} }), null);
  assert.equal(filterMatch(['*.php'], 'a/b.php'), false);
  assert.equal(filterMatch(['**.php'], 'a/b.php'), true);
});

test('what the worker refuses for a whole file is not lined up at all', () => {
  const jobs = jobsOf('.github/workflows/ci.yml', { on: 'pull_request', jobs: { a: ubuntu(), r: { uses: './.github/workflows/x.yml' } } });
  assert.ok(jobs.every((j) => j.skip && /refuses this workflow: job r calls another workflow/.test(j.skip)));
  const svc = jobsOf('.github/workflows/ci.yml', { on: 'pull_request', jobs: { a: ubuntu({ services: { db: { image: 'mysql', options: '--privileged' } } }) } });
  assert.match(svc[0].skip, /option --privileged/);
  const ok = jobsOf('.github/workflows/ci.yml', { on: 'pull_request', jobs: { a: ubuntu({ services: { db: { image: 'mysql', options: '--health-cmd "mysqladmin ping"' } } }) } });
  assert.ok(ok[0].check);
});

test('a job another job needs runs as part of it, not on its own', () => {
  const jobs = jobsOf('.github/workflows/ci.yml', { on: 'pull_request', jobs: { build: ubuntu(), test: ubuntu({ needs: 'build' }), e2e: ubuntu({ needs: ['test'] }) } });
  const by = Object.fromEntries(jobs.map((j) => [j.job, j]));
  assert.ok(by.e2e.check);
  assert.match(by.build.skip, /part of e2e/);
  assert.match(by.test.skip, /part of e2e/);
});

test('a fork\'s pull request gets no CI here; a job its condition left out is not counted as not run', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'ci-'));
  const ci = createCi({ dir, prepare: async () => ({ fork: true }), runJob: () => { throw new Error('ran'); }, parse: () => [] });
  ci.ensure('o/r', 1, SHA); await settle();
  assert.equal(ci.get('o/r', 1, SHA).state, 'not_run');
  assert.match(ci.get('o/r', 1, SHA).reason, /fork/);
  const l = line({ workflows: { '.github/workflows/ci.yml': { on: 'pull_request', jobs: { a: ubuntu({ if: "github.event_name == 'push'" }) } } } });
  l.ci.ensure('o/r', 1, SHA); await settle();
  l.started[0].resolve({ notRun: 'a: act reported success, but no job ran' }); await settle();
  assert.equal(l.ci.view(l.ci.get('o/r', 1, SHA)).jobs[0].status, 'skipped');
  assert.equal(summaryOf(l.ci.get('o/r', 1, SHA)).state, 'no_jobs');
});

test('the busy limit counts from the first busy answer, not from the time in the line', async () => {
  const l = line({ workflows: { '.github/workflows/ci.yml': { on: 'pull_request', jobs: { a: ubuntu() } } }, parallel: 1 });
  l.ci.ensure('o/r', 1, SHA); await settle();
  l.clock.t += 3 * 3600 * 1000; // waited three hours in Miu's own line
  l.started[0].resolve({ notRun: 'not run: this server is busy (1.0 GB memory and 0.5 CPUs free); try again later' }); await settle();
  assert.equal(l.ci.view(l.ci.get('o/r', 1, SHA)).jobs[0].status, 'queued');
});

test('filter patterns follow GitHub: **/ matches no folder too, ? and + work on the character before', () => {
  assert.equal(filterMatch(['**/README.md'], 'README.md'), true);
  assert.equal(filterMatch(['docs/**/*.md'], 'docs/README.md'), true);
  assert.equal(filterMatch(['**/docs/**'], 'docs/hello.md'), true);
  assert.equal(filterMatch(['**/*.php'], 'plugin.php'), true);
  assert.equal(filterMatch(['*.jsx?'], 'page.js'), true);
  assert.equal(filterMatch(['*.jsx?'], 'page.jsx'), true);
  assert.equal(filterMatch(['*.jsx?'], 'page.ts'), false);
  assert.equal(filterMatch(['v[12].*'], 'v2.x'), true);
  assert.equal(filterMatch(['src/[unclosed'], 'anything'), true, 'a pattern Miu cannot read lets the workflow run');
});

test('an include row with none of the matrix names joins every combination; a whole float is not run here', () => {
  assert.deepEqual(expandMatrix({ php: ['7.4', '8.2'], include: [{ coverage: 'none' }] }).cells, [{ php: '7.4' }, { php: '8.2' }]);
  assert.match(expandMatrix({ php: ['7.4', { wholeFloat: '8.0' }] }).error, /8\.0 unquoted.*write "8\.0"/);
});

test('service options split like a shell; a workflow on both pull_request and push runs if either would', () => {
  const ok = jobsOf('.github/workflows/ci.yml', { on: 'pull_request', jobs: { a: ubuntu({ services: { db: { image: 'mysql', options: '--health-cmd "mysqladmin ping -h localhost" --health-interval 10s' } } }) } });
  assert.ok(ok[0].check, ok[0].skip);
  assert.deepEqual(triggerOf({ pull_request: { branches: ['main'] }, push: {} }, { base: 'dev' }), { event: 'push' });
  assert.match(triggerOf({ pull_request: { branches: ['main'] }, push: { branches: ['main'] } }, { base: 'dev' }).skip, /into main, not dev/);
});

test('act running nothing is "not run" unless the job has its own condition', async () => {
  const l = line({ workflows: { '.github/workflows/ci.yml': { on: 'pull_request', jobs: { a: ubuntu() } } } });
  l.ci.ensure('o/r', 1, SHA); await settle();
  l.started[0].resolve({ notRun: 'a: act reported success, but no job ran' }); await settle();
  assert.equal(l.ci.view(l.ci.get('o/r', 1, SHA)).jobs[0].status, 'not_run');
});

// A repo like xspeed: its tests run by hand or from a release, never on pull requests.
const manualCi = {
  on: { workflow_dispatch: { inputs: { jobs: { default: 'all', type: 'choice', options: ['all', 'php', 'js'] } } }, workflow_call: {} },
  jobs: {
    php: { 'runs-on': 'ubuntu-22.04', if: "${{ inputs.jobs == '' || inputs.jobs == 'all' }}", container: { image: 'php:${{ matrix.php }}-cli' }, strategy: { matrix: { php: ['7.4', '8.1', '8.3', '8.5'] } }, steps: [{ run: 'vendor/bin/phpunit' }] },
    js: ubuntu({ if: "${{ inputs.jobs != 'php' }}" }),
    notify: { 'runs-on': 'ubuntu-latest', needs: ['php', 'js'], if: 'always()', steps: [{ name: 'Slack', run: 'curl -sS -X POST -H "Content-Type: application/json" --data @p.json "$SLACK_WEBHOOK_URL"' }] },
  },
};
const deployOnly = {
  '.github/workflows/deploy.yml': { on: { push: { tags: ['*'] } }, jobs: { a: ubuntu() } },
  '.github/workflows/close-issues-on-dev-merge.yml': { on: { pull_request: { types: ['closed'] } }, jobs: { a: ubuntu() } },
};

test('a listed workflow runs with workflow_dispatch, only its listed jobs and matrix values', () => {
  const jobs = jobsOf('.github/workflows/ci.yml', manualCi, { listed: { workflow: '.github/workflows/ci.yml', jobs: ['php', 'js', 'lint'], matrix: { php: ['7.4', '8.5'] } } });
  assert.deepEqual(jobs.map((j) => j.label), ['ci.yml: php (7.4)', 'ci.yml: php (8.5)', 'ci.yml: js', 'ci.yml: lint']);
  assert.ok(jobs.slice(0, 3).every((j) => j.check.sandbox_ci.event === 'workflow_dispatch'));
  assert.match(jobs[3].skip, /lists this job, but the workflow has none/);
  assert.equal(jobs.find((j) => j.job === 'notify'), undefined, 'a job not listed is not shown');
  assert.deepEqual(jobsOf('.github/workflows/ci.yml', manualCi), [], 'without a list, a manual-only workflow is not CI for a pull request');
  assert.match(jobsOf('.github/workflows/g.yml', { on: { workflow_call: {} }, jobs: { a: ubuntu() } }, { listed: { workflow: '.github/workflows/g.yml' } })[0].skip, /another workflow calls it/);
  assert.match(jobsOf('.github/workflows/ci.yml', manualCi, { listed: { workflow: '.github/workflows/ci.yml', jobs: ['php'], matrix: { php: ['5.6'] } } })[0].skip, /none of its matrix values/);
});

test('Miu runs tests only: deploy, release, notify and write jobs are refused, even when listed', () => {
  const all = jobsOf('.github/workflows/ci.yml', manualCi, { listed: { workflow: '.github/workflows/ci.yml' } });
  assert.match(all.find((j) => j.job === 'notify').skip, /tests only, and (its name says|a step posts)/);
  for (const f of ['deploy.yml', 'website-sync.yml', 'close-issues-on-dev-merge.yml', 'pr-summary.yml', 'slack-release.yml', 'announce-release.yml', 'release-tag.yml']) {
    const j = jobsOf(`.github/workflows/${f}`, { on: { workflow_dispatch: {} }, jobs: { a: ubuntu() } }, { listed: { workflow: `.github/workflows/${f}` } });
    assert.match(j[0].skip, /release, deploy or notification/, f);
  }
  assert.match(releaseProblem('.github/workflows/x.yml', { on: { pull_request_target: {} } }), /automation/);
  const refused = (job) => jobsOf('.github/workflows/ci.yml', { on: 'pull_request', jobs: { a: ubuntu(job) } })[0].skip;
  assert.match(refused({ permissions: { contents: 'read', 'pull-requests': 'write' } }), /write access/);
  assert.match(refused({ environment: 'production' }), /environment/);
  assert.match(refused({ steps: [{ uses: 'marocchino/sticky-pull-request-comment@v2' }] }), /uses marocchino/);
  assert.match(refused({ steps: [{ run: 'git push origin HEAD' }] }), /pushes/);
  assert.match(refused({ steps: [{ run: 'gh pr comment 1 --body x' }] }), /posts/);
  assert.equal(refused({ steps: [{ uses: 'actions/upload-artifact@v4' }, { run: 'curl -fsSL https://example.org/x.sh -o x.sh' }] }), undefined, 'a download or an artifact is fine');
  const needs = jobsOf('.github/workflows/ci.yml', { on: 'pull_request', jobs: { up: ubuntu({ environment: 'dev' }), t: ubuntu({ needs: 'up' }) } });
  assert.match(needs.find((j) => j.job === 't').skip, /the job it needs, up, posts, pushes or deploys/);
});

test('a profile\'s pr_ci is checked when it is saved', () => {
  assert.equal(prCiProblem(undefined), null);
  assert.equal(prCiProblem([{ workflow: '.github/workflows/ci.yml', jobs: ['php', 'js'], matrix: { php: ['7.4', 8.3] } }]), null);
  assert.match(prCiProblem({}), /must be a list/);
  assert.match(prCiProblem([{ workflow: '../x.yml' }]), /directly in .github\/workflows/);
  assert.match(prCiProblem([{ workflow: '.github/workflows/a/b.yml' }]), /directly in/);
  assert.match(prCiProblem([{ workflow: '.github/workflows/ci.yml', jobs: 'php' }]), /list of job ids/);
  assert.match(prCiProblem([{ workflow: '.github/workflows/ci.yml', matrix: { php: '8.3' } }]), /plain values/);
});

test('with pr_ci, only the listed workflows run, on Miu\'s run commit; only release or deploy workflows: "No PR CI"', async () => {
  const RUN = 'c'.repeat(40);
  const l = line({ workflows: { '.github/workflows/ci.yml': manualCi, ...deployOnly }, prCi: [{ workflow: '.github/workflows/ci.yml', jobs: ['php', 'js'], matrix: { php: ['8.3'] } }, { workflow: '.github/workflows/gone.yml' }], runSha: RUN });
  l.ci.ensure('o/r', 1, SHA); await settle();
  const v = l.ci.view(l.ci.get('o/r', 1, SHA));
  assert.equal(v.workflowsFrom, 'dev@1234567');
  assert.equal(v.listed, true);
  assert.deepEqual(v.jobs.map((j) => [j.label, j.status]), [['ci.yml: php (8.3)', 'running'], ['ci.yml: js', 'running'], ['gone.yml', 'skipped']]);
  assert.match(v.jobs[2].reason, /dev@1234567 has no such workflow/);
  assert.deepEqual(l.started.map((s) => s.sha), [RUN, RUN], 'the worker gets the commit with the base branch\'s .github');

  const d = line({ workflows: deployOnly });
  d.ci.ensure('o/r', 1, SHA); await settle();
  assert.equal(d.ci.get('o/r', 1, SHA).state, 'none');
  assert.match(d.ci.get('o/r', 1, SHA).reason, /No workflow here runs for pull requests/);
  const dl = line({ workflows: deployOnly, prCi: [{ workflow: '.github/workflows/deploy.yml' }] });
  dl.ci.ensure('o/r', 1, SHA); await settle();
  assert.equal(dl.ci.get('o/r', 1, SHA).state, 'not_run', 'a listed deploy is refused, and says why');
  assert.match(dl.ci.get('o/r', 1, SHA).reason, /Miu never runs/);
  assert.equal(dl.started.length, 0);
});

test('a commit read under older rules is read again', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'ci-'));
  const old = line({ workflows: deployOnly, dir });
  old.ci.ensure('o/r', 1, SHA); await settle();
  const file = fs.readdirSync(dir).find((f) => f.endsWith('.json'));
  const rec = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  delete rec.rules;
  Object.assign(rec, { state: 'ready', jobs: [] });
  fs.writeFileSync(path.join(dir, file), JSON.stringify(rec));
  const now = line({ workflows: { '.github/workflows/ci.yml': manualCi }, prCi: [{ workflow: '.github/workflows/ci.yml', jobs: ['js'] }], dir });
  now.ci.ensure('o/r', 1, SHA); await settle();
  assert.equal(now.started.length, 1);
  assert.equal(now.ci.get('o/r', 1, SHA).rules, 7);
});

test('the run commit is the pull request\'s own tree, its .github and act\'s files included', async () => {
  const repo = fs.mkdtempSync(path.join(tmp, 'git-'));
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const g = (...a) => { const r = spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8', env }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  const put = (f, t) => { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), t); };
  g('init', '-q', '-b', 'dev');
  put('.github/workflows/ci.yml', 'trusted'); put('.actrc', '-P x'); put('src/a.php', 'old');
  g('add', '-A'); g('commit', '-qm', 'base');
  g('checkout', '-qb', 'pr');
  put('.github/workflows/ci.yml', 'evil'); put('.github/workflows/extra.yml', 'evil'); fs.rmSync(path.join(repo, '.actrc')); put('src/a.php', 'new'); put('b space.txt', 'x');
  put('.input', 'jobs=js'); put('.vars', 'X=1'); put('.secrets', 'S=1'); put('.env', 'E=1'); put('.gitattributes', '.github/** export-ignore');
  g('add', '-A'); g('commit', '-qm', 'pr');
  const sha = g('rev-parse', 'HEAD');
  const git = (args, e, input) => new Promise((resolve, reject) => {
    const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', input, env: { ...process.env, ...(e ?? {}) } });
    r.status ? reject(new Error(r.stderr)) : resolve(r.stdout.trim());
  });
  const run = await ciRunCommit(git, sha, 'm');
  assert.equal(await ciRunCommit(git, sha, 'm'), run, 'the same commit each time');
  assert.equal(g('rev-parse', `${run}^{tree}`), g('rev-parse', `${sha}^{tree}`), 'nothing of the base branch is put over it');
  assert.equal(g('show', `${run}:.github/workflows/ci.yml`), 'evil');
  assert.equal(g('ls-tree', '--name-only', `${run}:.github/workflows`), 'ci.yml\nextra.yml');
  assert.equal(g('show', `${run}:src/a.php`), 'new');
  assert.equal(g('rev-parse', `${run}^`), sha);
  // The worker drops .actrc and links among these; plain files are the pull request's own values.
  assert.equal(g('ls-tree', '--name-only', run).split('\n').filter((f) => f.startsWith('.')).join(' '), '.env .gitattributes .github .input .secrets .vars');
});

test('a record lined up under older rules starts nothing after a restart, and is read again when asked', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'ci-'));
  const key = `r-1-${SHA.slice(0, 12)}`;
  fs.writeFileSync(path.join(dir, `${key}.json`), JSON.stringify({ key, repo: 'o/r', pr: 1, sha: SHA, at: 1000, state: 'ready', jobs: [{ n: 0, label: 'pr-summary', status: 'queued', check: { label: 'x', sandbox_ci: { workflow: '.github/workflows/pr-summary.yml', job: 'a' } } }] }));
  const l = line({ workflows: { '.github/workflows/ci.yml': manualCi }, prCi: [{ workflow: '.github/workflows/ci.yml', jobs: ['js'] }], dir });
  l.ci.tick(); await settle();
  assert.equal(l.started.length, 0, 'the old queued job does not run');
  assert.equal(l.ci.get('o/r', 1, SHA).state, 'not_run');
  l.ci.ensure('o/r', 1, SHA); await settle();
  assert.deepEqual(l.started.map((x) => x.check.sandbox_ci.job), ['js']);
});

test('records of rules 2, or read with another pr_ci, are read again', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'ci-'));
  const key = `r-1-${SHA.slice(0, 12)}`;
  fs.writeFileSync(path.join(dir, `${key}.json`), JSON.stringify({ key, repo: 'o/r', pr: 1, sha: SHA, at: 1000, rules: 2, state: 'ready', jobs: [{ n: 0, label: 'x', status: 'queued', check: { label: 'x', sandbox_ci: { workflow: '.github/workflows/x.yml', job: 'a' } } }] }));
  const l = line({ workflows: { '.github/workflows/ci.yml': manualCi }, prCi: [{ workflow: '.github/workflows/ci.yml', jobs: ['js'] }], dir });
  l.ci.tick(); await settle();
  assert.equal(l.started.length, 0);
  const list = { v: [{ workflow: '.github/workflows/ci.yml', jobs: ['js'] }] };
  const dir2 = fs.mkdtempSync(path.join(tmp, 'ci-'));
  const started = [];
  const ci = createCi({ dir: dir2, prCiFor: () => list.v, now: () => 1000, parse: (fs2) => fs2.map((f) => ({ path: f.path, doc: JSON.parse(f.text) })),
    prepare: async () => ({ gitDir: '/bare', workflows: [{ path: '.github/workflows/ci.yml', text: JSON.stringify(manualCi) }] }),
    runJob: (check) => new Promise((resolve) => { started.push(check.sandbox_ci.job); resolve({ status: 0, out: '' }); }) });
  ci.ensure('o/r', 1, SHA); await settle();
  assert.equal(ci.ensure('o/r', 1, SHA), ci.get('o/r', 1, SHA), 'the same list: not read again');
  list.v = [{ workflow: '.github/workflows/ci.yml', jobs: ['php'], matrix: { php: ['8.3'] } }];
  ci.ensure('o/r', 1, SHA); await settle();
  assert.deepEqual(started, ['js', 'php']);
});

test('path and branch filters are not "No PR CI"; a listed push-to-branch deploy is not run; pr_ci [] or invalid', async () => {
  const f = line({ changed: ['docs/a.md'], workflows: { '.github/workflows/ci.yml': { on: { pull_request: { paths: ['src/**'] } }, jobs: { a: ubuntu() } } } });
  f.ci.ensure('o/r', 1, SHA); await settle();
  assert.notEqual(f.ci.get('o/r', 1, SHA).state, 'none');
  assert.equal(summaryOf(f.ci.get('o/r', 1, SHA)).state, 'no_jobs');
  assert.match(jobsOf('.github/workflows/b.yml', { on: { push: { branches: ['main'] }, workflow_dispatch: {} }, jobs: { a: ubuntu() } }, { listed: { workflow: '.github/workflows/b.yml' } })[0].skip, /pushes to certain branches or tags, as a release or deploy/);
  assert.match(jobsOf('.github/workflows/s.yml', { on: { schedule: [{ cron: '0 0 * * *' }] }, jobs: { a: ubuntu() } }, { listed: { workflow: '.github/workflows/s.yml' } })[0].skip, /only on schedule/);
  const e = line({ workflows: three, prCi: [] });
  e.ci.ensure('o/r', 1, SHA); await settle();
  assert.match(e.ci.get('o/r', 1, SHA).reason, /pr_ci is empty/);
  const bad = line({ workflows: three, prCi: { workflow: 'x' } });
  bad.ci.ensure('o/r', 1, SHA); await settle();
  assert.match(bad.ci.get('o/r', 1, SHA).reason, /pr_ci is not valid/);
  assert.equal(bad.ci.get('o/r', 1, SHA).transient, undefined);
});

test('more ways a job posts, publishes or deploys are refused', () => {
  const refused = (job, doc = {}) => jobsOf('.github/workflows/ci.yml', { on: 'pull_request', ...doc, jobs: { t: ubuntu(job) } })[0].skip;
  assert.match(refused({ steps: [{ run: 'curl -sS \\\n  -d @p.json "$HOOK"' }] }), /posts/);
  for (const run of ['curl --request POST "$U"', 'curl -d@f "$U"', 'curl -T f "$U"', 'curl --json @f "$U"', 'wget --post-data=x "$U"', 'npm run deploy', 'npx semantic-release', 'pnpm publish', 'docker push x', 'aws s3 sync . s3://b', 'wrangler deploy', 'kubectl apply -f k.yml']) assert.match(refused({ steps: [{ run }] }) ?? '', /posts/, run);
  assert.match(refused({ steps: [{ uses: 'codecov/codecov-action@v4' }] }), /codecov/);
  assert.match(refused({}, { permissions: { contents: 'write' } }), /write access/);
  assert.match(jobsOf('.github/workflows/ci.yml', { on: 'pull_request', jobs: { deploy: ubuntu() } })[0].skip, /name says/);
  assert.match(refused({ steps: [{ uses: 'stefanzweifel/git-auto-commit-action@v5' }] }), /auto-commit/);
  // The owner's list (2026-11-18): a job named for a release is not run, even a test of one.
  const runs = (id, job) => jobsOf('.github/workflows/ci.yml', { on: 'pull_request', jobs: { [id]: ubuntu(job) } })[0].check;
  assert.equal(runs('site', { name: 'Website + release notes', steps: [{ run: 'npm ci && npm test' }] }), undefined);
  assert.equal(runs('release_check', { steps: [{ run: 'npm test' }] }), undefined);
  // Steps that only sound like it still run.
  assert.ok(runs('unit', { steps: [{ name: 'Test release service in Chromium', run: 'npm test' }, { name: 'Comment out xdebug', run: 'sed -i s/^z/;z/ x.ini' }, { name: 'Verify Core Comment Disabling Functionality', run: 'wp eval-file t.php' }] }));
  for (const run of ['wrangler deploy --dry-run', 'curl -f -sSL https://getcomposer.org/installer | php', 'curl -D - https://x/y', 'wget -T 30 -t 3 https://x/y', 'docker compose up -d', 'cargo build --release']) assert.ok(runs('t', { steps: [{ run }] }), run);
  assert.equal(refused({ steps: [{ run: 'curl -fsSL https://x/y -o y && npm ci && npm test -- --json' }] }), undefined, 'a download and a test run are fine');
});

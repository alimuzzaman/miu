// CI for every pull request of a paired run (Free, Pro, Hub), the CI section
// of the result comment, the job's failing tests, node for container jobs,
// and the owner's rule that Miu never runs a deploy (2026-11-18).
// Namespace and dynamic imports, so that each test fails on its own where a
// piece is missing rather than the whole file.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as ci from '../lib/ci.mjs';
import * as sandboxci from '../lib/sandboxci.mjs';

const WORKER = fileURLToPath(new URL('../bin/miu-sandbox-ci', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'miu-ci-linked-'));
const hasYaml = spawnSync('python3', ['-c', 'import yaml']).status === 0;
const needsYaml = { skip: hasYaml ? false : 'needs python3 with PyYAML' };
const SHA = 'a'.repeat(40);
const settle = () => new Promise((r) => setTimeout(r, 30));
const ubuntu = (extra = {}) => ({ 'runs-on': 'ubuntu-latest', steps: [{ run: 'npm test' }], ...extra });
const cicomment = () => import('../lib/cicomment.mjs').catch(() => ({}));

// ---- the line, with stand-ins for git and the worker (as in ci.test.mjs)
function line({ workflows, prCi, runSha, runShaFor, dir = fs.mkdtempSync(path.join(tmp, 'ci-')) }) {
  const started = [];
  const c = ci.createCi({
    dir, parallel: () => 8, now: () => 1000, prCiFor: () => prCi,
    parse: (files) => files.map((f) => ({ path: f.path, doc: JSON.parse(f.text) })),
    prepare: async () => ({ gitDir: '/bare', runSha, runShaFor, workflows: Object.entries(workflows).map(([p, d]) => ({ path: p, text: JSON.stringify(d) })) }),
    runJob: (check, gitDir, sha) => new Promise((resolve) => { started.push({ job: check.sandbox_ci.job, workflow: check.sandbox_ci.workflow, sha }); resolve({ status: 0, out: '' }); }),
  });
  return { ci: c, started, dir };
}

// ---- 7. never a deploy

const NEVER_FILES = ['deploy.yml', 'deploy-dev.yml', 'deploy-dev-fast.yml', 'release-tag.yml', 'announce-release.yml', 'slack-release.yml', 'website-sync.yml', 'close-issues-on-dev-merge.yml', 'publish.yml', 'tag.yml'];

test('a deploy, release or notification workflow listed in pr_ci is refused with a clear error, and nothing runs', async () => {
  for (const f of NEVER_FILES) {
    assert.match(ci.prCiProblem([{ workflow: `.github/workflows/${f}` }]) ?? '', new RegExp(`lists \\.github/workflows/${f.replace(/\./g, '\\.')}: .*Miu never runs`), f);
  }
  assert.match(ci.prCiProblem([{ workflow: '.github/workflows/ci.yml', jobs: ['php', 'deploy'] }]) ?? '', /lists job deploy of \.github\/workflows\/ci\.yml: .*never runs/);
  assert.match(ci.prCiProblem([{ workflow: '.github/workflows/ci.yml', jobs: ['release-tag'] }]) ?? '', /never runs/);
  assert.equal(ci.prCiProblem([{ workflow: '.github/workflows/ci.yml', jobs: ['php', 'js', 'hub', 'security', 'app', 'admin'] }]), null, 'CI jobs are fine');

  const l = line({ workflows: { '.github/workflows/deploy.yml': { on: { workflow_dispatch: {} }, jobs: { build: ubuntu() } } }, prCi: [{ workflow: '.github/workflows/deploy.yml', jobs: ['build'] }] });
  l.ci.ensure('o/r', 1, SHA); await settle();
  const rec = l.ci.get('o/r', 1, SHA);
  assert.equal(rec.state, 'not_run');
  assert.match(rec.reason, /pr_ci is not valid: "pr_ci" lists \.github\/workflows\/deploy\.yml: deploy\.yml is a deploy, release or notification workflow, which Miu never runs/);
  assert.equal(l.started.length, 0);
});

test('the default rule (no pr_ci) never picks a deploy, release or notification workflow or job, whatever triggers it', async () => {
  const on = { pull_request: {}, push: {} };
  const workflows = Object.fromEntries(NEVER_FILES.map((f) => [`.github/workflows/${f}`, { on, jobs: { a: ubuntu() } }]));
  workflows['.github/workflows/ci.yml'] = { name: 'CI', on, jobs: {
    test: ubuntu(),
    'tag-release': ubuntu(),
    publish_docs: ubuntu(),
    build: ubuntu({ name: 'Release tag' }),
    site: ubuntu({ name: 'Website sync' }),
    up: ubuntu({ environment: 'production' }),
    after: ubuntu({ needs: 'tag-release' }),
  } };
  const l = line({ workflows, prCi: undefined });
  l.ci.ensure('o/r', 1, SHA); await settle();
  assert.deepEqual(l.started.map((s) => `${path.basename(s.workflow)}:${s.job}`), ['ci.yml:test']);
  const rec = l.ci.get('o/r', 1, SHA);
  for (const j of rec.jobs.filter((x) => x.job !== 'test')) assert.equal(j.status, 'skipped', `${j.workflow} ${j.job}`);
});

test('a job named for a release or a tag is not run even when pr_ci lists its workflow', () => {
  const jobs = ci.jobsOf('.github/workflows/ci.yml', { on: { workflow_dispatch: {} }, jobs: { unit: ubuntu(), cut: ubuntu({ name: 'Cut the release' }), tag: ubuntu() } }, { listed: { workflow: '.github/workflows/ci.yml' } });
  assert.ok(jobs.find((j) => j.job === 'unit').check);
  assert.match(jobs.find((j) => j.job === 'cut').skip, /name says it releases, deploys or notifies/);
  assert.match(jobs.find((j) => j.job === 'tag').skip, /name says/);
});

// ---- 2. the Hub's pr_ci: its CI jobs, never its deploys

// The jobs of xspeed-hub's .github/workflows/ci.yml (dev, 2026-11-18), as they bear on Sandbox CI.
const pg = { image: 'postgres:16-alpine', env: { POSTGRES_USER: 'xspeed', POSTGRES_PASSWORD: 'xspeed', POSTGRES_DB: 'xspeed_hub' }, ports: ['5433:5432'], options: '--health-cmd "pg_isready -U xspeed" --health-interval 10s --health-timeout 5s --health-retries 5' };
const setup = [{ uses: 'actions/checkout@v4' }, { uses: 'actions/setup-node@v4', with: { 'node-version-file': '.nvmrc', cache: 'npm' } }, { run: 'npm ci' }];
const HUB_CI = { name: 'CI', on: { workflow_dispatch: {}, workflow_call: {} }, jobs: {
  hub: { name: 'Hub (server)', 'runs-on': 'ubuntu-latest', services: { postgres: pg }, steps: [...setup, { run: 'npm run typecheck' }, { run: 'npm test' }, { run: 'npm run test:db', env: { DATABASE_URL: 'postgres://xspeed:xspeed@localhost:5433/xspeed_hub', DB_DRIVER: 'prisma' } }, { run: 'npm run build' }] },
  security: { name: 'Security suite', 'runs-on': 'ubuntu-latest', 'timeout-minutes': 15, permissions: { contents: 'read', 'pull-requests': 'write' }, services: { postgres: pg }, steps: [...setup, { run: 'node scripts/security-test.mjs --require-db --report security-report.md' }, { if: "${{ always() && hashFiles('security-report.md') != '' }}", env: { GH_TOKEN: '${{ github.token }}' }, run: 'bash scripts/pr-comment.sh "$MODE" "$SHA" x security-report.md "$RUN_URL"' }] },
  app: { name: 'App (SPA)', 'runs-on': 'ubuntu-latest', steps: [...setup, { run: 'npm test', 'working-directory': 'app' }] },
  admin: { name: 'Admin (console)', 'runs-on': 'ubuntu-latest', steps: [...setup, { run: 'npm test', 'working-directory': 'admin' }] },
  'capture-provider': { name: 'Guarded capture provider (unreleased)', 'runs-on': 'ubuntu-22.04', if: false, steps: setup },
} };
export const HUB_PR_CI = [{ workflow: '.github/workflows/ci.yml', jobs: ['hub', 'security', 'app', 'admin'] }];

test('the Hub profile\'s pr_ci runs the server, app and admin jobs, and lists the security suite as not run with the reason', () => {
  assert.equal(ci.prCiProblem(HUB_PR_CI), null);
  assert.equal(ci.jobsOf('.github/workflows/ci.yml', HUB_CI).length, 0, 'without pr_ci a manual-only workflow is not run');
  const jobs = ci.jobsOf('.github/workflows/ci.yml', HUB_CI, { listed: HUB_PR_CI[0] });
  const by = Object.fromEntries(jobs.map((j) => [j.job, j]));
  for (const id of ['hub', 'app', 'admin']) assert.equal(by[id].check?.sandbox_ci.event, 'workflow_dispatch', id);
  assert.match(by.security.skip, /tests only, and it asks for write access to the repository or pull requests/);
  assert.equal(by['capture-provider'], undefined, 'not listed, not shown');
  for (const f of ['deploy-dev.yml', 'deploy-dev-fast.yml', 'release-tag.yml', 'announce-release.yml', 'website-sync.yml']) assert.match(ci.prCiProblem([{ workflow: `.github/workflows/${f}` }]) ?? '', /never runs/, f);
});

// ---- 1. linked pull requests

test('a paired run\'s Free, Pro and Hub pull requests each get CI, on their own repo', () => {
  assert.equal(typeof ci.linkedPrs, 'function');
  const pair = [
    { role: 'pro', repo: 'WPDevelopers/xspeed-pro', label: 'Pro', number: 246, headRefOid: '1aa96aff'.padEnd(40, '0') },
    { role: 'hub', repo: 'WPDevelopers/xspeed-hub', label: 'Hub', number: 276, headRefOid: '0b39e816'.padEnd(40, '0') },
    { repo: 'evil/other', number: 1 }, { repo: 'WPDevelopers/xspeed-hub', number: 276 }, { repo: 'WPDevelopers/xspeed-pro', number: '7' },
  ];
  assert.deepEqual(ci.linkedPrs(pair, ['WPDevelopers/xspeed', 'WPDevelopers/xspeed-pro', 'WPDevelopers/xspeed-hub']), [
    { repo: 'WPDevelopers/xspeed-pro', pr: 246, label: 'Pro', sha: '1aa96aff'.padEnd(40, '0') },
    { repo: 'WPDevelopers/xspeed-hub', pr: 276, label: 'Hub', sha: '0b39e816'.padEnd(40, '0') },
  ]);
  assert.deepEqual(ci.linkedPrs(null, ['a/b']), []);
});

// ---- 3. the sibling at two refs

function gitRepo() {
  const dir = fs.mkdtempSync(path.join(tmp, 'git-'));
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const g = (...a) => { const r = spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8', env }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  return { dir, g, env };
}
// Free with main and a branch; Pro's clone fetches from it as if from GitHub.
function freeAndPro() {
  const free = gitRepo();
  free.g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(free.dir, 'free.php'), 'main');
  free.g('add', '-A'); free.g('commit', '-qm', 'main');
  free.g('checkout', '-qb', 'feat/x');
  fs.writeFileSync(path.join(free.dir, 'free.php'), 'feat');
  free.g('commit', '-qam', 'feat');
  const pro = gitRepo();
  pro.g('init', '-q', '--bare');
  const git = (args, env) => new Promise((resolve, reject) => {
    const a = args.map((x) => (x === 'https://github.com/acme/free.git' ? free.dir : x));
    const r = spawnSync('git', ['-C', pro.dir, ...a], { encoding: 'utf8', env: { ...process.env, ...(env ?? {}) } });
    r.status ? reject(new Error(r.stderr)) : resolve(r.stdout.trim());
  });
  return { free, pro, git };
}
const checkoutFree = (ref) => ({ uses: 'actions/checkout@v4', with: { repository: 'acme/free', path: 'free', ...(ref ? { ref } : {}) } });

test('Pro\'s own CI and its deploy check Free out at different refs: only the jobs that run count, no clash', async () => {
  assert.equal(typeof ci.shipSiblings, 'function');
  const { git } = freeAndPro();
  const workflows = [
    { path: '.github/workflows/ci.yml', doc: { on: { workflow_dispatch: {} }, jobs: { php: ubuntu({ steps: [{ id: 'freeref', run: 'echo ref=main >> "$GITHUB_OUTPUT"' }, checkoutFree('${{ steps.freeref.outputs.ref }}')] }), js: ubuntu({ steps: [checkoutFree('${{ steps.freeref.outputs.ref }}')] }) } } },
    { path: '.github/workflows/deploy.yml', doc: { on: { push: { tags: ['*'] }, workflow_dispatch: {} }, jobs: { build: ubuntu({ steps: [checkoutFree('feat/x')] }) } } },
  ];
  const groups = ci.runningGroups(workflows, { list: [{ workflow: '.github/workflows/ci.yml' }] });
  const v = await ci.shipSiblings({ git, siblingRepo: 'acme/free', headRef: 'feat/none', docs: workflows.map((w) => w.doc), names: workflows.map((w) => w.path), groups });
  assert.equal(v.length, 1);
  assert.deepEqual(v[0].tops.sort(), ['.github/workflows/ci.yml\0js', '.github/workflows/ci.yml\0php']);
  assert.match(v[0].from, /acme\/free@main [0-9a-f]{7} at free/);
});

test('two jobs that run and check the sibling out at different refs each get their own run commit, not a refusal', async () => {
  const { git, free } = freeAndPro();
  const workflows = [{ path: '.github/workflows/ci.yml', doc: { on: { workflow_dispatch: {} }, jobs: { a: ubuntu({ steps: [checkoutFree('main')] }), b: ubuntu({ steps: [checkoutFree('feat/x')] }), c: ubuntu() } } }];
  const groups = ci.runningGroups(workflows, { list: [{ workflow: '.github/workflows/ci.yml' }] });
  const v = await ci.shipSiblings({ git, siblingRepo: 'acme/free', headRef: 'feat/x', docs: workflows.map((w) => w.doc), names: workflows.map((w) => w.path), groups });
  assert.equal(v.length, 3, 'main, feat/x, and none for the job that checks out nothing');
  const treeOf = (top) => v.find((x) => x.tops.includes(top)).extra[0]?.tree;
  assert.equal(treeOf('.github/workflows/ci.yml\0a'), free.g('rev-parse', 'main^{tree}'));
  assert.equal(treeOf('.github/workflows/ci.yml\0b'), free.g('rev-parse', 'feat/x^{tree}'));
  assert.equal(treeOf('.github/workflows/ci.yml\0c'), undefined);
  // One job and what it needs still need one tree at one path.
  const clash = [{ path: '.github/workflows/ci.yml', doc: { on: { workflow_dispatch: {} }, jobs: { a: ubuntu({ needs: 'b', steps: [checkoutFree('main')] }), b: ubuntu({ steps: [checkoutFree('feat/x')] }) } } }];
  await assert.rejects(ci.shipSiblings({ git, siblingRepo: 'acme/free', headRef: 'x', docs: clash.map((w) => w.doc), names: clash.map((w) => w.path), groups: ci.runningGroups(clash, { list: [{ workflow: '.github/workflows/ci.yml' }] }) }), /at different refs/);
});

test('the line runs each job on the run commit made for its sibling', async () => {
  const RUN = 'c'.repeat(40), OTHER = 'd'.repeat(40);
  const l = line({ workflows: { '.github/workflows/ci.yml': { on: { workflow_dispatch: {} }, jobs: { a: ubuntu(), b: ubuntu() } } }, prCi: [{ workflow: '.github/workflows/ci.yml' }], runSha: RUN, runShaFor: { '.github/workflows/ci.yml\0a': RUN, '.github/workflows/ci.yml\0b': OTHER } });
  l.ci.ensure('o/r', 1, SHA); await settle();
  assert.deepEqual(Object.fromEntries(l.started.map((s) => [s.job, s.sha])), { a: RUN, b: OTHER });
});

// ---- 5. failing tests survive the log's tail

test('the failing tests the worker reads from the job\'s report are kept with the job and shown', async () => {
  assert.equal(typeof sandboxci.testsIn, 'function');
  const line1 = `miu-ci-tests ${JSON.stringify({ total: 1830, passed: 1826, failedCount: 4, failed: [{ file: 'tests-js/components/railItems.test.tsx', name: 'railItems > renders the plan', message: 'Error: boom' }] })}`;
  assert.equal(sandboxci.testsIn(`noise\n${line1}\n{"ok":false}`).failedCount, 4);
  assert.equal(sandboxci.testsIn('miu-ci-tests not json'), null);
  const dir = fs.mkdtempSync(path.join(tmp, 'ci-'));
  const c = ci.createCi({ dir, now: () => 1000, prCiFor: () => [{ workflow: '.github/workflows/ci.yml' }], parse: (files) => files.map((f) => ({ path: f.path, doc: JSON.parse(f.text) })),
    prepare: async () => ({ gitDir: '/bare', workflows: [{ path: '.github/workflows/ci.yml', text: JSON.stringify({ on: { workflow_dispatch: {} }, jobs: { js: ubuntu() } }) }] }),
    runJob: async () => ({ status: 1, out: 'tail only', tests: sandboxci.testsIn(line1) }), scrub: (t) => t.replace('boom', '[scrubbed]') });
  c.ensure('o/r', 1, SHA); await settle(); await settle();
  const v = c.view(c.get('o/r', 1, SHA));
  assert.equal(v.jobs[0].status, 'failed');
  assert.deepEqual(v.jobs[0].tests, { total: 1830, passed: 1826, failedCount: 4, failed: [{ file: 'tests-js/components/railItems.test.tsx', name: 'railItems > renders the plan', message: 'Error: [scrubbed]' }] });
});

// ---- 6. the CI section of the result comment

const rec = (over) => ({ repo: 'WPDevelopers/xspeed', pr: 696, sha: '96684089'.padEnd(40, '0'), at: 1, state: 'ready', jobs: [], ...over });
const ENTRIES = () => [
  { label: 'Free', repo: 'WPDevelopers/xspeed', pr: 696, sha: '96684089'.padEnd(40, '0'), rec: rec({ jobs: [
    { label: 'CI: JS — Vitest + tsc + Vite', status: 'failed', tests: { total: 1830, passed: 1826, failedCount: 4, failed: [{ file: 'tests-js/components/railItems.test.tsx', name: 'railItems > renders `x` @someone', message: 'Error: boom' }] } },
    { label: 'CI: php (8.3)', status: 'passed', tests: { total: 120, passed: 120, failedCount: 0, failed: [] } },
    { label: 'CI: php (7.4)', status: 'not_run', reason: 'a reason' },
  ] }) },
  { label: 'Pro', repo: 'WPDevelopers/xspeed-pro', pr: 246, sha: '1aa96aff'.padEnd(40, '0'), rec: rec({ repo: 'WPDevelopers/xspeed-pro', pr: 246, sha: '1aa96aff'.padEnd(40, '0'), jobs: [{ label: 'CI: js', status: 'running' }] }) },
  { label: 'Hub', repo: 'WPDevelopers/xspeed-hub', pr: 276, sha: '0b39e816'.padEnd(40, '0'), rec: null },
];

test('the comment\'s CI section: each linked pull request, each job, failing test names, the commit, and whether CI is still running', async () => {
  const { ciBlock, putCiBlock, CI_START, CI_END } = await cicomment();
  assert.equal(typeof ciBlock, 'function');
  const { text, pending } = ciBlock(ENTRIES());
  assert.equal(pending, true);
  assert.ok(text.startsWith(CI_START) && text.endsWith(CI_END));
  assert.match(text, /CI is still running\. This comment is updated when it finishes\./);
  assert.match(text, /\*\*Free #696\*\* at `9668408`: 1 passed, 1 failed, 1 not run/);
  assert.match(text, /❌ CI: JS — Vitest \+ tsc \+ Vite: failed, 4 of 1830 tests failed/);
  assert.match(text, /  - `railItems › renders  x  @\u200bsomeone` in `tests-js\/components\/railItems\.test\.tsx`: `Error: boom`/, 'a backtick in a name cannot end its code span');
  assert.match(text, /  - and 3 more/);
  assert.match(text, /✅ CI: php \(8\.3\): passed \(120 of 120 tests\)/);
  assert.match(text, /⚪ CI: php \(7\.4\): not run: a reason/);
  assert.match(text, /\*\*Pro #246\*\* at `1aa96af`: 1 running/);
  assert.match(text, /\*\*Hub #276\*\* at `0b39e81`: CI has not started yet\./);
  // Put in before the footer, then replaced in place.
  const body = '## Verdict\n\nstuff\n\n<sub>Tested by Miu at `abc`</sub>';
  const once = putCiBlock(body, text);
  assert.ok(once.indexOf(CI_START) < once.indexOf('<sub>Tested by Miu') && once.indexOf(CI_START) > once.indexOf('stuff'));
  const done = ciBlock([{ ...ENTRIES()[0] }]);
  assert.equal(done.pending, false);
  const twice = putCiBlock(once, done.text);
  assert.equal(twice.split(CI_START).length, 2, 'one section, replaced');
  assert.doesNotMatch(twice, /still running/);
});

test('a comment posted while CI runs is edited in place when CI finishes, never posted again', async () => {
  const { ciBlock, putCiBlock, savePending, sweepCiComments, CI_WAIT_MS } = await cicomment();
  assert.equal(typeof sweepCiComments, 'function');
  const dir = fs.mkdtempSync(path.join(tmp, 'pending-'));
  const members = [{ label: 'Free', repo: 'o/free', pr: 1, sha: SHA }, { label: 'Hub', repo: 'o/hub', pr: 2, sha: SHA }];
  const recs = new Map([['o/free#1', rec({ repo: 'o/free', pr: 1, sha: SHA, jobs: [{ label: 'js', status: 'running' }] })], ['o/hub#2', rec({ repo: 'o/hub', pr: 2, sha: SHA, jobs: [{ label: 'hub', status: 'passed' }] })]]);
  const lookup = (r, n) => recs.get(`${r}#${n}`) ?? null;
  const first = ciBlock(members.map((m) => ({ ...m, rec: lookup(m.repo, m.pr) })));
  assert.equal(first.pending, true);
  const bodies = new Map([[11, putCiBlock('## Free verdict\n\n<sub>Tested by Miu</sub>', first.text)], [22, putCiBlock('## Hub verdict\n\n<sub>Tested by Miu</sub>', first.text)]]);
  const calls = [];
  const rest = async (method, p, opts = {}) => {
    calls.push([method, p, opts.token ?? null, opts.fallback ?? null]);
    const id = Number(p.split('/').pop());
    if (method === 'GET') return { body: bodies.get(id), user: { login: id === 22 ? 'person' : 'miu[bot]' } };
    if (method === 'PATCH') { bodies.set(id, opts.body.body); return {}; }
    throw new Error(`no ${method} here`);
  };
  savePending(dir, 'xspeed-1-1', { members, text: first.text, comments: [{ repo: 'o/free', id: 11, fallback: false }, { repo: 'o/hub', id: 22, fallback: true }], now: 1000 });
  const collaborator = () => ({ login: 'Person', token: 'collab-token' });
  assert.equal(await sweepCiComments({ dir, lookup, rest, collaborator, now: 2000 }), 0, 'nothing new: nothing edited');
  assert.equal(calls.length, 0);
  recs.get('o/free#1').jobs[0] = { label: 'js', status: 'failed', tests: { total: 3, passed: 2, failedCount: 1, failed: [{ name: 'adds up' }] } };
  assert.equal(await sweepCiComments({ dir, lookup, rest, collaborator, now: 3000 }), 2);
  assert.ok(calls.every(([m]) => m === 'GET' || m === 'PATCH'), 'never a POST');
  assert.deepEqual(calls.filter(([m]) => m === 'PATCH').map(([, p, token, fallback]) => [p, token, fallback]), [['repos/o/free/issues/comments/11', null, false], ['repos/o/hub/issues/comments/22', 'collab-token', null]], 'each edited by its author');
  for (const b of bodies.values()) { assert.match(b, /`adds up`/); assert.doesNotMatch(b, /still running/); assert.equal(b.split('<!-- miu-ci -->').length, 2); }
  assert.deepEqual(fs.readdirSync(dir), [], 'done: nothing left to wait for');

  // A comment a later round folded is left alone; one that waited too long says so once.
  calls.length = 0;
  bodies.set(11, `${putCiBlock('old', first.text)}\n<!-- miu-superseded -->`);
  recs.get('o/free#1').jobs[0] = { label: 'js', status: 'queued' };
  savePending(dir, 'xspeed-1-2', { members, text: 'older', comments: [{ repo: 'o/free', id: 11 }, { repo: 'o/hub', id: 22 }], now: 1000 });
  await sweepCiComments({ dir, lookup, rest, collaborator, now: 1000 + CI_WAIT_MS + 1 });
  assert.deepEqual(calls.filter(([m]) => m === 'PATCH').map(([, p]) => p), ['repos/o/hub/issues/comments/22']);
  assert.match(bodies.get(22), /CI did not finish within 4 hours/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

// ---- the worker: never a deploy, node for container jobs, the job's test reports

const script = (file, body) => fs.writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
const SELF = `${process.getuid()}:${process.getgid()}`;
const git = (dir, ...args) => spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
function prRepo(files) {
  const dir = fs.mkdtempSync(path.join(tmp, 'repo-'));
  for (const [name, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true }); fs.writeFileSync(path.join(dir, name), text); }
  git(dir, 'init', '-q'); git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'x');
  return dir;
}
// The real worker with a stand-in `sb` (it keeps the workflow it was given and
// can play the job writing its reports) and a stand-in `docker`.
function server({ help = '', docker = 'exit 0', plan = '{"jobs":[{"id":"a","cells":[{"matrix":{}}]}]}', cells = '[{"label":"a","status":"passed","exit_code":0,"output":"[t/a]   🏁  Job succeeded"}]', job = '' } = {}) {
  const home = fs.mkdtempSync(path.join(tmp, 'home-'));
  const bin = fs.mkdtempSync(path.join(tmp, 'bin-'));
  const sb = path.join(home, 'sandbox/sb-src/sb');
  fs.mkdirSync(path.dirname(sb), { recursive: true });
  script(sb, `if [ "$2" = plan ]; then echo '${plan}'; exit 0; fi\nif [ "$3" = --help ]; then echo '${help}'; exit 0; fi\nprintf '%s\\n' "$@" > "${home}/argv"\ncp "$3" "${home}/workflow"\nproject="$6"\n${job}\necho '{"ok":true,"cells":${cells}}'`);
  script(path.join(bin, 'sudo'), 'shift 4\nexec "$@"');
  script(path.join(bin, 'timeout'), 'shift 3\nexec "$@"');
  script(path.join(bin, 'docker'), `printf '%s\\n' "$*" >> "${bin}/docker-calls"\n${docker}`);
  script(path.join(bin, 'curl'), 'cat > /dev/null');
  const names = path.join(fs.mkdtempSync(path.join(tmp, 'names-')), 'ci-secret-names');
  fs.writeFileSync(names, '');
  const node = path.join(home, 'node');
  fs.writeFileSync(node, '#!/bin/true\n');
  return {
    env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, MIU_SANDBOX_USER: 'ubuntu', MIU_SANDBOX_WORKER: WORKER, TMPDIR: fs.mkdtempSync(path.join(tmp, 'run-')), MIU_CI_SLOTS_DIR: fs.mkdtempSync(path.join(tmp, 'slots-')), MIU_CI_FREE_MEM_GB: '20', MIU_CI_MIRRORS_CONF: path.join(tmp, 'no-keys'), MIU_CI_APPLY_LOCKS: path.join(tmp, 'no.lock'), MIU_CI_RUNNER_UID: String(process.getuid()), MIU_CI_SECRET_NAMES: names, MIU_CI_SECRET_NAMES_OWNER: SELF, MIU_CI_NODE_BIN: node },
    node,
    ran: () => fs.existsSync(path.join(home, 'workflow')),
    argv: () => fs.readFileSync(path.join(home, 'argv'), 'utf8').trim().split('\n'),
    workflow: () => fs.readFileSync(path.join(home, 'workflow'), 'utf8'),
    docker: () => { try { return fs.readFileSync(path.join(bin, 'docker-calls'), 'utf8'); } catch { return ''; } },
  };
}
const check = (workflow = '.github/workflows/test.yml', job = 'a', matrix) => ({ label: 'CI', sandbox_ci: { workflow, job, ...(matrix ? { matrix } : {}) } });

test('the worker refuses a deploy, release or notification workflow or job, whatever Miu\'s account sends it', needsYaml, async () => {
  const wf = (jobs) => `on: workflow_dispatch\njobs:\n${jobs}`;
  const cases = [
    ['.github/workflows/deploy.yml', 'a', wf('  a:\n    runs-on: ubuntu-latest\n    steps: [{ run: id }]\n'), /deploy\.yml: it is a deploy, release or notification workflow, which Miu never runs/],
    ['.github/workflows/release-tag.yml', 'a', wf('  a:\n    runs-on: ubuntu-latest\n    steps: [{ run: id }]\n'), /never runs/],
    ['.github/workflows/test.yml', 'a', `name: Slack release\n${wf('  a:\n    runs-on: ubuntu-latest\n    steps: [{ run: id }]\n')}`, /never runs/],
    ['.github/workflows/test.yml', 'deploy', wf('  deploy:\n    runs-on: ubuntu-latest\n    steps: [{ run: id }]\n'), /job deploy is named for a deploy/],
    ['.github/workflows/test.yml', 'a', wf('  a:\n    name: Publish the zip\n    runs-on: ubuntu-latest\n    steps: [{ run: id }]\n'), /job a is named for a deploy/],
    ['.github/workflows/test.yml', 'a', wf('  a:\n    runs-on: ubuntu-latest\n    needs: tag\n    steps: [{ run: id }]\n  tag:\n    runs-on: ubuntu-latest\n    steps: [{ run: id }]\n'), /job tag is named for a deploy/],
    ['.github/workflows/test.yml', 'a', wf('  a:\n    runs-on: ubuntu-latest\n    environment: production\n    steps: [{ run: id }]\n'), /job a deploys to an environment/],
  ];
  for (const [file, job, text, why] of cases) {
    const s = server();
    const r = await sandboxci.runSandboxCi(check(file, job), prRepo({ [file]: text }), s.env);
    assert.match(r.notRun ?? '', why, `${file} ${job}`);
    assert.equal(s.ran(), false, `${file} ${job}: Sandbox never ran`);
  }
});

const PHP = 'on: workflow_dispatch\njobs:\n  php:\n    runs-on: ubuntu-22.04\n    container:\n      image: php:${{ matrix.php }}-cli\n    strategy:\n      matrix:\n        php: ["7.4", "8.3"]\n    steps:\n      - uses: actions/checkout@v4\n      - run: vendor/bin/phpunit --testsuite unit --log-junit /tmp/phpunit.xml\n';
const plan83 = '{"jobs":[{"id":"php","cells":[{"matrix":{"php":"7.4"}},{"matrix":{"php":"8.3"}}]}]}';

test('a container job whose image has no node gets this server\'s node, read only, and the CI caps; one with node keeps its own', needsYaml, async () => {
  const yaml = (t) => JSON.parse(spawnSync('python3', ['-c', 'import json,sys,yaml; print(json.dumps(yaml.safe_load(sys.stdin)))'], { input: t, encoding: 'utf8' }).stdout);
  // `docker run ... command -v node` exits 1: no node in the image.
  const none = server({ plan: plan83, docker: 'case "$1" in run) exit 3;; esac; exit 0' });
  const r = await sandboxci.runSandboxCi(check('.github/workflows/test.yml', 'php', { php: '8.3' }), prRepo({ '.github/workflows/test.yml': PHP }), none.env);
  assert.equal(r.status, 0, JSON.stringify(r));
  assert.match(none.docker(), /run --rm .*--entrypoint sh php:8\.3-cli -c command -v node >\/dev\/null 2>&1 && exit 0; exit 3/);
  const c = yaml(none.workflow()).jobs.php.container;
  assert.equal(c.image, 'php:${{ matrix.php }}-cli', 'the image stays as the workflow wrote it');
  assert.equal(c.options, `--memory=2g --memory-swap=2g --cpus=2 --cgroup-parent=miu-ci.slice --volume=${none.node}:/usr/local/bin/node:ro`);
  // The probe is named for this run, capped, and removed after.
  assert.match(none.docker(), /run --rm --name miu-probe-miu-ci\.\w+ --pull=missing --network=none --memory=256m --cpus=0\.5 --pids-limit=64 /);
  assert.match(none.docker(), /^rm -f miu-probe-miu-ci\.\w+$/m);
  assert.match(r.log, /^Note: php:8\.3-cli has no node, so Miu gave job php this server's node/);
  assert.match(none.workflow(), /^'on': workflow_dispatch$/m, '`on` stays the trigger key, not YAML 1.1\'s true');

  const has = server({ plan: plan83 });
  await sandboxci.runSandboxCi(check('.github/workflows/test.yml', 'php', { php: '8.3' }), prRepo({ '.github/workflows/test.yml': PHP }), has.env);
  assert.equal(yaml(has.workflow()).jobs.php.container.options, '--memory=2g --memory-swap=2g --cpus=2 --cgroup-parent=miu-ci.slice');
});

const VITEST = 'on: workflow_dispatch\njobs:\n  a:\n    runs-on: ubuntu-22.04\n    steps:\n      - run: npm ci\n      - run: npm test -- --run --reporter=json --outputFile=/tmp/vitest.json\n      - run: npm run junit -- --junitxml=out/j.xml\n        working-directory: app\n';
// What the added last step does in the job: copy the reports into the workspace.
const writes = (files) => Object.entries(files).map(([f, t]) => `mkdir -p "$project/.miu-ci-reports"; printf '%s' '${t.replace(/'/g, "'\\''")}' > "$project/.miu-ci-reports/${f}"`).join('\n');

test('the job\'s own test reports come back as its failing tests, so they survive the log\'s tail', needsYaml, async () => {
  const report = JSON.stringify({ numTotalTests: 1830, numPassedTests: 1826, testResults: [
    { name: '__ROOT__/tests-js/components/railItems.test.tsx', status: 'failed', assertionResults: [{ fullName: 'railItems > renders the plan', status: 'failed', failureMessages: ['\u001b[31mError: boom\u001b[39m\n    at x'] }, { fullName: 'ok one', status: 'passed' }] },
    { name: '__ROOT__/tests-js/broken.test.ts', status: 'failed', message: 'SyntaxError: nope', assertionResults: [] },
  ] });
  const junit = '<testsuites><testsuite><testcase classname="Free\\PlanTest" name="test_items" file="tests/PlanTest.php"><failure message="Failed asserting that false is true."/></testcase><testcase name="ok"/></testsuite></testsuites>';
  const s = server({ cells: '[{"label":"a","status":"failed","exit_code":1,"output":"[t/a]   ❌  Failure - Main Vitest\\n[t/a] 🏁  Job failed"}]', job: `${writes({ '0.json': report, '1.xml': junit })}\nsed -i "s#__ROOT__#$project#g" "$project/.miu-ci-reports/0.json"` });
  const r = await sandboxci.runSandboxCi(check(), prRepo({ '.github/workflows/test.yml': VITEST }), s.env);
  assert.equal(r.status, 1, JSON.stringify(r));
  const wf = s.workflow();
  assert.match(wf, /name: 'Miu: keep the test reports'/);
  assert.match(wf, /cp "\/tmp\/vitest\.json" "\$d\/0\.json"/);
  assert.match(wf, /cp "\$GITHUB_WORKSPACE\/app\/out\/j\.xml" "\$d\/1\.xml"/);
  assert.deepEqual(r.tests, { total: 1832, passed: 1827, failedCount: 3, failed: [
    { file: 'tests-js/components/railItems.test.tsx', name: 'railItems > renders the plan', message: 'Error: boom' },
    { file: 'tests-js/broken.test.ts', name: '(the test file failed to run)', message: 'SyntaxError: nope' },
    { file: 'tests/PlanTest.php', name: 'Free\\PlanTest::test_items', message: 'Failed asserting that false is true.' },
  ] });
});

test('a report the job made into a link, or XML with entities, is not read', needsYaml, async () => {
  const secret = path.join(tmp, 'sandbox-secret.json');
  fs.writeFileSync(secret, JSON.stringify({ numTotalTests: 1, testResults: [{ name: 'SECRET', status: 'failed', assertionResults: [] }] }));
  const link = server({ cells: '[{"label":"a","status":"failed","exit_code":1,"output":"[t/a] 🏁  Job failed"}]', job: `mkdir -p "$project/.miu-ci-reports"; ln -s "${secret}" "$project/.miu-ci-reports/0.json"\nprintf '%s' '<!DOCTYPE x [<!ENTITY a "b">]><testsuite><testcase name="&a;"><failure/></testcase></testsuite>' > "$project/.miu-ci-reports/1.xml"` });
  const r = await sandboxci.runSandboxCi(check(), prRepo({ '.github/workflows/test.yml': VITEST }), link.env);
  assert.equal(r.status, 1);
  assert.equal(r.tests, undefined);
  const dirLink = server({ cells: '[{"label":"a","status":"failed","exit_code":1,"output":"[t/a] 🏁  Job failed"}]', job: `mkdir -p "${tmp}/elsewhere"; cp "${secret}" "${tmp}/elsewhere/0.json"; ln -s "${tmp}/elsewhere" "$project/.miu-ci-reports"` });
  assert.equal((await sandboxci.runSandboxCi(check(), prRepo({ '.github/workflows/test.yml': VITEST }), dirLink.env)).tests, undefined);
});

// ---- review fixes

test('names that only start with a never-run word, or hide it in camelCase, are refused too', () => {
  for (const n of ['deployment', 'deploys', 'releases', 'prerelease', 'deploy2', 'autodeploy', 'DeployToProd', 'tags', 'closeIssues']) assert.ok(ci.NEVER_RUN.test(n), n);
  for (const n of ['ci', 'unit', 'stage', 'tagline', 'Hub (server)', 'Security suite', 'App (SPA)', 'Dist — build + inspect the Pro zip', 'PHP — PHPUnit (PHP 8.3)', 'JS — Vitest + tsc + Vite']) assert.equal(ci.NEVER_RUN.test(n), false, n);
  assert.match(ci.prCiProblem([{ workflow: '.github/workflows/deployment.yml' }]) ?? '', /never runs/);
});

test('the worker refuses deployment-like names and release events too', needsYaml, async () => {
  const wf = 'on: workflow_dispatch\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps: [{ run: id }]\n  autoDeploy:\n    runs-on: ubuntu-latest\n    steps: [{ run: id }]\n';
  for (const [file, job, event, why] of [['.github/workflows/deployment.yml', 'a', undefined, /never runs/], ['.github/workflows/test.yml', 'autoDeploy', undefined, /job autoDeploy is named/], ['.github/workflows/test.yml', 'a', 'release', /never plays the release event/]]) {
    const s = server();
    const r = await sandboxci.runSandboxCi({ label: 'CI', sandbox_ci: { workflow: file, job, ...(event ? { event } : {}) } }, prRepo({ [file]: wf }), s.env);
    assert.match(r.notRun ?? '', why, `${file} ${job} ${event}`);
    assert.equal(s.ran(), false);
  }
});

test('what the worker adds to the workflow leaves the job\'s checkout clean', needsYaml, async () => {
  const s = server({ plan: plan83, job: 'git -C "$project" status --porcelain > "$HOME/status"' });
  await sandboxci.runSandboxCi(check('.github/workflows/test.yml', 'php', { php: '8.3' }), prRepo({ '.github/workflows/test.yml': PHP }), s.env);
  assert.match(s.workflow(), /--cgroup-parent=miu-ci\.slice/, 'the workflow was changed');
  assert.equal(fs.readFileSync(path.join(s.env.HOME, 'status'), 'utf8'), '', 'git status sees nothing');
});

test('text from the pull request\'s run cannot plant Miu\'s markers or mentions in the comment', async () => {
  const { ciBlock, putCiBlock, CI_START, CI_END } = await cicomment();
  const evil = '<!-- miu-sha=abc --> <!-- /miu-ci --> <!-- miu-superseded --> @owner';
  const { text } = ciBlock([{ label: 'Free', repo: 'o/r', pr: 1, sha: SHA, rec: rec({ repo: 'o/r', pr: 1, sha: SHA, jobs: [{ label: evil, status: 'not_run', reason: evil }, { label: 'js', status: 'failed', tests: { failedCount: 1, failed: [{ name: evil, file: evil, message: evil }] } }] }) }]);
  assert.equal(text.split('<!--').length, 3, 'only the section\'s own two markers');
  assert.doesNotMatch(text, /@owner/);
  const again = putCiBlock(putCiBlock('a\n<sub>Tested by Miu</sub>', text), text);
  assert.equal(again.split(CI_START).length, 2);
  assert.equal(again.split(CI_END).length, 2);
});

test('the CI section stays small enough to edit into any comment', async () => {
  const { ciBlock, CI_MAX } = await cicomment();
  const failed = Array.from({ length: 50 }, (_, i) => ({ name: `test ${i} ${'x'.repeat(280)}`, file: 'f'.repeat(190), message: 'm'.repeat(290) }));
  const jobs = Array.from({ length: 24 }, (_, i) => ({ label: `job ${i}`, status: 'failed', tests: { total: 99, passed: 49, failedCount: 50, failed } }));
  const entries = ['a', 'b', 'c'].map((r, k) => ({ label: r, repo: `o/${r}`, pr: k + 1, sha: SHA, rec: rec({ repo: `o/${r}`, pr: k + 1, sha: SHA, jobs }) }));
  const { text } = ciBlock(entries);
  assert.ok(text.length <= CI_MAX, String(text.length));
  assert.ok(text.endsWith('<!-- /miu-ci -->'));
  const { commentWithFullReport } = await import('../lib/publish.mjs');
  assert.ok(commentWithFullReport('c', 'x'.repeat(100000), null, CI_MAX).length + CI_MAX < 65536);
});

test('a deleted comment is not waited for; a rerun\'s file takes over the comment it edits', async () => {
  const { savePending, sweepCiComments } = await cicomment();
  const dir = fs.mkdtempSync(path.join(tmp, 'pending-'));
  const members = [{ label: 'Free', repo: 'o/free', pr: 1, sha: SHA }];
  const done = rec({ repo: 'o/free', pr: 1, sha: SHA, jobs: [{ label: 'js', status: 'passed' }] });
  savePending(dir, 'run-1', { members, text: 'x', comments: [{ repo: 'o/free', id: 11 }, { repo: 'o/free', id: 12 }], now: 1000 });
  savePending(dir, 'run-2', { members, text: 'x', comments: [{ repo: 'o/free', id: 11 }], now: 1000 });
  const p1 = JSON.parse(fs.readFileSync(path.join(dir, 'run-1.json'), 'utf8'));
  assert.deepEqual(p1.comments.map((c) => c.id), [12], 'comment 11 is run-2\'s now');
  const rest = async (method) => { if (method === 'GET') throw new Error('GitHub GET repos/o/free/issues/comments/12: HTTP 404 Not Found'); return {}; };
  await sweepCiComments({ dir, lookup: () => done, rest: async (m, p) => (p.endsWith('/12') ? rest(m) : m === 'GET' ? { body: '<!-- miu-ci -->x<!-- /miu-ci -->', user: { login: 'b' } } : {}), collaborator: () => null, now: 2000 });
  assert.deepEqual(fs.readdirSync(dir), [], 'both done: one edited, one gone');
});

// ---- the orchestrator's scope addition (2026-11-18): stale records, whole logs, git in a container job

test('an open pull request whose CI an older worker made runs again at its current head, one at a time, and then not again', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'ci-'));
  const OLD = 'b'.repeat(40), NEW = 'e'.repeat(40);
  // The two 11-15 failures: Sandbox's old blocking-id format, and Pro's sibling checkout with no token.
  fs.writeFileSync(path.join(dir, `xspeed-208-${OLD.slice(0, 12)}.json`), JSON.stringify({ key: `xspeed-208-${OLD.slice(0, 12)}`, repo: 'o/xspeed', pr: 208, sha: OLD, at: 100, rules: 6, state: 'ready', jobs: [{ n: 0, label: 'CI: js', status: 'not_run', reason: 'Sandbox refused this workflow: , ' }] }));
  fs.writeFileSync(path.join(dir, `xspeed-pro-30-${OLD.slice(0, 12)}.json`), JSON.stringify({ key: `xspeed-pro-30-${OLD.slice(0, 12)}`, repo: 'o/xspeed-pro', pr: 30, sha: OLD, at: 200, rules: 6, state: 'ready', jobs: [{ n: 0, label: 'CI: php', status: 'failed', reason: null, hasLog: true }] }));
  const started = [];
  let busy = false;
  const c = ci.createCi({ dir, now: () => 1000, parallel: () => 1, prCiFor: () => [{ workflow: '.github/workflows/ci.yml' }], parse: (files) => files.map((f) => ({ path: f.path, doc: JSON.parse(f.text) })),
    prepare: async () => ({ gitDir: '/bare', workflows: [{ path: '.github/workflows/ci.yml', text: JSON.stringify({ on: { workflow_dispatch: {} }, jobs: { a: ubuntu() } }) }] }),
    runJob: (check, d, sha) => new Promise((resolve) => { started.push(sha); busy = true; setTimeout(() => { busy = false; resolve({ status: 0, out: '' }); }, 5); }) });
  assert.equal(typeof c.refreshStale, 'function');
  const open = [{ repo: 'o/xspeed', number: 208, headRefOid: NEW }, { repo: 'o/xspeed-pro', number: 30, headRefOid: NEW }, { repo: 'o/xspeed', number: 999, headRefOid: NEW }];
  assert.deepEqual(c.refreshStale(open, { max: 1, room: 1 }), ['o/xspeed#208'], 'the oldest first, one at a time');
  assert.deepEqual(c.refreshStale(open, { max: 1, room: 1 }), [], 'not while one is being read');
  await settle(); await settle();
  assert.equal(busy, false);
  assert.deepEqual(c.refreshStale(open, { max: 1, room: 1 }), ['o/xspeed-pro#30']);
  await settle(); await settle();
  assert.deepEqual(started, [NEW, NEW], 'each at its current head');
  assert.equal(c.get('o/xspeed', 208, NEW).worker, ci.CI_WORKER);
  assert.deepEqual(c.refreshStale(open, { max: 5, room: 5 }), [], 'current now: not again, and a PR that never had CI is left to the queue');
});

test('the worker asks Sandbox for each job\'s whole output when Sandbox can keep it', needsYaml, async () => {
  const yes = server({ help: '  --output-limit BYTES   keep this much of each job\'s output (0: all)' });
  await sandboxci.runSandboxCi(check(), prRepo({ '.github/workflows/test.yml': 'on: workflow_dispatch\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps: [{ run: id }]\n' }), yes.env);
  const argv = yes.argv();
  assert.equal(argv[argv.indexOf('--output-limit') + 1], '2097152');
  const old = server({ help: '  --timeout SECONDS' });
  await sandboxci.runSandboxCi(check(), prRepo({ '.github/workflows/test.yml': 'on: workflow_dispatch\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps: [{ run: id }]\n' }), old.env);
  assert.equal(old.argv().includes('--output-limit'), false, 'an older Sandbox would refuse it');
});

test('a container job trusts its workspace for git first, as actions/checkout does on GitHub', needsYaml, async () => {
  const s = server({ plan: plan83 });
  await sandboxci.runSandboxCi(check('.github/workflows/test.yml', 'php', { php: '8.3' }), prRepo({ '.github/workflows/test.yml': PHP }), s.env);
  const steps = JSON.parse(spawnSync('python3', ['-c', 'import json,sys,yaml; print(json.dumps(yaml.safe_load(sys.stdin)))'], { input: s.workflow(), encoding: 'utf8' }).stdout).jobs.php.steps;
  assert.equal(steps[0].name, 'Miu: trust the workspace for git');
  assert.equal(steps[0].shell, 'sh');
  // What the step does, in a shell like the container's.
  const home = fs.mkdtempSync(path.join(tmp, 'gh-'));
  spawnSync('sh', ['-c', steps[0].run], { env: { ...process.env, HOME: home, GITHUB_WORKSPACE: '/tmp/miu-ci.abc' } });
  assert.equal(fs.readFileSync(path.join(home, '.gitconfig'), 'utf8'), '[safe]\n\tdirectory = /tmp/miu-ci.abc\n');
  assert.equal(steps[1].uses, 'actions/checkout@v4', 'then the job as it was');
});

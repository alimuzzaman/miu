import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSandboxCi, sandboxCiProblem, changesCiDefinition, reposNeeded, manifestRepos } from '../lib/sandboxci.mjs';
import { prCiProblem, jobsOf, ciRunCommit, siblingPaths, shipSibling } from '../lib/ci.mjs';

const WORKER = fileURLToPath(new URL('../bin/miu-sandbox-ci', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'miu-sandboxci-'));
const check = { label: 'CI', sandbox_ci: { workflow: '.github/workflows/test.yml', job: 'a' } };
// The worker's workflow policy needs PyYAML, which the installer adds on a server.
const hasYaml = spawnSync('python3', ['-c', 'import yaml']).status === 0;
const needsYaml = { skip: hasYaml ? false : 'needs python3 with PyYAML' };
const OK = 'jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps: [{ run: id }]\n';
const script = (file, body) => fs.writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
const git = (dir, ...args) => spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });

// A pull request's checkout: one commit, plus a file that was never committed.
function repo(extra = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, 'repo-'));
  const files = { '.github/workflows/test.yml': OK, 'code.php': '<?php\n', ...extra };
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  git(dir, 'init', '-q'); git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'x');
  fs.writeFileSync(path.join(dir, 'untracked.txt'), 'not in the commit');
  return dir;
}

// `sudo` is the only stand-in on the way: it records how it was called and
// runs the worker, the same as the rule install.sh writes.
function server({ worker, home, docker = 'exit 0' }) {
  const bin = fs.mkdtempSync(path.join(tmp, 'bin-'));
  script(path.join(bin, 'sudo'), `printf '%s\\n' "$@" > "${bin}/sudo-argv"\nshift 4\nexec "$@"`);
  script(path.join(bin, 'timeout'), 'shift 3\nexec "$@"');
  script(path.join(bin, 'docker'), docker);
  script(path.join(bin, 'curl'), `cat >> "${bin}/curl-stdin"\nprintf '%s\\n' "$@" >> "${bin}/curl-argv"`);
  if (!hasYaml) script(path.join(bin, 'python3'), 'exit 0');
  return {
    env: { ...process.env, HOME: home ?? tmp, PATH: `${bin}:${process.env.PATH}`, MIU_SANDBOX_USER: 'ubuntu', MIU_SANDBOX_WORKER: worker ?? WORKER, TMPDIR: fs.mkdtempSync(path.join(tmp, 'run-')), MIU_CI_SLOTS_DIR: fs.mkdtempSync(path.join(tmp, 'slots-')), MIU_CI_FREE_MEM_GB: '20', MIU_CI_FREE_CPUS: '8' },
    sudoArgv: () => fs.readFileSync(path.join(bin, 'sudo-argv'), 'utf8').trim().split('\n'),
    curl: (f) => { try { return fs.readFileSync(path.join(bin, `curl-${f}`), 'utf8'); } catch { return ''; } },
  };
}

// A stand-in worker: takes the tar, prints what the test asks for.
function fakeWorker({ stdout = '', stderr = '', exit = 0, sleep = 0, ignoreTerm = false }) {
  const dir = fs.mkdtempSync(path.join(tmp, 'worker-'));
  fs.writeFileSync(path.join(dir, 'stdout'), stdout);
  fs.writeFileSync(path.join(dir, 'stderr'), stderr);
  const worker = path.join(dir, 'worker');
  script(worker, `${ignoreTerm ? "trap '' TERM\n" : ''}cat > /dev/null\nprintf '%s\\n' "$@" > "${dir}/argv"\ncat "${dir}/stdout"\ncat "${dir}/stderr" >&2\nsleep ${sleep}\nexit ${exit}`);
  return { ...server({ worker }), worker, argv: () => fs.readFileSync(path.join(dir, 'argv'), 'utf8').trim().split('\n'), ran: () => fs.existsSync(path.join(dir, 'argv')) };
}

// The real worker, with a stand-in `sb` that keeps what it was given.
function sandboxHome({ stdout = '{"ok":true,"cells":[{"label":"a","status":"passed","exit_code":0,"output":"[t/a]   🏁  Job succeeded"}]}', plan = '{"jobs":[{"id":"a","cells":[{"matrix":{}}]}]}' } = {}) {
  const home = fs.mkdtempSync(path.join(tmp, 'home-'));
  const sb = path.join(home, 'sandbox/sb-src/sb');
  fs.mkdirSync(path.dirname(sb), { recursive: true });
  script(sb, `if [ "$2" = plan ]; then echo '${plan}'; exit 0; fi\nprintf '%s\\n' "$@" > "${home}/argv"\ncat > "${home}/stdin"\necho "$TMPDIR" > "${home}/tmpdir"\nproject="$6"\necho "$project" > "${home}/project"\nfind "$project" -path "$project/.git" -prune -o -type f -print | sed "s#^$project/##" | LC_ALL=C sort > "${home}/files"\ngit -C "$project" rev-parse --is-inside-work-tree > "${home}/git"\ncat "$XDG_CONFIG_HOME/act/actrc" > "${home}/actrc"\necho '${stdout}'`);
  return { home, read: (f) => fs.readFileSync(path.join(home, f), 'utf8').trim() };
}

const report = (cells) => JSON.stringify({ ok: cells.every((c) => c.status === 'passed'), cells }) + '\n';

test('goes through the one sudo rule, as the configured account', async () => {
  const s = fakeWorker({ stdout: report([{ label: 'a', status: 'passed', exit_code: 0, output: '[t/a]   🏁  Job succeeded' }]) });
  const r = await runSandboxCi({ label: 'CI', sandbox_ci: { workflow: '.github/workflows/test.yml', job: 'php', matrix: { php: 8.3, db: 'mysql' }, event: 'push', timeout_minutes: 5 } }, repo(), s.env);
  assert.equal(r.status, 0);
  assert.deepEqual(s.sudoArgv().slice(0, 4), ['-n', '-H', '-u', 'ubuntu']);
  assert.equal(s.sudoArgv()[4], s.worker);
  assert.deepEqual(s.argv(), ['.github/workflows/test.yml', 'push', '300', 'php', 'php=8.3', 'db=mysql']);
});

test('defaults: a pull request, 30 minutes', async () => {
  const s = fakeWorker({ stdout: report([{ label: 'a', status: 'passed', exit_code: 0, output: '[t/a]   🏁  Job succeeded' }]) });
  await runSandboxCi(check, repo(), s.env);
  assert.deepEqual(s.argv(), ['.github/workflows/test.yml', 'pull_request', '1800', 'a']);
});

test('the worker runs the commit on this server and never asks for deploy steps', async () => {
  const sandbox = sandboxHome();
  const r = await runSandboxCi(check, repo(), server({ home: sandbox.home }).env);
  assert.equal(r.status, 0, JSON.stringify(r));
  const argv = sandbox.read('argv').split('\n');
  assert.deepEqual(argv.slice(0, 2), ['ci', 'run']);
  assert.match(argv[2], /\/\.github\/workflows\/test\.yml$/);
  assert.ok(argv.includes('--local'));
  assert.ok(!argv.includes('--remote'));
  assert.ok(!argv.includes('--allow-deploy'));
  assert.equal(argv[argv.indexOf('--job') + 1], 'a');
  assert.equal(argv[argv.indexOf('--runtime') + 1], 'none');
  assert.equal(sandbox.read('files'), '.github/workflows/test.yml\ncode.php');
  assert.equal(sandbox.read('git'), 'true');
});

test('jobs do not get the Docker socket, and a committed .actrc is ignored', async () => {
  const sandbox = sandboxHome();
  await runSandboxCi(check, repo({ '.actrc': '--privileged\n' }), server({ home: sandbox.home }).env);
  assert.equal(sandbox.read('actrc'), '--container-daemon-socket=-');
  assert.doesNotMatch(sandbox.read('files'), /actrc/);
});

test('every job container is capped and kept in miu-ci.slice', async () => {
  const sandbox = sandboxHome();
  await runSandboxCi(check, repo(), server({ home: sandbox.home }).env);
  const argv = sandbox.read('argv').split('\n');
  const limits = argv.flatMap((a, i) => (a === '--container-limit' ? [argv[i + 1]] : []));
  assert.deepEqual(limits, ['memory=2g', 'cpus=2', 'cgroup-parent=miu-ci.slice']);
});

// Holds an flock on a file, the way a Sandbox host apply or another CI run would.
function holdLock(file, mode) {
  const ready = path.join(tmp, `ready-${process.hrtime.bigint()}`);
  const child = spawn('python3', ['-c', `import fcntl,os,sys,time\nfd=os.open(sys.argv[1], os.O_RDWR|os.O_CREAT)\nfcntl.flock(fd, fcntl.${mode})\nopen(sys.argv[2],'w').close()\ntime.sleep(60)`, file, ready], { stdio: 'ignore' });
  return new Promise((resolve) => { const t = setInterval(() => { if (fs.existsSync(ready)) { clearInterval(t); resolve(child); } }, 20); });
}

test('does not start while a Sandbox host apply holds its lock', async () => {
  const sandbox = sandboxHome();
  const lock = path.join(tmp, `apply-${process.hrtime.bigint()}.lock`);
  const holder = await holdLock(lock, 'LOCK_EX');
  try {
    const s = server({ home: sandbox.home });
    const r = await runSandboxCi(check, repo(), { ...s.env, MIU_CI_APPLY_LOCKS: lock });
    assert.match(r.notRun, /host apply is in progress/);
    assert.equal(fs.existsSync(path.join(sandbox.home, 'argv')), false);
  } finally { holder.kill(); }
});

test('an apply lock nobody holds does not stop a run', async () => {
  const sandbox = sandboxHome();
  const lock = path.join(tmp, `idle-${process.hrtime.bigint()}.lock`);
  fs.writeFileSync(lock, '');
  const r = await runSandboxCi(check, repo(), { ...server({ home: sandbox.home }).env, MIU_CI_APPLY_LOCKS: lock });
  assert.equal(r.status, 0);
});

// A server with plenty free, so only the slots decide.
const roomy = {};

test('runs side by side while the CI pool has room, and no more', async () => {
  const sandbox = sandboxHome();
  const dir = fs.mkdtempSync(path.join(tmp, 'tmpdir-'));
  fs.mkdirSync(path.join(dir, 'miu-sandbox-ci-slots'));
  const first = await holdLock(path.join(dir, 'miu-sandbox-ci-slots', '0.lock'), 'LOCK_EX');
  try {
    const env = { ...server({ home: sandbox.home }).env, ...roomy, TMPDIR: dir, MIU_CI_SLOTS_DIR: path.join(dir, 'miu-sandbox-ci-slots') };
    assert.equal((await runSandboxCi(check, repo(), env)).status, 0, 'a second run fits in a 4 GB, 4 CPU pool');
    const second = await holdLock(path.join(dir, 'miu-sandbox-ci-slots', '1.lock'), 'LOCK_EX');
    try {
      const r = await runSandboxCi(check, repo(), env);
      assert.match(r.notRun, /all 2 Sandbox CI slots on this server are in use/);
    } finally { second.kill(); }
  } finally { first.kill(); }
});

test('a bigger pool allows more runs at once', async () => {
  const sandbox = sandboxHome();
  const dir = fs.mkdtempSync(path.join(tmp, 'tmpdir-'));
  fs.mkdirSync(path.join(dir, 'miu-sandbox-ci-slots'));
  const held = [];
  for (const i of [0, 1]) held.push(await holdLock(path.join(dir, 'miu-sandbox-ci-slots', `${i}.lock`), 'LOCK_EX'));
  try {
    const env = { ...server({ home: sandbox.home }).env, ...roomy, TMPDIR: dir, MIU_CI_SLOTS_DIR: path.join(dir, 'miu-sandbox-ci-slots'), MIU_CI_POOL_MEM_GB: '8', MIU_CI_POOL_CPUS: '8' };
    assert.equal((await runSandboxCi(check, repo(), env)).status, 0);
  } finally { held.forEach((h) => h.kill()); }
});

test('does not start when the server is short of memory or CPU', async () => {
  for (const [free, why] of [[{ MIU_CI_FREE_MEM_GB: '5', MIU_CI_FREE_CPUS: '8' }, 'memory'], [{ MIU_CI_FREE_MEM_GB: '20', MIU_CI_FREE_CPUS: '2.5' }, 'CPU']]) {
    const sandbox = sandboxHome();
    const dir = fs.mkdtempSync(path.join(tmp, 'tmpdir-'));
    const r = await runSandboxCi(check, repo(), { ...server({ home: sandbox.home }).env, ...free, TMPDIR: dir, MIU_CI_SLOTS_DIR: path.join(dir, 'miu-sandbox-ci-slots') });
    assert.match(r.notRun ?? '', /this server is busy/, `short of ${why}`);
    assert.equal(fs.existsSync(path.join(sandbox.home, 'argv')), false, `nothing ran when short of ${why}`);
  }
});

test('files the tar brings cannot run or read anything on the server', async () => {
  const sandbox = sandboxHome();
  const dir = repo();
  fs.symlinkSync('/etc/hosts', path.join(dir, '.env'));
  fs.writeFileSync(path.join(dir, '.vars'), 'PLAIN=1\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'links');
  await runSandboxCi(check, dir, server({ home: sandbox.home }).env);
  const files = sandbox.read('files').split('\n');
  assert.ok(!files.includes('.env'));
  assert.ok(files.includes('.vars'));
});

test('a .git in the tar is thrown away, hooks and all', () => {
  const sandbox = sandboxHome();
  const src = fs.mkdtempSync(path.join(tmp, 'evil-'));
  const marker = path.join(sandbox.home, 'hook-ran');
  fs.mkdirSync(path.join(src, '.github/workflows'), { recursive: true });
  fs.writeFileSync(path.join(src, '.github/workflows/test.yml'), OK);
  fs.mkdirSync(path.join(src, '.git/hooks'), { recursive: true });
  fs.writeFileSync(path.join(src, '.git/hooks/post-commit'), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
  const tar = spawnSync('tar', ['-c', '-C', src, '.']);
  const { env } = server({ home: sandbox.home });
  const r = spawnSync(WORKER, ['.github/workflows/test.yml', 'push', '60', 'a'], { input: Buffer.concat([Buffer.from('miu-ci-secrets 0\n'), tar.stdout]), env });
  assert.equal(r.status, 0, String(r.stderr));
  assert.equal(fs.existsSync(marker), false);
  assert.equal(sandbox.read('git'), 'true');
});

test('removes the containers of its own run, and no others', async () => {
  const sandbox = sandboxHome();
  const log = path.join(sandbox.home, 'docker-log');
  const docker = `case "$1" in
ps) echo mine; echo other ;;
inspect) if [ "$4" = mine ]; then cat "${sandbox.home}/project"; else echo /somewhere/else; fi ;;
rm) echo "$3" >> "${log}" ;;
esac`;
  await runSandboxCi(check, repo(), server({ home: sandbox.home, docker }).env);
  assert.equal(fs.readFileSync(log, 'utf8').trim(), 'mine');
});

test('the worker never asks Sandbox for a site', async () => {
  const sandbox = sandboxHome();
  await runSandboxCi(check, repo({ 'sandbox.config.json': '{}' }), server({ home: sandbox.home }).env);
  const argv = sandbox.read('argv').split('\n');
  assert.equal(argv[argv.indexOf('--runtime') + 1], 'none');
});

const refusals = [
  ['a job container that mounts the server', 'jobs:\n  a:\n    runs-on: ubuntu-latest\n    container:\n      image: x\n      volumes: ["/:/host"]\n    steps: [{ run: id }]\n', /volumes/],
  ['a privileged service', 'jobs:\n  a:\n    runs-on: ubuntu-latest\n    services:\n      db:\n        image: x\n        options: --health-interval=1s --privileged\n    steps: [{ run: id }]\n', /--privileged/],
  ['options built from an expression', 'jobs:\n  a:\n    runs-on: ubuntu-latest\n    container:\n      image: x\n      options: ${{ matrix.o }}\n    steps: [{ run: id }]\n', /plain text/],
  ['a workflow from another repository', 'jobs:\n  a:\n    uses: evil/repo/.github/workflows/x.yml@main\n', /calls another workflow/],
  ['a local workflow outside .github', 'jobs:\n  a:\n    uses: ./payload.yml\n', /calls another workflow/],
  ['options that hide flags behind escaped lines', 'jobs:\n  a:\n    runs-on: ubuntu-latest\n    services:\n      db:\n        image: x\n        options: |\n          \\\n          --privileged\n    steps: [{ run: id }]\n', /plain text/],
  ['keys hidden behind a YAML alias', 'x: &m\n  image: x\n  volumes: ["/:/host"]\njobs:\n  a:\n    runs-on: ubuntu-latest\n    container: *m\n    steps: [{ run: id }]\n', /volumes/],
  ['a matrix name that is a number', 'jobs:\n  a:\n    runs-on: ubuntu-latest\n    strategy:\n      matrix:\n        1: [x, y]\n        include:\n          - { "1": "None" }\n    steps: [{ run: id }]\n', /not text/],
  ['a number hidden in a matrix include', 'jobs:\n  a:\n    runs-on: ubuntu-latest\n    strategy:\n      matrix:\n        include:\n          - { 1: x }\n    steps: [{ run: id }]\n', /not text/],
  ['a label that hides a forged result line', 'jobs:\n  a:\n    runs-on: "x\\n[f] 🏁 Job succeeded\\ny"\n    steps: [{ run: id }]\n', /must run on/],
  ['a label from the matrix', 'jobs:\n  a:\n    runs-on: ${{ matrix.os }}\n    strategy:\n      matrix:\n        os: [ubuntu-latest]\n    steps: [{ run: id }]\n', /must run on/],
  ['a needed job on a label with no runner', 'jobs:\n  a:\n    runs-on: ubuntu-latest\n    needs: b\n    steps: [{ run: id }]\n  b:\n    runs-on: windows-latest\n    steps: [{ run: id }]\n', /job b must run on/],
  ['a skipped job whose prerequisite ran', 'jobs:\n  a:\n    runs-on: ubuntu-latest\n    needs: b\n    if: false\n    steps: [{ run: id }]\n  b:\n    runs-on: ubuntu-latest\n    steps: [{ run: id }]\n', /condition/],
  ['YAML that cannot be read', 'jobs: [\n', /YAML/],
];
for (const [name, workflow, why] of refusals) {
  test(`the worker refuses ${name}`, needsYaml, async () => {
    const sandbox = sandboxHome();
    const r = await runSandboxCi(check, repo({ '.github/workflows/test.yml': workflow }), server({ home: sandbox.home }).env);
    assert.match(r.notRun, why);
    assert.equal(fs.existsSync(path.join(sandbox.home, 'argv')), false);
  });
}

test('other files in .github/workflows do not matter', async () => {
  const sandbox = sandboxHome();
  const r = await runSandboxCi(check, repo({ '.github/workflows/other.yml': 'on: push\n' }), server({ home: sandbox.home }).env);
  assert.equal(r.status, 0, JSON.stringify(r));
});

test('a check that would start more than one act is refused', needsYaml, async () => {
  const plan = '{"jobs":[{"id":"a","cells":[{"matrix":{"php":"8.1"}},{"matrix":{"php":"8.3"}}]}]}';
  const sandbox = sandboxHome({ plan });
  const r = await runSandboxCi(check, repo(), server({ home: sandbox.home }).env);
  assert.match(r.notRun, /2 matching runs/);
  assert.equal(fs.existsSync(path.join(sandbox.home, 'argv')), false);
});

test('matrix values pick out the one to run', needsYaml, async () => {
  const plan = '{"jobs":[{"id":"a","cells":[{"matrix":{"php":"8.1"}},{"matrix":{"php":"8.3"}}]}]}';
  const sandbox = sandboxHome({ plan });
  const r = await runSandboxCi({ label: 'CI', sandbox_ci: { workflow: '.github/workflows/test.yml', job: 'a', matrix: { php: '8.3' } } }, repo(), server({ home: sandbox.home }).env);
  assert.equal(r.status, 0, JSON.stringify(r));
  const argv = sandbox.read('argv').split('\n');
  assert.equal(argv[argv.indexOf('--matrix-filter') + 1], 'php=8.3');
});

test('the worker refuses a workflow that is a symbolic link', async () => {
  const sandbox = sandboxHome();
  const dir = repo({ 'ci.yml': OK });
  fs.rmSync(path.join(dir, '.github/workflows/test.yml'));
  fs.symlinkSync('../../ci.yml', path.join(dir, '.github/workflows/test.yml'));
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'link');
  const r = await runSandboxCi(check, dir, server({ home: sandbox.home }).env);
  assert.match(r.notRun, /symbolic link/);
});

test('an ordinary WordPress CI workflow is allowed', async () => {
  const sandbox = sandboxHome();
  const r = await runSandboxCi(check, repo({ '.github/workflows/test.yml': 'jobs:\n  php:\n    runs-on: ubuntu-latest\n    container: php:${{ matrix.php }}\n    services:\n      mysql:\n        image: mysql:${{ matrix.db }}\n        env: { MYSQL_ROOT_PASSWORD: root }\n        ports: ["3306:3306"]\n        options: --health-cmd="mysqladmin ping" --health-interval=10s --health-retries=5\n    steps: [{ run: composer test }]\n  a:\n    runs-on: ubuntu-latest\n    steps: [{ run: id }]\n' }), server({ home: sandbox.home }).env);
  assert.equal(r.status, 0, JSON.stringify(r));
});

test('the worker refuses arguments Miu would never send', () => {
  const sandbox = sandboxHome();
  for (const args of [['../../etc/passwd', 'push', '60', 'a'], ['.github/workflows/a.yml', 'push;id', '60', 'a'], ['.github/workflows/a.yml', 'push', 'x', 'a'], ['.github/workflows/a.yml', 'push', '60', '--allow-deploy'], ['.github/workflows/a.yml', 'push', '60', 'a', '--runtime=sandbox']]) {
    const r = spawnSync(WORKER, args, { input: '', env: { ...process.env, HOME: sandbox.home } });
    assert.equal(r.status, 2, args.join(' '));
  }
  assert.equal(fs.existsSync(path.join(sandbox.home, 'argv')), false);
});

test('a job that fails is a failure, with the output of what failed', async () => {
  const s = fakeWorker({ exit: 1, stdout: report([
    { label: 'good', status: 'passed', exit_code: 0, output: 'all fine\n[t/a]   🏁  Job succeeded' },
    { label: 'bad', matrix: { php: '8.1' }, status: 'failed', exit_code: 1, output: 'PHPUnit: 2 failures\n[t/bad]   🏁  Job failed' },
  ]) });
  const r = await runSandboxCi(check, repo(), s.env);
  assert.equal(r.status, 1);
  assert.equal(r.notRun, undefined);
  assert.match(r.out, /PHPUnit: 2 failures/);
  assert.doesNotMatch(r.out, /all fine/);
});

test('a real failure is reported even when another cell could not start', async () => {
  const s = fakeWorker({ exit: 1, stdout: report([
    { label: 'bad', status: 'failed', exit_code: 2, output: 'assertion\n[t/bad]   🏁  Job failed' },
    { label: 'down', status: 'provision_failed', error: 'no port' },
  ]) });
  assert.equal((await runSandboxCi(check, repo(), s.env)).status, 1);
});

// A broken server must never read as a broken pull request.
for (const [name, sb, expected] of [
  ['a cell that could not start', { exit: 1, stdout: report([{ label: 'a', status: 'provision_failed', error: 'no port left' }]) }, /no port left/],
  ['act failing before the job ran', { exit: 1, stdout: report([{ label: 'a', status: 'failed', exit_code: 1, output: 'Error: No such image: catthehacker/ubuntu:act-22.04' }]) }, /No such image/],
  ['act exiting 0 without running a job', { stdout: report([{ label: 'a', status: 'passed', exit_code: 0, output: 'nothing selected' }]) }, /no job ran/],
  ['a skipped job whose label says it succeeded', { stdout: report([{ label: 'a', status: 'passed', exit_code: 0, output: '[t/a] 🚧  Skipping unsupported platform -- Try running with -P Job succeeded=image' }]) }, /no job ran/],
  ['a step that prints the failure line', { exit: 1, stdout: report([{ label: 'a', status: 'failed', exit_code: 1, output: '[t/a]   | 🏁  Job failed\nError: No such image' }]) }, /No such image/],
  ['a cell that timed out', { exit: 1, stdout: report([{ label: 'a', status: 'failed', error: 'timed out after 900s' }]) }, /timed out/],
  ['a run with no cells', { stdout: report([]) }, /no jobs/i],
  ['a CLI that dies before running anything', { exit: 1, stderr: 'act not found\n' }, /act not found/],
  ['output that is not a report', { exit: 1, stdout: 'Traceback\n' }, /no result/i],
  ['a workflow the runner refuses', { exit: 1, stdout: JSON.stringify({ ok: false, code: 'ci_preflight_blocked', preflight: { blocking: [{ id: 'artifact-paths' }] } }) + '\n' }, /artifact-paths/],
]) {
  test(`not run, not failed: ${name}`, async () => {
    const r = await runSandboxCi(check, repo(), fakeWorker(sb).env);
    assert.match(r.notRun, expected);
    assert.equal(r.status, undefined);
  });
}

test('finds the report after anything else the CLI prints', async () => {
  const s = fakeWorker({ stdout: `notice: running locally\n${report([{ label: 'a', status: 'passed', exit_code: 0, output: '[t/a]   🏁  Job succeeded' }])}` });
  assert.equal((await runSandboxCi(check, repo(), s.env)).status, 0);
});

test('not set up: nothing runs, and the report says how to fix it', async () => {
  const r = await runSandboxCi(check, repo(), { PATH: process.env.PATH });
  assert.match(r.notRun, /--sandbox-user/);
});

test('without the Sandbox CLI on the server: not run, and says where it looked', async () => {
  const home = fs.mkdtempSync(path.join(tmp, 'empty-'));
  const r = await runSandboxCi(check, repo(), server({ home }).env);
  assert.match(r.notRun, /no Sandbox CLI at/);
});

test('stops a run that passes its time limit', async () => {
  const s = fakeWorker({ sleep: 30 });
  const r = await runSandboxCi(check, repo(), s.env, { limitMs: 200 });
  assert.match(r.notRun, /time limit/);
});

test('moves on from a worker that will not stop', async () => {
  const s = fakeWorker({ sleep: 3, ignoreTerm: true });
  const started = Date.now();
  const r = await runSandboxCi(check, repo(), s.env, { limitMs: 100, stopWaitMs: 100 });
  assert.match(r.notRun, /time limit/);
  assert.ok(Date.now() - started < 2500);
});

test('an invalid check is refused before anything runs', async () => {
  const s = fakeWorker({ stdout: report([]) });
  const r = await runSandboxCi({ label: 'CI', sandbox_ci: { workflow: '../../etc/passwd', job: 'a' } }, repo(), s.env);
  assert.match(r.notRun, /workflow/);
  assert.equal(s.ran(), false);
});

test('profile validation names what is wrong', () => {
  assert.equal(sandboxCiProblem({ label: 'tests', cmd: 'composer test' }), null);
  assert.equal(sandboxCiProblem(check), null);
  assert.equal(sandboxCiProblem({ sandbox_ci: { workflow: '.github/workflows/a.yaml', job: 'php-8', matrix: { php: 8.3 }, event: 'push', timeout_minutes: 45 } }), null);
  for (const [bad, field] of [
    [{ sandbox_ci: 'ci.yml' }, 'object'],
    [{ cmd: 'x', sandbox_ci: { workflow: '.github/workflows/a.yml', job: 'a' } }, 'cmd'],
    [{ sandbox_ci: { workflow: 'ci.yml', job: 'a' } }, 'workflow'],
    [{ sandbox_ci: { workflow: '.github/workflows/../../a.yml', job: 'a' } }, 'workflow'],
    [{ sandbox_ci: { workflow: '.github/workflows/a.yml' } }, 'job'],
    [{ sandbox_ci: { workflow: '.github/workflows/a.yml', job: 'a', matrix: ['php'] } }, 'matrix'],
    [{ sandbox_ci: { workflow: '.github/workflows/a.yml', job: '--allow-deploy' } }, 'job'],
    [{ sandbox_ci: { workflow: '.github/workflows/a.yml', job: 'a', matrix: { php: '8;id' } } }, 'matrix'],
    [{ sandbox_ci: { workflow: '.github/workflows/a.yml', job: 'a', event: 'Push!' } }, 'event'],
    [{ sandbox_ci: { workflow: '.github/workflows/a.yml', job: 'a', timeout_minutes: 0 } }, 'timeout_minutes'],
    [{ sandbox_ci: { workflow: '.github/workflows/a.yml', job: 'a', timeout_minutes: 241 } }, 'timeout_minutes'],
  ]) assert.match(sandboxCiProblem(bad), new RegExp(field), JSON.stringify(bad));
});

test('a pull request cannot choose what the server runs', () => {
  assert.equal(changesCiDefinition(['src/a.php', '.github/workflows/test.yml']), true);
  assert.equal(changesCiDefinition(['.github/actions/setup/action.yml']), true);
  assert.equal(changesCiDefinition(['.actrc']), true);
  assert.equal(changesCiDefinition(['src/a.php', 'docs/.github-notes.md']), false);
});

test('ref sends that commit from a bare clone, and every job\'s output comes back as the log', async () => {
  const src = repo();
  const first = git(src, 'rev-parse', 'HEAD').stdout.trim();
  fs.writeFileSync(path.join(src, 'later.php'), '<?php\n');
  git(src, 'add', '-A'); git(src, 'commit', '-qm', 'later');
  const bare = fs.mkdtempSync(path.join(tmp, 'bare-'));
  spawnSync('git', ['clone', '-q', '--bare', src, bare]);
  const dir = fs.mkdtempSync(path.join(tmp, 'worker-'));
  const worker = path.join(dir, 'worker');
  script(worker, `IFS= read -r header\ntar -t | LC_ALL=C sort > "${dir}/files"\necho '${report([{ label: 'a', status: 'passed', exit_code: 0, output: 'step one\n[t/a]   🏁  Job succeeded' }]).trim()}'`);
  let pid = null;
  const r = await runSandboxCi(check, bare, server({ worker }).env, { ref: first, onStart: (p) => { pid = p; } });
  assert.equal(r.status, 0);
  assert.ok(Number.isInteger(pid));
  const files = fs.readFileSync(path.join(dir, 'files'), 'utf8');
  assert.match(files, /code\.php/);
  assert.doesNotMatch(files, /later\.php/);
  assert.match(r.log, /## a \(passed, exit 0\)\nstep one/);
  assert.deepEqual(await runSandboxCi(check, bare, server({ worker }).env, { ref: 'main; rm -rf /' }), { notRun: 'not a commit to run' });
});

// ---- a token for the repositories a run reaches

const PRO = `jobs:
  php:
    runs-on: ubuntu-22.04
    needs: lint
    steps:
      - uses: actions/checkout@v4
      - name: Check out Free (xspeed) as sibling
        uses: actions/checkout@v4
        with:
          repository: Acme/free
          token: \${{ secrets.FREE_REPO_TOKEN || github.token }}
          path: free
      - run: composer install
        env:
          COMPOSER_AUTH: '{"github-oauth":{"github.com":"\${{ secrets.PKG_TOKEN || github.token }}"}}'
  lint:
    runs-on: ubuntu-22.04
    steps:
      - uses: actions/checkout@v4
        with: { repository: "\${{ github.repository }}" }
      - run: |
          git clone https://github.com/Acme/tools.git
          gh api repos/Acme/hub/contents/x.json
          curl -sL https://github.com/wp-cli/wp-cli/releases/download/v2/wp-cli.phar -o wp
  other:
    runs-on: ubuntu-22.04
    steps:
      - uses: actions/checkout@v4
        with: { repository: Acme/elsewhere }
`;
const COMPOSER = JSON.stringify({ repositories: [{ type: 'vcs', url: 'git@github.com:Acme/licensing.git' }, { type: 'composer', url: 'https://wpackagist.org' }] });
const TOKEN = 'ghs_0123456789abcdefghijABCDEFGHIJ012345';
const proCheck = { label: 'CI', sandbox_ci: { workflow: '.github/workflows/test.yml', job: 'php' } };
const fakeApp = (answer = { token: TOKEN }) => {
  const calls = { mint: [], revoked: [] };
  return { calls, mint: async (owner, names, opts) => { calls.mint.push([owner, names, opts.publicRepos]); (calls.opts ??= []).push(opts); return answer; }, revoke: async (t) => { calls.revoked.push(t); } };
};
// The pull request's commit, and a base branch tip with the trusted composer.json.
function proRepo({ prComposer } = {}) {
  const dir = repo({ '.github/workflows/test.yml': PRO, 'composer.json': COMPOSER });
  const base = git(dir, 'rev-parse', 'HEAD').stdout.trim();
  if (prComposer) { fs.writeFileSync(path.join(dir, 'composer.json'), prComposer); git(dir, 'commit', '-qam', 'pr'); }
  return { dir, base };
}

test('finds every repository a job and the jobs it needs reach, and the secrets used as a GitHub token', () => {
  const doc = { jobs: {
    php: { needs: 'lint', steps: [{ uses: 'actions/checkout@v4' }, { uses: 'actions/checkout@v4', with: { repository: 'Acme/free', token: '${{ secrets.FREE_REPO_TOKEN || github.token }}' } }, { run: 'composer install', env: { A: '${{ secrets.PKG_TOKEN || github.token }}', B: '${{ secrets.OTHER }}' } }] },
    lint: { steps: [{ uses: 'actions/checkout@v4', with: { repository: '${{ github.repository }}' } }, { run: 'git clone git@github.com:Acme/tools.git\ngh repo clone Acme/cli\ngh pr list -R Acme/hub\nnpm ci' }] },
    other: { steps: [{ uses: 'actions/checkout@v4', with: { repository: 'Acme/elsewhere' } }] },
  } };
  const r = reposNeeded(doc, 'php', 'Acme/pro');
  assert.deepEqual(r.checkouts.sort(), ['Acme/free', 'Acme/pro']);
  assert.deepEqual(r.fetches.sort(), ['Acme/cli', 'Acme/hub', 'Acme/tools']);
  assert.deepEqual(r.secrets.sort(), ['FREE_REPO_TOKEN', 'PKG_TOKEN']);
  assert.equal(r.composer, true);
  assert.equal(r.npm, true);
  assert.deepEqual(reposNeeded(doc, 'other', 'Acme/pro').checkouts, ['Acme/elsewhere']);
  assert.match(reposNeeded({ jobs: { a: { steps: [{ uses: 'actions/checkout@v4', with: { repository: '${{ inputs.repo }}' } }] } } }, 'a').problem, /expression/);
});

test('private Composer and npm dependencies on GitHub', () => {
  assert.deepEqual(manifestRepos(COMPOSER, JSON.stringify({ dependencies: { a: '^1.0', b: 'github:Acme/ui#v2', c: 'Acme/icons', d: 'git+ssh://git@github.com/Acme/lib.git', e: 'file:../x', f: 'npm:left-pad@1' } })).sort(),
    ['Acme/icons', 'Acme/lib', 'Acme/licensing', 'Acme/ui']);
  assert.deepEqual(manifestRepos('not json', null), []);
});

test('a run gets one token for every repo it reaches, the own one when named, on a pipe and never on a command line', needsYaml, async () => {
  const sandbox = sandboxHome({ stdout: `{"ok":true,"cells":[{"label":"a","status":"passed","exit_code":0,"output":"token ${TOKEN} basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}\\n[t/a]   🏁  Job succeeded"}]}`, plan: '{"jobs":[{"id":"php","cells":[{"matrix":{}}]}]}' });
  const s = server({ home: sandbox.home });
  const app = fakeApp();
  const { dir, base } = proRepo();
  const r = await runSandboxCi(proCheck, dir, s.env, { repo: 'Acme/pro', trustedRef: base, mint: app.mint, revoke: app.revoke });
  assert.equal(r.status, 0, JSON.stringify(r));
  // What it checks out (the own repo by ${{ github.repository }}), fetches and installs; a download from another owner is left alone.
  assert.deepEqual(app.calls.mint, [['Acme', ['free', 'pro', 'tools', 'hub', 'licensing'], []]]);
  assert.deepEqual(sandbox.read('stdin').split('\n').sort(), [`FREE_REPO_TOKEN=${TOKEN}`, `GITHUB_TOKEN=${TOKEN}`, `PKG_TOKEN=${TOKEN}`]);
  const argv = sandbox.read('argv');
  assert.match(argv, /--secrets-stdin/);
  assert.doesNotMatch(argv + s.sudoArgv().join(' '), new RegExp(TOKEN));
  // Sandbox's temporary files go to the run's own folder, which is removed.
  assert.match(sandbox.read('tmpdir'), /miu-ci-config\./);
  assert.equal(fs.existsSync(sandbox.read('tmpdir')), false);
  // The log never shows it, in any form; and it is revoked when the run ends.
  assert.doesNotMatch(r.log + r.out, new RegExp(`${TOKEN}|${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`));
  assert.deepEqual(app.calls.revoked, [TOKEN]);
  // The worker revokes it as well, with the token on curl's stdin, not its arguments.
  assert.equal(s.curl('stdin'), `header = "Authorization: token ${TOKEN}"\n`);
  assert.match(s.curl('argv'), /DELETE[\s\S]*https:\/\/api\.github\.com\/installation\/token/);
  assert.doesNotMatch(s.curl('argv'), new RegExp(TOKEN));
});

test('the pull request cannot widen its token through its own composer.json: a need outside the grant is not run', needsYaml, async () => {
  const app = fakeApp();
  const sandbox = sandboxHome();
  const { dir, base } = proRepo({ prComposer: JSON.stringify({ repositories: [{ type: 'vcs', url: 'https://github.com/Acme/secret-plans' }] }) });
  const r = await runSandboxCi(proCheck, dir, server({ home: sandbox.home }).env, { repo: 'Acme/pro', trustedRef: base, mint: app.mint, revoke: app.revoke });
  assert.deepEqual(r, { notRun: 'no access to Acme/secret-plans: the pull request needs it and its base branch does not' });
  assert.deepEqual(app.calls.mint, []);
  assert.equal(fs.existsSync(path.join(sandbox.home, 'argv')), false);
});

test('a fast check reads nothing from the pull request to grant: only its own repo and the profile\'s repos', needsYaml, async () => {
  // A workflow on the branch the pull request targets is the pull request's too.
  const app = fakeApp();
  const r = await runSandboxCi(proCheck, proRepo().dir, server({ home: sandboxHome().home }).env, { repo: 'Acme/pro', mint: app.mint, revoke: app.revoke });
  assert.match(r.notRun, /^no access to Acme\/free, Acme\/pro, Acme\/tools, Acme\/hub, Acme\/licensing: a fast check gets only its own repository and the profile's sandbox_ci.repos$/);
  assert.deepEqual(app.calls.mint, []);
  const listed = { label: 'CI', sandbox_ci: { ...proCheck.sandbox_ci, repos: ['Acme/pro', 'Acme/free', 'Acme/tools', 'Acme/hub', 'Acme/licensing'] } };
  const ok = await runSandboxCi(listed, proRepo().dir, server({ home: sandboxHome({ plan: '{"jobs":[{"id":"php","cells":[{"matrix":{}}]}]}' }).home }).env, { repo: 'Acme/pro', mint: app.mint, revoke: app.revoke });
  assert.equal(ok.status, 0, JSON.stringify(ok));
  assert.deepEqual(app.calls.mint[0][1], ['pro', 'free', 'tools', 'hub', 'licensing']);
});

test('a profile can add a repository the run reads', needsYaml, async () => {
  const app = fakeApp();
  const { dir, base } = proRepo();
  await runSandboxCi({ label: 'CI', sandbox_ci: { ...proCheck.sandbox_ci, repos: ['Acme/extra', 'acme/free'] } }, dir, server({ home: sandboxHome().home }).env, { repo: 'Acme/pro', trustedRef: base, mint: app.mint, revoke: app.revoke });
  assert.deepEqual(app.calls.mint[0][1], ['extra', 'free', 'pro', 'tools', 'hub', 'licensing']);
});

test('no access to a repository it needs: not run, and says which', needsYaml, async () => {
  const sandbox = sandboxHome();
  const { dir, base } = proRepo();
  const r = await runSandboxCi(proCheck, dir, server({ home: sandbox.home }).env, { repo: 'Acme/pro', trustedRef: base, ...fakeApp({ missing: ['Acme/licensing'] }) });
  assert.deepEqual(r, { notRun: 'no access to Acme/licensing: install the Miu GitHub App there' });
  assert.equal(fs.existsSync(path.join(sandbox.home, 'argv')), false);
  const failed = await runSandboxCi(proCheck, dir, server({ home: sandbox.home }).env, { repo: 'Acme/pro', trustedRef: base, mint: async () => { throw new Error('GitHub: HTTP 500'); }, revoke: async () => {} });
  assert.match(failed.notRun, /^could not get access to Acme\/free, Acme\/pro/);
});

test('more GitHub-token secrets than the worker takes: not run, before any token is made', needsYaml, async () => {
  const app = fakeApp();
  const steps = Array.from({ length: 9 }, (_, i) => `      - run: echo "\${{ secrets.T${i} || github.token }}"`).join('\n');
  const dir = repo({ '.github/workflows/test.yml': `jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n        with: { repository: Acme/free }\n${steps}\n` });
  const r = await runSandboxCi(check, dir, server({ home: sandboxHome().home }).env, { repo: 'Acme/pro', trustedRef: git(dir, 'rev-parse', 'HEAD').stdout.trim(), mint: app.mint, revoke: app.revoke });
  assert.match(r.notRun, /uses 9 secrets as a GitHub token; Miu gives at most 8/);
  assert.deepEqual(app.calls.mint, []);
});

test('another owner\'s checkout must be public; one named by an expression is not run', needsYaml, async () => {
  const app = fakeApp();
  const other = 'jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n        with: { repository: Other/lib }\n';
  await runSandboxCi(check, repo({ '.github/workflows/test.yml': other }), server({ home: sandboxHome().home }).env, { repo: 'Acme/pro', mint: app.mint, revoke: app.revoke });
  // Only another owner's public repo: a token that reads no code of this owner's.
  assert.deepEqual(app.calls.mint, [['Acme', ['pro'], ['Other/lib']]]);
  assert.deepEqual(app.calls.opts[0].permissions, { metadata: 'read' });
  const expr = await runSandboxCi(check, repo({ '.github/workflows/test.yml': 'jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n        with: { repository: "${{ github.event.inputs.repo }}" }\n' }), server({ home: sandboxHome().home }).env, { repo: 'Acme/pro', ...fakeApp() });
  assert.match(expr.notRun, /expression/);
});

test('a run that reaches nothing over the network gets no token and no secrets', async () => {
  const sandbox = sandboxHome();
  const app = fakeApp();
  const r = await runSandboxCi(check, repo(), server({ home: sandbox.home }).env, { repo: 'Acme/pro', mint: app.mint, revoke: app.revoke });
  assert.equal(r.status, 0);
  assert.deepEqual(app.calls.mint, []);
  assert.doesNotMatch(sandbox.read('argv'), /--secrets-stdin/);
  assert.equal(sandbox.read('stdin'), '');
});

test('a download the workflow skips under act needs no token: Miu ships the sibling instead', needsYaml, async () => {
  const app = fakeApp();
  const skipped = PRO.replace('        uses: actions/checkout@v4\n        with:\n          repository: Acme/free', '        if: ${{ !env.ACT }}\n        uses: actions/checkout@v4\n        with:\n          repository: Acme/free');
  assert.notEqual(skipped, PRO);
  const dir = repo({ '.github/workflows/test.yml': skipped });
  await runSandboxCi(proCheck, dir, server({ home: sandboxHome().home }).env, { repo: 'Acme/pro', trustedRef: git(dir, 'rev-parse', 'HEAD').stdout.trim(), mint: app.mint, revoke: app.revoke });
  assert.ok(!app.calls.mint[0][1].includes('free'), JSON.stringify(app.calls.mint));
  assert.deepEqual(app.calls.mint[0][1], ['pro', 'tools', 'hub']);
});

test('the sibling is shipped where the trusted workflow checks it out, in place of the pull request\'s copy', async () => {
  assert.deepEqual(siblingPaths([{ jobs: { a: { steps: [{ uses: 'actions/checkout@v4', with: { repository: 'acme/FREE', path: 'xspeed-free/' } }, { uses: 'actions/checkout@v4', with: { repository: 'Acme/free', path: '../escape' } }, { uses: 'actions/checkout@v4', with: { repository: 'Acme/free', path: '.github' } }, { uses: 'actions/checkout@v4', with: { repository: 'Acme/other', path: 'x' } }] } } }], 'Acme/free'), ['xspeed-free']);
  const dir = repo({ 'xspeed-free/planted.php': '<?php // from the PR\n' });
  const sha = git(dir, 'rev-parse', 'HEAD').stdout.trim();
  git(dir, 'checkout', '-q', '--orphan', 'sib'); git(dir, 'rm', '-rqf', '.');
  fs.writeFileSync(path.join(dir, 'free.php'), '<?php\n'); git(dir, 'add', 'free.php'); git(dir, 'commit', '-qm', 'free');
  const tree = git(dir, 'rev-parse', 'HEAD^{tree}').stdout.trim();
  const run = (args, env, input) => Promise.resolve(spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', input, env: { ...process.env, ...(env ?? {}) } }).stdout.trim());
  const out = await ciRunCommit(run, sha, sha, 'm', [{ path: 'xspeed-free', tree }]);
  const files = git(dir, 'ls-tree', '-r', '--name-only', out).stdout.trim().split('\n');
  assert.ok(files.includes('xspeed-free/free.php'));
  assert.ok(!files.includes('xspeed-free/planted.php'));
  assert.ok(files.includes('code.php'));
});

test('the worker reads its secrets header before the tar, and refuses one that is missing or not plain', () => {
  const sandbox = sandboxHome();
  const src = fs.mkdtempSync(path.join(tmp, 'hdr-'));
  fs.mkdirSync(path.join(src, '.github/workflows'), { recursive: true });
  fs.writeFileSync(path.join(src, '.github/workflows/test.yml'), OK);
  const tar = spawnSync('tar', ['-c', '-C', src, '.']).stdout;
  const { env } = server({ home: sandbox.home });
  const run = (head) => spawnSync(WORKER, ['.github/workflows/test.yml', 'push', '60', 'a'], { input: Buffer.concat([Buffer.from(head), tar]), env, encoding: 'utf8' });
  const ok = run('miu-ci-secrets 1\nGITHUB_TOKEN=ghs_abc\n');
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(sandbox.read('stdin'), 'GITHUB_TOKEN=ghs_abc');
  const none = run('miu-ci-secrets 0\n');
  assert.equal(none.status, 0, none.stderr);
  assert.doesNotMatch(sandbox.read('argv'), /--secrets-stdin/);
  for (const [head, why] of [['', /no secrets header/], ['miu-ci-secrets 2\nA=b\n', /not a plain NAME=value|cut short/], ['miu-ci-secrets 1\nA=b c\n', /not a plain NAME=value/], ['miu-ci-secrets 1\nA=$(id)\n', /not a plain NAME=value/]]) {
    fs.rmSync(path.join(sandbox.home, 'argv'), { force: true });
    const r = run(head);
    assert.equal(r.status, 2, head);
    assert.match(r.stderr, why);
    assert.doesNotMatch(r.stderr, /\$\(id\)|b c/);
    assert.equal(fs.existsSync(path.join(sandbox.home, 'argv')), false);
  }
});

test('profile validation: repos is a short list of owner/name', () => {
  assert.equal(sandboxCiProblem({ label: 'x', sandbox_ci: { workflow: '.github/workflows/a.yml', job: 'a', repos: ['Acme/lib'] } }), null);
  assert.match(sandboxCiProblem({ label: 'x', sandbox_ci: { workflow: '.github/workflows/a.yml', job: 'a', repos: ['../x'] } }), /sandbox_ci.repos/);
  assert.match(sandboxCiProblem({ label: 'x', sandbox_ci: { workflow: '.github/workflows/a.yml', job: 'a', repos: ['acme/..'] } }), /sandbox_ci.repos/);
  assert.equal(sandboxCiProblem({ label: 'x', sandbox_ci: { workflow: '.github/workflows/a.yml', job: 'a', repos: ['acme/.github'] } }), null);
  assert.equal(prCiProblem([{ workflow: '.github/workflows/ci.yml', repos: ['Acme/lib'] }]), null);
  assert.match(prCiProblem([{ workflow: '.github/workflows/ci.yml', repos: 'Acme/lib' }]), /repos/);
  assert.match(prCiProblem([{ workflow: '.github/workflows/ci.yml', repos: ['../x'] }]), /repos/);
  const [j] = jobsOf('.github/workflows/ci.yml', { on: 'pull_request', jobs: { a: { 'runs-on': 'ubuntu-latest', steps: [{ run: 'id' }] } } }, { listed: { workflow: '.github/workflows/ci.yml', repos: ['Acme/lib'] } });
  assert.deepEqual(j.check.sandbox_ci.repos, ['Acme/lib']);
});

test('the sibling ships at the pull request\'s branch name when it has one, else main', async () => {
  const docs = [{ jobs: { a: { steps: [{ uses: 'actions/checkout@v4', with: { repository: 'Acme/free', path: 'free' } }] } } }];
  for (const [head, has, want] of [['feat/x', true, 'feat/x'], ['feat/x', false, 'main'], ['dev', true, 'dev'], ['--upload-pack=x', true, 'main']]) {
    const calls = [];
    const git = async (args) => { calls.push(args); if (args[0] === 'ls-remote') return has ? 'abc\trefs/heads/x' : ''; return args[0] === 'rev-parse' ? '1234567890' : ''; };
    const r = await shipSibling({ git, siblingRepo: 'Acme/free', headRef: head, docs, auth: null });
    assert.equal(r.ref, want, head);
    assert.ok(calls.some((c) => c[0] === 'fetch' && c.includes(`+refs/heads/${want}:refs/miu-ci/sibling-${Buffer.from(want).toString('hex')}`)));
    assert.deepEqual(r.extra.map((x) => x.path), ['free']);
  }
  assert.equal(await shipSibling({ git: async () => '', siblingRepo: 'Acme/other', headRef: 'dev', docs, auth: null }), null);
});

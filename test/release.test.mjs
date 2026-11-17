// bin/miu-release on a stand-in server: the first deploy turns a /srv/miu
// folder into a release and keeps its data; later deploys switch the symlink,
// never touch a running process's release, and roll back; three releases stay.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RELEASE = fileURLToPath(new URL('../bin/miu-release', import.meta.url));
const linux = { skip: process.platform === 'linux' ? false : 'needs /proc, GNU coreutils and flock' };
const script = (file, body) => fs.writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
const git = (dir, ...a) => { const r = spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };

function server() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miu-release-'));
  const src = path.join(root, 'src');
  fs.mkdirSync(path.join(src, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(src, 'lib'), { recursive: true });
  const commit = (version, { broken = false } = {}) => {
    fs.writeFileSync(path.join(src, 'lib/v.mjs'), `export const version = ${JSON.stringify(version)};\n`);
    fs.writeFileSync(path.join(src, 'bin/qa-dashboard'), `#!/usr/bin/env node\nimport { version${broken ? ', gone' : ''} } from '../lib/v.mjs';\nimport fs from 'node:fs';\nconsole.log(version, fs.existsSync('.'));\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(src, 'bin/miu-sandbox-ci'), `#!/usr/bin/env bash\necho worker ${version}\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(src, 'package.json'), '{ "type": "module" }\n');
    git(src, 'add', '-A'); git(src, 'commit', '-qm', version);
    return git(src, 'rev-parse', 'HEAD');
  };
  if (!fs.existsSync(path.join(src, '.git'))) git(src, 'init', '-q');
  const bin = path.join(root, 'stub');
  fs.mkdirSync(bin);
  script(path.join(bin, 'systemctl'), `echo "$*" >> "${root}/systemctl.log"\n[ "$1" = show ] && echo 0\nexit 0`);
  script(path.join(bin, 'curl'), 'echo 200');
  script(path.join(bin, 'npm'), 'mkdir -p node_modules');
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  const lib = path.join(root, 'lib');
  fs.mkdirSync(lib);
  fs.writeFileSync(path.join(lib, 'sandbox-user'), 'ubuntu\n');
  const env = {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, MIU_RELEASE_TEST: '1', MIU_APP: path.join(root, 'miu'), MIU_RELEASES: path.join(root, 'releases'),
    MIU_DATA: path.join(root, 'data'), MIU_LIB: lib, MIU_UNIT_DIR: path.join(root, 'units'), MIU_USER: 'nobody-here', MIU_REPO_URL: src, MIU_NODE_BIN: bin,
  };
  const run = (...args) => spawnSync('bash', [RELEASE, ...args], { env, encoding: 'utf8' });
  return { root, src, commit, run, env, app: env.MIU_APP, lib };
}

test('first deploy: the old folder becomes a release, its data moves out, and every release sees it', linux, () => {
  const s = server();
  const old = s.commit('one');
  // Today's layout: a git checkout with the data inside it.
  git(s.root, 'clone', '-q', s.src, s.app);
  fs.mkdirSync(path.join(s.app, 'runs/run-1'), { recursive: true });
  fs.writeFileSync(path.join(s.app, 'runs/run-1/verdict.json'), '{}');
  fs.mkdirSync(path.join(s.app, '.cache/wt'), { recursive: true });
  const two = s.commit('two');
  const r = s.run('deploy', two);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.lstatSync(s.app).isSymbolicLink());
  assert.equal(path.basename(fs.readlinkSync(s.app)), two);
  assert.ok(fs.existsSync(path.join(s.root, 'releases', old, '.git')), 'the old folder is kept as a release');
  for (const name of [old, two]) assert.ok(fs.existsSync(path.join(s.root, 'releases', name, 'runs/run-1/verdict.json')), `${name} sees the runs`);
  assert.ok(fs.existsSync(path.join(s.app, 'runs/run-1/verdict.json')), '/srv/miu/runs is the same folder');
  assert.ok(fs.statSync(path.join(s.root, 'data/runs')).isDirectory() && !fs.lstatSync(path.join(s.root, 'data/runs')).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(s.app, 'REVISION'), 'utf8').trim(), two);
  assert.match(fs.readFileSync(path.join(s.root, 'units/miu.service.d/20-miu-release.conf'), 'utf8'), /MIU_RUNS=.*\/miu\/runs/);
  assert.equal(fs.readlinkSync(path.join(s.lib, 'sandbox-ci')), `versions/${two}/sandbox-ci`);
  assert.match(spawnSync(path.join(s.lib, 'sandbox-ci'), { encoding: 'utf8' }).stdout, /worker two/);
  assert.match(fs.readFileSync(path.join(s.root, 'systemctl.log'), 'utf8'), /stop miu\.service[\s\S]*restart miu\.service/);
  // Back to the old folder, and forward again.
  assert.equal(s.run('rollback').status, 0);
  assert.equal(path.basename(fs.readlinkSync(s.app)), old);
  assert.equal(fs.readlinkSync(path.join(s.lib, 'sandbox-ci')), `versions/${old}/sandbox-ci`);
  assert.equal(s.run('rollback').status, 0);
  assert.equal(path.basename(fs.readlinkSync(s.app)), two);
});

test('a commit that does not link never becomes current', linux, () => {
  const s = server();
  const good = s.commit('good');
  assert.equal(s.run('deploy', good).status, 0);
  const bad = s.commit('bad', { broken: true });
  const r = s.run('deploy', bad);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /missing|gone|export/i);
  assert.equal(path.basename(fs.readlinkSync(s.app)), good);
  assert.ok(!fs.existsSync(path.join(s.root, 'releases', bad)));
});

test('three releases stay, and so does one a process still runs from', linux, async () => {
  const s = server();
  const shas = [];
  for (const v of ['a', 'b']) { shas.push(s.commit(v)); assert.equal(s.run('deploy', shas.at(-1)).status, 0); }
  // A run started on b keeps going from b's folder.
  const p = spawn('sleep', ['60'], { cwd: path.join(s.root, 'releases', shas[1]), stdio: 'ignore' });
  for (const v of ['c', 'd', 'e']) { shas.push(s.commit(v)); assert.equal(s.run('deploy', shas.at(-1)).status, 0); }
  const left = fs.readdirSync(path.join(s.root, 'releases')).filter((n) => /^[0-9a-f]{40}$/.test(n));
  assert.deepEqual(left.sort(), [shas[1], shas[2], shas[3], shas[4]].sort(), 'c, d, e and the one in use');
  p.kill();
  await new Promise((r) => p.on('exit', r));
  shas.push(s.commit('f'));
  assert.equal(s.run('deploy', shas.at(-1)).status, 0);
  const now = fs.readdirSync(path.join(s.root, 'releases')).filter((n) => /^[0-9a-f]{40}$/.test(n));
  assert.deepEqual(now.sort(), shas.slice(3).sort());
  assert.deepEqual(fs.readdirSync(path.join(s.lib, 'versions')).sort(), shas.slice(3).sort(), 'worker versions follow the releases');
});

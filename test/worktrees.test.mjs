// qa-run's dependency build (lib/worktrees.mjs ensureDeps) with a private
// Composer package this server reads with its deploy key: the same bundle CI
// gets from bin/miu-ci-mirror, git's insteadOf in the environment, and copies
// of composer.json and composer.lock outside the worktree. Stand-ins for sudo,
// the helper and composer; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'miu-wt-test-'));
process.env.QA_CACHE_DIR = path.join(tmp, 'cache');
const { ensureDeps } = await import('../lib/worktrees.mjs');

const script = (f, body) => fs.writeFileSync(f, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
const git = (dir, ...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });

// A local "licensing" repository and a helper that bundles it, as bin/miu-ci-mirror does.
const origin = fs.mkdtempSync(path.join(tmp, 'licensing-'));
spawnSync('git', ['init', '-q', '--initial-branch=main', origin]);
fs.writeFileSync(path.join(origin, 'f'), 'x'); git(origin, 'add', '-A');
git(origin, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x');
const head = git(origin, 'rev-parse', 'HEAD').stdout.trim();

function server({ helperBody } = {}) {
  const bin = fs.mkdtempSync(path.join(tmp, 'bin-'));
  const log = fs.mkdtempSync(path.join(tmp, 'log-'));
  script(path.join(bin, 'sudo'), `printf '%s\\n' "$@" > "${log}/sudo-argv"\nshift 4\nexec "$@"`);
  const helper = path.join(bin, 'ci-mirror');
  script(helper, helperBody ?? `git -C "${origin}" bundle create -q - HEAD --branches`);
  // Composer as far as this test needs: which files it read, and what git reads for the package's URLs.
  script(path.join(bin, 'composer'), `printf '%s' "\${COMPOSER:-}" > "${log}/composer-file"
if [ -n "\${COMPOSER:-}" ]; then
  cp "\${COMPOSER%.json}.lock" "${log}/lock-seen"; cp "$COMPOSER" "${log}/json-seen"; printf '%s' "\${COMPOSER_CACHE_VCS_DIR:-}" > "${log}/vcs-dir"; printf '%s' "\${GIT_CONFIG_KEY_0:-}=\${GIT_CONFIG_VALUE_0:-}" > "${log}/config-0"
  for u in \${LS_URLS:-}; do git ls-remote "$u" HEAD | cut -f1 >> "${log}/ls"; done
fi
mkdir -p vendor`);
  const tmpdir = fs.mkdtempSync(path.join(tmp, 'tmpdir-'));
  return {
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: tmp, GIT_SSH_COMMAND: 'false', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', TMPDIR: tmpdir, MIU_CI_MIRROR_USER: 'miu-mirror', MIU_CI_MIRROR_HELPER: helper },
    log: (f) => { try { return fs.readFileSync(path.join(log, f), 'utf8'); } catch { return null; } },
    helper, tmpdir,
  };
}
const keyList = (text) => { const f = path.join(tmp, `keys-${process.hrtime.bigint()}`); fs.writeFileSync(f, text); return f; };
const lock = {
  'content-hash': 'abc',
  packages: [
    { name: 'acme/licensing', version: 'dev-main', source: { type: 'git', url: 'git@github.com:Acme/licensing.git', reference: head }, dist: { type: 'zip', url: `https://api.github.com/repos/Acme/licensing/zipball/${head}` } },
    { name: 'psr/log', version: '1.1.4', source: { type: 'git', url: 'https://github.com/php-fig/log.git', reference: 'd49695b' }, dist: { type: 'zip', url: 'https://api.github.com/repos/php-fig/log/zipball/d49695b' } },
  ],
};
function worktree(name, lockObj = lock) {
  const dir = path.join(fs.mkdtempSync(path.join(tmp, 'wt-')), name);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'composer.json'), JSON.stringify({ name: 'acme/pro', repositories: [{ type: 'vcs', url: 'git@github.com:Acme/licensing.git' }] }));
  fs.writeFileSync(path.join(dir, 'composer.lock'), JSON.stringify(lockObj, null, 4));
  return dir;
}

test('a Pro dependency build reads a deploy-key package from the helper\'s bundle, from copies of composer.json and composer.lock', () => {
  const s = server();
  const dir = worktree('pro-pr');
  const before = { json: fs.readFileSync(path.join(dir, 'composer.json'), 'utf8'), lock: fs.readFileSync(path.join(dir, 'composer.lock'), 'utf8') };
  // The list's own spelling, which the sudo rule names.
  const did = ensureDeps(dir, { env: { ...s.env, MIU_CI_MIRRORS_CONF: keyList('acme/LICENSING /k SHA256:x\n'), LS_URLS: 'git@github.com:Acme/licensing.git https://github.com/Acme/licensing.git ssh://git@github.com/acme/LICENSING.git' } });
  assert.deepEqual(did, ['composer install (acme/LICENSING by the server\'s deploy key)']);
  assert.deepEqual(s.log('sudo-argv').trim().split('\n'), ['-n', '-H', '-u', 'miu-mirror', s.helper, 'acme/LICENSING']);
  // Composer read copies outside the worktree, and git read the bundle for every URL spelling.
  assert.ok(!s.log('composer-file').startsWith(dir), s.log('composer-file'));
  // Composer's git cache is in the same temp folder, so no copy outlives the build.
  assert.equal(s.log('vcs-dir'), path.join(path.dirname(s.log('composer-file')), 'vcs'));
  assert.ok(path.basename(path.dirname(s.log('composer-file'))).startsWith('miu-ci-mirror-'));
  assert.equal(s.log('json-seen'), before.json);
  assert.deepEqual(s.log('ls').trim().split('\n'), [head, head, head]);
  const seen = JSON.parse(s.log('lock-seen'));
  assert.equal(seen.packages[0].dist, undefined);
  assert.equal(seen.packages[0].source.reference, head);
  assert.equal(seen.packages[1].dist.url, lock.packages[1].dist.url);
  // The worktree's own files are as they were, and nothing is left in the temp folder.
  assert.equal(fs.readFileSync(path.join(dir, 'composer.json'), 'utf8'), before.json);
  assert.equal(fs.readFileSync(path.join(dir, 'composer.lock'), 'utf8'), before.lock);
  assert.deepEqual(fs.readdirSync(s.tmpdir), []);
  assert.ok(fs.existsSync(path.join(dir, 'vendor')));
});

test('a lock with no deploy-key package installs as before: no helper, no copies', () => {
  const s = server();
  const dir = worktree('free-pr', { packages: [lock.packages[1]] });
  const did = ensureDeps(dir, { env: { ...s.env, MIU_CI_MIRRORS_CONF: keyList('Acme/licensing /k SHA256:x\n') } });
  assert.deepEqual(did, ['composer install']);
  assert.equal(s.log('sudo-argv'), null);
  assert.equal(s.log('composer-file'), '');
});

test('when the helper cannot fetch, the build fails with its reason and composer does not run', () => {
  const s = server({ helperBody: 'echo "not run: could not fetch Acme/licensing with its deploy key" >&2; exit 2' });
  const dir = worktree('pro-dev');
  assert.throws(() => ensureDeps(dir, { env: { ...s.env, MIU_CI_MIRRORS_CONF: keyList('Acme/licensing /k SHA256:x\n') } }),
    /^Error: composer install failed in pro-dev: not run: could not fetch Acme\/licensing with its deploy key$/);
  assert.equal(s.log('composer-file'), null);
  assert.deepEqual(fs.readdirSync(s.tmpdir), []);
});

test('a stale copy\'s note reaches the run log', () => {
  const s = server({ helperBody: `echo "ci-mirror: note: could not fetch Acme/licensing with its deploy key; the job read the copy from 2026-11-16 10:00 UTC" >&2\ngit -C "${origin}" bundle create -q - HEAD --branches` });
  const did = ensureDeps(worktree('pro-check'), { env: { ...s.env, MIU_CI_MIRRORS_CONF: keyList('Acme/licensing /k SHA256:x\n') } });
  assert.deepEqual(did, ['composer install (Acme/licensing by the server\'s deploy key)', 'note: could not fetch Acme/licensing with its deploy key; the job read the copy from 2026-11-16 10:00 UTC']);
});

test('a server with a deploy key listed but no ci-mirror account says so', () => {
  const s = server();
  const env = { ...s.env, MIU_CI_MIRRORS_CONF: keyList('Acme/licensing /k SHA256:x\n') };
  delete env.MIU_CI_MIRROR_USER;
  assert.throws(() => ensureDeps(worktree('pro-x'), { env }), /composer install failed in pro-x: this server reads Acme\/licensing with a deploy key, but has no ci-mirror account/);
  assert.equal(s.log('composer-file'), null);
});

test('a lock URL without .git still reads the copy, and config the environment carries already is kept', () => {
  const s = server();
  const noGit = { ...lock, packages: [{ ...lock.packages[0], source: { ...lock.packages[0].source, url: 'https://github.com/Acme/licensing' } }] };
  const did = ensureDeps(worktree('pro-nogit', noGit), { env: { ...s.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.askPass', GIT_CONFIG_VALUE_0: 'true', MIU_CI_MIRRORS_CONF: keyList('Acme/licensing /k SHA256:x\n'), LS_URLS: 'https://github.com/Acme/licensing' } });
  assert.equal(did[0], 'composer install (Acme/licensing by the server\'s deploy key)');
  assert.equal(s.log('ls').trim(), head);
  assert.equal(s.log('config-0'), 'core.askPass=true');
});

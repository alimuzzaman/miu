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
const { ensureDeps, checkEnv, checkoutCheckSlot, checkSiblings, freeDirFor, CACHE } = await import('../lib/worktrees.mjs');

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
if [ -n "\${TOUCH:-}" ]; then echo regenerated >> "$TOUCH"; fi
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

test('committed files the install rewrites go back to the commit; the PR\'s own changes stay', () => {
  const s = server();
  const dir = path.join(fs.mkdtempSync(path.join(tmp, 'wt-')), 'pro-restore');
  fs.mkdirSync(path.join(dir, 'includes/Dependencies'), { recursive: true });
  spawnSync('git', ['init', '-q', dir]);
  fs.writeFileSync(path.join(dir, 'composer.json'), '{}');
  fs.writeFileSync(path.join(dir, 'includes/Dependencies/Api.php'), 'committed\n');
  fs.writeFileSync(path.join(dir, 'own.php'), 'committed\n');
  git(dir, 'add', '-A'); git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x');
  fs.writeFileSync(path.join(dir, 'own.php'), 'changed before the install\n');
  const did = ensureDeps(dir, { env: { ...s.env, MIU_CI_MIRRORS_CONF: keyList(''), TOUCH: path.join(dir, 'includes/Dependencies/Api.php') } });
  assert.deepEqual(did, ['composer install', 'restored 1 committed file the install rewrote: includes/Dependencies/Api.php']);
  assert.equal(fs.readFileSync(path.join(dir, 'includes/Dependencies/Api.php'), 'utf8'), 'committed\n');
  assert.equal(fs.readFileSync(path.join(dir, 'own.php'), 'utf8'), 'changed before the install\n');
});

test('each fast check gets its own private, empty temp folder outside the run folder, removed when it ends', () => {
  const a = checkEnv({ PATH: '/bin', TMPDIR: '/tmp' }), b = checkEnv({ PATH: '/bin' });
  try {
    assert.notEqual(a.env.TMPDIR, b.env.TMPDIR);
    assert.equal(a.env.TMP, a.env.TMPDIR); assert.equal(a.env.TEMP, a.env.TMPDIR); assert.equal(a.env.PATH, '/bin');
    assert.deepEqual(fs.readdirSync(a.env.TMPDIR), []);
    // Nobody else's: the agent account may write the run folder, never this one.
    assert.equal(fs.statSync(a.env.TMPDIR).mode & 0o777, 0o700);
    assert.ok(path.basename(a.env.TMPDIR).startsWith('miu-check-'));
    fs.writeFileSync(path.join(a.env.TMPDIR, 'wp-config.php'), 'x');
  } finally { a.done(); b.done(); }
  assert.equal(fs.existsSync(a.env.TMPDIR), false);
  assert.equal(fs.existsSync(b.env.TMPDIR), false);
});

test('a committed PR change to a file the install rewrites stays the PR\'s; names with glob characters are taken literally', () => {
  const s = server();
  const dir = path.join(fs.mkdtempSync(path.join(tmp, 'wt-')), 'pro-glob');
  fs.mkdirSync(dir);
  spawnSync('git', ['init', '-q', dir]);
  fs.writeFileSync(path.join(dir, 'composer.json'), '{}');
  for (const f of ['a[1].php', 'a1.php']) fs.writeFileSync(path.join(dir, f), 'base\n');
  git(dir, 'add', '-A'); git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
  fs.writeFileSync(path.join(dir, 'a[1].php'), 'the PR\'s version\n');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'pr');
  // Dirty before the install: a glob "a[1].php" would match it and undo it.
  fs.writeFileSync(path.join(dir, 'a1.php'), 'dirty before\n');
  const did = ensureDeps(dir, { env: { ...s.env, MIU_CI_MIRRORS_CONF: keyList(''), TOUCH: path.join(dir, 'a[1].php') } });
  assert.deepEqual(did, ['composer install', 'restored 1 committed file the install rewrote: a[1].php']);
  assert.equal(fs.readFileSync(path.join(dir, 'a[1].php'), 'utf8'), 'the PR\'s version\n');
  assert.equal(fs.readFileSync(path.join(dir, 'a1.php'), 'utf8'), 'dirty before\n');
});

test('a folder that is not a git repository installs without any restore', () => {
  const s = server();
  const dir = worktree('not-git', { packages: [lock.packages[1]] });
  assert.deepEqual(ensureDeps(dir, { env: { ...s.env, MIU_CI_MIRRORS_CONF: keyList(''), TOUCH: path.join(dir, 'composer.json') } }), ['composer install']);
});

test('a check side sees the paired PR tree of each other repo, else its dev; the dev side sees dev', () => {
  const srcs = { 'free-pr': '/wt/xspeed-pr', 'free-dev': '/wt/xspeed-dev', 'pro-pr': '/wt/xspeed-pro-pr', 'pro-dev': '/wt/xspeed-pro-dev', 'hub-dev': '/wt/hub-dev' };
  const repos = { free: 'Acme/xspeed', pro: 'Acme/xspeed-pro', hub: 'Acme/hub' };
  assert.deepEqual(checkSiblings(srcs, 'pr', repos, 'Acme/xspeed-pro'), { xspeed: '/wt/xspeed-pr', hub: '/wt/hub-dev' });
  assert.deepEqual(checkSiblings(srcs, 'dev', repos, 'Acme/xspeed-pro'), { xspeed: '/wt/xspeed-dev', hub: '/wt/hub-dev' });
  const unpaired = { ...srcs }; delete unpaired['free-pr'];
  assert.deepEqual(checkSiblings(unpaired, 'pr', repos, 'Acme/xspeed-pro'), { xspeed: '/wt/xspeed-dev', hub: '/wt/hub-dev' });
});

// A repo's bare clone where qa-run keeps it, with one commit; its sha.
function bareRepo(name, file) {
  const src = fs.mkdtempSync(path.join(tmp, `${name}-src-`));
  spawnSync('git', ['init', '-q', '--initial-branch=main', src]);
  fs.writeFileSync(path.join(src, file), name);
  git(src, 'add', '-A'); git(src, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x');
  const bare = path.join(CACHE, 'repos', `${name}.git`);
  fs.rmSync(bare, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(bare), { recursive: true });
  spawnSync('git', ['clone', '-q', '--bare', src, bare]);
  return git(src, 'rev-parse', 'HEAD').stdout.trim();
}

test('the PR check and the dev check each read ../xspeed from their own Free tree, and neither flips the other', () => {
  const sha = bareRepo('xspeed-pro', 'tsconfig.json');
  // Two Free trees, told apart by a file.
  const free = (side) => { const d = fs.mkdtempSync(path.join(tmp, `xspeed-${side}-`)); fs.mkdirSync(path.join(d, 'src')); fs.writeFileSync(path.join(d, 'src', 'side'), side); return d; };
  const freePr = free('pr'), freeDev = free('dev');
  const sideOf = (dir) => fs.readFileSync(path.join(dir, '..', 'xspeed', 'src', 'side'), 'utf8');
  const prDir = checkoutCheckSlot('Acme/xspeed-pro', 'pr', sha, { xspeed: freePr, 'xspeed-pro': '/ignored', '..': '/nope' });
  const devDir = checkoutCheckSlot('Acme/xspeed-pro', 'dev', sha, { xspeed: freeDev, hub: freeDev });
  assert.notEqual(path.dirname(prDir), path.dirname(devDir));
  assert.equal(sideOf(prDir), 'pr');
  assert.equal(sideOf(devDir), 'dev');
  assert.ok(fs.existsSync(path.join(prDir, 'tsconfig.json')));
  // Its own name and odd names never become links.
  assert.deepEqual(fs.readdirSync(path.dirname(prDir)).sort(), ['xspeed', 'xspeed-pro']);
  // The next run, unpaired: the PR side moves to dev, and a sibling no longer named goes.
  checkoutCheckSlot('Acme/xspeed-pro', 'pr', sha, { xspeed: freeDev });
  checkoutCheckSlot('Acme/xspeed-pro', 'dev', sha, { xspeed: freeDev });
  assert.equal(sideOf(prDir), 'dev');
  assert.deepEqual(fs.readdirSync(path.dirname(devDir)).sort(), ['xspeed', 'xspeed-pro']);
  assert.throws(() => checkoutCheckSlot('Acme/xspeed-pro', 'check', sha), /side is pr or dev/);
});

test('Free, Pro and Hub check folders never share a path: a Pro run then a Free run and back leave the serving trees alone', () => {
  const proSha = bareRepo('pro2', 'pro.txt'), freeSha = bareRepo('free2', 'free.txt');
  // The Free tree a QA site serves, with an untracked file Miu placed there.
  const serving = fs.mkdtempSync(path.join(tmp, 'xspeed-pr-serving-'));
  fs.writeFileSync(path.join(serving, 'built.js'), 'keep');
  const hub = fs.mkdtempSync(path.join(tmp, 'hub-'));
  for (let round = 0; round < 2; round++) {
    const pro = checkoutCheckSlot('Acme/pro2', 'pr', proSha, { free2: serving, hub });
    const free = checkoutCheckSlot('Acme/free2', 'pr', freeSha, { pro2: pro, hub });
    assert.ok(fs.existsSync(path.join(pro, 'pro.txt')) && fs.existsSync(path.join(free, 'free.txt')));
    assert.ok(!fs.lstatSync(free).isSymbolicLink() && !fs.lstatSync(pro).isSymbolicLink());
    assert.equal(fs.realpathSync(path.join(pro, '..', 'free2')), fs.realpathSync(serving));
    assert.notEqual(path.dirname(pro), path.dirname(free));
  }
  assert.equal(fs.readFileSync(path.join(serving, 'built.js'), 'utf8'), 'keep');
  assert.deepEqual(fs.readdirSync(serving), ['built.js']);
});

test('a check folder refuses a link where its checkout goes, and a non-link where a sibling link goes', () => {
  const sha = bareRepo('linkcheck', 'f');
  const parent = path.join(CACHE, 'wt', 'check-pr-linkcheck');
  fs.mkdirSync(parent, { recursive: true });
  const elsewhere = fs.mkdtempSync(path.join(tmp, 'elsewhere-'));
  fs.symlinkSync(elsewhere, path.join(parent, 'linkcheck'));
  assert.throws(() => checkoutCheckSlot('Acme/linkcheck', 'pr', sha), /is a link, not a checkout/);
  fs.rmSync(path.join(parent, 'linkcheck'));
  fs.mkdirSync(path.join(parent, 'xspeed'));
  assert.throws(() => checkoutCheckSlot('Acme/linkcheck', 'pr', sha, { xspeed: elsewhere }), /is not a link; it would not be replaced/);
  assert.deepEqual(fs.readdirSync(elsewhere), []);
});

test('XSPEED_DIR is the side\'s link, else Free of the same side, never the other side\'s', () => {
  const srcs = { 'free-pr': '/wt/xspeed-pr', 'free-dev': '/wt/xspeed-dev' };
  const linked = path.join(CACHE, 'wt', 'check-dev-linked');
  fs.mkdirSync(path.join(linked, 'xspeed'), { recursive: true });
  assert.equal(freeDirFor(path.join(linked, 'xspeed-pro'), srcs), path.join(linked, 'xspeed'));
  assert.equal(freeDirFor(path.join(CACHE, 'wt', 'check-dev-xspeed', 'xspeed'), srcs), '/wt/xspeed-dev');
  // Free's own check: its checkout is ../xspeed itself.
  const own = path.join(CACHE, 'wt', 'check-pr-ownfree', 'xspeed');
  fs.mkdirSync(own, { recursive: true });
  assert.equal(freeDirFor(own, srcs), own);
  assert.equal(freeDirFor(path.join(CACHE, 'wt', 'check-pr-xspeed', 'xspeed'), srcs), '/wt/xspeed-pr');
  assert.equal(freeDirFor(path.join(CACHE, 'wt', 'check-pr-xspeed', 'xspeed'), { 'free-dev': '/wt/xspeed-dev' }), '/wt/xspeed-dev');
});

test('deps stamps: a check side\'s checkout is named by its folder, a top-level slot as before', () => {
  const s = server();
  for (const [rel, stamp] of [['check-pr-st/st', 'check-pr-st--st.json'], ['st-pr', 'st-pr.json']]) {
    const dir = path.join(CACHE, 'wt', rel);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'composer.json'), '{}');
    ensureDeps(dir, { env: { ...s.env, MIU_CI_MIRRORS_CONF: keyList('') } });
    assert.ok(fs.existsSync(path.join(CACHE, 'deps', stamp)), stamp);
  }
});

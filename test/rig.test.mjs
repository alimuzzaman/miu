import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeRig, rigPort, checkFile, checkConf, reloadDone, RIG_BASE_PORT } from '../lib/rig.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'miu-rig-'));
const SITES_DIR = path.join(tmp, 'Sites');
const MOVED = path.join(SITES_DIR, '_moved', '0'); // no lane in the tests

// rexenv as the rig sees it: site info, php list, site server, site move.
function fakeRex() {
  const sites = {
    'qa-pr-1.rex': { path: path.join(SITES_DIR, 'qa-pr-1.rex'), webServer: 'nginx', phpVersion: '8.3' },
    'qa-dev-1.rex': { path: path.join(SITES_DIR, 'qa-dev-1.rex'), webServer: 'nginx', phpVersion: '8.3' },
  };
  const calls = [];
  const rex = (args) => {
    const a = args.filter((x) => x !== '--json');
    if (a[0] === 'site' && a[1] === 'info') return JSON.stringify({ edgeHttpsPort: 8543, site: { domain: a[2], ...sites[a[2]] } });
    if (a[0] === 'php' && a[1] === 'list') return JSON.stringify({ versions: [{ minor: '7.4', fpmPort: 9774 }, { minor: '8.3', fpmPort: 9783 }] });
    calls.push(a.join(' '));
    if (a[0] === 'site' && a[1] === 'server') sites[a[2]].webServer = a[3];
    else if (a[0] === 'site' && a[1] === 'move' && sites[a[2]].unmanaged) throw new Error(`rex site move: ${sites[a[2]].path} is your own folder — rexenv doesn't move it.`);
    else if (a[0] === 'site' && a[1] === 'move') sites[a[2]].path = path.join(a[3], a[2]);
    else if (a[0] === 'site' && a[1] === 'relink') sites[a[2]].path = a[3];
    else throw new Error(`unexpected rex ${a.join(' ')}`);
    return '';
  };
  return { rex, calls, sites };
}
// nginx as the rig runs it: -t answers from `syntax`, a start writes the pid.
function fakeNginx(dir, { syntax = () => true } = {}) {
  const calls = [];
  const run = (_bin, args) => {
    const rest = args.slice(6);
    calls.push(rest.join(' ') || 'start');
    if (rest[0] === '-t') return syntax() ? { status: 0, stdout: '', stderr: 'syntax is ok' } : { status: 1, stdout: '', stderr: 'nginx: [emerg] unexpected "}"' };
    if (rest.length === 0) fs.writeFileSync(path.join(dir, 'run', 'nginx.pid'), `${process.pid}\n`);
    return { status: 0, stdout: '', stderr: '' };
  };
  let worker = 1000;
  const children = () => [{ pid: worker, title: 'nginx: worker process' }];
  const run2 = (bin, args) => { const r = run(bin, args); if (args.slice(6).join(' ') === '-s reload' && !stuck()) worker += 1; return r; };
  return { run: run2, calls, children };
}
let stuck = () => false;
const newRig = (name, opts = {}) => {
  const cache = path.join(tmp, name);
  const r = fakeRex();
  const n = fakeNginx(path.join(cache, 'rig'), opts);
  const rig = makeRig({ cache, sites: { pr: 'qa-pr-1.rex', dev: 'qa-dev-1.rex' }, rex: r.rex, run: n.run, children: n.children, isMaster: () => true, kill: (pid, sig) => n.calls.push(`kill ${sig}`), sleep: () => {}, reloadMs: 300, port: 18641, sitesDir: SITES_DIR });
  return { rig, rex: r, nginx: n, dir: path.join(cache, 'rig') };
};
process.env.QA_RIG_NGINX = '/fake/nginx';

test('each lane gets its own loopback port', () => {
  assert.equal(rigPort(''), RIG_BASE_PORT);
  assert.equal(rigPort('1'), RIG_BASE_PORT + 1);
  assert.equal(rigPort('2'), RIG_BASE_PORT + 2);
  assert.notEqual(rigPort('abc'), rigPort('1'));
  // Only the plain number is a numbered lane: 01 and l9 are names, kept off 18641-18739.
  assert.ok(rigPort('01') >= RIG_BASE_PORT + 100);
  assert.notEqual(rigPort('l9'), rigPort('l10'));
});

test('the agent writes only its own rig files', () => {
  for (const ok of ['sites/pr.conf', 'sites/dev-tenant.conf', 'sites/shared-root.conf', 'snippets/pr/xspeed.conf']) assert.equal(checkFile(ok), ok);
  for (const bad of ['nginx.conf', 'php-pr.conf', 'sites/../nginx.conf', 'snippets/fix/a.conf', 'sites/other.conf', '/etc/nginx/nginx.conf', 'snippets/pr/a.txt']) assert.throws(() => checkFile(bad), /rig file must be/);
});

test('a config may serve on the rig port and use rexenv PHP, nothing else', () => {
  const ctx = { port: 18641, fpmPort: 9783, dir: '/r', allowed: ['/r', '/home/miu/rexenv/Sites/qa-pr-1.rex', '/home/miu/rexenv/Sites/qa-dev-1.rex'] };
  checkConf([
    'server { listen 127.0.0.1:18641; server_name qa-pr-1.rex; # no root: it inherits',
    '  set $xs_file "/home/miu/rexenv/Sites/qa-pr-1.rex/wp-content/cache/xspeed/$host$uri/index.html";',
    '  if ($realpath_root != "/home/miu/rexenv/Sites/qa-pr-1.rex") { set $xs_file ""; }',
    '  location / { try_files $xs_file $uri /index.php?$args; access_log "/home/miu/rexenv/Sites/qa-pr-1.rex/wp-content/uploads/xspeed/hits.log"; }',
    '  location /c/ { alias $document_root/wp-content/cache/; } access_log off;',
    '  location ~ \\.php$ { include "/r/php-pr.conf"; fastcgi_pass 127.0.0.1:9783; } }',
  ].join('\n'), ctx);
  const refused = (text, why) => assert.throws(() => checkConf(text, ctx), why);
  refused('server { listen 0.0.0.0:18641; }', /listen 0\.0\.0\.0:18641/);
  refused('server { listen 80; }', /listen 80/);
  refused('server { listen 127.0.0.1:18642; }', /only 127\.0\.0\.1:18641/);
  refused('location / { proxy_pass http://example.com; }', /proxy_pass/);
  refused('location ~ \\.php$ { fastcgi_pass 127.0.0.1:9000; }', /fastcgi_pass 127\.0\.0\.1:9000/);
  refused('include /etc/nginx/fastcgi_params;', /include \/etc\/nginx\/fastcgi_params/);
  refused('include "/r/../etc/passwd";', /include/);
  refused('load_module modules/x.so;', /load_module/);
  // nginx's own syntax: a quoted name, or a "#" inside a string, is still a directive.
  refused('"listen" 0.0.0.0:18642;', /listen 0\.0\.0\.0:18642/);
  refused('"include" /etc/nginx/fastcgi_params;', /include \/etc\/nginx\/fastcgi_params/);
  refused('set $x "#"; listen 0.0.0.0:18642;', /listen 0\.0\.0\.0:18642/);
  refused("'proxy_pass' http://x;", /proxy_pass/);
  refused('server { listen 127.0.0.1:18641; } "listen" "0.0.0.0:1";', /listen 0\.0\.0\.0:1/);
  // Files: only under the rig and this lane's sites.
  refused('location / { alias /home/miu/; autoindex on; }', /alias \/home\/miu\/ \(only under/);
  refused('root /home/miu/rexenv/Sites/qa-pr-2.rex;', /root \/home\/miu\/rexenv\/Sites\/qa-pr-2\.rex/);
  refused('root /home/miu/rexenv/Sites/qa-pr-1.rex/../qa-pr-2.rex;', /root/);
  refused('access_log /home/miu/.bashrc;', /access_log \/home\/miu\/\.bashrc/);
  refused('error_log syslog:server=1.2.3.4;', /error_log syslog/);
  refused('root "/r/x;', /unclosed quote/);
  // A "#" inside a word is no comment, for nginx.
  refused('server { listen 127.0.0.1:18641; set $x a#; listen 0.0.0.0:18642; }', /listen 0\.0\.0\.0:18642/);
  // A server block with no listen would take *:8000.
  refused('server { return 200; }', /a server block with no listen/);
  refused('server { location / { listen 127.0.0.1:18641; } }', /a server block with no listen/);
  // A request must not choose the folder.
  refused('root /home/miu/rexenv/Sites/qa-pr-1.rex/$arg_tree;', /root/);
  refused('alias $document_root/$arg_x;', /alias/);
  refused('alias $document_root/../../qa-pr-2.rex/;', /alias/);
  // Directives with files of their own.
  refused('location / { fastcgi_store /home/miu/outside/result; }', /fastcgi_store/);
  refused('ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt;', /ssl_trusted_certificate/);
  refused('proxy_cache_path /tmp/x keys_zone=a:1m;', /proxy_cache_path/);
  // An include is read unchecked at reload: only the rig's own files, never a site's.
  refused('include /home/miu/rexenv/Sites/qa-pr-1.rex/wp-content/uploads/rig.conf;', /include .* \(only files under \/r\)/);
  // A commented-out directive is not one.
  checkConf('# listen 0.0.0.0:80;\nserver { listen 127.0.0.1:18641 default_server; }', ctx);
});

test('start lays out a config that serves both sites at their roots', () => {
  const { rig, nginx, dir } = newRig('start');
  const r = rig.start();
  assert.equal(r.action, 'started');
  assert.deepEqual(nginx.calls, ['-t', 'start']);
  const main = fs.readFileSync(path.join(dir, 'nginx.conf'), 'utf8');
  assert.match(main, /listen 127\.0\.0\.1:18641 default_server; return 421;/);
  assert.match(main, new RegExp(`include "${dir}/sites/\\*\\.conf";`));
  const pr = fs.readFileSync(path.join(dir, 'sites', 'pr.conf'), 'utf8');
  assert.match(pr, new RegExp(`root "${SITES_DIR}/qa-pr-1\\.rex";`));
  assert.match(pr, /server_name qa-pr-1\.rex;/);
  assert.match(pr, new RegExp(`include "${dir}/snippets/pr/\\*\\.conf";`));
  // PHP answers as the site at its rexenv URL, so WordPress does not redirect there.
  const php = fs.readFileSync(path.join(dir, 'php-pr.conf'), 'utf8');
  assert.match(php, /fastcgi_pass 127\.0\.0\.1:9783;/);
  assert.match(php, /fastcgi_param HTTP_HOST qa-pr-1\.rex:8543;/);
  assert.match(php, /fastcgi_param HTTPS on;/);
  assert.equal(r.sites.dev.request, "curl -sS -D - -H 'Host: qa-dev-1.rex' http://127.0.0.1:18641/");
  // Miu's own defaults pass the same check the agent's files do.
  checkConf(pr, { port: 18641, fpmPort: 9783, dir, allowed: [path.join(SITES_DIR, 'qa-pr-1.rex')] });
  assert.equal(rig.reload().action, 'reloaded');
  assert.deepEqual(nginx.calls.slice(2), ['-t', '-s reload']);
});

test('a config nginx refuses is not reloaded', () => {
  let good = true;
  const { rig, nginx } = newRig('refused', { syntax: () => good });
  rig.start();
  rig.put('snippets/pr/xspeed.conf', 'location /x { return 200; }\n');
  good = false;
  assert.throws(() => rig.reload(), /nginx -t refused the rig config, nothing reloaded:\nnginx: \[emerg\]/);
  assert.equal(nginx.calls.filter((c) => c === '-s reload').length, 0);
});

test('put refuses a file or config outside the rules, and writes the rest', () => {
  const { rig, dir } = newRig('put');
  assert.throws(() => rig.put('nginx.conf', 'events {}'), /rig file must be/);
  assert.throws(() => rig.put('sites/shared-x.conf', 'server { listen 8080; }'), /listen 8080/);
  assert.equal(fs.existsSync(path.join(dir, 'sites', 'shared-x.conf')), false);
  const devRoot = `root "${path.join(SITES_DIR, 'qa-dev-1.rex')}";\n`;
  rig.put('sites/shared-root.conf', devRoot);
  assert.equal(fs.readFileSync(path.join(dir, 'sites', 'shared-root.conf'), 'utf8'), devRoot);
  rig.rm('sites/shared-root.conf');
  assert.equal(fs.existsSync(path.join(dir, 'sites', 'shared-root.conf')), false);
});

test('server and move go through rexenv, and only when something changes', () => {
  const { rig, rex } = newRig('switch');
  assert.deepEqual(rig.server('pr', 'apache'), { domain: 'qa-pr-1.rex', server: 'apache' });
  rig.server('pr', 'apache');
  assert.throws(() => rig.server('pr', 'caddy'), /apache or nginx/);
  const m = rig.move('pr', 'r2');
  assert.equal(m.root, path.join(MOVED, 'r2', 'qa-pr-1.rex'));
  assert.throws(() => rig.move('pr', '../etc'), /move to a name/);
  rig.move('pr', 'r2');
  rig.move('pr', 'back');
  assert.deepEqual(rex.calls, ['site server qa-pr-1.rex apache', `site move qa-pr-1.rex ${path.join(MOVED, 'r2')}`, `site move qa-pr-1.rex ${SITES_DIR}`]);
});

test('restore puts the site back on nginx, in its folder, with its default rig files', () => {
  const { rig, rex, nginx, dir } = newRig('restore');
  rig.start();
  rig.server('pr', 'apache');
  rig.move('pr', 'r2');
  rig.put('snippets/pr/xspeed.conf', 'location /x { return 200; }\n');
  rig.put('sites/pr.conf', 'server { listen 127.0.0.1:18641; server_name qa-pr-1.rex; }\n');
  rig.put('sites/pr-extra.conf', 'server { listen 127.0.0.1:18641; server_name t2.qa-pr-1.rex; }\n');
  rig.put('sites/shared-root.conf', `root "${path.join(SITES_DIR, 'qa-dev-1.rex')}";\n`);
  rig.put('snippets/dev/keep.conf', 'location /y { return 200; }\n');
  rex.calls.length = 0;
  const undone = rig.restore('pr');
  assert.deepEqual(undone, ['server apache', `moved ${path.join(MOVED, 'r2', 'qa-pr-1.rex')}`]);
  assert.deepEqual(rex.calls, ['site server qa-pr-1.rex nginx', `site move qa-pr-1.rex ${SITES_DIR}`]);
  assert.equal(fs.existsSync(path.join(dir, 'snippets', 'pr', 'xspeed.conf')), false);
  assert.equal(fs.existsSync(path.join(dir, 'sites', 'pr-extra.conf')), false);
  assert.equal(fs.existsSync(path.join(dir, 'sites', 'shared-root.conf')), false);
  assert.match(fs.readFileSync(path.join(dir, 'sites', 'pr.conf'), 'utf8'), new RegExp(`root "${SITES_DIR}/qa-pr-1\\.rex";`));
  // dev's own files are dev's, until dev is reset.
  assert.equal(fs.existsSync(path.join(dir, 'snippets', 'dev', 'keep.conf')), true);
  // The running rig reloads on the restored files.
  assert.deepEqual(nginx.calls.slice(-2), ['-t', '-s reload']);
  // A clean site needs nothing undone.
  rex.calls.length = 0;
  assert.deepEqual(rig.restore('pr'), []);
  assert.deepEqual(rex.calls, []);
});

test('restore before the rig ever started writes no rig files', () => {
  const { rig, dir } = newRig('never');
  assert.deepEqual(rig.restore('dev'), []);
  assert.equal(fs.existsSync(dir), false);
});

test('a reload counts once nginx runs a worker on the new config', () => {
  const { rig } = newRig('stuck');
  rig.start();
  stuck = () => true;
  try { assert.throws(() => rig.reload(), /did not move to the new config in 0\.3s/); } finally { stuck = () => false; }
  assert.equal(rig.reload().action, 'reloaded');
});

test('moves stay inside rexenv\'s Sites, so rexenv can move the folder back', () => {
  const { rig, rex } = newRig('inside');
  assert.equal(rig.move('dev', 'r1').root, path.join(MOVED, 'r1', 'qa-dev-1.rex'));
  rig.restore('dev');
  assert.deepEqual(rex.calls, [`site move qa-dev-1.rex ${path.join(MOVED, 'r1')}`, `site move qa-dev-1.rex ${SITES_DIR}`]);
});

test('a folder rexenv no longer manages is renamed and relinked, there and back', () => {
  const { rig, rex } = newRig('unmanaged');
  rex.sites['qa-dev-1.rex'].unmanaged = true;
  const home = rex.sites['qa-dev-1.rex'].path;
  fs.mkdirSync(home, { recursive: true }); fs.writeFileSync(path.join(home, 'index.php'), '<?php');
  const m = rig.move('dev', 'r3');
  assert.equal(m.root, path.join(MOVED, 'r3', 'qa-dev-1.rex'));
  assert.equal(fs.existsSync(path.join(m.root, 'index.php')), true);
  assert.deepEqual(rig.restore('dev'), [`moved ${m.root}`]);
  assert.equal(fs.existsSync(path.join(home, 'index.php')), true);
  assert.deepEqual(rex.calls.filter((c) => c.includes('relink')), [`site relink qa-dev-1.rex ${m.root}`, `site relink qa-dev-1.rex ${home}`]);
});

test('a reload is done when a new worker runs and every old one is leaving', () => {
  const w = (pid, title = 'nginx: worker process') => ({ pid, title });
  const before = [w(10)];
  assert.equal(reloadDone(before, [w(10)]), false);
  // The new worker is up, but the old one still takes connections on the old config.
  assert.equal(reloadDone(before, [w(10), w(11)]), false);
  assert.equal(reloadDone(before, [w(10, 'nginx: worker process is shutting down'), w(11)]), true);
  assert.equal(reloadDone(before, [w(11)]), true);
});

test('a reload after a move points Miu\'s default block at the new root, and leaves the agent\'s own alone', () => {
  const { rig, dir } = newRig('moved-root');
  rig.start();
  rig.put('sites/dev.conf', 'server { listen 127.0.0.1:18641; server_name qa-dev-1.rex; }\n');
  rig.move('pr', 'r2'); rig.move('dev', 'r2');
  rig.reload();
  assert.match(fs.readFileSync(path.join(dir, 'sites', 'pr.conf'), 'utf8'), new RegExp(`root "${MOVED}/r2/qa-pr-1\\.rex";`));
  assert.equal(fs.readFileSync(path.join(dir, 'sites', 'dev.conf'), 'utf8'), 'server { listen 127.0.0.1:18641; server_name qa-dev-1.rex; }\n');
});

test('a reset finishes when the other site\'s files break the rig: the rig stops', () => {
  let ok = true;
  const { rig, nginx } = newRig('other-broken', { syntax: () => ok });
  rig.start();
  rig.put('snippets/dev/bad.conf', 'location /x { return 200; }\n');
  ok = false;
  const undone = rig.restore('pr');
  assert.match(undone.at(-1), /^rig stopped: nginx -t refused the rig config/);
  // nginx -s stop would read the same broken config: the master gets the signal itself.
  assert.equal(nginx.calls.at(-1), 'kill SIGTERM');
});

test('a pid file naming some other process is not the rig', () => {
  const cache = path.join(tmp, 'reused');
  const r = fakeRex(); const n = fakeNginx(path.join(cache, 'rig'));
  const rig = makeRig({ cache, sites: { pr: 'qa-pr-1.rex', dev: 'qa-dev-1.rex' }, rex: r.rex, run: n.run, children: n.children, isMaster: () => false, sleep: () => {}, reloadMs: 300, port: 18641, sitesDir: SITES_DIR });
  rig.start();
  // The pid file now names a process that is not this rig's nginx: start again, never signal it.
  assert.equal(rig.reload().action, 'started');
  assert.deepEqual(rig.stop(), { stopped: false, running: false });
  assert.equal(n.calls.includes('-s reload') || n.calls.includes('-s stop'), false);
});

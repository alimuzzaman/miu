// What a server-level test needs beyond the QA sites themselves, per lane:
//
//   - its own nginx (rexenv's binary, run as miu on a loopback port of the
//     lane), whose server blocks the agent writes and reloads. It serves the
//     lane's two sites, pr and dev: two tenants on one server, so a block
//     without a root of its own inherits the other's (or none). Reloading it
//     touches no other site: rexenv's shared nginx and the system nginx are
//     separate processes with configs of their own.
//   - the site on Apache instead of nginx, through rexenv (`rex site server`),
//     .htaccess and all.
//   - the site's docroot moved to another folder, through rexenv (`rex site
//     move`, a rename on the same disk, so the plugin links move with it). The
//     folder stays under rexenv's Sites (Sites/_moved/<lane>/<name>): a site
//     moved out of it is no longer rexenv's to move, and could not come back.
//
// reset() of a site puts all three back: nginx, its own folder, and the rig
// files of that site.
//
//   qasite rig start|reload|stop|show|default
//   qasite rig put <file> < content     sites/<pr|dev|shared>[-name].conf or snippets/<pr|dev>/<name>.conf
//   qasite rig rm <file>
//   qasite server pr|dev apache|nginx
//   qasite move pr|dev <name>|back
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { LANE } from './lane.mjs';

export const RIG_BASE_PORT = 18640;
const HOME = os.homedir();
const REX_DATA = process.env.QA_REX_DATA ?? path.join(HOME, '.local', 'share', 'rexenv');
// Moved docroots stay inside rexenv's Sites folder: a move is then a rename,
// the plugin folders (links into the worktrees) stay links, and rexenv still
// manages the folder, so it can move it back.
export const movedDir = (sitesDir, lane = LANE) => path.join(sitesDir, '_moved', lane || '0');

// One port per lane: 18640 for no lane, 18641 for lane 1 and so on.
export function rigPort(lane = LANE) {
  if (!lane) return RIG_BASE_PORT;
  if (/^[1-9]\d?$/.test(lane)) return RIG_BASE_PORT + Number(lane);
  // Other lane names hash into 18740-19639; two that meet fail at start, on a busy port.
  let h = 0; for (const c of lane) h = (h * 31 + c.charCodeAt(0)) % 900;
  return RIG_BASE_PORT + 100 + h;
}

export const rigDir = (cache) => path.join(cache, 'rig');

// rexenv's own nginx build, the newest one it has.
export function nginxBin() {
  if (process.env.QA_RIG_NGINX) return process.env.QA_RIG_NGINX;
  const bin = path.join(REX_DATA, 'bin');
  const found = (fs.existsSync(bin) ? fs.readdirSync(bin) : []).filter((d) => /^nginx-\d/.test(d))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop();
  if (!found) throw new Error(`rexenv has no nginx in ${bin}`);
  return path.join(bin, found, 'nginx');
}

// A file the agent may write: a server block (http level) for one site or
// shared by both, or a snippet included inside a site's default server block.
const FILE = /^(sites\/(pr|dev|shared)(-[a-z0-9][a-z0-9_-]{0,40})?\.conf|snippets\/(pr|dev)\/[a-z0-9][a-z0-9_-]{0,40}\.conf)$/;
export function checkFile(rel) {
  if (!FILE.test(rel ?? '')) throw new Error(`rig file must be sites/<pr|dev|shared>[-name].conf or snippets/<pr|dev>/<name>.conf, not "${String(rel).slice(0, 80)}"`);
  return rel;
}

// nginx's own tokens: quoted strings (either quote, with backslash escapes),
// comments outside them, and { } ; as their own tokens. Each statement is its
// words up to the ; or { that ends it, so a quoted directive name or a "#"
// inside a string is read as nginx reads it.
export function statements(text) {
  const src = String(text);
  const out = []; let words = [];
  for (let i = 0; i < src.length;) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === ';' || c === '{') { out.push({ words, opens: c === '{' }); words = []; i++; continue; }
    if (c === '}') { if (words.length) out.push({ words, opens: false }); out.push({ words: [], closes: true }); words = []; i++; continue; }
    let w = '';
    if (c === '"' || c === "'") {
      i++;
      while (i < src.length && src[i] !== c) { if (src[i] === '\\' && i + 1 < src.length) i++; w += src[i++]; }
      if (i >= src.length) throw new Error('the rig does not take: an unclosed quote');
      i++;
    } else {
      // A "#" inside a word is part of it (nginx: a comment starts only a token).
      while (i < src.length && !/[\s;{}"']/.test(src[i])) w += src[i++];
    }
    words.push(w);
  }
  if (words.length) out.push({ words, opens: false });
  return out;
}

const NOT_IN_RIG = new Set(['load_module', 'proxy_pass', 'uwsgi_pass', 'scgi_pass', 'grpc_pass', 'memcached_pass', 'mirror', 'perl', 'perl_modules', 'perl_require',
  'js_import', 'js_path', 'upstream', 'user', 'pid', 'daemon', 'master_process', 'env', 'lock_file', 'working_directory', 'ssl_certificate', 'ssl_certificate_key',
  'client_body_temp_path', 'fastcgi_temp_path', 'proxy_temp_path', 'uwsgi_temp_path', 'scgi_temp_path', 'fastcgi_cache_path', 'proxy_cache_path', 'stream', 'mail']);
// Families that read or write files of their own, open sockets or load code.
const NOT_IN_RIG_LIKE = /^(ssl_|proxy_|uwsgi_|scgi_|grpc_|memcached_|perl|js_|xslt_|geoip|mail|stream|quic_|http2_push)|(_store|_store_access|_temp_path|_cache_path)$/;
// Directives whose first word is a file or folder nginx reads or writes.
const PATHS = new Set(['root', 'alias', 'access_log', 'error_log', 'include', 'auth_basic_user_file']);

// What an agent file may say. The rig listens on its own loopback port only,
// talks to rexenv's PHP only, reads and writes only under the rig and the
// lane's own sites (allowed: absolute folders), and loads no modules: the rest
// of nginx is the agent's, as on a customer's server. (The agent can already
// run PHP as miu through site_wp_run; the paths keep the rig to its lane.)
export function checkConf(text, { port, fpmPort, dir, allowed = [dir] }) {
  const bad = [];
  // A literal folder under an allowed one, or one below the server's own root
  // ($document_root, $realpath_root: a root this check already allowed). No
  // other variable: a request could choose the folder.
  const inside = (p, roots) => {
    const rest = p.replace(/^\$(document_root|realpath_root)(?=\/|$)/, '');
    if (rest.includes('$') || rest.split('/').includes('..')) return false;
    if (rest !== p) return true;
    if (!path.isAbsolute(p)) return false;
    const n = path.normalize(p);
    return roots.some((a) => n === a || n.startsWith(a + path.sep));
  };
  const stack = [];
  for (const st of statements(text)) {
    if (st.closes) {
      const b = stack.pop();
      if (b?.name === 'server' && !b.listens) bad.push(`a server block with no listen (it would listen on *:8000; give it listen 127.0.0.1:${port})`);
      continue;
    }
    const [name, ...args] = st.words;
    if (!name) continue;
    if (name === 'listen' && stack.at(-1)?.name === 'server') stack.at(-1).listens = true;
    if (st.opens) stack.push({ name });
    if (NOT_IN_RIG.has(name) || NOT_IN_RIG_LIKE.test(name)) bad.push(`${name} (not available in the rig)`);
    else if (name === 'listen' && !(args[0] === `127.0.0.1:${port}` && args.slice(1).every((a) => a === 'default_server'))) bad.push(`listen ${args.join(' ')} (only 127.0.0.1:${port})`);
    else if (name === 'fastcgi_pass' && args[0] !== `127.0.0.1:${fpmPort}`) bad.push(`fastcgi_pass ${args.join(' ')} (only 127.0.0.1:${fpmPort}, rexenv's PHP)`);
    // An included file is read as it is at reload, unchecked: only the rig's own files, which put checks.
    else if (name === 'include' && !inside(args[0] ?? '', [dir])) bad.push(`include ${args[0]} (only files under ${dir})`);
    else if (PATHS.has(name) && name !== 'include' && args[0] !== undefined && !(['access_log', 'error_log'].includes(name) && args[0] === 'off') && !inside(args[0], [dir, ...allowed])) {
      bad.push(`${name} ${args[0]} (only under the rig or this lane's sites)`);
    } else if (['access_log', 'error_log'].includes(name) && /^(syslog|memory):/.test(args[0] ?? '')) bad.push(`${name} ${args[0]} (files only)`);
  }
  if (bad.length) throw new Error(`the rig does not take: ${bad.join('; ')}`);
}

// Requests through the rig carry the site's own host and port to PHP, so
// WordPress answers as it does at its rexenv URL instead of redirecting there.
export function phpConf({ fpmPort, host }) {
  return [
    `fastcgi_pass 127.0.0.1:${fpmPort};`,
    'fastcgi_index index.php;',
    'fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;',
    'fastcgi_param QUERY_STRING $query_string;',
    'fastcgi_param REQUEST_METHOD $request_method;',
    'fastcgi_param CONTENT_TYPE $content_type;',
    'fastcgi_param CONTENT_LENGTH $content_length;',
    'fastcgi_param SCRIPT_NAME $fastcgi_script_name;',
    'fastcgi_param REQUEST_URI $request_uri;',
    'fastcgi_param DOCUMENT_URI $document_uri;',
    'fastcgi_param DOCUMENT_ROOT $document_root;',
    'fastcgi_param SERVER_PROTOCOL $server_protocol;',
    'fastcgi_param GATEWAY_INTERFACE CGI/1.1;',
    'fastcgi_param SERVER_SOFTWARE nginx;',
    'fastcgi_param REMOTE_ADDR $remote_addr;',
    'fastcgi_param REMOTE_PORT $remote_port;',
    'fastcgi_param SERVER_ADDR $server_addr;',
    `fastcgi_param SERVER_PORT ${host.port};`,
    `fastcgi_param SERVER_NAME ${host.name};`,
    `fastcgi_param HTTP_HOST ${host.port === 443 ? host.name : `${host.name}:${host.port}`};`,
    'fastcgi_param REQUEST_SCHEME https;',
    'fastcgi_param HTTPS on;',
    '',
  ].join('\n');
}

export function siteConf({ which, domain, root, port, dir }) {
  return [
    `# The default server block of ${which} (${domain}), written by Miu. Replace it with`,
    `# \`qasite rig put sites/${which}.conf\`; \`qasite reset ${which}\` writes it again.`,
    'server {',
    `\tlisten 127.0.0.1:${port};`,
    `\tserver_name ${domain};`,
    `\troot "${root}";`,
    '\tindex index.php index.html;',
    `\tinclude "${dir}/snippets/${which}/*.conf";`,
    '\tlocation / {',
    '\t\ttry_files $uri $uri/ /index.php?$args;',
    '\t}',
    '\tlocation ~* \\.php$ {',
    `\t\tinclude "${dir}/php-${which}.conf";`,
    '\t}',
    '}',
    '',
  ].join('\n');
}

export function mainConf({ dir, port }) {
  return [
    '# The lane\'s own nginx, written by Miu. The agent\'s files are sites/*.conf.',
    'worker_processes 1;',
    `pid "${dir}/run/nginx.pid";`,
    `error_log "${dir}/logs/error.log" warn;`,
    'events { worker_connections 256; }',
    'http {',
    `\tinclude "${dir}/mime.types";`,
    '\tdefault_type application/octet-stream;',
    `\taccess_log "${dir}/logs/access.log";`,
    `\tclient_body_temp_path "${dir}/tmp/body";`,
    `\tfastcgi_temp_path "${dir}/tmp/fastcgi";`,
    `\tproxy_temp_path "${dir}/tmp/proxy";`,
    `\tuwsgi_temp_path "${dir}/tmp/uwsgi";`,
    `\tscgi_temp_path "${dir}/tmp/scgi";`,
    '\tsendfile on;',
    `\tserver { listen 127.0.0.1:${port} default_server; return 421; }`,
    `\tinclude "${dir}/sites/*.conf";`,
    '}',
    '',
  ].join('\n');
}

const MIME = 'types {\n\ttext/html html htm;\n\ttext/css css;\n\tapplication/javascript js;\n\tapplication/json json;\n\timage/png png;\n\timage/jpeg jpg jpeg;\n\timage/gif gif;\n\timage/svg+xml svg;\n\timage/webp webp;\n\ttext/plain txt;\n\tapplication/xml xml;\n\tfont/woff2 woff2;\n}\n';

// The rig of one lane. sites: { pr: domain, dev: domain }; rex: the rexenv CLI
// (args) => stdout; run: spawnSync-like, for nginx.
// The worker processes of an nginx master, with their process titles. A
// reload has taken effect once the master runs a worker that was not there
// before (on the new config) and every old one has stopped taking connections:
// it is gone, or titled "worker process is shutting down" while it finishes.
function procChildren(pid) {
  let pids = [];
  try { pids = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number); } catch {
    for (const d of fs.existsSync('/proc') ? fs.readdirSync('/proc') : []) {
      if (!/^\d+$/.test(d)) continue;
      try { if (Number(fs.readFileSync(`/proc/${d}/stat`, 'utf8').replace(/^.*\) /, '').split(' ')[1]) === pid) pids.push(Number(d)); } catch { /* gone */ }
    }
  }
  return pids.map((p) => { let title = ''; try { title = fs.readFileSync(`/proc/${p}/cmdline`, 'utf8').replace(/\0/g, ' ').trim(); } catch { /* gone */ } return { pid: p, title }; });
}
export function reloadDone(before, now) {
  const old = new Set(before.map((c) => c.pid));
  return now.some((c) => !old.has(c.pid)) && now.every((c) => !old.has(c.pid) || /shutting down/.test(c.title));
}
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function procIsMaster(pid, conf) {
  try {
    const t = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim().split(/\s+/);
    const c = t.indexOf('-c');
    return t.slice(0, 3).join(' ') === 'nginx: master process' && c > 0 && t[c + 1] === conf;
  } catch { return false; }
}

export function makeRig({ cache, sites, rex, run = spawnSync, port = rigPort(), sitesDir, moved = movedDir(sitesDir), children = procChildren, isMaster = procIsMaster, kill = (n, sig) => process.kill(n, sig), sleep = pause, reloadMs = 15000 }) {
  const dir = rigDir(cache);
  const info = (domain) => JSON.parse(rex(['--json', 'site', 'info', domain]));
  const fpmPortFor = (minor) => {
    const v = (JSON.parse(rex(['--json', 'php', 'list'])).versions ?? []).find((x) => x.minor === minor);
    if (!v?.fpmPort) throw new Error(`rexenv has no PHP ${minor} pool`);
    return v.fpmPort;
  };
  // What rexenv says about the sites (only, or all of them), and its PHP port.
  const state = (only = Object.keys(sites)) => {
    const out = {};
    for (const [which, domain] of Object.entries(sites).filter(([w]) => only.includes(w))) {
      const i = info(domain);
      out[which] = { domain, root: i.site.path, server: i.site.webServer, php: i.site.phpVersion, edgePort: i.edgeHttpsPort ?? 443 };
    }
    out.fpmPort = fpmPortFor(Object.values(out)[0]?.php ?? '8.3');
    return out;
  };
  const nginx = (args) => {
    const r = run(nginxBin(), ['-p', dir, '-e', path.join(dir, 'logs', 'error.log'), '-c', path.join(dir, 'nginx.conf'), ...args], { encoding: 'utf8', timeout: 60000 });
    return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
  };
  // The rig's nginx master, if the pid file names one: a live process whose
  // title says it is an nginx master on this rig's config, not whatever has
  // the number now.
  const pid = () => {
    try {
      const n = Number(fs.readFileSync(path.join(dir, 'run', 'nginx.pid'), 'utf8').trim());
      if (n > 0 && isMaster(n, path.join(dir, 'nginx.conf'))) return n;
    } catch { /* not running */ }
    return null;
  };

  // rexenv moves the folder; one it no longer manages (moved out of its Sites
  // once) it refuses to move, and then the rig renames it and relinks the site.
  function moveSite(domain, from, parent) {
    fs.mkdirSync(parent, { recursive: true });
    try { rex(['site', 'move', domain, parent]); } catch (e) {
      if (!/your own folder/.test(e.message)) throw e;
      const to = path.join(parent, domain);
      if (fs.existsSync(to)) throw new Error(`cannot move ${domain} to ${parent}: ${to} is there already`);
      fs.renameSync(from, to);
      rex(['site', 'relink', domain, to]);
    }
  }
  const allowed = () => [dir, moved, ...Object.values(sites).map((d) => path.join(sitesDir, d))];
  // Miu's default server block starts with this line; one that still does is
  // Miu's to rewrite (a moved root), one the agent replaced is the agent's.
  const MARK = (which) => `# The default server block of ${which} `;
  function writeSite(which, st) {
    const s = st[which];
    fs.mkdirSync(path.join(dir, 'snippets', which), { recursive: true });
    fs.writeFileSync(path.join(dir, `php-${which}.conf`), phpConf({ fpmPort: st.fpmPort, host: { name: s.domain, port: s.edgePort } }));
    fs.writeFileSync(path.join(dir, 'sites', `${which}.conf`), siteConf({ which, domain: s.domain, root: s.root, port, dir }));
  }
  function layout(st) {
    for (const d of ['sites', 'snippets', 'run', 'logs', 'tmp']) fs.mkdirSync(path.join(dir, d), { recursive: true });
    fs.writeFileSync(path.join(dir, 'nginx.conf'), mainConf({ dir, port }));
    fs.writeFileSync(path.join(dir, 'mime.types'), MIME);
    for (const which of Object.keys(sites)) {
      const f = path.join(dir, 'sites', `${which}.conf`);
      let have = null; try { have = fs.readFileSync(f, 'utf8'); } catch { /* none yet */ }
      if (have === null || have.startsWith(MARK(which))) writeSite(which, st);
    }
  }
  // A site's rig files back to Miu's default: its server block, no snippets,
  // no extra blocks of its own, and none shared by the two.
  function clearSite(which, st) {
    fs.rmSync(path.join(dir, 'snippets', which), { recursive: true, force: true });
    for (const f of fs.existsSync(path.join(dir, 'sites')) ? fs.readdirSync(path.join(dir, 'sites')) : []) {
      if (f.startsWith(`${which}-`) || f.startsWith('shared')) fs.rmSync(path.join(dir, 'sites', f), { force: true });
    }
    writeSite(which, st);
  }
  function reload() {
    const t = nginx(['-t']);
    if (!t.ok) throw new Error(`nginx -t refused the rig config, nothing reloaded:\n${t.out}`);
    const master = pid();
    if (master) {
      const before = children(master);
      const r = nginx(['-s', 'reload']);
      if (!r.ok) throw new Error(`nginx reload failed: ${r.out}`);
      for (let waited = 0; ; waited += 100) {
        if (reloadDone(before, children(master))) return 'reloaded';
        if (waited >= reloadMs) throw new Error(`nginx took the reload signal but did not move to the new config in ${reloadMs / 1000}s; see ${path.join(dir, 'logs', 'error.log')}`);
        sleep(100);
      }
    }
    const r = nginx([]);
    if (!r.ok) throw new Error(`nginx did not start: ${r.out}`);
    return 'started';
  }
  function show(st) {
    const files = [];
    const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else files.push(path.relative(dir, p)); } };
    for (const d of ['sites', 'snippets']) if (fs.existsSync(path.join(dir, d))) walk(path.join(dir, d));
    return {
      running: Boolean(pid()), port, dir, files: files.sort(),
      sites: Object.fromEntries(Object.keys(sites).map((w) => [w, { domain: st[w].domain, root: st[w].root, server: st[w].server, request: `curl -sS -D - -H 'Host: ${st[w].domain}' http://127.0.0.1:${port}/` }])),
      php_include: Object.fromEntries(Object.keys(sites).map((w) => [w, path.join(dir, `php-${w}.conf`)])),
      access_log: path.join(dir, 'logs', 'access.log'), error_log: path.join(dir, 'logs', 'error.log'),
    };
  }

  return {
    dir, port,
    start() { const st = state(); layout(st); return { ...show(st), action: reload() }; },
    reload() { const st = state(); layout(st); return { ...show(st), action: reload() }; },
    stop() {
      const n = pid();
      if (!n) return { stopped: false, running: false };
      const r = nginx(['-s', 'stop']);
      if (!r.ok) {
        // A config nginx refuses also stops -s stop; signal the verified master.
        try { kill(n, 'SIGTERM'); } catch (e) { throw new Error(`nginx stop failed: ${r.out}; ${e.message}`); }
      }
      return { stopped: true };
    },
    show() { const st = state(); layout(st); return show(st); },
    defaults() { const st = state(); layout(st); for (const w of Object.keys(sites)) clearSite(w, st); return { ...show(st), action: pid() ? reload() : 'not running' }; },
    put(rel, text) {
      checkFile(rel);
      const st = state(); layout(st);
      checkConf(text, { port, fpmPort: st.fpmPort, dir, allowed: allowed() });
      const file = path.join(dir, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
      return { wrote: file, next: 'qasite rig reload' };
    },
    rm(rel) { checkFile(rel); fs.rmSync(path.join(dir, rel), { force: true }); return { removed: rel, next: 'qasite rig reload' }; },
    // The web server rexenv serves the site with, at its usual URL.
    server(which, server) {
      if (!['apache', 'nginx'].includes(server)) throw new Error('server is apache or nginx');
      const domain = sites[which];
      if (info(domain).site.webServer !== server) rex(['site', 'server', domain, server]);
      return { domain, server: info(domain).site.webServer };
    },
    // The site's folder somewhere else (name), or back in rexenv's Sites (back).
    move(which, to) {
      const domain = sites[which];
      if (to !== 'back' && !/^[a-z0-9][a-z0-9-]{0,30}$/.test(to ?? '')) throw new Error('move to a name (lowercase letters, digits, dashes) or back');
      const parent = to === 'back' ? sitesDir : path.join(moved, to);
      const from = info(domain).site.path;
      if (path.dirname(from) !== parent) moveSite(domain, from, parent);
      return { domain, from, root: info(domain).site.path };
    },
    // Called first in reset(): the site back on nginx, in its own folder, with
    // its default rig files. Returns what it had to undo.
    restore(which) {
      const domain = sites[which];
      const undone = [];
      let i = info(domain);
      if (i.site.webServer !== 'nginx') { rex(['site', 'server', domain, 'nginx']); undone.push(`server ${i.site.webServer}`); }
      if (path.dirname(i.site.path) !== sitesDir) { moveSite(domain, i.site.path, sitesDir); undone.push(`moved ${i.site.path}`); i = info(domain); }
      if (fs.existsSync(path.join(dir, 'nginx.conf'))) {
        const st = state([which]);
        clearSite(which, st);
        // The other site's files can be what nginx refuses; a reset still
        // finishes, with the rig stopped, and its next start says why.
        if (pid()) {
          try { reload(); } catch (e) {
            // nginx -s stop reads the config first, so it fails on the same
            // file; the verified master takes the signal directly.
            const n = pid(); if (n) { try { kill(n, 'SIGTERM'); } catch { /* gone */ } }
            undone.push(`rig stopped: ${e.message.split('\n').slice(0, 3).join(' ')}`);
          }
        }
      }
      return undone;
    },
  };
}

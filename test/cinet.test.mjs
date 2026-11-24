// bin/miu-ci-net on a stand-in server: the CI network is made once, with its
// own bridge, and held in by rules that reject the server itself and every
// private address; running it again changes nothing, and a network that is
// not Miu's is never taken for it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NET = fileURLToPath(new URL('../bin/miu-ci-net', import.meta.url));
const ID = 'c1'.repeat(32);

// iptables and docker that keep their state in JSON files. iptables can fail
// its n-th call (failAt), as a run killed half way would stop, and checks after
// every call that each parent still jumps to a complete chain of ours (guard).
function server({ network = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miu-ci-net-'));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const state = path.join(root, 'ipt.json');
  fs.writeFileSync(state, JSON.stringify({ calls: 0, tables: { filter: { INPUT: ['-j ts-input', '-j ufw-before-input'], 'DOCKER-USER': ['-j RETURN'] }, mangle: { PREROUTING: [] } } }));
  const net = path.join(root, 'net.json');
  if (network) fs.writeFileSync(net, JSON.stringify(network));
  const failAt = path.join(root, 'fail-at');
  const guard = path.join(root, 'guard.json');
  const broken = path.join(root, 'broken');
  fs.writeFileSync(path.join(bin, 'iptables'), `#!/usr/bin/env node
const fs = require('fs');
const f = ${JSON.stringify(state)};
const s = JSON.parse(fs.readFileSync(f, 'utf8'));
let a = process.argv.slice(2).filter((x) => x !== '-w');
let table = 'filter';
if (a[0] === '-t') { table = a[1]; a = a.slice(2); }
const c = s.tables[table];
const [op, name] = a;
s.calls++;
const failNow = fs.existsSync(${JSON.stringify(failAt)}) && Number(fs.readFileSync(${JSON.stringify(failAt)}, 'utf8')) === s.calls;
const save = () => fs.writeFileSync(f, JSON.stringify(s));
if (failNow) { save(); process.exit(4); }
const rest = a.slice(2).join(' ');
const jumpsTo = (n) => Object.values(c).some((r) => r.some((x) => x.endsWith('-j ' + n)));
let code = 0;
switch (op) {
  case '-N': if (c[name]) code = 1; else c[name] = []; break;
  case '-F': if (!c[name]) code = 1; else c[name] = []; break;
  case '-X': if (!c[name] || jumpsTo(name)) code = 1; else delete c[name]; break;
  case '-I': c[name].splice(Number(a[2]) - 1, 0, a.slice(3).join(' ')); break;
  case '-A': c[name].push(rest); break;
  case '-D': { const i = (c[name] ?? []).indexOf(rest); if (i < 0) code = 1; else c[name].splice(i, 1); break; }
  case '-S': if (!c[name]) code = 1; else console.log(['-N ' + name, ...c[name].map((r) => '-A ' + name + ' ' + r)].join('\\n')); break;
  default: code = 2;
}
save();
if (fs.existsSync(${JSON.stringify(guard)})) {
  for (const g of JSON.parse(fs.readFileSync(${JSON.stringify(guard)}, 'utf8'))) {
    const t = s.tables[g.table];
    const live = t[g.parent].map((r) => r.match(/^-i miu-ci0 -j (\\S+)$/)?.[1]).filter(Boolean);
    if (!live.some((n) => JSON.stringify(t[n]) === JSON.stringify(g.rules))) fs.appendFileSync(${JSON.stringify(broken)}, 'after call ' + s.calls + ' (' + process.argv.slice(2).join(' ') + '): ' + g.table + ' ' + g.parent + ' has no complete chain\\n');
  }
}
process.exit(code);
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'docker'), `#!/usr/bin/env node
const fs = require('fs');
const f = ${JSON.stringify(net)};
const a = process.argv.slice(2);
const n = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
if (a[0] !== 'network') process.exit(2);
if (a[1] === 'create') {
  const opt = (k) => a.filter((x, i) => a[i - 1] === '--opt').find((x) => x.startsWith(k + '='))?.split('=')[1];
  fs.writeFileSync(f, JSON.stringify({ id: ${JSON.stringify(ID)}, name: a.at(-1), driver: a[a.indexOf('--driver') + 1], subnet: a[a.indexOf('--subnet') + 1], bridge: opt('com.docker.network.bridge.name'), icc: opt('com.docker.network.bridge.enable_icc'), ipv6: false, argv: a }));
  process.exit(0);
}
if (a[1] === 'inspect') {
  if (!n || n.name !== a.at(-1)) process.exit(1);
  if (a[2] !== '-f') process.exit(0);
  console.log(a[3] === '{{.Id}}' ? n.id : [n.driver, n.bridge, n.icc, n.subnet, n.ipv6].join(' '));
  process.exit(0);
}
process.exit(2);
`, { mode: 0o755 });
  const stamp = path.join(root, 'run/miu-ci-net/ok');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, MIU_CI_NET_STAMP: stamp };
  const tables = () => JSON.parse(fs.readFileSync(state, 'utf8')).tables;
  return {
    run: (...args) => spawnSync('bash', [NET, ...args], { env, encoding: 'utf8' }),
    tables,
    calls: () => JSON.parse(fs.readFileSync(state, 'utf8')).calls,
    failAt: (n) => (n ? fs.writeFileSync(failAt, String(n)) : fs.rmSync(failAt, { force: true })),
    // From now on, each parent must jump to a chain with these rules after every call.
    guard: (list) => fs.writeFileSync(guard, JSON.stringify(list)),
    broken: () => (fs.existsSync(broken) ? fs.readFileSync(broken, 'utf8') : ''),
    network: () => (fs.existsSync(net) ? JSON.parse(fs.readFileSync(net, 'utf8')) : null),
    stamp: () => (fs.existsSync(stamp) ? fs.readFileSync(stamp, 'utf8').trim() : null),
  };
}

const PRIVATE = ['10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.168.0.0/16'];
// The chain of ours a parent jumps to, and that jump's place.
const ours = (t, table, parent) => {
  const i = t[table][parent].findIndex((r) => /^-i miu-ci0 -j MIU-CI-/.test(r));
  return { at: i, name: t[table][parent][i]?.split(' ').at(-1), jumps: t[table][parent].filter((r) => /^-i miu-ci0 -j /.test(r)).length };
};
const PARENTS = [['mangle', 'PREROUTING', 'MIU-CI-PRE'], ['filter', 'INPUT', 'MIU-CI-IN'], ['filter', 'DOCKER-USER', 'MIU-CI-FWD']];
const complete = (t) => PARENTS.map(([table, parent]) => ({ table, parent, rules: t[table][ours(t, table, parent).name] }));

test('up: its own bridge, nothing to the server or anything private, the internet open, then the stamp', () => {
  const s = server();
  const r = s.run('up');
  assert.equal(r.status, 0, r.stderr);
  const n = s.network();
  assert.deepEqual([n.name, n.driver, n.bridge, n.icc, n.subnet], ['miu-ci', 'bridge', 'miu-ci0', 'false', '10.213.0.0/24']);
  const t = s.tables();
  for (const [table, parent, base] of PARENTS) {
    const o = ours(t, table, parent);
    // First, ahead of tailscale's and ufw's own, which would let 22, 80 and 443 in.
    assert.equal(o.at, 0, `${table} ${parent}`);
    assert.equal(o.jumps, 1, `${table} ${parent}`);
    assert.match(o.name, new RegExp(`^${base}-[AB]$`));
  }
  // The floor: before any filter chain and before Docker rewrites a published port.
  const pre = t.mangle[ours(t, 'mangle', 'PREROUTING').name];
  assert.equal(pre[0], '-m addrtype --dst-type LOCAL -j DROP', 'nothing to this server, on any of its addresses');
  for (const d of PRIVATE) assert.ok(pre.includes(`-d ${d} -j DROP`), d);
  assert.equal(pre.at(-1), '-j RETURN', 'everything else (the internet) goes on');
  assert.deepEqual(t.filter[ours(t, 'filter', 'INPUT').name], ['-p tcp -j REJECT --reject-with tcp-reset', '-j REJECT --reject-with icmp-port-unreachable']);
  const fwd = t.filter[ours(t, 'filter', 'DOCKER-USER').name];
  assert.equal(fwd[0], '-m conntrack --ctstate ESTABLISHED,RELATED -j RETURN');
  for (const d of PRIVATE) {
    assert.ok(fwd.includes(`-d ${d} -p tcp -j REJECT --reject-with tcp-reset`), d);
    assert.ok(fwd.includes(`-d ${d} -j REJECT --reject-with icmp-net-prohibited`), d);
  }
  assert.equal(fwd.at(-1), '-j RETURN');
  assert.equal(s.stamp(), ID);
});

test('up again swaps each chain in whole: one jump each, nothing left over, never a moment without the rules', () => {
  const s = server();
  assert.equal(s.run('up').status, 0);
  const before = s.tables();
  s.guard(complete(before));
  const r = s.run('up');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(s.broken(), '');
  const after = s.tables();
  for (const [table, parent, base] of PARENTS) {
    const was = ours(before, table, parent).name, now = ours(after, table, parent).name;
    assert.notEqual(now, was, 'the other name, filled beside the one in use');
    assert.equal(ours(after, table, parent).jumps, 1);
    assert.equal(after[table][was], undefined, `${was} is gone`);
    assert.deepEqual(after[table][now], before[table][was]);
    assert.ok(now.startsWith(base));
  }
  assert.equal(s.stamp(), ID);
});

test('a run stopped at any step, then run again: the rules hold at every step and end as one complete set', () => {
  const s = server();
  assert.equal(s.run('up').status, 0);
  const good = complete(s.tables());
  // How many iptables calls a whole second run makes.
  const start = s.calls();
  assert.equal(s.run('up').status, 0);
  const steps = s.calls() - start;
  assert.ok(steps > 20, `${steps} calls`);
  s.guard(good);
  for (let k = 1; k <= steps; k++) {
    s.failAt(s.calls() + k);
    s.run('up');
    s.failAt(0);
    const r = s.run('up');
    assert.equal(r.status, 0, `stopped at call ${k}: ${r.stderr}`);
    const t = s.tables();
    for (const [table, parent] of PARENTS) assert.equal(ours(t, table, parent).jumps, 1, `stopped at call ${k}: ${table} ${parent}`);
    const names = (tb) => Object.keys(t[tb]).filter((n) => n.startsWith('MIU-CI-'));
    assert.equal(names('filter').length + names('mangle').length, 3, `stopped at call ${k}: left over ${[...names('filter'), ...names('mangle')]}`);
  }
  assert.equal(s.broken(), '');
});

test('a listing that fails stops the run, and never reads as a chain not in use', () => {
  const s = server();
  assert.equal(s.run('up').status, 0);
  s.guard(complete(s.tables()));
  // The first call of a run is the mangle listing.
  s.failAt(s.calls() + 1);
  const r = s.run('up');
  assert.notEqual(r.status, 0);
  assert.equal(s.broken(), '');
  assert.equal(s.stamp(), null, 'no stamp while the run did not finish');
});

test('a network of that name that Miu did not make is never used, and no stamp says it is', () => {
  const s = server({ network: { id: ID, name: 'miu-ci', driver: 'bridge', bridge: 'br-0123456789ab', icc: 'true', subnet: '172.18.0.0/16', ipv6: false } });
  const r = s.run('up');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /network miu-ci is not the one Miu makes/);
  assert.equal(s.stamp(), null);
  assert.deepEqual(s.tables().mangle.PREROUTING, []);
});

test('unstamp (the unit stopping, as Docker stops) takes the stamp and keeps the rules; down takes both, by hand', () => {
  const s = server();
  assert.equal(s.run('up').status, 0);
  const t = s.tables();
  assert.equal(s.run('unstamp').status, 0);
  assert.equal(s.stamp(), null);
  assert.deepEqual(s.tables(), { ...t }, 'a job that outlives a Docker restart stays held in');
  assert.equal(s.run('down').status, 0);
  const d = s.tables();
  assert.deepEqual(d.filter.INPUT, ['-j ts-input', '-j ufw-before-input']);
  assert.deepEqual(d.filter['DOCKER-USER'], ['-j RETURN']);
  assert.deepEqual(d.mangle.PREROUTING, []);
  assert.deepEqual(Object.keys(d.filter).concat(Object.keys(d.mangle)).filter((n) => n.startsWith('MIU-CI-')), []);
  assert.ok(s.network(), 'the network stays');
});

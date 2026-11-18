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

// iptables and docker that keep their state in JSON files.
function server({ network = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miu-ci-net-'));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const state = path.join(root, 'ipt.json');
  fs.writeFileSync(state, JSON.stringify({ chains: { INPUT: ['-j ts-input', '-j ufw-before-input'], 'DOCKER-USER': ['-j RETURN'] } }));
  const net = path.join(root, 'net.json');
  if (network) fs.writeFileSync(net, JSON.stringify(network));
  fs.writeFileSync(path.join(bin, 'iptables'), `#!/usr/bin/env node
const fs = require('fs');
const f = ${JSON.stringify(state)};
const s = JSON.parse(fs.readFileSync(f, 'utf8'));
const a = process.argv.slice(2).filter((x) => x !== '-w');
const [op, name] = a;
const rest = a.slice(2).join(' ');
const save = () => fs.writeFileSync(f, JSON.stringify(s));
const c = s.chains;
switch (op) {
  case '-N': if (c[name]) process.exit(1); c[name] = []; break;
  case '-F': if (!c[name]) process.exit(1); c[name] = []; break;
  case '-X': if (!c[name] || Object.values(c).some((r) => r.some((x) => x.endsWith('-j ' + name)))) process.exit(1); delete c[name]; break;
  case '-E': c[a[2]] = c[name]; delete c[name]; for (const k of Object.keys(c)) c[k] = c[k].map((x) => x.endsWith('-j ' + name) ? x.slice(0, -name.length) + a[2] : x); break;
  case '-I': c[name].splice(Number(a[2]) - 1, 0, a.slice(3).join(' ')); break;
  case '-A': c[name].push(rest); break;
  case '-D': { const i = (c[name] ?? []).indexOf(rest); if (i < 0) process.exit(1); c[name].splice(i, 1); break; }
  case '-S': if (!c[name]) process.exit(1); break;
  default: process.exit(2);
}
save();
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
  return {
    run: (...args) => spawnSync('bash', [NET, ...args], { env, encoding: 'utf8' }),
    chains: () => JSON.parse(fs.readFileSync(state, 'utf8')).chains,
    network: () => (fs.existsSync(net) ? JSON.parse(fs.readFileSync(net, 'utf8')) : null),
    stamp: () => (fs.existsSync(stamp) ? fs.readFileSync(stamp, 'utf8').trim() : null),
  };
}

const PRIVATE = ['10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.168.0.0/16'];

test('up: its own bridge, nothing to the server, nothing private, the internet open, then the stamp', () => {
  const s = server();
  const r = s.run('up');
  assert.equal(r.status, 0, r.stderr);
  const n = s.network();
  assert.deepEqual([n.name, n.driver, n.bridge, n.icc, n.subnet], ['miu-ci', 'bridge', 'miu-ci0', 'false', '10.213.0.0/24']);
  const c = s.chains();
  // Ahead of tailscale's and ufw's own, which would let 22, 80 and 443 in.
  assert.equal(c.INPUT[0], '-i miu-ci0 -j MIU-CI-IN');
  assert.deepEqual(c['MIU-CI-IN'], ['-p tcp -j REJECT --reject-with tcp-reset', '-j REJECT --reject-with icmp-port-unreachable']);
  assert.equal(c['DOCKER-USER'][0], '-i miu-ci0 -j MIU-CI-FWD');
  const fwd = c['MIU-CI-FWD'];
  assert.equal(fwd[0], '-m conntrack --ctstate ESTABLISHED,RELATED -j RETURN');
  for (const d of PRIVATE) {
    assert.ok(fwd.includes(`-d ${d} -p tcp -j REJECT --reject-with tcp-reset`), d);
    assert.ok(fwd.includes(`-d ${d} -j REJECT --reject-with icmp-net-prohibited`), d);
  }
  assert.equal(fwd.at(-1), '-j RETURN', 'everything else (the internet) goes on as before');
  assert.equal(s.stamp(), ID);
});

test('up again changes nothing: one jump each, no chain left over, the same network', () => {
  const s = server();
  assert.equal(s.run('up').status, 0);
  const once = s.chains();
  const r = s.run('up');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(s.chains(), once);
  assert.equal(s.stamp(), ID);
});

test('a network of that name that Miu did not make is never used, and no stamp says it is', () => {
  const s = server({ network: { id: ID, name: 'miu-ci', driver: 'bridge', bridge: 'br-0123456789ab', icc: 'true', subnet: '172.18.0.0/16', ipv6: false } });
  const r = s.run('up');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /network miu-ci is not the one Miu makes/);
  assert.equal(s.stamp(), null);
  assert.equal(s.chains()['MIU-CI-IN'], undefined);
});

test('down takes the rules and the stamp away, and leaves the network', () => {
  const s = server();
  assert.equal(s.run('up').status, 0);
  const r = s.run('down');
  assert.equal(r.status, 0, r.stderr);
  const c = s.chains();
  assert.deepEqual(c.INPUT, ['-j ts-input', '-j ufw-before-input']);
  assert.deepEqual(c['DOCKER-USER'], ['-j RETURN']);
  assert.equal(c['MIU-CI-IN'], undefined);
  assert.equal(c['MIU-CI-FWD'], undefined);
  assert.equal(s.stamp(), null);
  assert.ok(s.network());
});

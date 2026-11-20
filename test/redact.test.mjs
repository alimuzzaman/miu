// Redaction at capture: a synthetic WordPress session planted in a request, a
// response and a command never reaches any evidence file or the ledger.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { redact, redactFile, MASK } from '../lib/redact.mjs';

const EVIDENCE = fileURLToPath(new URL('../bin/qa-evidence', import.meta.url));
const linux = { skip: process.platform === 'linux' ? false : 'needs bash and curl as on the QA server' };
const HASH = '0123456789abcdef0123456789abcdef';
const TOKEN = 'SynthTok3nSynthTok3nSynthTok3nSynthTok3nAbc';
const SIG = 'f'.repeat(64);
const VALUE = `miu-qa%7C1795100000%7C${TOKEN}%7C${SIG}`;

test('redact masks session cookies by name and the run\'s literals, encoded or not', () => {
  const t = redact(`Cookie: wordpress_sec_${HASH}=${VALUE}; other=1\nSet-Cookie: wordpress_logged_in_${HASH}="${VALUE}"; path=/\n__Host-xspeed_admin_session=abc123def`, []);
  assert.doesNotMatch(t, new RegExp(TOKEN));
  assert.doesNotMatch(t, /abc123def/);
  assert.match(t, /other=1/);
  assert.match(t, new RegExp(`wordpress_sec_${HASH}=\\[redacted\\]`));
  const j = redact(JSON.stringify({ cookies: [{ name: `wordpress_${HASH}`, value: 'v'.repeat(30) }] }), []);
  assert.equal(JSON.parse(j).cookies[0].value, MASK);
  // Any key order, keys between, a HAR entry, single quotes, a JS object.
  const har = JSON.stringify({ log: { entries: [{ request: { cookies: [{ value: 'w'.repeat(40), path: '/', name: `wordpress_sec_${HASH}`, httpOnly: true }] } }] } });
  assert.equal(JSON.parse(redact(har, [])).log.entries[0].request.cookies[0].value, MASK);
  assert.doesNotMatch(redact(`{ value: 'x'.repeat(1), name: 'xspeed_hub_session', domain: 'h' } {'value': 'hubsecretvalue123', 'name': '__Host-xspeed_admin_session'}`, []), /hubsecretvalue123/);
  assert.doesNotMatch(redact(`curl -b 'wordpress_logged_in_${HASH}=${VALUE}' url`, []), new RegExp(SIG));
  assert.equal(redact(`token ${TOKEN} and ${encodeURIComponent(`${TOKEN}|`)}`, [TOKEN]), `token ${MASK} and ${MASK}%7C`);
  assert.equal(redact('short', ['abc']), 'short', 'a short literal is never a mask');
});

test('a file with a NUL or invalid UTF-8 is redacted byte for byte, every other byte kept', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'miu-redact-')), 'out.log');
  const head = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x0a]);
  fs.writeFileSync(f, Buffer.concat([head, Buffer.from(`Cookie: wordpress_sec_${HASH}=${VALUE}\ntok ${TOKEN}\n`), Buffer.from([0x00, 0xc3])]));
  assert.equal(redactFile(f, [TOKEN]), true);
  const out = fs.readFileSync(f);
  assert.deepEqual(out.subarray(0, 5), head);
  assert.deepEqual(out.subarray(-2), Buffer.from([0x00, 0xc3]));
  assert.doesNotMatch(out.toString('latin1'), new RegExp(`${TOKEN}|${SIG}`));
});

const sh = (args, env) => new Promise((resolve) => {
  const c = spawn('bash', [EVIDENCE, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
  c.on('close', (code) => resolve({ code, out }));
});

test('a synthetic cookie in a request, a response, a command and a note is in no evidence file', linux, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miu-redact-'));
  const priv = path.join(dir, 'private');
  fs.mkdirSync(priv);
  fs.writeFileSync(path.join(priv, 'redact.list'), `${TOKEN}\n`, { mode: 0o600 });
  const server = http.createServer((req, res) => {
    res.setHeader('Set-Cookie', `wordpress_logged_in_${HASH}=${VALUE}; path=/; secure; HttpOnly`);
    res.end(`you sent: ${req.headers.cookie ?? ''}\n`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/wp-admin/`;
  const env = { ...process.env, QA_EVIDENCE_DIR: path.join(dir, 'evidence'), QA_REDACT_FILE: path.join(priv, 'redact.list') };
  try {
    const h = await sh(['http', 'admin page', '-H', `Cookie: wordpress_sec_${HASH}=${VALUE}`, url], env);
    assert.equal(h.code, 0, h.out);
    assert.doesNotMatch(h.out, new RegExp(TOKEN), 'not even what the agent is shown');
    const r = await sh(['run', 'echo', '--', 'echo', `the token is ${TOKEN}`], env);
    assert.equal(r.code, 0, r.out);
    const note = path.join(dir, 'state.json');
    fs.writeFileSync(note, JSON.stringify({ cookies: [{ name: `wordpress_${HASH}`, value: VALUE }] }));
    assert.equal((await sh(['note', 'state', note], env)).code, 0);
  } finally { server.close(); }
  const files = fs.readdirSync(path.join(dir, 'evidence')).filter((f) => f !== '.staging');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'evidence', '.staging')), [], 'nothing left in staging');
  assert.ok(files.includes('index.jsonl') && files.some((f) => f.endsWith('.http')) && files.some((f) => f.endsWith('.body')));
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, 'evidence', f), 'utf8');
    assert.doesNotMatch(text, new RegExp(TOKEN), `${f} holds the token`);
    assert.doesNotMatch(text, new RegExp(SIG), `${f} holds a cookie value`);
  }
});

test('a capture that cannot be redacted is not kept: no evidence file, no ledger row', linux, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miu-redact-'));
  const env = { ...process.env, QA_EVIDENCE_DIR: path.join(dir, 'evidence'), QA_REDACT_FILE: path.join(dir, 'none') };
  const stage = path.join(dir, 'evidence', '.staging');
  // The command locks the staging folder, so the redactor cannot write its result.
  const r = await sh(['run', 'locked', '--', 'sh', '-c', `echo "wordpress_sec_${HASH}=${VALUE}"; chmod 500 "${stage}"`], env);
  fs.chmodSync(stage, 0o700);
  assert.equal(r.code, 5, r.out);
  assert.match(r.out, /could not redact the capture/);
  assert.doesNotMatch(r.out, new RegExp(SIG));
  assert.deepEqual(fs.readdirSync(path.join(dir, 'evidence')).filter((f) => f !== '.staging').filter((f) => f !== 'index.jsonl'), []);
  assert.equal(fs.readFileSync(path.join(dir, 'evidence', 'index.jsonl'), 'utf8'), '');
});

// lib/wpsession.mjs: a wp-admin session on a stack's public WordPress, whose
// token never leaves Miu except on the worker's stdin.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newToken, cookiesFrom, startWpSession, endWpSessions } from '../lib/wpsession.mjs';
import { dropSessions } from '../lib/hubstack.mjs';

const HOST = 'wp-pr-hub-9.xspeedcdn.online';
const HASH = '0123456789abcdef0123456789abcdef';
const SIG = 'a'.repeat(64);
const answer = (extra = {}) => ({ ok: true, host: HOST, login: 'miu-qa', expires: 1795100000, cookies: [
  { name: `wordpress_sec_${HASH}`, path: '/wp-admin', sig: SIG },
  { name: `wordpress_${HASH}`, path: '/wp-admin', sig: 'b'.repeat(64) },
  { name: `wordpress_logged_in_${HASH}`, path: '/', sig: 'c'.repeat(64) },
], ...extra });

test('a token is 43 letters and digits, and new each time', () => {
  const a = newToken(), b = newToken();
  assert.match(a, /^[A-Za-z0-9]{43}$/);
  assert.notEqual(a, b);
});

test('cookies are the login, expiry, token and signature, as WordPress sets them', () => {
  const t = newToken();
  const c = cookiesFrom(answer(), t, HOST);
  assert.equal(c.length, 3);
  assert.deepEqual(c[2], { name: `wordpress_logged_in_${HASH}`, value: `miu-qa%7C1795100000%7C${t}%7C${'c'.repeat(64)}`, domain: HOST, path: '/', expires: 1795100000, sameSite: 'Lax' });
});

test('an answer for another host, another user or with odd fields is refused', () => {
  const t = newToken();
  const code = (out) => { try { cookiesFrom(out, t, HOST); return null; } catch (e) { return e.code; } };
  assert.equal(code(answer({ host: 'wp-pr-hub-8.xspeedcdn.online' })), 'wp_session_host');
  assert.equal(code(answer({ login: 'xsadmin' })), 'wp_session_unreadable');
  assert.equal(code(answer({ cookies: [{ name: 'PHPSESSID', path: '/', sig: SIG }] })), 'wp_session_unreadable');
  assert.equal(code(answer({ cookies: [{ name: `wordpress_${HASH}`, path: '/', sig: 'x; Domain=evil' }] })), 'wp_session_unreadable');
  assert.equal(code(answer({ cookies: [{ name: `wordpress_${HASH}`, path: '/\n', sig: SIG }] })), 'wp_session_unreadable');
  assert.equal(code({ ok: false, code: 'wp_qa_user_missing' }), 'wp_qa_user_missing');
  assert.equal(code({ ok: false, code: 'Not A Code <script>' }), 'wp_session_failed');
  assert.equal(code(null), 'wp_session_failed');
});

test('the token goes on stdin only; the state is 0600 in private/, listed for redaction and for the end', async () => {
  const runDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'miu-wpsession-')), 'xspeed-hub-9-run');
  fs.mkdirSync(runDir);
  const calls = [];
  const run = async (args, opts) => { calls.push({ args, input: opts?.input }); return { code: 0, out: JSON.stringify(answer()) }; };
  const r = await startWpSession({ run, stack: 'pr-hub-9', host: HOST, runDir });
  assert.equal(r.ok, true);
  assert.deepEqual(calls[0].args, ['wp-session', 'pr-hub-9', 'xspeed-hub-9-run']);
  const token = calls[0].input.trim();
  assert.match(token, /^[A-Za-z0-9]{43}$/);
  assert.ok(!calls[0].args.join(' ').includes(token), 'never in argv');
  assert.ok(!JSON.stringify(r).includes(token), 'never in what it returns');
  assert.equal(r.state, path.join(runDir, 'private', 'wp-pr-hub-9.json'));
  assert.equal(fs.statSync(r.state).mode & 0o777, 0o600);
  const state = JSON.parse(fs.readFileSync(r.state, 'utf8'));
  assert.ok(state.cookies.every((c) => c.domain === HOST && c.secure && c.httpOnly && c.value.includes(token)));
  assert.equal(fs.readFileSync(path.join(runDir, 'private', 'redact.list'), 'utf8'), `${token}\n`);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runDir, 'private', 'wp-sessions.json'), 'utf8')), ['pr-hub-9']);
});

test('a refused session is reported by code, is still ended at the end, and dropSessions ends it before the states go', async () => {
  const runDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'miu-wpsession-')), 'run-2');
  fs.mkdirSync(runDir);
  const run = async () => ({ code: 1, out: '{"ok":false,"code":"wp_container_not_found"}' });
  const r = await startWpSession({ run, stack: 'pr-hub-base', host: 'wp-pr-hub-base.xspeedcdn.online', runDir });
  assert.deepEqual(r, { ok: false, code: 'wp_container_not_found', exit: 1 });
  const ended = [];
  assert.deepEqual(endWpSessions(runDir, (stack, name) => { ended.push([stack, name]); return true; }), [{ stack: 'pr-hub-base', ok: true }]);
  assert.deepEqual(ended, [['pr-hub-base', 'run-2']]);
  ended.length = 0;
  dropSessions(runDir, { endWp: (stack, name) => { ended.push([stack, name, fs.existsSync(path.join(runDir, 'private'))]); return true; } });
  assert.deepEqual(ended, [['pr-hub-base', 'run-2', true]], 'ended while its state is still there');
  assert.equal(fs.existsSync(path.join(runDir, 'private')), false);
  assert.deepEqual(endWpSessions(runDir, () => { throw new Error('not called'); }), [], 'nothing left to end');
});

test('a session that could not be ended stays listed (names only), and the next drop tries it again', () => {
  const runDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'miu-wpsession-')), 'run-3');
  fs.mkdirSync(path.join(runDir, 'private'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'private', 'wp-sessions.json'), JSON.stringify(['pr-hub-7', 'pr-hub-base']));
  fs.writeFileSync(path.join(runDir, 'private', 'wp-pr-hub-7.json'), '{"cookies":[]}');
  fs.mkdirSync(path.join(runDir, 'evidence', '.staging'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'evidence', '.staging', 'ev-001.log'), 'raw');
  const left = dropSessions(runDir, { endWp: (stack) => stack === 'pr-hub-base' });
  assert.deepEqual(left, ['pr-hub-7']);
  assert.deepEqual(fs.readdirSync(path.join(runDir, 'private')), ['wp-sessions.json'], 'only the names stay, no state');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runDir, 'private', 'wp-sessions.json'), 'utf8')), ['pr-hub-7']);
  assert.equal(fs.existsSync(path.join(runDir, 'evidence', '.staging')), false, 'half-captured evidence goes too');
  const tried = [];
  assert.deepEqual(dropSessions(runDir, { endWp: (stack) => { tried.push(stack); return true; } }), []);
  assert.deepEqual(tried, ['pr-hub-7']);
  assert.equal(fs.existsSync(path.join(runDir, 'private')), false);
});

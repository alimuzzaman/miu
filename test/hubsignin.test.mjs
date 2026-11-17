import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { signIn, signInApp, totpCode, readTotp, writeStorageState, COOKIE, EMAIL, APP_COOKIE } from '../lib/hubsignin.mjs';

// RFC 6238 appendix B, SHA-1, secret "12345678901234567890" (base32 below), 6 digits.
test('totpCode matches the RFC 6238 vectors', () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  assert.equal(totpCode(secret, Math.floor(59 / 30)), '287082');
  assert.equal(totpCode(secret, Math.floor(1111111109 / 30)), '081804');
  assert.equal(totpCode(secret, Math.floor(1234567890 / 30)), '005924');
});

// A fake Hub admin and Mailpit with the routes and checks lib/hubsignin.mjs relies on.
function fakeHub({ hasFactor = false, appLinkHost = 'hub-pr-hub-9.xspeedcdn.online', appTwoFactor = false } = {}) {
  let t = Date.UTC(2026, 10, 17, 6, 0, 0);
  const state = { tokens: new Set(), sessions: new Map(), mails: [], factor: hasFactor ? 'OTHERSECRETOTHERSECRETOTHERSECRE' : null, pending: null, lastStep: null, calls: [], seen: [] };
  const ok = (body, cookie) => {
    const headers = new Headers({ 'content-type': 'application/json' });
    if (cookie) headers.append('set-cookie', `${COOKIE}=${cookie}; Path=/; HttpOnly; SameSite=Strict; Max-Age=600; Secure`);
    return new Response(JSON.stringify(body), { status: 200, headers });
  };
  const no = (status, error) => new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json' } });
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : {};
    state.calls.push(`${init.method ?? 'GET'} ${u.pathname}`);
    state.seen.push(JSON.stringify({ url, headers: init.headers, body }));
    if (u.port === '18123') {
      if (u.pathname === '/mail/api/v1/search') return ok({ messages: state.mails.map((m, i) => ({ ID: String(i), Created: new Date(m.at).toISOString() })) });
      if (u.pathname.startsWith('/mail/api/v1/message/')) return ok({ Text: state.mails[Number(u.pathname.split('/').pop())].text });
      if (u.pathname === '/mail/api/v1/messages' && init.method === 'DELETE') { state.mails = state.mails.filter((_, i) => !body.IDs.includes(String(i))); return ok({}); }
      return no(404, 'nf');
    }
    if (u.hostname === 'hub-pr-hub-9.xspeedcdn.online' || u.hostname === 'elsewhere.example') {
      if (u.pathname === '/auth/email/request' && init.method === 'POST') {
        state.mails.push({ at: t, text: `Sign in: https://${appLinkHost}/auth/email/verify?token=apptok${'y'.repeat(30)}&amp;return=https%3A%2F%2Fhub-pr-hub-9.xspeedcdn.online` });
        return ok({ sent: true });
      }
      if (u.pathname === '/auth/email/verify' && u.searchParams.get('token')?.startsWith('apptok')) {
        const headers = new Headers({ location: appTwoFactor ? 'https://hub-pr-hub-9.xspeedcdn.online/two-factor' : 'https://hub-pr-hub-9.xspeedcdn.online/' });
        headers.append('set-cookie', `${APP_COOKIE}=app1; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure`);
        return new Response('', { status: 302, headers });
      }
      return no(404, 'nf');
    }
    // The admin host: the console's API is under /api/ (the stack's edge), the rest is the SPA.
    if (!u.pathname.startsWith('/api/admin/')) return no(405, 'spa');
    u.pathname = u.pathname.slice(4);
    if (init.headers?.origin !== 'https://admin-pr-hub-9.xspeedcdn.online') return no(403, 'origin');
    const sid = (init.headers?.cookie ?? '').split('=')[1];
    const sess = sid && state.sessions.get(sid);
    const step = Math.floor(t / 30000);
    switch (u.pathname) {
      case '/admin/auth/link': {
        const tok = `tok${'x'.repeat(30)}${state.tokens.size}`;
        state.tokens.add(tok);
        state.mails.push({ at: t, text: `Sign in: https://admin-pr-hub-9.xspeedcdn.online/#link=${tok}` });
        return ok({ sent: true });
      }
      case '/admin/auth/link/verify':
        if (!state.tokens.delete(body.token)) return no(400, 'link_invalid');
        state.sessions.set('p1', 'pending');
        return ok({ stage: state.factor ? 'mfa' : 'enroll' }, 'p1');
      case '/admin/auth/enroll/totp/setup':
        if (sess !== 'pending' || state.factor) return no(401, 'Unauthorized.');
        state.pending = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
        return ok({ secret: state.pending, otpauth_uri: 'otpauth://x' });
      case '/admin/auth/enroll/totp':
        if (sess !== 'pending' || body.code !== totpCode(state.pending, step)) return no(400, 'code_invalid');
        state.factor = state.pending; state.lastStep = step;
        state.sessions.set('a1', 'active');
        return ok({ ok: true, stage: 'active', recovery_codes: ['rc-one', 'rc-two'] }, 'a1');
      case '/admin/auth/mfa/totp':
        if (sess !== 'pending') return no(401, 'Unauthorized.');
        if (step <= state.lastStep || body.code !== totpCode(state.factor, step)) return no(400, 'code_invalid');
        state.lastStep = step;
        state.sessions.set('a2', 'active');
        return ok({ ok: true, stage: 'active' }, 'a2');
      default: return no(404, 'nf');
    }
  };
  return { fetch, state, now: () => t, sleep: async (ms) => { t += ms; } };
}

const base = (dir, extra = {}) => ({
  admin: 'https://admin-pr-hub-9.xspeedcdn.online', mailpit: 'http://127.0.0.1:18123/mail',
  stack: 'pr-hub-9', incarnation: '2026-11-17T06:00:00Z/abc', totpFile: path.join(dir, '.stacks', 'pr-hub-9.totp'), ...extra,
});

test('first sign-in enrolls an authenticator; the next one uses it, at a later step', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miu-hubsignin-'));
  const hub = fakeHub();
  const first = await signIn(base(dir, hub));
  assert.equal(first.enrolled, true);
  assert.equal(first.cookie.value, 'a1');
  assert.equal(first.cookie.domain, 'admin-pr-hub-9.xspeedcdn.online');
  assert.equal(fs.statSync(base(dir).totpFile).mode & 0o777, 0o600);
  assert.equal(hub.state.mails.length, 0, 'the sign-in mail is deleted from Mailpit');
  const again = await signIn(base(dir, hub));
  assert.equal(again.enrolled, false);
  assert.equal(again.cookie.value, 'a2');
  assert.ok(hub.state.calls.includes('POST /admin/auth/mfa/totp'));
});

test('a kept authenticator from an earlier stack of the same name is deleted, not used', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miu-hubsignin-'));
  const file = base(dir).totpFile;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ stack: 'pr-hub-9', incarnation: 'older/zzz', secret: 'JBSWY3DPEHPK3PXP', step: 1 }), { mode: 0o600 });
  assert.equal(readTotp(file, 'pr-hub-9', '2026-11-17T06:00:00Z/abc'), null);
  assert.equal(fs.existsSync(file), false);
  const hub = fakeHub();
  const r = await signIn(base(dir, hub));
  assert.equal(r.enrolled, true, 'a new stack enrolls afresh');
});

test('a stack whose QA address already has a factor Miu does not hold says so', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miu-hubsignin-'));
  const hub = fakeHub({ hasFactor: true });
  await assert.rejects(signIn(base(dir, hub)), /already has a second factor/);
});

test('no link, code, secret or recovery code is in what signIn returns or throws', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miu-hubsignin-'));
  const hub = fakeHub();
  const r = await signIn(base(dir, hub));
  const shown = JSON.stringify({ enrolled: r.enrolled });
  assert.doesNotMatch(shown, /tok|JBSWY|rc-one/);
  const state = path.join(dir, 'state.json');
  writeStorageState(state, r.cookie);
  assert.equal(fs.statSync(state).mode & 0o777, 0o600);
  const saved = JSON.parse(fs.readFileSync(state, 'utf8'));
  assert.equal(saved.cookies[0].name, COOKIE);
  assert.doesNotMatch(fs.readFileSync(state, 'utf8'), /JBSWY|tok|rc-one/);
  assert.equal(EMAIL, 'miu-qa@wpdeveloper.com');
});

test('the app side: the seeded QA account is signed in by its emailed link, and the mail is deleted', async () => {
  const hub = fakeHub();
  const r = await signInApp({ hub: 'https://hub-pr-hub-9.xspeedcdn.online', mailpit: 'http://127.0.0.1:18123/mail', fetch: hub.fetch, now: hub.now, sleep: hub.sleep });
  assert.equal(r.cookie.name, APP_COOKIE);
  assert.equal(r.cookie.value, 'app1');
  assert.equal(r.cookie.domain, 'hub-pr-hub-9.xspeedcdn.online');
  assert.equal(r.cookie.sameSite, 'Lax');
  assert.equal(hub.state.mails.length, 0);
});

test('the app side never follows a mailed link to another host, and stops at two-factor', async () => {
  const away = fakeHub({ appLinkHost: 'elsewhere.example' });
  await assert.rejects(signInApp({ hub: 'https://hub-pr-hub-9.xspeedcdn.online', mailpit: 'http://127.0.0.1:18123/mail', fetch: away.fetch, now: away.now, sleep: away.sleep }), /not for this stack/);
  assert.ok(!away.state.calls.includes('GET /auth/email/verify'));
  const tf = fakeHub({ appTwoFactor: true });
  await assert.rejects(signInApp({ hub: 'https://hub-pr-hub-9.xspeedcdn.online', mailpit: 'http://127.0.0.1:18123/mail', fetch: tf.fetch, now: tf.now, sleep: tf.sleep }), /two-factor/);
});

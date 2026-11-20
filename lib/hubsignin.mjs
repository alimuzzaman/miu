// Sign the QA agent into a PR stack's Hub admin console (admin-<stack>), so
// the agent's browser starts signed in and never sees a link or a code.
//
// The Hub's staff sign-in (xspeed-hub docs/architecture/admin-auth.md), under
// the admin host's /api/ (the stack's edge proxies it to the hub; / is the SPA):
//   1. POST /admin/auth/link {email}       mails a link with the token in its #fragment
//   2. POST /admin/auth/link/verify {token} opens a pending session (cookie)
//   3. the second factor: on a stack's first sign-in, enroll an authenticator
//      (enroll/totp/setup, then enroll/totp {code}); later, mfa/totp {code}.
// The stack's mail all lands in its own Mailpit, on this server's loopback.
//
// The address is on the stack's XSPEED_HUB_ADMIN_EMAILS (xspeed-dev-setup's
// full template), so it is staff there and nowhere else.
//
// Secrets: the link, codes and recovery codes stay in this process. The
// authenticator secret is kept in one 0600 file per stack (the Hub lets a
// person enroll only while they have no factor), bound to the stack's
// incarnation: a file from an earlier stack of the same name is not used, and
// a new enrollment replaces it. The file goes only with its stack
// (lib/prstackctl.mjs removeOne). Only the session cookie leaves, as a
// Playwright storage state the caller writes 0600 and deletes after the run.
import fs from 'node:fs';
import path from 'node:path';
import { createHmac } from 'node:crypto';

export const EMAIL = 'miu-qa@wpdeveloper.com';
export const COOKIE = '__Host-xspeed_admin_session';
// The app side: the account seed-qa.mjs makes on every stack, signed in by its emailed link.
export const APP_EMAIL = 'qa@example.invalid';
export const APP_COOKIE = 'xspeed_hub_session';
const STEP_S = 30;

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Decode(s) {
  let bits = 0, value = 0;
  const out = [];
  for (const ch of String(s).replace(/=+$/, '').toUpperCase()) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('invalid base32');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

// RFC 6238: SHA-1, 6 digits, 30-second steps, as src/auth/totp.ts.
export function totpCode(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const o = mac[mac.length - 1] & 15;
  const bin = ((mac[o] & 127) << 24) | (mac[o + 1] << 16) | (mac[o + 2] << 8) | mac[o + 3];
  return String(bin % 1e6).padStart(6, '0');
}

// The kept authenticator: { stack, incarnation, secret, step } or null. One
// for another incarnation is not used, and not deleted either: only a new
// enrollment replaces it, so a wrong incarnation can never lose a secret the
// Hub still holds.
export function readTotp(file, stack, incarnation) {
  let t = null;
  try { t = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  if (t?.stack === stack && t?.incarnation === incarnation && typeof t.secret === 'string') return t;
  return null;
}
function writeTotp(file, t) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(t), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const cookieFrom = (res, name = COOKIE) => {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const m = c.match(new RegExp(`^${name.replace(/[-]/g, '\\-')}=([^;]*)`));
    if (m) {
      const age = c.match(/;\s*Max-Age=(\d+)/i);
      const domain = c.match(/;\s*Domain=([^;]+)/i);
      return { value: m[1], maxAge: age ? Number(age[1]) : null, domain: domain ? domain[1].trim().replace(/^\./, '') : null };
    }
  }
  return null;
};

// The newest mail to `to` since `since`, matched by `re`; the mail is deleted
// from Mailpit once read. Resolves the first capture group, or null.
async function mailFor({ f, mailpit, to, since, re, now, sleep, waitMs }) {
  const until = since + (waitMs ?? 60_000);
  while (now() < until) {
    const s = await f(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}&limit=5`);
    const list = s.ok ? (await s.json()).messages ?? [] : [];
    for (const m of list) {
      if (Date.parse(m.Created) < since - 5000) continue;
      const body = await (await f(`${mailpit}/api/v1/message/${encodeURIComponent(m.ID)}`)).json();
      const hit = `${body.Text ?? ''}\n${body.HTML ?? ''}`.replace(/&amp;/g, '&').match(re);
      await f(`${mailpit}/api/v1/messages`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ IDs: [m.ID] }) });
      if (hit) return hit[1];
    }
    await sleep(2000);
  }
  return null;
}

// opts: { admin: 'https://admin-<stack>.xspeedcdn.online', mailpit: 'http://127.0.0.1:<port>/mail',
//         stack, incarnation, totpFile, email?, fetch?, now?, sleep?, mailWaitMs? }
// Resolves { cookie: { name, value, domain, expires }, enrolled } or throws an
// Error whose message names the step, never a secret.
export async function signIn(opts) {
  const { admin, mailpit, stack, incarnation, totpFile, email = EMAIL } = opts;
  const f = opts.fetch ?? globalThis.fetch;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const origin = new URL(admin).origin;
  const api = `${origin}/api`;
  let cookie = null;
  const post = async (p, body) => {
    const headers = { 'content-type': 'application/json', origin, accept: 'application/json' };
    if (cookie) headers.cookie = `${COOKIE}=${cookie.value}`;
    const res = await f(`${api}${p}`, { method: 'POST', headers, body: JSON.stringify(body ?? {}), redirect: 'manual' });
    const next = cookieFrom(res);
    if (next) cookie = next;
    let json = null;
    try { json = await res.json(); } catch { /* not json */ }
    return { status: res.status, json };
  };
  const fail = (step, r) => { throw new Error(`hub sign-in: ${step} answered ${r.status}${hubCode(r.json?.error)}`); };

  // 1. The link, read from the stack's Mailpit and deleted there.
  const asked = now();
  const r1 = await post('/admin/auth/link', { email });
  if (r1.status !== 200 || r1.json?.sent !== true) fail('link', r1);
  let token = await mailFor({ f, mailpit, to: email, since: asked, re: /#link=([A-Za-z0-9_-]{20,128})/, now, sleep, waitMs: opts.mailWaitMs });
  if (!token) throw new Error('hub sign-in: no sign-in mail reached the stack\'s Mailpit within a minute');
  const r2 = await post('/admin/auth/link/verify', { token });
  token = null;
  if (r2.status !== 200 || !cookie) fail('link/verify', r2);

  // 2. The second factor.
  const step = () => Math.floor(now() / 1000 / STEP_S);
  let kept = readTotp(totpFile, stack, incarnation);
  let enrolled = false;
  if (kept?.pending) {
    // An enrollment that may not have been confirmed: the code decides. With no
    // factor on the Hub, mfa/totp answers 409 and the session can still enroll.
    const s = step();
    const r = await post('/admin/auth/mfa/totp', { code: totpCode(kept.secret, s) });
    if (r.status === 200 && r.json?.stage === 'active') writeTotp(totpFile, { stack, incarnation, secret: kept.secret, step: s });
    else if (r.status === 409) { fs.rmSync(totpFile, { force: true }); kept = null; }
    else fail('mfa/totp', r);
    if (kept) return done();
  }
  if (kept) {
    // A code works once: wait for a step after the last one used.
    while (kept.step != null && step() <= kept.step) await sleep(1000);
    const s = step();
    const r = await post('/admin/auth/mfa/totp', { code: totpCode(kept.secret, s) });
    if (r.status !== 200 || r.json?.stage !== 'active') fail('mfa/totp', r);
    writeTotp(totpFile, { ...kept, step: s });
  } else {
    const r3 = await post('/admin/auth/enroll/totp/setup');
    if (r3.status !== 200 || typeof r3.json?.secret !== 'string') {
      if (r3.status === 401 || r3.status === 403 || r3.status === 409) {
        throw Object.assign(new Error(`hub sign-in: ${email} already has an authenticator on ${stack}, but Miu holds no secret for it (${path.basename(totpFile)} is missing from its runs/.stacks); remove that factor on the stack (admin-auth-cli) or rebuild the stack, and Miu enrolls again (answered ${r3.status})`), { code: 'staff_factor_without_secret' });
      }
      fail('enroll/totp/setup', r3);
    }
    const secret = r3.json.secret;
    // Kept before it is confirmed: a crash after the Hub accepts it must not lose it.
    writeTotp(totpFile, { stack, incarnation, secret, step: null, pending: true });
    const s = step();
    const r4 = await post('/admin/auth/enroll/totp', { code: totpCode(secret, s) });
    // Left pending: the next sign-in asks the Hub whether it took it (above).
    if (r4.status !== 200 || r4.json?.stage !== 'active') fail('enroll/totp', r4);
    writeTotp(totpFile, { stack, incarnation, secret, step: s });
    enrolled = true;
  }
  return done();
  function done() {
    const expires = cookie.maxAge ? Math.floor(now() / 1000) + cookie.maxAge : -1;
    return { cookie: { name: COOKIE, value: cookie.value, domain: new URL(origin).hostname, expires }, enrolled };
  }
}

// The app side: sign the seeded QA account into the stack's account app
// (hub-<stack>) by its emailed link: POST /auth/email/request, then the link
// itself (GET /auth/email/verify), which sets the session cookie. Only a link
// to the same hub host is followed.
// opts: { hub: 'https://hub-<stack>.xspeedcdn.online', mailpit, email?, fetch?, now?, sleep?, mailWaitMs? }
export async function signInApp(opts) {
  const { hub, mailpit, email = APP_EMAIL } = opts;
  const f = opts.fetch ?? globalThis.fetch;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const origin = new URL(hub).origin;
  const asked = now();
  const r1 = await f(`${origin}/auth/email/request`, { method: 'POST', headers: { 'content-type': 'application/json', origin, accept: 'application/json' }, body: JSON.stringify({ email }), redirect: 'manual' });
  if (r1.status !== 200) throw new Error(`app sign-in: email/request answered ${r1.status}`);
  const link = await mailFor({ f, mailpit, to: email, since: asked, re: /(https:\/\/[^\s"'<>]+\/auth\/email\/verify\?token=[^\s"'<>]+)/, now, sleep, waitMs: opts.mailWaitMs });
  if (!link) throw new Error('app sign-in: no sign-in mail reached the stack\'s Mailpit within a minute');
  if (new URL(link).origin !== origin) throw new Error('app sign-in: the mailed link is not for this stack\'s Hub; not followed');
  const r2 = await f(link, { redirect: 'manual', headers: { accept: 'text/html' } });
  const c = cookieFrom(r2, APP_COOKIE);
  if (!c) throw new Error(`app sign-in: the link answered ${r2.status} without a session`);
  if (/\/two-factor/.test(r2.headers.get('location') ?? '')) throw new Error(`app sign-in: ${email} has two-factor on; Miu cannot pass it`);
  const expires = c.maxAge ? Math.floor(now() / 1000) + c.maxAge : -1;
  return { cookie: { name: APP_COOKIE, value: c.value, domain: c.domain ?? new URL(origin).hostname, expires, sameSite: 'Lax' } };
}

// Only an error code the Hub sends (code_invalid, rate_limited) goes into a
// message, never free text it might echo a code or cookie into.
const hubCode = (e) => (typeof e === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(e) ? ` ${e}` : '');
// Errors this file throws are its own words: they name a step, a status, the
// stack and the address. Anything else (a transport failure, a bug) leaves as
// its kind only, since its message may carry a URL with a token in it.
const OWN = /^(hub|app) sign-in: /;
const OWN_CODES = new Set(['staff_factor_without_secret']);
function shown(e) {
  const msg = String(e?.message ?? '');
  return {
    ...(typeof e?.code === 'string' && OWN_CODES.has(e.code) ? { code: e.code } : {}),
    error: OWN.test(msg) ? msg.slice(0, 300) : `sign-in request failed (${String(e?.name ?? 'Error').replace(/[^A-Za-z]/g, '').slice(0, 30)})`,
  };
}

// Both sign-ins for one stack, each on its own: a failure of one never stops
// the other, and each side that signs in has its state written.
// opts: { stack, incarnation, mailpit, admin, hub, totpFile, adminOut?, appOut?, fetch?, now?, sleep?, mailWaitMs? }
// Resolves { ok, stack, enrolled, admin?, app? }: ok when at least one asked-for
// side signed in; each asked-for side is { ok: true } (admin adds enrolled)
// or { ok: false, code?, error }. No link, code, secret or cookie is in it.
export async function signInStack(opts) {
  const { stack, adminOut, appOut } = opts;
  const out = { ok: false, stack, enrolled: false };
  const failed = (e) => ({ ok: false, ...shown(e) });
  if (adminOut) {
    try {
      const r = await signIn(opts);
      writeStorageState(adminOut, r.cookie);
      out.admin = { ok: true, enrolled: r.enrolled };
      out.enrolled = r.enrolled;
    } catch (e) { out.admin = failed(e); }
  }
  if (appOut) {
    try {
      const r = await signInApp(opts);
      writeStorageState(appOut, r.cookie);
      out.app = { ok: true };
    } catch (e) { out.app = failed(e); }
  }
  out.ok = !!(out.admin?.ok || out.app?.ok);
  if (!out.ok) out.error = [out.admin && `admin: ${out.admin.error.slice(0, 145)}`, out.app && `app: ${out.app.error.slice(0, 145)}`].filter(Boolean).join('; ');
  return out;
}

// A Playwright storage state holding the sessions, written 0600.
export function writeStorageState(file, ...cookies) {
  const state = {
    cookies: cookies.map((cookie) => ({ name: cookie.name, value: cookie.value, domain: cookie.domain, path: '/', expires: cookie.expires, httpOnly: true, secure: true, sameSite: cookie.sameSite ?? 'Strict' })),
    origins: [],
  };
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
}

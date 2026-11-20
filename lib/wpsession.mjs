// A WordPress admin session on a full stack's own public site
// (wp-<stack>.xspeedcdn.online), for claims that need a site the Hub can
// reach: native attach, a render the Hub starts. The Hub's URL guard
// (assertPublicUrl) refuses Miu's QA sites (qa-*.rex), and rightly.
//
// Miu makes the session token here and hands it to `pr-stack wp-session` on
// stdin. WordPress stores only its hash (as its own logins do, user meta
// session_tokens) for the stack's `miu-qa` administrator, tagged with the
// run, and prints only the cookies' signatures. The cookies are put together
// here, written as a Playwright storage state in the run's private/ (0600),
// and the token is listed for redaction (private/redact.list). The run's end
// (lib/hubstack.mjs dropSessions) ends that run's session only.
import fs from 'node:fs';
import path from 'node:path';
import { randomInt } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { writeStorageState } from './hubsignin.mjs';
import { WORKER } from './prstackctl.mjs';

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
// 43 letters and digits, as WordPress makes its own session tokens.
export const newToken = () => Array.from({ length: 43 }, () => ALNUM[randomInt(ALNUM.length)]).join('');

export const SESSIONS_FILE = 'wp-sessions.json';
export const REDACT_FILE = 'redact.list';
const COOKIE_NAME = /^wordpress_(?:sec_|logged_in_)?[0-9a-f]{32}$/;
const COOKIE_PATH = /^\/[A-Za-z0-9/._-]{0,100}$/;

const lastJson = (text) => {
  for (const line of String(text ?? '').trim().split('\n').reverse()) {
    if (!line.trim().startsWith('{')) continue;
    try { return JSON.parse(line); } catch { /* not this line */ }
  }
  return null;
};

// The worker's answer, checked field by field, and the token: Playwright
// cookies for `host`, or throws a code. WordPress sets them urlencoded.
export function cookiesFrom(out, token, host) {
  if (out?.ok !== true) throw Object.assign(new Error('wp-session refused'), { code: typeof out?.code === 'string' && /^[a-z_]{1,40}$/.test(out.code) ? out.code : 'wp_session_failed' });
  if (out.host !== host) throw Object.assign(new Error('wp-session answered for another host'), { code: 'wp_session_host' });
  if (out.login !== 'miu-qa' || !Number.isInteger(out.expires) || !Array.isArray(out.cookies) || !out.cookies.length || out.cookies.length > 8) {
    throw Object.assign(new Error('wp-session answer is not one Miu reads'), { code: 'wp_session_unreadable' });
  }
  return out.cookies.map((c) => {
    if (!COOKIE_NAME.test(c?.name ?? '') || !COOKIE_PATH.test(c?.path ?? '') || !/^[0-9a-f]{64}$/.test(c?.sig ?? '')) {
      throw Object.assign(new Error('wp-session answer is not one Miu reads'), { code: 'wp_session_unreadable' });
    }
    return { name: c.name, value: [out.login, out.expires, token, c.sig].join('%7C'), domain: host, path: c.path, expires: out.expires, sameSite: 'Lax' };
  });
}

// run: the worker (sudoRunner); stack: pr-hub-<n> or pr-hub-base; host: its
// wp-<stack> host; runDir: the run's folder. Resolves { ok, state } or
// { ok: false, code }. Nothing it returns or logs holds the token.
export async function startWpSession({ run, stack, host, runDir }) {
  const priv = path.join(runDir, 'private');
  fs.mkdirSync(priv, { recursive: true, mode: 0o700 });
  const token = newToken();
  // Listed for redaction and for the end of the run before the session exists,
  // so a crash between the two still ends it and still hides it.
  fs.appendFileSync(path.join(priv, REDACT_FILE), `${token}\n`, { mode: 0o600 });
  const file = path.join(priv, SESSIONS_FILE);
  let list = [];
  try { list = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* none yet */ }
  if (!list.includes(stack)) list.push(stack);
  fs.writeFileSync(file, JSON.stringify(list), { mode: 0o600 });
  const r = await run(['wp-session', stack, path.basename(runDir)], { input: `${token}\n` });
  try {
    const cookies = cookiesFrom(lastJson(r.out), token, host);
    const state = path.join(priv, `wp-${stack}.json`);
    writeStorageState(state, ...cookies);
    return { ok: true, state };
  } catch (e) {
    return { ok: false, code: e.code ?? 'wp_session_failed', exit: r.code };
  }
}

// The end of a run: each stack it made a session on ends that run's session.
// Synchronous, so it also runs from an exit handler. end(stack, run) is the
// worker call; by default sudo as the Sandbox account.
export function endWpSessions(runDir, end = defaultEnd) {
  let list = [];
  try { list = JSON.parse(fs.readFileSync(path.join(runDir, 'private', SESSIONS_FILE), 'utf8')); } catch { return []; }
  const out = [];
  for (const stack of Array.isArray(list) ? list : []) {
    if (typeof stack !== 'string') continue;
    out.push({ stack, ok: end(stack, path.basename(runDir)) });
  }
  return out;
}

function defaultEnd(stack, runName) {
  const user = process.env.MIU_SANDBOX_USER;
  if (!user) return false;
  const r = spawnSync('sudo', ['-n', '-H', '-u', user, WORKER, 'wp-session-end', stack, runName], { input: '', timeout: 60_000, encoding: 'utf8' });
  return r.status === 0 && lastJson(r.stdout)?.ok === true;
}

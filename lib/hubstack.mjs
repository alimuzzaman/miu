// The two Hubs a Hub PR's run tests on, when the Hub's profile says
// `stack: { kind: "full" }` (docs/profiles.md): Sandbox stacks on this server
// instead of Hubs on the QA machine.
//
//   pr   the PR's own stack, pr-hub-<n> (lib/prstacks.mjs), at the PR's head
//   dev  pr-hub-base, the whole stack at dev: the "before"
//
// The dashboard makes and follows the stacks (lib/prstackctl.mjs); a run only
// waits until each has applied the commit it must test, then signs the QA
// agent in (bin/qa-hub-signin) and writes context/hubs.json. The sign-in
// states are files in <run>/private/, readable by Miu and the agent account
// only, and deleted when the run ends (dropSessions).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { BASE, ZONE, urls } from './prstacks.mjs';
import { fromStatus } from './prstackctl.mjs';
import { EMAIL as STAFF_EMAIL, APP_EMAIL } from './hubsignin.mjs';

const lastJson = (text) => {
  for (const line of String(text ?? '').trim().split('\n').reverse()) {
    if (!line.trim().startsWith('{')) continue;
    try { return JSON.parse(line); } catch { /* not this line */ }
  }
  return null;
};

// role -> commit each side must have applied. The pr side: the PR's head for its
// own role and each partner's head for theirs. The dev side: whatever dev is.
export function expectedHeads({ selfRole, sha, partners = {} }) {
  const want = { [selfRole]: sha };
  for (const [role, p] of Object.entries(partners)) if (p?.headRefOid) want[role] = p.headRefOid;
  return want;
}

// The stack a run's pr side is: the Hub PR's.
export const prStackName = ({ selfRole, pr, partners = {} }) => `pr-hub-${selfRole === 'hub' ? pr : partners.hub?.number}`;

// Wait until `name` has applied `want` (role -> sha; {} = anything applied).
// Resolves { ok, applied, why }. A failed build of exactly these heads ends the wait.
export async function waitApplied({ run, name, want, timeoutMs = 45 * 60 * 1000, everyMs = 60 * 1000, now = Date.now, sleep, log = () => {} }) {
  const until = now() + timeoutMs;
  let last = 'no status yet';
  for (;;) {
    const r = await run(['status', name]);
    const v = lastJson(r.out);
    if (r.code === 0 && v && v.ok !== false) {
      const st = v.follows?.[0] ?? v;
      const s = fromStatus(v, 'hub');
      const applied = st.applied ?? null;
      const matches = applied && Object.entries(want).every(([role, sha]) => applied[role] === sha);
      if (matches) return { ok: true, applied };
      const tried = st.attempt?.heads ?? st.failed_heads ?? null;
      if (s.failed && tried && Object.entries(want).every(([role, sha]) => tried[role] === sha)) return { ok: false, applied, why: `the stack's build of this commit failed${s.failedReason ? `: ${s.failedReason}` : ''}` };
      last = applied ? `at ${Object.entries(applied).map(([k, x]) => `${k} ${String(x).slice(0, 7)}`).join(', ')}` : (s.attemptRunning ? 'building' : 'not built yet');
    } else last = v?.code ?? `status exit ${r.code}`;
    if (now() >= until) return { ok: false, applied: null, why: `the stack did not reach this commit in time (${last})` };
    log(`hub stack ${name}: waiting (${last})`);
    await sleep(everyMs);
  }
}

// Give the agent account read on a session file, and no one else.
function grant(file, agentUser) {
  if (!agentUser) return;
  const r = spawnSync('setfacl', ['-m', `u:${agentUser}:r,m::r`, file], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`setfacl on a session file failed: ${(r.stderr || '').trim()}`);
}

// Both sides. Resolves { hubs, infra }: hubs is what context/hubs.json holds.
//   run: the worker (lib/prstackctl.mjs sudoRunner); signin(args) -> { code, out }: bin/qa-hub-signin
export async function prepareHubStacks({ run, signin, selfRole, pr, sha, partners = {}, runDir, runsDir, agentUser = null, log = () => {}, sleep, now, timeoutMs }) {
  const infra = [];
  const hubs = {};
  const priv = path.join(runDir, 'private');
  fs.mkdirSync(priv, { recursive: true, mode: 0o700 });
  const sides = [
    { which: 'pr', name: prStackName({ selfRole, pr, partners }), want: expectedHeads({ selfRole, sha, partners }) },
    { which: 'dev', name: BASE.name, want: {} },
  ];
  await Promise.all(sides.map(async (side) => {
    const w = await waitApplied({ run, name: side.name, want: side.want, log, sleep, now, timeoutMs });
    if (!w.ok) {
      infra.push({ what: `The ${side.which} Hub stack ${side.name} is not ready: ${w.why}`, impact: side.which === 'pr' ? 'runtime criteria cannot be tested' : 'claims cannot be reproduced on dev', blocking: true });
      return;
    }
    const p = lastJson((await run(['ports', side.name])).out);
    const port = p?.ports?.mailpit;
    if (!p?.ok || !Number.isInteger(port)) {
      infra.push({ what: `The ${side.which} Hub stack ${side.name} has no Mailpit port (${p?.code ?? 'ports failed'})`, impact: 'Miu cannot sign in to it', blocking: true });
      return;
    }
    const adminState = path.join(priv, `hub-${side.which}-admin.json`);
    const appState = path.join(priv, `hub-${side.which}-app.json`);
    const s = await signin(['--stack', side.name, '--incarnation', `${p.created_at}/${p.copy_id}`, '--mailpit-port', String(port), '--admin-out', adminState, '--app-out', appState, '--runs-dir', runsDir]);
    const out = lastJson(s.out);
    const u = urls(side.name, 'full');
    hubs[side.which] = {
      kind: 'stack', stack: side.name, commit: w.applied?.hub ?? null, applied: w.applied,
      hub: u.hub, admin: u.admin, renderer: u.renderer, wp: u.site, panel: u.panel,
      staff_email: STAFF_EMAIL, app_email: APP_EMAIL,
      admin_state: null, app_state: null,
    };
    if (s.code !== 0 || !out?.ok) {
      infra.push({ what: `Miu could not sign in to ${side.name}: ${out?.error ?? `exit ${s.code}`}`, impact: 'the admin console and the account app need a manual sign-in', blocking: false });
      return;
    }
    try { for (const f of [adminState, appState]) grant(f, agentUser); } catch (e) { infra.push({ what: e.message, impact: 'the agent cannot use the sign-in', blocking: false }); return; }
    Object.assign(hubs[side.which], { admin_state: adminState, app_state: appState });
    log(`hub stack ${side.name}: ready at hub ${String(w.applied?.hub ?? '').slice(0, 7)}, signed in${out.enrolled ? ' (authenticator enrolled)' : ''}`);
  }));
  return { hubs, infra };
}

// The end of a run: the sign-in states go.
export function dropSessions(runDir) {
  fs.rmSync(path.join(runDir, 'private'), { recursive: true, force: true });
}

export { ZONE };

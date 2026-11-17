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
import { BASE, ZONE, urls, describe } from './prstacks.mjs';
import { fromStatus, followOf } from './prstackctl.mjs';
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
// planned: the dashboard's entry for the stack (runs/.stacks.json), or null.
export async function waitApplied({ run, name, want, planned = null, timeoutMs = 45 * 60 * 1000, everyMs = 60 * 1000, now = Date.now, sleep, log = () => {} }) {
  // No stack is coming: say so now rather than hold the run lock for the whole wait.
  if (planned && ['refused', 'failed', 'removing', 'removed'].includes(planned.state)) return { ok: false, applied: null, why: `no test stack: ${describe(planned)}` };
  const until = now() + timeoutMs;
  let last = 'no status yet';
  for (;;) {
    const r = await run(['status', name]);
    const v = lastJson(r.out);
    if (v?.code === 'follow_not_found' && !(planned && ['waiting', 'adding'].includes(planned.state))) return { ok: false, applied: null, why: 'no test stack follows it (test stacks are off in Settings, or the pull request was never queued)' };
    if (r.code === 0 && v && v.ok !== false) {
      const st = followOf(v);
      const s = fromStatus(v, 'hub');
      const applied = st.applied ?? null;
      const matches = applied && Object.entries(want).every(([role, sha]) => applied[role] === sha);
      if (matches) return { ok: true, applied };
      const tried = st.attempt?.heads ?? st.failed_heads ?? null;
      if (s.failed && tried && Object.entries(want).every(([role, sha]) => tried[role] === sha)) return { ok: false, applied, why: `the stack's build of this commit failed${s.failedReason ? `: ${s.failedReason}` : ''}` };
      // A fetch that fails (a deploy key) fails every commit alike.
      if (s.failed && /fetch failed|deploy key/.test(s.failedReason ?? '')) return { ok: false, applied, why: s.failedReason };
      last = applied ? `at ${Object.entries(applied).map(([k, x]) => `${k} ${String(x).slice(0, 7)}`).join(', ')}` : (s.attemptRunning ? 'building' : 'not built yet');
    } else last = v?.code ?? `status exit ${r.code}`;
    if (now() >= until) return { ok: false, applied: null, why: `the stack did not reach this commit in time (${last})` };
    log(`hub stack ${name}: waiting (${last})`);
    await sleep(everyMs);
  }
}

// The agent account may read the session files and nothing else in private/.
// Run after the run folder is shared with it (lib/agentuser.mjs shareRunDir
// grants it rw everywhere), so this is what holds.
export function grantSessions(runDir, agentUser) {
  if (!agentUser) return;
  const priv = path.join(runDir, 'private');
  if (!fs.existsSync(priv)) return;
  const set = (spec, p) => {
    const r = spawnSync('setfacl', ['-m', spec, p], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`setfacl on ${path.basename(p)} failed: ${(r.stderr || '').trim()}`);
  };
  set(`u:${agentUser}:x`, priv);
  for (const f of fs.readdirSync(priv)) set(`u:${agentUser}:r,m::r`, path.join(priv, f));
}

// Both sides. Resolves { hubs, infra }: hubs is what context/hubs.json holds.
//   run: the worker (lib/prstackctl.mjs sudoRunner); signin(args) -> { code, out }: bin/qa-hub-signin
export async function prepareHubStacks({ run, signin, selfRole, pr, sha, partners = {}, runDir, runsDir, log = () => {}, sleep, now, timeoutMs }) {
  const infra = [];
  const hubs = {};
  const priv = path.join(runDir, 'private');
  fs.mkdirSync(priv, { recursive: true, mode: 0o700 });
  const sides = [
    { which: 'pr', name: prStackName({ selfRole, pr, partners }), want: expectedHeads({ selfRole, sha, partners }) },
    { which: 'dev', name: BASE.name, want: {} },
  ];
  await Promise.all(sides.map(async (side) => {
    let planned = null;
    try { planned = Object.values(JSON.parse(fs.readFileSync(path.join(runsDir, '.stacks.json'), 'utf8'))).find((x) => x.name === side.name) ?? null; } catch { /* no plan file: a stack made by hand */ }
    const w = await waitApplied({ run, name: side.name, want: side.want, planned, log, sleep, now, timeoutMs });
    if (!w.ok) {
      infra.push({ what: `The ${side.which} Hub stack ${side.name} is not ready: ${w.why}`, impact: side.which === 'pr' ? 'runtime criteria cannot be tested' : 'claims cannot be reproduced on dev', blocking: true });
      return;
    }
    const p = lastJson((await run(['ports', side.name])).out);
    const port = p?.ports?.mailpit;
    if (!p?.ok || !Number.isInteger(port) || !p.created_at || !p.copy_id) {
      infra.push({ what: `The ${side.which} Hub stack ${side.name} has no Mailpit port or no incarnation (${p?.code ?? 'ports failed'})`, impact: 'Miu cannot sign in to it', blocking: true });
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

// A run Miu did not test because of a merge conflict says which files and
// which base, on the run page and in the run list (not "the agent wrote no results").
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'miu-conflict-'));
const runs = path.join(tmp, 'runs');
const profilesDir = path.join(tmp, 'profiles');
fs.mkdirSync(profilesDir);
fs.writeFileSync(path.join(profilesDir, 'project.json'), JSON.stringify({ owner: 'acme' }));
const port = 40000 + Math.floor(Math.random() * 20000);
const env = { ...process.env, HOME: tmp, MIU_PROFILES: profilesDir, MIU_AUTH: '', MIU_HOST: '127.0.0.1', MIU_SANDBOX_USER: '', MIU_SANDBOX_WORKER: '' };

function run(name, conflict) {
  const dir = path.join(runs, name);
  fs.mkdirSync(path.join(dir, 'context'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'context/pr.json'), JSON.stringify({ number: 822, title: 'x', url: 'https://github.com/acme/app/pull/822', author: { login: 'a' } }));
  fs.writeFileSync(path.join(dir, 'run.log'), '[qa 10:59:06] conflict\n');
  fs.writeFileSync(path.join(dir, 'conflict.json'), JSON.stringify(conflict));
}
run('app-822-m-1', { kind: 'conflict', sha: '5b55edf7586799302eccfcbaf1e049e25a2ece8d', base: 'dev', files: ['docs/guides/hooks-and-filters.md'], at: '2026-11-18T10:59:06.498Z' });
run('app-823-m-1', { kind: 'already_in_base', sha: '1111111aaaa', base: 'dev', files: [], at: '2026-11-18T10:59:06.498Z' });

function startDashboard() {
  const child = spawn(process.execPath, [path.join(ROOT, 'bin/qa-dashboard'), '--port', String(port), '--runs', runs], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no start in 20 s:\n${out}`)), 20000);
    const seen = (d) => { out += d; if (/listening on/.test(out)) { clearTimeout(timer); resolve(child); } };
    child.stdout.on('data', seen); child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (c) => { clearTimeout(timer); reject(new Error(`exited ${c}:\n${out}`)); });
  });
}

test('a conflict run carries its base, commit and files; the page names them', { timeout: 60000 }, async () => {
  const dash = await startDashboard();
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/api/runs`)).json();
    const c = list.find((r) => r.name === 'app-822-m-1');
    assert.equal(c.state, 'conflict');
    assert.equal(c.conflictKind, 'conflict');
    assert.deepEqual(c.conflictFiles, ['docs/guides/hooks-and-filters.md']);
    assert.equal(list.find((r) => r.name === 'app-823-m-1').conflictKind, 'already_in_base');

    const d = await (await fetch(`http://127.0.0.1:${port}/api/runs/app-822-m-1`)).json();
    assert.deepEqual(d.status.conflict.files, ['docs/guides/hooks-and-filters.md']);
    assert.equal(d.status.conflict.base, 'dev');

    // The page's own words for both kinds, from the functions the page runs.
    const html = fs.readFileSync(path.join(ROOT, 'lib/dashboard.html'), 'utf8');
    const src = html.slice(html.indexOf('const STATE ='), html.indexOf('// MIU (set by the server'));
    const { stateOf, noVerdictText } = new Function(`${src}; return { stateOf, noVerdictText };`)();
    assert.equal(stateOf(c), 'Not tested: merge conflict');
    assert.match(noVerdictText(d.status), /^Not tested\. Merging this pull request \(at 5b55edf\) into dev conflicts in 1 file: docs\/guides\/hooks-and-filters\.md\. /);
    const a = await (await fetch(`http://127.0.0.1:${port}/api/runs/app-823-m-1`)).json();
    assert.equal(stateOf(a.status), 'Not tested: already in dev');
    assert.match(noVerdictText(a.status), /already in dev, so merging it changes nothing/);
    assert.doesNotMatch(noVerdictText(d.status) + noVerdictText(a.status), /wrote no results|or already in/);
  } finally {
    dash.kill('SIGTERM');
  }
});

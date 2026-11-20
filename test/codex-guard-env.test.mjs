import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { codexMcpEnv } from '../lib/codex.mjs';
import { QASITE_MCP_TOOLS } from '../lib/rules.mjs';

test('with the agent on its own account, the guard is told so and runs qasite through sudo', () => {
  const e = codexMcpEnv({ PATH: '/usr/bin' }, 'miu-agent');
  assert.equal(e.MIU_AGENT_USER, 'miu-agent');
  assert.equal(e.HOME, '/home/miu-agent');
  assert.match(e.QA_REX_BIN, /rex-as-qa$/);
});

test('without an agent account the guard keeps Miu\'s own rexenv CLI', () => {
  assert.deepEqual(codexMcpEnv({ PATH: '/usr/bin', HOME: '/home/miu' }, null), { PATH: '/usr/bin', HOME: '/home/miu' });
});

test('Codex enables every qasite tool the guard offers', () => {
  const guard = fs.readFileSync(new URL('../lib/mcp-guard.mjs', import.meta.url), 'utf8');
  const offered = [...guard.matchAll(/^\s+(qa_[a-z_]+): \{ sub:/gm)].map((m) => m[1]);
  offered.push(guard.match(/name: '(qa_rig)'/)[1]);
  assert.deepEqual([...offered].sort(), [...QASITE_MCP_TOOLS].sort());
  assert.match(fs.readFileSync(new URL('../lib/codex.mjs', import.meta.url), 'utf8'), /\.\.\.QASITE_MCP_TOOLS\]/);
});

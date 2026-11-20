#!/usr/bin/env node
// rexenv's MCP server behind a guard, for engines without Claude's tool hooks
// (Codex). The engine starts this instead of `rex mcp`; it starts `rex mcp`
// and passes messages both ways, with the limits a Claude run gets from its
// hooks in lib/agent.mjs:
//   - only the tools in REXENV_TOOLS are listed or callable
//   - a call with a site_id reaches only the QA sites (context/sites.json) and
//     scratch sites this run made; anything else is refused
//   - every call is written to the evidence ledger, and its reply says the id
//
//   node lib/mcp-guard.mjs <run-dir>
// Refusals are logged to <run-dir>/mcp-guard.log.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AGENT_USER, AGENT_QASITE } from './agentuser.mjs';
import { REXENV_TOOLS, QASITE_MCP_TOOLS, recordMcpEvidence, siteRule } from './rules.mjs';

const runDir = process.argv[2];
if (!runDir || !fs.existsSync(runDir)) { console.error('usage: mcp-guard.mjs <run-dir>'); process.exit(2); }
const TOOLS = new Set(REXENV_TOOLS.map((t) => t.replace('mcp__rexenv__', '')));
const FIX = (() => { try { return 'fix' in JSON.parse(fs.readFileSync(path.join(runDir, 'context/sites.json'), 'utf8')); } catch { return false; } })();
if (FIX) for (const t of [...TOOLS]) if (t.startsWith('scratch_')) TOOLS.delete(t);

// qasite as MCP tools. Codex's sandbox forbids sudo, which the shell's qasite
// needs once the agent has its own account; this guard runs outside that
// sandbox, so it can run qasite for the agent.
const QASITE_TOOLS = {
  qa_site_reset: { sub: 'reset', description: 'Put a QA site back to its clean snapshot in about a second (database, drop-ins and cache folders), on nginx in its own folder with its default rig files. The same as `qasite reset pr|dev`. Run it before every combo.' },
  qa_site_login: { sub: 'login', description: 'A one-time wp-admin sign-in link for a QA site, valid for two minutes. The same as `qasite login pr|dev`.' },
  qa_site_server: { sub: 'server', rig: true, arg: { name: 'server', enum: ['apache', 'nginx'] }, description: 'Serve a QA site with Apache (rexenv\'s, .htaccess on) or back with nginx, at its usual URL. The same as `qasite server pr|dev apache|nginx`. qa_site_reset puts it back on nginx.' },
  qa_site_move: { sub: 'move', rig: true, arg: { name: 'to', pattern: '^(back|[a-z0-9][a-z0-9-]{0,30})$' }, description: 'Move a QA site\'s docroot to a folder of that name (a real move; its URL stays), or back. The same as `qasite move pr|dev <name>|back`. qa_site_reset moves it back.' },
};
// The lane's own nginx (lib/rig.mjs): the same as `qasite rig <action> [file]`,
// with content for put (what the shell version reads on stdin).
const RIG_TOOL = {
  name: 'qa_rig',
  description: 'The lane\'s own nginx, serving the pr and dev sites on a loopback port: write server blocks and snippets, test and reload it. The same as `qasite rig start|reload|stop|show|default` and `qasite rig put|rm <file>`. Files: sites/<pr|dev|shared>[-name].conf (http level) and snippets/<pr|dev>/<name>.conf (inside the default server block). `show` gives the port and a curl line per site.',
  inputSchema: { type: 'object', properties: {
    action: { type: 'string', enum: ['start', 'reload', 'stop', 'show', 'default', 'put', 'rm'] },
    file: { type: 'string', description: 'for put and rm' },
    content: { type: 'string', description: 'the file\'s text, for put' },
  }, required: ['action'] },
};
// Codex shows only the tools it enables (lib/codex.mjs, from QASITE_MCP_TOOLS).
for (const n of [...Object.keys(QASITE_TOOLS), RIG_TOOL.name]) if (!QASITE_MCP_TOOLS.includes(n)) throw new Error(`${n} is missing from QASITE_MCP_TOOLS (lib/rules.mjs): Codex would never show it`);
// The QA sites of this run (context/sites.json): pr and dev for a test, fix
// for a fix. A fix has its own site, so it makes no scratch sites.
let siteMap = {};
try { siteMap = JSON.parse(fs.readFileSync(path.join(runDir, 'context/sites.json'), 'utf8')); } catch { /* none */ }
const NAMES = Object.keys(siteMap).filter((w) => ['pr', 'dev', 'fix'].includes(w));
const RIG_NAMES = NAMES.filter((w) => w !== 'fix');
const domainOf = (w) => siteMap[w]?.domain ?? `qa-${w}.rex`;
const WHAT = { pr: `pr = ${domainOf('pr')} (the PR build)`, dev: `dev = ${domainOf('dev')} (the base branch)`, fix: `fix = ${domainOf('fix')} (the code being fixed)` };
// The run's lane (lib/lane.mjs), from sites.json: the guard gets no QA_LANE.
const LANE_ARG = (() => { const l = Object.values(siteMap).find((w) => w?.lane)?.lane; return l ? [`--lane=${l}`] : []; })();
const qasiteDefs = NAMES.length ? [
  ...Object.entries(QASITE_TOOLS).filter(([, t]) => !t.rig || RIG_NAMES.length).map(([name, t]) => {
    const names = t.rig ? RIG_NAMES : NAMES;
    const properties = { site: { type: 'string', enum: names, description: names.map((w) => WHAT[w]).join(', ') } };
    if (t.arg) properties[t.arg.name] = { type: 'string', ...(t.arg.enum ? { enum: t.arg.enum } : { pattern: t.arg.pattern }) };
    return { name, description: t.description, inputSchema: { type: 'object', properties, required: ['site', ...(t.arg ? [t.arg.name] : [])] } };
  }),
  ...(RIG_NAMES.length ? [RIG_TOOL] : []),
] : [];
const qasite = (argv, input) => (AGENT_USER
  ? spawnSync(AGENT_QASITE, [...argv, ...LANE_ARG], { encoding: 'utf8', timeout: 5 * 60 * 1000, input })
  : spawnSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'warmsites.mjs'), ...argv, ...LANE_ARG], { encoding: 'utf8', timeout: 5 * 60 * 1000, input }));
function runQasite(name, args) {
  let r;
  if (name === RIG_TOOL.name) {
    const action = args?.action;
    if (!RIG_NAMES.length || !RIG_TOOL.inputSchema.properties.action.enum.includes(action)) return { text: `action must be one of: ${RIG_TOOL.inputSchema.properties.action.enum.join(', ')}.`, error: true };
    if (['put', 'rm'].includes(action) && (typeof args?.file !== 'string' || !/^[a-z0-9/_.-]{1,120}$/.test(args.file))) return { text: `${action} needs a file: sites/<pr|dev|shared>[-name].conf or snippets/<pr|dev>/<name>.conf.`, error: true };
    if (action === 'put' && (typeof args?.content !== 'string' || args.content.includes('\0'))) return { text: 'put needs content: the file\'s text.', error: true };
    r = qasite(['rig', action, ...(['put', 'rm'].includes(action) ? [String(args.file)] : [])], action === 'put' ? String(args?.content ?? '') : '');
  } else {
    const t = QASITE_TOOLS[name];
    const site = args?.site;
    const names = t.rig ? RIG_NAMES : NAMES;
    if (!names.includes(site)) return { text: `site must be one of: ${names.join(', ') || 'none in this run'}.`, error: true };
    const extra = t.arg ? args?.[t.arg.name] : undefined;
    if (t.arg && (typeof extra !== 'string' || (t.arg.enum ? !t.arg.enum.includes(extra) : !new RegExp(t.arg.pattern).test(extra)))) return { text: `${t.arg.name} is not valid.`, error: true };
    r = qasite([t.sub, site, ...(t.arg ? [extra] : [])], '');
  }
  return { text: ((r.stdout || '') + (r.stderr || '')).trim() || `exit ${r.status}`, error: r.status !== 0 };
}
const sites = new Set();
try { for (const w of Object.values(JSON.parse(fs.readFileSync(path.join(runDir, 'context/sites.json'), 'utf8')))) if (w?.id) sites.add(w.id); } catch { /* no QA sites: scratch sites only */ }
const note = (m) => fs.appendFileSync(path.join(runDir, 'mcp-guard.log'), `[${new Date().toISOString()}] ${m}\n`);

const rex = spawn(process.env.QA_REX_BIN ?? 'rex', ['mcp'], { stdio: ['pipe', 'pipe', 'inherit'] });
rex.on('exit', (code) => process.exit(code ?? 0));
process.stdin.on('end', () => rex.stdin.end());
const toClient = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

const pending = new Map(); // request id -> { kind: 'list' } | { kind: 'call', tool, args }

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { rex.stdin.write(line + '\n'); return; }
  if (msg.method === 'tools/list' && msg.id != null) pending.set(msg.id, { kind: 'list' });
  if (msg.method === 'tools/call' && msg.id != null && (QASITE_TOOLS[msg.params?.name] || msg.params?.name === RIG_TOOL.name)) {
    const tool = msg.params.name;
    const args = msg.params.arguments ?? {};
    let out;
    try { out = runQasite(tool, args); } catch (e) { out = { text: `${tool} failed: ${e.message}`, error: true }; }
    const content = [{ type: 'text', text: out.text }];
    try {
      const id = recordMcpEvidence(runDir, { tool_name: `mcp__rexenv__${tool}`, tool_input: args, tool_response: content });
      content.push({ type: 'text', text: `Recorded as evidence ${id}. Cite it as "${id}".` });
    } catch (e) { note(`could not record evidence for ${tool}: ${e.message}`); }
    toClient({ jsonrpc: '2.0', id: msg.id, result: { content, isError: out.error } });
    return;
  }
  if (msg.method === 'tools/call' && msg.id != null) {
    const tool = msg.params?.name;
    const args = msg.params?.arguments ?? {};
    let why = null;
    if (!TOOLS.has(tool)) why = `${tool} is not available in a QA run.`;
    else why = siteRule(tool, args, sites);
    if (why) {
      note(`refused ${tool}: ${why}`);
      toClient({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: why }], isError: true } });
      return;
    }
    pending.set(msg.id, { kind: 'call', tool, args });
  }
  rex.stdin.write(JSON.stringify(msg) + '\n');
});

readline.createInterface({ input: rex.stdout }).on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { process.stdout.write(line + '\n'); return; }
  const req = msg.id != null && pending.get(msg.id);
  if (req) pending.delete(msg.id);
  if (req?.kind === 'list' && Array.isArray(msg.result?.tools)) {
    msg.result.tools = [...msg.result.tools.filter((t) => TOOLS.has(t.name)), ...qasiteDefs];
  }
  if (req?.kind === 'call' && msg.result) {
    try {
      const content = msg.result.content ?? [];
      const id = recordMcpEvidence(runDir, { tool_name: `mcp__rexenv__${req.tool}`, tool_input: req.args, tool_response: content });
      if (req.tool === 'scratch_create_site') {
        try { const made = JSON.parse(content.map((c) => c.text ?? '').join('')); if (made.id) sites.add(made.id); } catch { /* no id */ }
      }
      msg.result.content = [...content, { type: 'text', text: `Recorded as evidence ${id}. Cite it as "${id}".` }];
    } catch (e) { note(`could not record evidence for ${req.tool}: ${e.message}`); }
  }
  toClient(msg);
});

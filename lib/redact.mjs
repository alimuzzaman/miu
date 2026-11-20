// Redaction where evidence is captured: bin/qa-evidence runs this on every
// file it writes (a command's log, an HTTP capture and its body, a console
// log, a copied note) in a staging folder, and publishes the file only once
// this succeeded, so no session reaches a report, the run page or run-read.
//
//   node lib/redact.mjs <file>...     rewrite each file in place; exit 1 on any failure
//
// Two things go: the value of any session cookie Miu's sign-ins make
// (WordPress auth and logged-in cookies, the Hub admin and app sessions),
// written as name=value (quoted or not) or as a {name, value} object in any key
// order (storage states, HAR); and every literal in $QA_REDACT_FILE (the
// run's private/redact.list: its WordPress tokens and Hub session values),
// plain or urlencoded. It works on bytes (latin1), so a NUL or invalid UTF-8
// anywhere changes nothing about what is found, and every other byte stays.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const MASK = '[redacted]';
const COOKIE_NAMES = String.raw`(?:wordpress_(?:sec_|logged_in_)?[0-9a-f]{32}|__Host-xspeed_admin_session|xspeed_hub_session)`;
// name=value, as a header, a query, a shell line or a log has it.
const PAIR = new RegExp(String.raw`(${COOKIE_NAMES}\s*=\s*)(["']?)[^;\s"',&]+`, 'g');
// A JSON or JS object with no nested braces that names such a cookie: its
// value field goes, wherever it sits among the keys.
const OBJECT = new RegExp(String.raw`\{[^{}]*?["']?name["']?\s*:\s*["']${COOKIE_NAMES}["'][^{}]*\}`, 'g');
const VALUE_FIELD = /(["']?value["']?\s*:\s*)(["'])(?:\\.|(?!\2).)*\2/g;

export function redact(text, literals = []) {
  let out = String(text)
    .replace(OBJECT, (o) => o.replace(VALUE_FIELD, (_, k, q) => `${k}${q}${MASK}${q}`))
    .replace(PAIR, (_, k, q) => `${k}${q}${MASK}`);
  for (const l of literals) {
    if (typeof l !== 'string' || l.length < 16) continue;
    for (const form of new Set([l, encodeURIComponent(l), JSON.stringify(l).slice(1, -1)])) out = out.split(form).join(MASK);
  }
  return out;
}

export function literalsFrom(file) {
  if (!file) return [];
  try { return fs.readFileSync(file, 'utf8').split('\n').map((x) => x.trim()).filter(Boolean); } catch { return []; }
}

// Throws when the file cannot be read or written: the caller then does not publish it.
export function redactFile(file, literals) {
  const before = fs.readFileSync(file).toString('latin1');
  const after = redact(before, literals);
  if (after === before) return false;
  const tmp = `${file}.redact-${process.pid}`;
  fs.writeFileSync(tmp, Buffer.from(after, 'latin1'), { mode: fs.statSync(file).mode & 0o777 });
  fs.renameSync(tmp, file);
  return true;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const literals = literalsFrom(process.env.QA_REDACT_FILE);
  let failed = 0;
  for (const f of process.argv.slice(2)) {
    try { redactFile(f, literals); } catch (e) { failed++; console.error(`redact: ${f}: ${e.code ?? e.message}`); }
  }
  process.exit(failed ? 1 : 0);
}

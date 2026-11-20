# A WordPress admin session on a stack's own public site

Status: built on `feat/stack-wp-session` (Miu) and `feat/stack-wp-session` (xspeed-dev-setup), 2026-11-20. Two parts changed from the first draft, both marked "Built as" below.

## The problem

Some Hub claims, such as native attach or a render that the Hub starts, need a WordPress site that the Hub can reach. Every fetch the Hub makes to a site goes through `assertPublicUrl()` (xspeed-hub `src/security/ssrf.ts`). That guard refuses loopback, private ranges, literal IPs, odd ports and names that do not resolve publicly. Miu's QA sites are `https://qa-pr-<n>.rex:8543`: a `.rex` name on port 8543 that resolves on the server only. The guard rejects them, and it should, so those claims cannot pass on a QA site.

A full PR stack already has a public WordPress: `https://wp-<stack>.xspeedcdn.online` (lib/prstacks.mjs `urls()`, xspeed-dev-setup `stacks/wp-site`, `WP_HOST={slug}.xspeedcdn.online`). That WordPress runs the PR's plugins and sits beside the stack's own Hub. What is missing is a way for the agent's browser to start signed in to its wp-admin, as it already starts signed in to the stack's admin console and account app (lib/hubsignin.mjs).

## The two questions, answered (2026-11-20, from the setup repo and pr-hub-642, read-only)

- **Which container is a full stack's WordPress?** The same Sandbox stack's. `stacks/hub/overlay/sandbox.full.hosting.yml` lays `wordpress`, `wp-db` and `wp-setup` into the stack `<stack>` (compose project `sandbox-host-xspeed-hub-<stack>-sandbox`), with `wp-<stack>.xspeedcdn.online` as its primary host. There is no separate `wp-<stack>` stack: that name is only for WordPress-only stacks on the shared Hub. Miu's `pr-stack add` uses the Docker backend. On pr-hub-642 the `wordpress` service answered with `siteurl` `https://wp-pr-hub-642.xspeedcdn.online`.
- **Is it attached to its own Hub?** It points at its own Hub but is not attached. `site.env` sets `XSPEED_HUB_URL=https://hub-<stack>.xspeedcdn.online`, and on pr-hub-642 `Mcp_Hub::hub_url()` is that URL, `attached` is false and the account is empty. So native attach is a claim the agent can make on it from the start. The prompt says so, and no longer says the site is attached.

## The smallest mechanism

1. **A QA admin on the stack's WordPress.** The stack's init (xspeed-dev-setup `stacks/wp-site/init/init.sh`) adds a user `miu-qa` with the administrator role and a random password that is never stored. It is not `xsadmin`, so Miu's sessions can be ended without touching the stack owner's.
2. **Two fixed verbs in `bin/miu-pr-stack`: `wp-session <stack> <run>` and `wp-session-end <stack> <run>`.** They run as the Sandbox account through the existing sudo rule. **Built as:**
   - **Where the PHP runs.** `wp eval` runs in the stack's `wp-setup` container, which has WP-CLI, is not blue-green, and is found by its compose labels, with `docker exec`. This replaces `sb host exec`, because `host exec` needs `--remote` and the server has no remote for itself.
   - **Where the token comes from.** Miu makes the token (43 letters and digits) and sends it on stdin. WordPress stores the session under the token's sha256, tagged `miu_run`, for 4 hours. It prints only each cookie's signature (`wp_generate_auth_cookie` with the token dropped), for `secure_auth` on the admin and plugins paths, `auth` and `logged_in`. Miu joins login, expiry, token and signature itself. No stdout, argv or log, Miu's or Sandbox's, holds a working cookie, and a signature without its token is refused (checked).
   - **Ending.** `wp-session-end` removes the sessions tagged with that run, and a second `wp-session` for a run replaces its first.
   - **One at a time.** Every start and end on a stack holds a per-stack lock (`flock`, in the Sandbox account's `sandbox/runtime/miu-pr-stack`), since each one reads and writes `miu-qa`'s whole session list; otherwise a start beside an end could bring back the session just ended.
3. **Miu takes it like the Hub sessions** (`lib/wpsession.mjs`). `lib/hubstack.mjs` calls the verb after the stack is ready, for each side, on its own. It writes the cookies into a Playwright storage state for `wp-<stack>.xspeedcdn.online` (`Secure`, `HttpOnly`, the paths WordPress sets: `/wp-admin` for the auth cookie and `/` for logged-in), 0600, in the run's `private/`. It adds `wp_state` and `wp` next to `admin_state`/`app_state` in `context/hubs.json`. The agent's browser loads it as it loads the others. `dropSessions()` deletes it at the end.
4. **The session is ended at the end of the run.** `dropSessions()`, which runs at every end of a run and from its exit handler, calls `wp-session-end <stack> <run>` for each stack listed in `private/wp-sessions.json` before it deletes `private/`. The stack is listed before the session is made, so a crash between the two still ends it. Only that run's sessions go, never `destroy_all()`, since several runs share `pr-hub-base`. A stack whose end failed stays listed (names only) and is tried again by the exit handler; the run log says so. The 4-hour expiry covers a run killed before its exit handler runs.

Native attach then runs as the product does. The agent opens wp-admin on the public host, starts attach, and the Hub fetches `https://wp-<stack>.xspeedcdn.online`, which `assertPublicUrl` accepts. The OAuth step goes to `hub-<stack>`, where the app session already exists.

## Risks and what holds them

- **A live admin credential to a public URL.** Anyone who has the cookie can administer that stack's WordPress from the internet until it expires or is destroyed. Hold:
  - only test stacks have the `miu-qa` user, and no production site does;
  - the expiry is short, and the token is destroyed at the end of the run;
  - one token per run, so ending it does not end anyone else's session.
- **Leaks through Miu's own outputs.** These are the paths a cookie could take:
  - stdout of `pr-stack`: `sudoRunner` keeps 500 characters of stderr in errors, so the verb must print the cookie only on stdout and never on stderr;
  - the run log: log only "wp signed in", never the line;
  - evidence: `.http` captures, HAR files and console logs can carry a `Cookie:` header;
  - PR comments.

  **Built as:** redaction at capture (`lib/redact.mjs`). `bin/qa-evidence` runs it on every text file it writes (command logs, HTTP captures and bodies, console logs, copied notes) and on the ledger, before the agent is shown the output. Each file is captured in `evidence/.staging` (not served, and refused by `run-read`), redacted there, and only then moved into `evidence/`; if redaction fails, nothing is kept and the capture fails. Ledger rows are redacted before they are appended. It works on bytes, so a NUL or invalid UTF-8 changes nothing. It masks the values of the WordPress and Hub session cookies by name, as `name=value` (quoted or not) or as a `{name, value}` object in any key order, and every literal in the run's `private/redact.list` (`QA_REDACT_FILE`): the WordPress tokens and the Hub sessions' cookie values. `test/redact.test.mjs` plants a synthetic session in a request, a response, a command and a note, and checks that no evidence file or ledger line holds the token or a signature. Agent transcripts are not redacted at capture; the prompt forbids printing state files or cookies, and that stays a rule rather than a guard.
- **The agent can do anything an administrator can on that site:** install plugins, change settings, delete content. That is acceptable on a test stack that a rebuild resets. The stack's WordPress must never share a database, uploads or credentials with dev or production.
- **Cookie format drift.** WordPress may change its cookie or token APIs. These are core functions used by core's own login, but a major WordPress update should run this path's test.
- **The verb runs PHP inside the stack.** It takes no user input: the stack name is checked by `name_ok` as the other verbs are, and the PHP is a fixed string. It must not grow a "run this PHP" argument.
- **Same-name stacks.** A token belongs to one WordPress database. A rebuilt stack has a new one, so an old cookie fails rather than signing in somewhere else. There is no incarnation file to keep, unlike the Hub authenticator.

## Not chosen

- **Loosening `assertPublicUrl` for `.rex` or for the dev server.** It is the Hub's SSRF guard. A carve-out for test hosts is the kind of exception that ends up in production.
- **A login-link plugin on the stack site.** It is one more plugin in the code under test, and a standing route that mints sessions.
- **Driving the wp-login form with a stored password.** That means a long-lived secret to keep and to rotate, where the token above has none.

## Still open

- A run killed with SIGKILL skips its exit handler, so its session lives until it expires (4 hours). A sweep of expired `miu-qa` sessions is not needed: WordPress drops expired ones on the next write, and every `wp-session` does one.
- The stack's WordPress must get `miu-qa` before any of this works. That comes from the setup branch's `init.sh` and reaches a stack on its next apply: after the setup change is on `main`, every followed stack rebuilds.

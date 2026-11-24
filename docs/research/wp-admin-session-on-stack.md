# A WordPress admin session on a stack's own public site

Status: design note, 2026-11-20. Nothing here is built.

## The problem

Some Hub claims, such as native attach or a render that the Hub starts, need a WordPress site that the Hub can reach. Every fetch the Hub makes to a site goes through `assertPublicUrl()` (xspeed-hub `src/security/ssrf.ts`). That guard refuses loopback, private ranges, literal IPs, odd ports and names that do not resolve publicly. Miu's QA sites are `https://qa-pr-<n>.rex:8543`: a `.rex` name on port 8543 that resolves on the server only. The guard rejects them, and it should, so those claims cannot pass on a QA site.

A full PR stack already has a public WordPress: `https://wp-<stack>.xspeedcdn.online` (lib/prstacks.mjs `urls()`, xspeed-dev-setup `stacks/wp-site`, `WP_HOST={slug}.xspeedcdn.online`). That WordPress runs the PR's plugins and sits beside the stack's own Hub. What is missing is a way for the agent's browser to start signed in to its wp-admin, as it already starts signed in to the stack's admin console and account app (lib/hubsignin.mjs).

## The smallest mechanism

1. **A QA admin on the stack's WordPress.** The stack's init (xspeed-dev-setup `stacks/wp-site/init/init.sh`) adds a user `miu-qa` with the administrator role and a random password that is never stored. It is not `xsadmin`, so Miu's sessions can be ended without touching the stack owner's.
2. **A new fixed verb in `bin/miu-pr-stack`, `wp-session <stack>`.** It runs as the Sandbox account through the existing sudo rule. It runs one PHP call in the stack's `wordpress` service, the way `stacks/wp-site/attach.sh` does with `sb host exec ... -- php -r`, since the image has no WP-CLI. The call loads `wp-load.php`, finds `miu-qa` and creates a session token (`WP_Session_Tokens::get_instance($id)->create($expires)`). It then builds the two cookies wp-admin needs over https: `wp_generate_auth_cookie($id, $expires, 'secure_auth', $token)` for `wordpress_sec_<COOKIEHASH>`, and the same call with `'logged_in'` for `wordpress_logged_in_<COOKIEHASH>`. `COOKIEHASH` is `md5(siteurl)`. It prints one JSON line: `{ ok, host, expires, cookies: [{ name, value, path }] }`. Expiry is the run's limit, at most 4 hours.
3. **Miu takes it like the Hub sessions.** `lib/hubstack.mjs` calls the verb after the stack is ready. It writes the cookies into a Playwright storage state for `wp-<stack>.xspeedcdn.online` (`Secure`, `HttpOnly`, the paths WordPress sets: `/wp-admin` for the auth cookie and `/` for logged-in), 0600, in the run's `private/`. It adds `wp_state` and `wp` next to `admin_state`/`app_state` in `context/hubs.json`. The agent's browser loads it as it loads the others. `dropSessions()` deletes it at the end.
4. **The session is ended at the end of the run.** A second verb, `wp-session-end <stack> <run>`, destroys that run's token only (`WP_Session_Tokens::destroy($token)`), never `destroy_all()`, since several runs share `pr-hub-base`. `wp-session` takes the run name too and keeps the run's token in the run's `private/`, 0600, so the end of one run cannot end another's session. The run calls it when it ends, so the cookie stops working even if a copy was left somewhere. The short expiry covers a run that dies before it can call it.

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

  Scrubbing reports is not enough: `run-read cat` and the run page serve raw evidence as written. The cookie must be redacted where evidence is captured (bin/qa-evidence and the agent's HAR and `.http` writers), before anything is saved, for the `wordpress_(sec|logged_in)_[0-9a-f]{32}` names and the run's token. A test should plant a synthetic cookie in a request and check that no saved evidence file, log or comment contains it. `run-read` refuses `private/` but not evidence, so redaction at capture is the guard there.
- **The agent can do anything an administrator can on that site:** install plugins, change settings, delete content. That is acceptable on a test stack that a rebuild resets. The stack's WordPress must never share a database, uploads or credentials with dev or production.
- **Cookie format drift.** WordPress may change its cookie or token APIs. These are core functions used by core's own login, but a major WordPress update should run this path's test.
- **The verb runs PHP inside the stack.** It takes no user input: the stack name is checked by `name_ok` as the other verbs are, and the PHP is a fixed string. It must not grow a "run this PHP" argument.
- **Same-name stacks.** A token belongs to one WordPress database. A rebuilt stack has a new one, so an old cookie fails rather than signing in somewhere else. There is no incarnation file to keep, unlike the Hub authenticator.

## Not chosen

- **Loosening `assertPublicUrl` for `.rex` or for the dev server.** It is the Hub's SSRF guard. A carve-out for test hosts is the kind of exception that ends up in production.
- **A login-link plugin on the stack site.** It is one more plugin in the code under test, and a standing route that mints sessions.
- **Driving the wp-login form with a stored password.** That means a long-lived secret to keep and to rotate, where the token above has none.

## To check before building

- Confirm that a full stack's WordPress is the `wordpress` service of the same Sandbox stack, and not a separate `wp-<stack>` stack. `urls()` names the host `wp-<stack>`, while `attach.sh` takes a separate site-stack name. The answer decides what `--name` the verb passes to `sb host exec`.
- Confirm that the stack's WordPress is attached to its own Hub (`hub-<stack>`), as `attach.sh` does for test stacks, and not to dev.

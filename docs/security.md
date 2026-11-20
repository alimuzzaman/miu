# Security: GitHub access, sign-in and members, the dashboard

How Miu reaches GitHub and who can use its dashboard. Read this before you put
Miu on a server.

## GitHub access

All GitHub traffic goes through [lib/github.mjs](../lib/github.mjs) over HTTPS;
the gh CLI is not needed. The token, in order:

1. **The Miu GitHub App's installation token** for the repo's owner. This is the
   production path: comments, labels and statuses show as the App, and the
   App's own rate limit applies. Tokens last an hour and are renewed
   15 minutes before they expire.
2. `GITHUB_TOKEN` from the environment.
3. On a developer machine only: the local `gh auth token`.

Rules the code keeps:

- Tokens are never logged, never put on a command line or in a URL, and never
  sent to a page. Git fetches carry the token in `GIT_CONFIG_*` environment
  variables, which a process list does not show.
- Repo names and PR numbers are checked before they reach an API path or a
  query; GraphQL uses variables.
- Network errors, 5xx answers and the secondary rate limit are retried with a
  back-off; anything else fails at once.
- The QA agent gets no GitHub, Cloudinary, agent-notes or Slack token.
- **A CI run gets one GitHub token, and the pull request's code can read it.**
  [lib/sandboxci.mjs](../lib/sandboxci.mjs) has the App mint it per run
  (`ciRepoToken` in [lib/ghapp.mjs](../lib/ghapp.mjs)): `contents: read` only,
  for the repositories the workflow reaches (read from the base branch's
  workflow, `composer.json` and `package.json`, never the pull request's, so a
  pull request cannot widen it; one that needs more is not run), GitHub's
  one-hour expiry, never cached, revoked when the run ends by Miu and by the
  worker. A run that reaches nothing gets none: the profile's sibling is
  shipped in the tar instead. It goes to the worker on
  stdin and to Sandbox on a pipe: never in an argument, the environment of a
  Miu process, a file Miu keeps, or the tar. Miu removes it, and its base64
  forms, from the CI log. Forks and Dependabot get no run, so no token.
- **A repository listed in `/etc/miu/ci-mirrors` is read with a deploy key**
  ([install.md](install.md#a-repository-the-app-may-not-read-a-deploy-key)).
  - **Who holds the key.** Only `miu-mirror` holds it, a system account with
    nothing else: no shell, no groups, no Sandbox secrets.
  - **What `miu` can ask for.** `miu` may run one script as that account, and
    only with a listed repository's name as its argument, since each sudo rule
    names the repository exactly.
  - **What the script checks.** The list must be root's, and the key must be
    the account's own at mode 600 with the fingerprint the list names. GitHub's
    host key is pinned.
  - **What the script does.** It takes no path, opens nothing outside the
    account's own folders, and writes only a git bundle to `miu`. So the worst
    it can be made to do is read a listed repository, which the key allows
    anyway.
  - **What the job gets.** A copy with no key and no remote, so pull request
    code can read the repository's code, as with a token for it, but never use
    the key.
  - **QA runs too.** qa-run's dependency build (`ensureDeps` in
    [lib/worktrees.mjs](../lib/worktrees.mjs)) gets the same bundle for a
    listed package in `composer.lock`. Git reads a copy in a temp folder for the
    package's GitHub URLs. Composer reads copies of `composer.json` and
    `composer.lock`, the second without that package's dist. The worktree's
    files are not changed, and no key or token goes into the build.
    Composer's git cache for that install is in the temp folder as well, so
    no copy outlives the build. If the helper cannot get the package, the
    build fails, with no retry: no token can read it.
  - **Who can get a copy.** `miu` runs pull request code in fast checks, so
    anything that runs as `miu` can get a copy of a listed repository. List
    only what every repository Miu tests may read.
- A comment can be edited only by whoever wrote it: editing one posted before
  the App was installed uses the fallback account (`fallback: true`).

The App may write comments, labels and commit statuses, and read code. It
cannot push, merge or approve. Its private key and client secret live in
`~/.config/miu/github-app.json` (mode 600), outside the repo.

### Pushing a fix

A fix ([bin/qa-fix](../bin/qa-fix)) is the one thing Miu pushes. The App cannot
push, so the push uses the GitHub account connected under GitHub and notices,
and no other: the commit, the push and the fix comment are all that person's.
No account connected, or no write access, means no push. The sign-in goes
through the Miu App, so the App needs Contents: Read and write as well (a
sign-in through an App can do only what the App may).

- The fix agent gets no token and reaches only its QA site (`qa-fix.rex`, through rexenv and URLs on `.rex`), with no scratch sites; its tool rules
  ([lib/rules.mjs](../lib/rules.mjs) `fixToolRule`) let it write only in its
  worktree and its run folder, never `vendor/`, `.git/` or `.github/`, and never
  run git that changes anything. Codex runs it in its sandbox; the rexenv guard limits it to that site.
- Miu checks the change before it commits ([lib/fix.mjs](../lib/fix.mjs)
  `checkChange`) and keeps anything that fails as a patch.
- The push is never forced and never goes to a fork, `dev` or `main`.
- The commit message is cleaned of any line naming a model or a tool.

## Sign-in and members

Each Miu has its own accounts ([lib/users.mjs](../lib/users.mjs)), kept in
`~/.config/miu/users.json` (mode 600).

- **The first account** is the owner. A new install has none: the server writes
  a one-time setup code to its log and to `~/.config/miu/setup-code` (mode
  600), and `/auth/setup` asks for it, so whoever reaches the page first cannot
  take the install. The code is deleted once the owner exists.
- **Others join by invite.** An admin invites an email address or a GitHub
  username with a role and gets a link (`/auth/invite/<token>`) to send. The
  link works once and for 7 days; only its SHA-256 is stored. An email invite
  sets a password; a GitHub invite signs in with that GitHub account and no
  other.
- **Roles.** Owner: everything, including who is owner. Admin: Settings (AI
  connections, rules, instructions, posting) and members. Member: starts and
  stops tests, posts reports, reviews findings. Viewer: reads reports. A role
  is read from the account on every request, so a change or a removal applies
  at once. There is always at least one owner, only an owner changes an owner,
  and nobody removes themselves.
- **Passwords** are scrypt hashes (N=2^15, 16-byte salt), 10 to 200 characters,
  checked in constant time, with the same work for an unknown email. Five
  wrong tries for an email or an address mean a 5-minute wait.
- **Sign in with GitHub** appears once the Miu App has a client secret. OAuth
  with `state` and PKCE (S256); the user's GitHub token is used once to read
  who they are and is not kept. The login must belong to a member or match the
  invite being accepted. The redirect after sign-in only goes to a path on
  this server.
- **Pictures:** a GitHub account shows its GitHub picture; an email account its
  Gravatar, asked for by the SHA-256 of the email (`d=404`, so an email with
  none shows initials). The browser fetches them; the email itself is not sent.
- **Sessions:** a random 32-byte id in a cookie that is `HttpOnly`,
  `SameSite=Lax` and `Secure` on https. The server keeps only its SHA-256, with
  the account id and an expiry (12 hours), in `runs/.sessions.json` (mode 600).
- **When sign-in is on:** as soon as an account exists, whenever the dashboard
  listens on anything but 127.0.0.1, or with `MIU_AUTH=github`. A local Miu
  with no accounts has sign-in off, and the person at the keyboard is the
  owner. The setup, sign-in and invite forms need an `Origin` (or `Referer`) of
  this server.

## Requests

- Every response: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: same-origin`, `Cross-Origin-Opener-Policy`, and HSTS on
  https.
- The dashboard page has a Content-Security-Policy with a per-request script
  nonce: no inline handlers, no framing, scripts only from this page and
  cdnjs, images only from this server, Cloudinary and GitHub.
- Writes (POST) need the `X-QA-Dashboard: 1` header, which a cross-site form
  cannot send, and an `Origin` of this server; with sign-in on, the Origin is
  required and must be `MIU_PUBLIC_URL`.
- Text from GitHub (comments in the History view) is rendered as Markdown and
  then stripped of scripts, event handlers and `javascript:` links.

## Running on a server

| Variable | What it does |
|---|---|
| `MIU_HOST` | Address to listen on (default `127.0.0.1`). Anything else turns sign-in on. |
| `MIU_PUBLIC_URL` | The URL people use, e.g. `https://miu.example.com`. Sign-in callbacks and the Origin check use it. |
| `MIU_AUTH=github` | Require sign-in even on 127.0.0.1 before the first account exists (behind a reverse proxy on the same machine). |
| `MIU_GH_CLIENT_SECRET` | The App's client secret, if you prefer the environment to the key file. |
| `GITHUB_TOKEN` | A fallback token before the App is installed. |

Put Miu behind a reverse proxy that terminates TLS, set `MIU_PUBLIC_URL` to the
https address, and add `<MIU_PUBLIC_URL>/auth/callback` as a callback URL in
the App's settings.

## Pull request test stacks

With `--sandbox-user` and `"stacks": {"on": true}` in `runs/.config.json`, each
pull request in Miu's queue gets a Sandbox stack that follows its branch (Sandbox
`host follow`), for people to try. Miu reaches it only through
`/usr/local/lib/miu/pr-stack` (`bin/miu-pr-stack`), run as the Sandbox account by
one sudo rule. That command has five verbs (`mem`, `add`, `status`, `ports`, `remove`) and
builds every Sandbox argument itself. Miu passes a stack name, a kind and branch
names, and the command checks each one.

- Branches from the WPDevelopers org only. A fork never gets a stack.
- The prepare step and the stack template come from `xspeed-dev-setup@main`, not
  from the pull request. `stacks/follow-prepare.sh` builds the pull request's code
  in a throwaway container: no Docker socket, no home folder, no Sandbox state, no
  keys, non-root, no capabilities. Only the plugin zips come back.
- The follow's deploy keys are read-only. Pro stays unlicensed: no key is ever
  wired, real or placeholder.
- At most 10 stacks. A new one past 10 removes the oldest idle one first. A stack
  goes when its pull request is merged or closed, or 48 hours after Miu's verdict
  with no new commits. Nothing new starts while the server has under 3 GB of memory
  free.
- A Hub pull request's stack (`pr-hub-<n>`) is a whole Hub: hub, admin console,
  renderer, Postgres, Mailpit and a WordPress site. A Free or Pro pull request
  that names a Hub pull request shares that stack. It uses only the secrets its
  template names, through Sandbox; never a production key, and never
  xspeedcache.com or app.xspeedcache.com.
- To test the admin console, `bin/qa-hub-signin` signs `miu-qa@wpdeveloper.com`
  in. That address is staff only on test stacks (xspeed-dev-setup's full
  template), and every mail a stack sends lands in its own Mailpit, on this
  server's loopback. The helper reads the link there, deletes the mail, and
  passes the second factor itself. The agent gets only a browser storage state
  (0600, deleted after the run); no link, code or recovery code is printed,
  logged or written. The stack's authenticator secret is kept in
  `runs/.stacks/<stack>.totp` (0600), bound to that stack's incarnation, and
  deleted when the stack is removed. An add keeps it, since the stack (and the
  factor on its Hub) may survive one, and a file from another incarnation is
  never used. Admin and app sign in each on their own; when the address already
  has a factor and Miu holds no secret for it, the admin side fails as
  `staff_factor_without_secret`, naming the stack.
- On the same stacks, the agent gets a wp-admin session on the stack's public
  WordPress (`wp-<stack>`) as its `miu-qa` administrator, for claims the Hub
  must reach a site for (lib/wpsession.mjs, `pr-stack wp-session`). Miu makes
  the token and sends it to the stack on stdin; WordPress keeps only its hash
  and answers with signatures, so no output or log holds a working cookie. The
  storage state is in `private/` (0600), the token in `private/redact.list`,
  which `bin/qa-evidence` masks in every file it writes (lib/redact.mjs), and
  the run's end ends that run's session only. Sessions last 4 hours at most.
  The Hub's URL guard is unchanged: QA sites stay refused.

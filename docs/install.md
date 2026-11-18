# Installing Miu

```sh
curl -fsSL https://raw.githubusercontent.com/akashmdiu/miu/main/install.sh | sudo bash -s -- --domain miu.example.com
```

Read [install.sh](../install.sh) before you run it. It changes the server as root, so check what it does first.

## What you need

- A server running Ubuntu 24.04, x86_64 or arm64, with 4 GB of memory and 20 GB of free disk. Use a machine of its own, or one that runs nothing you would mind an AI agent being near. The agent is locked down, but it does have a shell.
- For `--domain`, a DNS name that points at the server, with ports 80 and 443 free. Caddy gets the certificate from Let's Encrypt.
- A Claude (Pro or Max) or ChatGPT (Plus or Pro) subscription, or an API key, for the agent.
- Admin rights on the GitHub account or organization that owns the repositories, to install Miu's App.

## Options

| Option | What it does |
|---|---|
| `--domain NAME` | Serves Miu at `https://NAME` through Caddy, and turns sign-in on from the first request. |
| `--ref REF` | Installs this branch or tag of Miu. The default is `main`. |
| `--repo URL` | Gets Miu from a fork. |
| `--no-agent-user` | Runs the agent as Miu's own account. Only do this for a test machine. |

## What it changes on the server

| Piece | Where |
|---|---|
| Account `miu` | Runs the dashboard and rexenv, and holds every secret. It has no sudo and is not in the `docker` group. |
| Account `miu-agent` | Runs the AI agent. It cannot read anything that belongs to `miu`. |
| rexenv, headless | The `rexenv` apt package, plus `rexenv-headless.service` running as `miu`. Its edge listens on `127.0.0.1:8180` and `127.0.0.1:8543`, so ports 80 and 443 stay free. |
| Node, `claude`, `codex`, Chromium | `/opt/miu`, owned by root. Neither account can change them. |
| Miu | `/srv/miu-releases/<commit>`, one folder per deployed commit, owned by root. `/srv/miu` is a symlink to the current one. It runs as the `miu.service` unit on `127.0.0.1:4747`. |
| Miu's data | `/srv/miu-data`: `runs/`, `.cache/` and `.agent-codex/`, owned by `miu`. Miu names them by these paths (`MIU_RUNS`, `QA_CACHE_DIR`). Each release links them too, so `/srv/miu/runs` still finds them. |
| Profiles | `/etc/miu/profiles` |
| Settings and sign-ins | `/home/miu/.config/miu`. Tokens are stored in `keys.enc.json`, encrypted with AES-256-GCM. |
| Secrets key | `/etc/credstore.encrypted/miu-secrets-key`, sealed with the machine's own key. systemd decrypts it for `miu.service` only. |
| Agent helpers | The scripts in `/usr/local/lib/miu`, the sudoers rule in `/etc/sudoers.d/miu`, and the AppArmor profile in `/etc/apparmor.d/miu-codex-bwrap`. |
| Packages | git, PHP 8.3 CLI with common extensions, composer, gh, acl, xvfb. With `--domain`, Caddy too. |

### How the agent is kept apart

`miu` starts the agent's CLI through `sudo -u miu-agent /usr/local/lib/miu/agent-exec`. That is the only command `miu` may run as `miu-agent`. The agent can run two commands as `miu`, and nothing else: rexenv's MCP server and the QA-site reset. The MCP server goes through Miu's guard, which refuses any site except the run's own. Each run folder gets an ACL so the agent can write its results there.

Codex runs commands inside bwrap. Ubuntu 24.04 lets a program create the user namespace that bwrap needs only if the program has an AppArmor profile. The installer adds a profile for the bwrap that ships with Codex, and for nothing else.

## CI workflows through Sandbox

Optional. A profile's fast check can run a GitHub Actions workflow ([profiles.md](profiles.md#a-ci-workflow-as-a-fast-check)) on this server, using Sandbox. Set Sandbox up on the server first, with `sb remote provision` from your own machine, and install [act](https://github.com/nektos/act) on it. Then name the account that owns Sandbox:

```sh
sudo bash install.sh --sandbox-user ubuntu
```

`miu` stays out of the `docker` group. The installer adds one sudo rule, `/etc/sudoers.d/miu-sandbox-ci`, that lets `miu` run the worker as that account and nothing else: `/usr/local/lib/miu/sandbox-ci` and the per-release copies in `/usr/local/lib/miu/versions/<commit>/sandbox-ci`, all root's. A copy stays as long as its release (the last 3, and any still in use), so a fix to the worker reaches every run once the older releases are gone. The script gets the commit as a tar on stdin, runs it in a temporary folder and removes the folder afterwards. It expects Sandbox at `~/sandbox/sb-src/sb`.

Workflow steps run the pull request's code in Docker containers on this server, without the Docker socket. Each job runs as `runner` (uid 1001), as on GitHub, in `catthehacker/ubuntu:runner-22.04` (`sb ci run --as-runner`), so the Sandbox account must be uid 1001: with another uid every CI job is reported as not run. Run `sudo bash install.sh` again after an update to pull that image. A pull request from the repository runs its own workflows, as on GitHub, so anyone who can push a branch there can run code here. Give a workflow only the CI secrets you would give that code: the `ci_secrets` in the Sandbox account's `sandbox.local.yml`. A pull request's workflow may name only the secrets its base branch's workflows already name. A workflow that needs a secret with no entry there is reported as not run, also when it has a fallback (`${{ secrets.X || github.token }}`). Miu adds one secret itself: a read-only GitHub App token for the repositories the run reaches, as `GITHUB_TOKEN` and the secrets used beside `github.token` ([profiles.md](profiles.md#choosing-the-workflows-pr_ci)). It reaches the script on stdin, before the tar, and Sandbox on a pipe (`sb ci run --secrets-stdin`, which needs a Sandbox that has it).

### The CI network

A job runs on its own Docker network, `miu-ci` (bridge `miu-ci0`, `10.213.0.0/24`), not on the server's. `bin/miu-ci-net` makes it, and the firewall rules that hold it in: nothing from it reaches the server itself (SSH, nginx, tailnet names, anything on loopback), a private, shared or link-local address (other stacks' networks and the ports they publish, tailnet peers, cloud metadata), or another job. The internet stays open, so package installs and GitHub work. The rules are in `mangle PREROUTING` (`MIU-CI-PRE-A` or `-B`), which drops such traffic before any filter chain, so what Tailscale, ufw or Docker put ahead in `INPUT` or `FORWARD` cannot let it through, and again in `INPUT` and `DOCKER-USER` (`MIU-CI-IN-*`, `MIU-CI-FWD-*`), which reject it so a job fails at once. `miu-release` installs it as `miu-ci-net.service`, which runs again whenever Docker starts and is reloaded on a deploy; each chain is swapped in whole, so the rules are never missing. The worker runs a job only while that unit's stamp (`/run/miu-ci-net/ok`) names the network Docker has; otherwise the job is reported as not run. Stopping the unit (Docker stopping) takes only the stamp; `/usr/local/lib/miu/ci-net down` takes the rules too. Check it with `systemctl status miu-ci-net` and `sudo iptables -t mangle -S PREROUTING`. act's cache server is off for these jobs (`actions/cache` and `setup-node`'s `cache:` find nothing), since it would listen on the server.

A job with `services:` (or one it needs) is the exception: act 0.2.x makes a network of its own for it and ignores the one it is given, and the job reaches its services on `localhost`, so it still runs on the server's network. Its report says so.

### Which CI secrets each repository may use

The CI script also checks root's own list, `/etc/miu/ci-secret-names`. A workflow may name a `ci_secrets` entry only when that list gives it to the pull request's repository and the base branch's job already names it. One line per repository, `#` for comments; repository names match in any case:

```text
# owner/name NAME,NAME
acme/plugin SLACK_WEBHOOK
acme/plugin-pro SLACK_WEBHOOK,LICENSE_KEY
```

The installer makes the file empty (owned by root, mode `644`) when there is none, and never changes one that exists. Edit it as root; the next run reads it, with no restart. Until a name is listed, a workflow that names it is reported as not run. A file that is missing, a symbolic link, not owned by `root:root`, or writable by group or others gives no repository any name. Names Miu fills itself (`GITHUB_TOKEN` and the secrets used beside `github.token`) need no line.

The list is the limit, not the repository check. The CI script runs as the Sandbox account through `miu`'s sudo rule, and `miu` also runs pull request code in fast checks, so a pull request's code could call the script and name another repository. Every name on the list is one that any pull request Miu tests here could read. List only what you would give all of them.

### A repository the App may not read: a deploy key

A private dependency (a Composer or npm package on GitHub) that the App is not installed on can be read with a read-only deploy key instead. The installer makes a system account for this, `miu-mirror`, with no login shell. It holds nothing but the deploy keys and its mirrors, in `/var/lib/miu-mirror`. Sandbox's account never touches a key.

1. Add the key on GitHub as the repository's deploy key, without write access.
2. Put the private half in `/var/lib/miu-mirror/keys/`, owned by `miu-mirror`, mode `600`.
3. List it in `/etc/miu/ci-mirrors`, a file owned by root, mode `644`. Each line holds the repository, the key's path and its fingerprint (`ssh-keygen -lf <key> -E sha256`):

   ```text
   acme/licensing /var/lib/miu-mirror/keys/licensing SHA256:...
   ```

4. Run the installer again. It writes one sudo rule for each listed repository, `/etc/sudoers.d/miu-ci-mirror`: `miu` may run `/usr/local/lib/miu/ci-mirror <that repository>` as `miu-mirror`, with exactly that argument.

For a job that needs a listed repository, other than through `actions/checkout`, Miu runs that script. It checks four things: the list is root's, the key is the account's own at mode 600, its fingerprint matches the list, and GitHub's host key matches `/usr/local/lib/miu/github-known-hosts`. It then fetches the repository into the account's mirror and hands Miu a git bundle, so it takes no path from Miu. Miu puts a bare copy of the bundle in the job's tar at `.miu-ci/mirrors`, with no key and no remote. The CI script gives the job git config (`GIT_CONFIG_*`, through its `.env`) that reads that copy for the repository's `git@github.com:`, `ssh://` and `https://` URLs.

Composer first tries the package's zip from GitHub's API, which the key cannot open, and does not fall back to git after that. So the job's copy of `composer.lock` loses the `dist` of each listed package. `composer.json` and the lock's content hash stay as they are.

When the fetch fails, the job reads the last copy, up to a day old, and the top of its log says how old it is. A run that then needs no repository token but whose workflow names one (`${{ secrets.X || github.token }}`) gets an App token that reads only the pull request's repository's metadata. Composer sends that token with every download, public ones too.

## After the installer

1. **Owner account.** Open the address and go to `/auth/setup`. Enter the setup code the installer printed. You can also read it with `sudo cat /home/miu/.config/miu/setup-code`.
2. **GitHub App.** Open **GitHub** at the bottom of the sidebar and press **Create the App on GitHub**. GitHub asks for the App's name. Names must be unique across GitHub, so add a word if the one offered is taken. Then install the App on the account or organization that owns your plugins, and choose the repositories. The App can write comments, labels and statuses, and read code. It cannot push, merge or approve.
3. **Repositories.** On the same page, press **Make a profile** for each plugin. Miu reads the repository and writes a first profile. Tune it later ([profiles.md](profiles.md)).
4. **AI.** Go to **Settings → AI & agents** and press **Sign in with Claude** or **Sign in with ChatGPT**, or paste an API key.
5. **Sign-in for the team.** On the GitHub page, add the App's client secret so people can sign in with GitHub. Then invite them under **Settings → Members**.
6. **Optional.** Set `CLOUDINARY_URL` under Settings so screenshots show inside the comment. To post the full report to agent-notes, set `AGENT_NOTES_TOKEN` and `AGENT_NOTES_MCP_URL` in `/home/miu/.config/miu/env`.

Auto-test is on from the start, for pull requests opened or pushed after the install. Pull requests that already existed wait until you press **Test** on them.

The Pull requests page has the queue's switches. **Auto** tests new pull requests and new commits on their own, one at a time. **Manual** still lines them up, but they wait ("Waiting for you") until a person starts them. A `/miu` comment or a request label from the team lines its pull request up too, and it waits for a person like the rest (its CI too). Removing one from the line keeps it out until its next commit, even with the label still on. Miu answers a `/miu` comment that waits this way once, with a link to the dashboard (when Miu has an https address), even with posting to GitHub off: it says the test waits, it is not a report. Automatic fixes also wait in manual mode and while paused. Switching back to auto starts what waited, one at a time; the dashboard asks first. To start some, tick them and press **Start now**, or press **Start** or **Test** on a row. They go first in the line, with their CI, in either mode. **Pause** starts nothing new, tests or CI, until **Resume**; what is running goes on. The ⋯ menu on a queued row can **Hold** it (it keeps its place and does not start) and **Release** it. A running test cannot be paused safely, because its sites, sign-ins and the agent's session keep going: **Stop** cancels it, and **Test again** runs it anew. The mode and the pause survive a restart. Auto and manual are for admins, as auto-test was. Members can pause, resume, hold and start; viewers can only read.

The same controls work from a terminal on the server, as Miu's account and with no network port: `sudo -u miu /opt/miu/node/bin/node /srv/miu/bin/miu-queue status` (also `auto`, `manual`, `pause`, `resume`, `start owner/repo#12 ...`, `hold`, `release`, `unqueue`, `ci owner/repo#12 --again`, `stop <run>`). The dashboard's API has them too, behind sign-in: `GET /api/queue`, `POST /api/queue/control` `{ "mode": "manual" }` (admins) or `{ "paused": true }`, `POST /api/queue/start` `{ "prs": [{ "repo": "owner/repo", "pr": 12 }] }`, `POST /api/queue/hold` `{ "repo", "pr", "held" }`, `POST /api/ci/run` `{ "repo", "pr" }`, `GET /api/ci?repo=&pr=`. Posting to GitHub starts off: reports show only on the dashboard until you turn on posting under Settings. Read a few reports first, then turn it on.

## Updating

Run the installer again. It fetches Miu, reinstalls the dependencies and the CLIs, and restarts the service. It does not touch runs, settings, profiles or sign-ins.

To deploy only Miu itself, use `bin/miu-release`, which the installer puts in `/usr/local/lib/miu`:

```sh
sudo /usr/local/lib/miu/miu-release deploy main      # or a branch, a tag or a full commit sha
sudo /usr/local/lib/miu/miu-release rollback         # back to the release before
sudo /usr/local/lib/miu/miu-release status
```

A deploy builds the commit in a folder of its own first: its files, `npm ci`, and a check that every module and import the dashboard, a run, a fix and `miu-queue` load is there. A commit that fails the build or the check never goes live. Then it switches `/srv/miu` to the new folder with one rename, installs the release's CI worker in `/usr/local/lib/miu/versions/<commit>`, and restarts `miu.service`. Each release calls its own copy of the worker, so a run keeps the worker it started with; `/usr/local/lib/miu/sandbox-ci` is a symlink to the newest one. The sudo rule names both paths. If the dashboard does not answer within 30 seconds, it switches back and restarts the old release.

You do not need to wait for tests to finish before you deploy:

- The unit stops only the dashboard's own process on a restart (`KillMode=process`).
- A QA run or a fix runs from the release folder it started in, to its end. The new dashboard shows it as running, as before.
- A CI job writes its output to files. The new dashboard waits for it, still within the job's time limit, and records its result. After a reboot, a CI job that was running is run again.
- New tests and CI jobs use the new release.

To see which release a live run uses, read its working folder: `sudo readlink /proc/$(pgrep -f 'bin/qa-run ' | head -1)/cwd` prints `/srv/miu-releases/<commit>`.

The last 3 releases are kept, and so is any release a process still runs from. Changes to the unit, the sudo rules or the system packages still need the installer.

The first deploy on a server installed before releases existed stops the service and moves `runs/`, `.cache/` and `.agent-codex/` from the old `/srv/miu` folder to `/srv/miu-data`. It keeps that folder as a release, so `rollback` goes back to it. This one deploy refuses to run while a test is going, and with `--no-restart` (as the installer runs it) it leaves the service stopped until the installer starts it.

## Checking it works

```sh
systemctl is-active rexenv-headless miu
sudo -u miu XDG_RUNTIME_DIR=/run/user/$(id -u miu) rex status
journalctl -u miu -n 50
```

## Removing it

```sh
sudo systemctl disable --now miu rexenv-headless
sudo rm -rf /srv/miu /srv/miu-releases /srv/miu-data /opt/miu /etc/miu /usr/local/lib/miu /etc/sudoers.d/miu /etc/sudoers.d/miu-sandbox-ci /etc/apparmor.d/miu-codex-bwrap \
  /etc/systemd/system/miu.service /etc/credstore.encrypted/miu-secrets-key /etc/caddy/conf.d/miu
sudo userdel -r miu-agent; sudo userdel -r miu
sudo apt-get remove rexenv
```

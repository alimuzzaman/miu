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
| Miu | `/srv/miu` (code, owned by root), with `runs/` and `.cache/` owned by `miu`. It runs as the `miu.service` unit on `127.0.0.1:4747`. |
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

`miu` stays out of the `docker` group. The installer adds one sudo rule, `/etc/sudoers.d/miu-sandbox-ci`, that lets `miu` run `/usr/local/lib/miu/sandbox-ci` as that account and nothing else. The script gets the commit as a tar on stdin, runs it in a temporary folder and removes the folder afterwards. It expects Sandbox at `~/sandbox/sb-src/sb`.

Workflow steps run the pull request's code in Docker containers on this server, without the Docker socket. Give a workflow only the CI secrets you would give that code: the `ci_secrets` in the Sandbox account's `sandbox.local.yml`. A workflow that needs a secret with no entry there is reported as not run, also when it has a fallback (`${{ secrets.X || github.token }}`). Miu adds one secret itself: a read-only GitHub App token for the repositories the run reaches, as `GITHUB_TOKEN` and the secrets used beside `github.token` ([profiles.md](profiles.md#choosing-the-workflows-pr_ci)). It reaches the script on stdin, before the tar, and Sandbox on a pipe (`sb ci run --secrets-stdin`, which needs a Sandbox that has it).

### A repository the App may not read: a deploy key

A private dependency (a Composer or npm package on GitHub) that the App is not installed on can be read with a read-only deploy key instead. The key must belong to the Sandbox account, mode `600`, and be added on GitHub as that repository's deploy key without write access. List it in `/etc/miu/ci-mirrors`, a file owned by root, mode `644`. Each line holds the repository, the key's path and its fingerprint (`ssh-keygen -lf <key> -E sha256`):

```text
acme/licensing /home/ubuntu/keys/licensing SHA256:...
```

For a job that needs a listed repository, other than through `actions/checkout`, the script fetches it with the key into a bare mirror in the account's `~/.cache/miu-ci-mirrors`. It checks GitHub's host key against `/usr/local/lib/miu/github-known-hosts`. The job then gets a copy of the mirror in its workspace (`.miu-ci/mirrors`, with no key and no remote). The job's `.env` gets git config (`GIT_CONFIG_*`) that reads that copy for the repository's `git@github.com:`, `ssh://` and `https://` URLs, so Composer and npm install it from there. The repository's own `composer.json` stays as it is. When the fetch fails, the job reads the last copy, and the log says how old it is. A run that then needs no token still gets the secrets its workflow names, as a value that opens nothing (`miu_no_github_token`), so the workflow runs as it would on GitHub.

## After the installer

1. **Owner account.** Open the address and go to `/auth/setup`. Enter the setup code the installer printed. You can also read it with `sudo cat /home/miu/.config/miu/setup-code`.
2. **GitHub App.** Open **GitHub** at the bottom of the sidebar and press **Create the App on GitHub**. GitHub asks for the App's name. Names must be unique across GitHub, so add a word if the one offered is taken. Then install the App on the account or organization that owns your plugins, and choose the repositories. The App can write comments, labels and statuses, and read code. It cannot push, merge or approve.
3. **Repositories.** On the same page, press **Make a profile** for each plugin. Miu reads the repository and writes a first profile. Tune it later ([profiles.md](profiles.md)).
4. **AI.** Go to **Settings → AI & agents** and press **Sign in with Claude** or **Sign in with ChatGPT**, or paste an API key.
5. **Sign-in for the team.** On the GitHub page, add the App's client secret so people can sign in with GitHub. Then invite them under **Settings → Members**.
6. **Optional.** Set `CLOUDINARY_URL` under Settings so screenshots show inside the comment. To post the full report to agent-notes, set `AGENT_NOTES_TOKEN` and `AGENT_NOTES_MCP_URL` in `/home/miu/.config/miu/env`.

Auto-test is on from the start, for pull requests opened or pushed after the install. Pull requests that already existed wait until you press **Test** on them.

The Pull requests page has the queue's switches. **Auto** tests new pull requests and new commits on their own, one at a time. **Manual** still lines them up, but they wait ("Waiting for you") until a person starts them. A `/miu` comment or a request label from the team still starts its pull request, as it did with auto-test off. Automatic fixes also wait in manual mode and while paused. Switching back to auto starts what waited, one at a time; the dashboard asks first. To start some, tick them and press **Start now**, or press **Start** or **Test** on a row. They go first in the line, with their CI, in either mode. **Pause** starts nothing new, tests or CI, until **Resume**; what is running goes on. The ⋯ menu on a queued row can **Hold** it (it keeps its place and does not start) and **Release** it. A running test cannot be paused safely, because its sites, sign-ins and the agent's session keep going: **Stop** cancels it, and **Test again** runs it anew. The mode and the pause survive a restart. Auto and manual are for admins, as auto-test was. Members can pause, resume, hold and start; viewers can only read.

The same controls work from a terminal on the server, as Miu's account and with no network port: `sudo -u miu /opt/miu/node/bin/node /srv/miu/bin/miu-queue status` (also `auto`, `manual`, `pause`, `resume`, `start owner/repo#12 ...`, `hold`, `release`, `unqueue`, `ci owner/repo#12 --again`, `stop <run>`). The dashboard's API has them too, behind sign-in: `GET /api/queue`, `POST /api/queue/control` `{ "mode": "manual" }` (admins) or `{ "paused": true }`, `POST /api/queue/start` `{ "prs": [{ "repo": "owner/repo", "pr": 12 }] }`, `POST /api/queue/hold` `{ "repo", "pr", "held" }`, `POST /api/ci/run` `{ "repo", "pr" }`, `GET /api/ci?repo=&pr=`. Posting to GitHub starts off: reports show only on the dashboard until you turn on posting under Settings. Read a few reports first, then turn it on.

## Updating

Run the installer again. It fetches Miu, reinstalls the dependencies and the CLIs, and restarts the service. It does not touch runs, settings, profiles or sign-ins.

## Checking it works

```sh
systemctl is-active rexenv-headless miu
sudo -u miu XDG_RUNTIME_DIR=/run/user/$(id -u miu) rex status
journalctl -u miu -n 50
```

## Removing it

```sh
sudo systemctl disable --now miu rexenv-headless
sudo rm -rf /srv/miu /opt/miu /etc/miu /usr/local/lib/miu /etc/sudoers.d/miu /etc/sudoers.d/miu-sandbox-ci /etc/apparmor.d/miu-codex-bwrap \
  /etc/systemd/system/miu.service /etc/credstore.encrypted/miu-secrets-key /etc/caddy/conf.d/miu
sudo userdel -r miu-agent; sudo userdel -r miu
sudo apt-get remove rexenv
```

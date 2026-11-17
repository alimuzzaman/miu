#!/usr/bin/env bash
# Install Miu on a fresh Ubuntu 24.04 server, or update an installed one.
#
#   curl -fsSL https://raw.githubusercontent.com/akashmdiu/miu/main/install.sh | sudo bash
#   curl -fsSL https://raw.githubusercontent.com/akashmdiu/miu/main/install.sh | sudo bash -s -- --domain miu.example.com
#
# Options:
#   --domain NAME   serve Miu on https://NAME (Caddy, with a Let's Encrypt
#                   certificate; the name must already point at this server)
#   --ref REF       the branch or tag of Miu to install (default: main)
#   --repo URL      where to get Miu (default: https://github.com/akashmdiu/miu)
#   --user NAME     the account Miu runs as (default: miu; an existing one is kept)
#   --agent-user NAME  the account the AI agent runs as (default: miu-agent)
#   --no-agent-user run the AI agent as Miu's own account (not recommended)
#   --sandbox-user NAME  let Miu run CI workflows through Sandbox, as this account
#                   (the one that owns Sandbox on this server); see docs/install.md
#
# What it sets up (docs/install.md has the detail):
#   - two accounts: `miu` runs the dashboard, rexenv and holds every secret;
#     `miu-agent` runs the AI agent and can read none of that
#   - rexenv, headless, as `miu`, for the disposable WordPress sites
#   - Node, the claude and codex CLIs and Chromium, in /opt/miu
#   - Miu in /srv/miu-releases/<commit>, /srv/miu a symlink to the current one
#     (bin/miu-release), its data in /srv/miu-data, as the systemd service
#     `miu`, on 127.0.0.1:4747
#   - a key that seals Miu's stored tokens, kept as a systemd credential
#
# Running it again updates Miu and keeps its data, settings and sign-ins.
set -euo pipefail

MIU_REPO="https://github.com/akashmdiu/miu"
MIU_REF="main"
DOMAIN=""
AGENT_USER_ON=1
NODE_MAJOR=24
MIU_USER=miu
AGENT_USER=miu-agent
SANDBOX_USER=""

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --ref) MIU_REF="${2:-}"; shift 2 ;;
    --repo) MIU_REPO="${2:-}"; shift 2 ;;
    --user) MIU_USER="${2:-}"; shift 2 ;;
    --agent-user) AGENT_USER="${2:-}"; shift 2 ;;
    --no-agent-user) AGENT_USER_ON=0; shift ;;
    --sandbox-user) SANDBOX_USER="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,25p' "$0" 2>/dev/null || true; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
done

say() { printf '\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31mError: %s\033[0m\n' "$*" >&2; exit 1; }

# ------------------------------------------------------------------ checks
[ "$(id -u)" = 0 ] || die "run it as root: curl ... | sudo bash"
[ -r /etc/os-release ] && . /etc/os-release
[ "${ID:-}" = ubuntu ] || die "Miu installs on Ubuntu (24.04 tested); this is ${PRETTY_NAME:-an unknown system}."
case "${VERSION_ID:-}" in 24.04|24.10|25.04|25.10|26.04) ;; *) say "Ubuntu ${VERSION_ID:-?} is not tested; 24.04 is. Going on." ;; esac
command -v systemctl >/dev/null || die "Miu needs systemd."
case "$(uname -m)" in x86_64) NODE_ARCH=x64 ;; aarch64|arm64) NODE_ARCH=arm64 ;; *) die "Miu runs on x86_64 and arm64; this is $(uname -m)." ;; esac
if [ -n "$DOMAIN" ] && ! [[ "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]]; then die "--domain takes a host name, like miu.example.com"; fi
[[ "$MIU_REF" =~ ^[A-Za-z0-9._/-]+$ ]] || die "--ref takes a branch or tag name"
for u in "$MIU_USER" "$AGENT_USER" ${SANDBOX_USER:+"$SANDBOX_USER"}; do [[ "$u" =~ ^[a-z_][a-z0-9_-]{0,30}$ ]] || die "not an account name: $u"; done
[ "$MIU_USER" != "$AGENT_USER" ] || die "--user and --agent-user must differ"

APP=/srv/miu
RELEASES=/srv/miu-releases
DATA=/srv/miu-data
OPT=/opt/miu
ETC=/etc/miu
LIB=/usr/local/lib/miu
export DEBIAN_FRONTEND=noninteractive

# ---------------------------------------------------------------- packages
say "Installing system packages"
apt-get update -qq
# iproute2 and systemd-resolved carry rexenv's .rex names; a minimal image can lack them.
apt-get install -y -qq git curl ca-certificates gnupg acl jq unzip xz-utils xvfb xauth iproute2 systemd-resolved default-mysql-client-core \
  php-cli php-xml php-mbstring php-curl php-zip php-mysql php-gd php-intl composer >/dev/null
if ! command -v gh >/dev/null; then
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg
  chmod 0644 /etc/apt/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list
  apt-get update -qq && apt-get install -y -qq gh >/dev/null
fi

# ---------------------------------------------------------------- accounts
say "Creating the accounts"
id "$MIU_USER" >/dev/null 2>&1 || useradd -m -s /bin/bash "$MIU_USER"
MIU_UID=$(id -u "$MIU_USER")
MIU_HOME=$(getent passwd "$MIU_USER" | cut -d: -f6)
chmod 0750 "$MIU_HOME"
if [ "$AGENT_USER_ON" = 1 ]; then
  id "$AGENT_USER" >/dev/null 2>&1 || useradd -m -s /bin/bash "$AGENT_USER"
  chmod 0750 "$(getent passwd "$AGENT_USER" | cut -d: -f6)"
fi
loginctl enable-linger "$MIU_USER"
for _ in $(seq 1 20); do [ -d "/run/user/$MIU_UID" ] && break; sleep 0.5; done
as_miu() { sudo -u "$MIU_USER" -H env XDG_RUNTIME_DIR="/run/user/$MIU_UID" PATH="$OPT/node/bin:/usr/local/bin:/usr/bin:/bin" "$@"; }

# -------------------------------------------------------------------- node
INSTALLED_NODE=$("$OPT/node/bin/node" -v 2>/dev/null || true)
if [ "${INSTALLED_NODE%%.*}" != "v$NODE_MAJOR" ]; then
  say "Installing Node $NODE_MAJOR"
  base="https://nodejs.org/dist/latest-v$NODE_MAJOR.x"
  tmp=$(mktemp -d)
  curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  file=$(grep -o "node-v[0-9.]*-linux-$NODE_ARCH.tar.xz" "$tmp/SHASUMS256.txt" | head -1)
  [ -n "$file" ] || die "no Node $NODE_MAJOR build for linux-$NODE_ARCH"
  curl -fsSL "$base/$file" -o "$tmp/$file"
  (cd "$tmp" && grep " $file\$" SHASUMS256.txt | sha256sum -c --quiet -) || die "the Node download did not match its checksum"
  rm -rf "$OPT/node" && install -d -m 0755 "$OPT/node"
  tar -xJf "$tmp/$file" -C "$OPT/node" --strip-components=1
  rm -rf "$tmp"
fi
export PATH="$OPT/node/bin:$PATH"

# The agent CLIs, shared and owned by root: neither account can change them.
say "Installing the claude and codex CLIs"
npm install -g --silent --no-fund --no-audit @anthropic-ai/claude-code @openai/codex >/dev/null

# ------------------------------------------------------------------ rexenv
if ! command -v rexenv >/dev/null; then
  say "Installing rexenv"
  tmp=$(mktemp -d)
  curl -fsSL https://rexenv.rex.bd/install.sh -o "$tmp/rexenv-install.sh"
  REXENV_NO_LAUNCH=1 bash "$tmp/rexenv-install.sh"
  rm -rf "$tmp"
fi
if [ ! -f /etc/systemd/system/rexenv-headless.service ]; then
  say "Setting up rexenv for $MIU_USER (headless)"
  # The edge goes on 127.0.0.1:8180/8543 first, so ports 80 and 443 stay free
  # for Miu's own address (and anything else on the server).
  as_miu rexenv --headless >/tmp/rexenv-first-start.log 2>&1 &
  pid=$!
  for _ in $(seq 1 60); do as_miu rex status >/dev/null 2>&1 && break; sleep 1; done
  as_miu rex config set edge_http_port 8180
  as_miu rex config set edge_https_port 8543
  as_miu rex config set edge_bind 127.0.0.1
  kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true
  pkill -u "$MIU_USER" -f 'rexenv --headless' 2>/dev/null || true
  rexenv --headless-setup --user "$MIU_USER" --enable-mcp --agent-access full
fi
systemctl enable --now rexenv-headless.service >/dev/null

# --------------------------------------------------------------------- miu
say "Installing Miu ($MIU_REF)"
# Each commit gets a folder of its own; /srv/miu points at the current one
# (bin/miu-release). An older install's /srv/miu folder is kept as a release,
# its runs/, .cache/ and .agent-codex/ moved to $DATA.
install -d -m 0755 "$RELEASES" "$LIB"
[ -d "$RELEASES/repo.git" ] || git init -q --bare "$RELEASES/repo.git"
git -C "$RELEASES/repo.git" remote remove origin 2>/dev/null || true
git -C "$RELEASES/repo.git" remote add origin "$MIU_REPO"
git -C "$RELEASES/repo.git" fetch -q --no-tags origin "+$MIU_REF:refs/miu-release/install"
MIU_SHA=$(git -C "$RELEASES/repo.git" rev-parse --verify "refs/miu-release/install^{commit}")
git -C "$RELEASES/repo.git" show "$MIU_SHA:bin/miu-release" > "$LIB/.miu-release.new" 2>/dev/null || die "$MIU_REF has no bin/miu-release: this installer needs a Miu with side-by-side releases"
install -o root -g root -m 0755 "$LIB/.miu-release.new" "$LIB/miu-release" && rm -f "$LIB/.miu-release.new"
# It also writes miu.service.d/20-miu-release.conf: MIU_RUNS and QA_CACHE_DIR
# name the data by its real folders in $DATA, the same in every release.
MIU_USER="$MIU_USER" MIU_REPO_URL="$MIU_REPO" "$LIB/miu-release" deploy "$MIU_SHA" --no-restart
install -d -o "$MIU_USER" -g "$MIU_USER" -m 0750 "$DATA/runs" "$DATA/.cache"
if [ "$AGENT_USER_ON" = 1 ]; then
  # The agent passes through runs/ to its own run folder (Miu grants each one).
  setfacl -m "u:$AGENT_USER:--x" "$DATA/runs"
  install -d -o "$MIU_USER" -g "$MIU_USER" -m 0750 "$DATA/.agent-codex"
  setfacl -m "u:$AGENT_USER:--x" "$DATA/.agent-codex"
fi

say "Installing Chromium"
export PLAYWRIGHT_BROWSERS_PATH="$OPT/ms-playwright"
(cd "$APP" && npx --yes playwright install --with-deps chromium >/dev/null 2>&1) || die "Chromium did not install; run: cd $APP && sudo npx playwright install --with-deps chromium"
chmod -R a+rX "$OPT"

# ---------------------------------------------------------------- profiles
# Miu's account owns the profiles: the dashboard's "Make a profile" writes here.
install -d -m 0755 "$ETC"
install -d -o "$MIU_USER" -g "$MIU_USER" -m 0755 "$ETC/profiles"
[ -f "$ETC/profiles/project.json" ] || cp "$APP/docs/examples/project.json" "$ETC/profiles/project.json"
chown -R "$MIU_USER:$MIU_USER" "$ETC/profiles"

# --------------------------------------------------- the agent's own account
if [ "$AGENT_USER_ON" = 1 ]; then
  say "Locking down the agent account"
  install -d -m 0755 "$LIB" "$OPT/agent-bin"
  cat > "$LIB/agent-exec" <<EOF
#!/bin/bash
# Miu starts the AI agent's CLI (claude, codex) through this, as $AGENT_USER:
#   sudo -n -E -u $AGENT_USER $LIB/agent-exec <cli> <args>
# The only thing sudo lets $MIU_USER run as $AGENT_USER. It keeps the run's
# environment (the CLI's sign-in travels in it) but takes the agent's own PATH
# and home, and drops what points into Miu's account.
export HOME=/home/$AGENT_USER USER=$AGENT_USER LOGNAME=$AGENT_USER
export PATH="\${MIU_AGENT_PATH:-$OPT/agent-bin:$OPT/node/bin:/usr/local/bin:/usr/bin:/bin}"
unset CREDENTIALS_DIRECTORY MIU_SECRETS_KEY_FILE XDG_RUNTIME_DIR MIU_AGENT_LIB
cd "\${MIU_AGENT_CWD:-\$HOME}" 2>/dev/null || cd "\$HOME"
exec "\$@"
EOF
  cat > "$LIB/rex-mcp" <<EOF
#!/bin/bash
# rexenv's MCP server, run as $MIU_USER for the agent account (sudo rule in
# /etc/sudoers.d/miu). Miu's guard and hooks limit which sites it touches.
export HOME=$MIU_HOME USER=$MIU_USER PATH=/usr/bin:/bin XDG_RUNTIME_DIR=/run/user/$MIU_UID
exec /usr/bin/rex mcp
EOF
  cat > "$LIB/qasite" <<EOF
#!/bin/bash
# qasite for the agent account, run as $MIU_USER: reset or log in to a QA site.
case "\${1:-}:\${2:-}" in reset:pr|reset:dev|reset:fix|login:pr|login:dev|login:fix|info:) ;; *) echo "usage: qasite reset|login pr|dev|fix, or qasite info" >&2; exit 2 ;; esac
export HOME=$MIU_HOME USER=$MIU_USER XDG_RUNTIME_DIR=/run/user/$MIU_UID PATH=$OPT/node/bin:/usr/bin:/bin QA_CACHE_DIR=$DATA/.cache MIU_PROFILES=$ETC/profiles
cd $APP && exec node lib/warmsites.mjs "\$@"
EOF
  printf '#!/bin/bash\nexec sudo -n -u %s %s/rex-mcp\n' "$MIU_USER" "$LIB" > "$LIB/rex-as-qa"
  printf '#!/bin/bash\nexec sudo -n -u %s %s/qasite "$@"\n' "$MIU_USER" "$LIB" > "$LIB/qasite-as-qa"
  chown root:root "$LIB"/*; chmod 0755 "$LIB"/*

  cat > /etc/sudoers.d/miu.tmp <<EOF
# Miu runs as $MIU_USER, its AI agent as $AGENT_USER.
# $MIU_USER may start the agent's CLI as $AGENT_USER, keeping the run's environment.
$MIU_USER ALL=($AGENT_USER) NOPASSWD:SETENV: $LIB/agent-exec
# $AGENT_USER may reach rexenv's MCP server and the QA-site reset as $MIU_USER, nothing else.
$AGENT_USER ALL=($MIU_USER) NOPASSWD: $LIB/rex-mcp, $LIB/qasite
EOF
  visudo -cqf /etc/sudoers.d/miu.tmp || die "the sudoers rule did not validate"
  chmod 0440 /etc/sudoers.d/miu.tmp && mv /etc/sudoers.d/miu.tmp /etc/sudoers.d/miu

  # Codex's sandbox runs commands in bwrap, which needs a user namespace. Ubuntu
  # 24.04 allows that only to programs with an AppArmor profile; this one is
  # for the bwrap bundled with Codex, and nothing else.
  BWRAP=$(ls "$OPT"/node/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-*/vendor/*/codex-resources/bwrap 2>/dev/null | head -1 || true)
  if [ -n "$BWRAP" ]; then
    ln -sfn "$BWRAP" "$OPT/agent-bin/bwrap"
    if [ -d /etc/apparmor.d ] && command -v apparmor_parser >/dev/null; then
      cat > /etc/apparmor.d/miu-codex-bwrap <<EOF
abi <abi/4.0>,
include <tunables/global>
profile miu-codex-bwrap $BWRAP flags=(unconfined) {
  userns,
}
EOF
      apparmor_parser -r /etc/apparmor.d/miu-codex-bwrap
    fi
  else
    say "Codex's bwrap was not found; GPT runs will fail until 'sudo bash install.sh' runs again"
  fi
fi

# ------------------------------------------------------------- secrets key
CRED=/etc/credstore.encrypted/miu-secrets-key
if [ ! -f "$CRED" ]; then
  say "Making the key that seals Miu's tokens"
  install -d -m 0700 /etc/credstore.encrypted
  # 32 random bytes as hex, sealed with this machine's own key: systemd
  # decrypts it for the miu service only, and a copied disk image cannot.
  head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' | systemd-creds encrypt --with-key=host --name=miu-secrets-key - "$CRED"
  chmod 0600 "$CRED"
fi

# ----------------------------------------------------------------- service
install -d -o "$MIU_USER" -g "$MIU_USER" -m 0700 "$MIU_HOME/.config/miu"
ENVF="$MIU_HOME/.config/miu/env"
touch "$ENVF" && chown "$MIU_USER:$MIU_USER" "$ENVF" && chmod 0600 "$ENVF"
setenv() { grep -q "^$1=" "$ENVF" && sed -i "s#^$1=.*#$1=$2#" "$ENVF" || echo "$1=$2" >> "$ENVF"; }
setenv MIU_PROFILES "$ETC/profiles"
setenv PLAYWRIGHT_BROWSERS_PATH "$OPT/ms-playwright"
setenv DISABLE_AUTOUPDATER 1
if [ "$AGENT_USER_ON" = 1 ]; then
  setenv MIU_AGENT_USER "$AGENT_USER"
  setenv MIU_AGENT_LIB "$LIB"
  setenv MIU_AGENT_CLAUDE "$OPT/node/bin/claude"
  setenv MIU_AGENT_CODEX "$OPT/node/bin/codex"
  setenv MIU_AGENT_BASE_PATH "$OPT/agent-bin:$OPT/node/bin:/usr/local/bin:/usr/bin:/bin"
  setenv MIU_AGENT_CODEX_DIR "$DATA/.agent-codex"
fi
if [ -n "$DOMAIN" ]; then
  setenv MIU_PUBLIC_URL "https://$DOMAIN"
  # Behind the proxy every request comes from 127.0.0.1: require sign-in from the start.
  setenv MIU_AUTH github
fi

# A later run without --sandbox-user keeps the account an earlier run set. That
# is kept where only root can write: it decides a sudo rule, and $ENVF is $MIU_USER's.
[ -n "$SANDBOX_USER" ] || SANDBOX_USER=$(cat "$LIB/sandbox-user" 2>/dev/null || true)
if [ -n "$SANDBOX_USER" ]; then
  [ "$SANDBOX_USER" != root ] || die "--sandbox-user: use the account that owns Sandbox, not root"
  id "$SANDBOX_USER" >/dev/null 2>&1 || die "--sandbox-user: no account named $SANDBOX_USER"
  say "Letting Miu run CI workflows as $SANDBOX_USER"
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3-yaml >/dev/null
  install -d -m 0755 "$LIB"
  echo "$SANDBOX_USER" > "$LIB/sandbox-user"
  # CI job containers go here (bin/miu-sandbox-ci passes --cgroup-parent), capped
  # together; stop them all with: systemctl stop miu-ci.slice
  cat > /etc/systemd/system/miu-ci.slice <<SLICE
[Unit]
Description=Miu's Sandbox CI job containers (capped)
[Slice]
MemoryAccounting=yes
MemoryMax=4G
CPUWeight=20
CPUQuota=400%
SLICE
  systemctl daemon-reload
  cat > /etc/sudoers.d/miu-sandbox-ci.tmp <<EOF
# $MIU_USER may hand a pull request's files to Sandbox CI as $SANDBOX_USER, nothing else.
# Each release runs its own copy (bin/miu-release: $LIB/versions/<commit>, root's).
$MIU_USER ALL=($SANDBOX_USER) NOPASSWD: $LIB/sandbox-ci, $LIB/versions/*/sandbox-ci
# ... and add, read and remove its pull requests' test stacks (fixed verbs, checked arguments).
$MIU_USER ALL=($SANDBOX_USER) NOPASSWD: $LIB/pr-stack
EOF
  visudo -cqf /etc/sudoers.d/miu-sandbox-ci.tmp || die "the Sandbox CI sudoers rule did not validate"
  chmod 0440 /etc/sudoers.d/miu-sandbox-ci.tmp && mv /etc/sudoers.d/miu-sandbox-ci.tmp /etc/sudoers.d/miu-sandbox-ci
  # The server's CI secrets each repository's workflows may name
  # ($ETC/ci-secret-names: `owner/name NAME,NAME` lines). Every release's worker
  # reads it and refuses a run that names one not listed, so it is made before
  # the first worker is installed: empty, so no CI secret reaches a run until
  # root lists it. An existing list is never touched.
  if [ ! -e "$ETC/ci-secret-names" ] && [ ! -L "$ETC/ci-secret-names" ]; then
    install -d -o root -g root -m 0755 "$ETC"
    install -o root -g root -m 0644 /dev/null "$ETC/ci-secret-names"
  fi
  # After the rule, which decides whether each release calls its own copy.
  # The current release's worker, ci-mirror, PR-stack helper (lib/prstackctl.mjs,
  # off until Settings has stacks.on) and GitHub's SSH host key (for repositories
  # CI reads with a deploy key, /etc/miu/ci-mirrors), in $LIB/versions/<commit>,
  # behind $LIB/sandbox-ci, $LIB/ci-mirror and $LIB/pr-stack.
  "$LIB/miu-release" worker
  setenv MIU_SANDBOX_USER "$SANDBOX_USER"
  setenv MIU_SANDBOX_WORKER "$LIB/sandbox-ci"
  # Repositories CI reads with a deploy key ($ETC/ci-mirrors: repository, key
  # file, fingerprint). bin/miu-ci-mirror fetches them as its own account, which
  # holds nothing but those keys and its mirrors, never as $SANDBOX_USER. Each
  # sudo rule names one listed repository exactly; run this again after
  # changing the list. Put each key in /var/lib/miu-mirror/keys, owned by
  # miu-mirror, mode 600.
  MIRROR_USER=miu-mirror
  id "$MIRROR_USER" >/dev/null 2>&1 || useradd --system --user-group --home-dir /var/lib/miu-mirror --shell /usr/sbin/nologin "$MIRROR_USER"
  # An account made some other way may have a shell, groups (docker) or another home.
  [ "$(getent passwd "$MIRROR_USER" | cut -d: -f6,7)" = "/var/lib/miu-mirror:/usr/sbin/nologin" ] || die "$MIRROR_USER exists with another home or a login shell; fix or remove it first"
  [ "$(id -Gn "$MIRROR_USER")" = "$MIRROR_USER" ] && [ "$(id -u "$MIRROR_USER")" -ne 0 ] && [ "$(id -g "$MIRROR_USER")" -ne 0 ] \
    && [ "$(getent group "$MIRROR_USER" | cut -d: -f3)" = "$(id -g "$MIRROR_USER")" ] \
    && [ "$(getent passwd | awk -F: -v g="$(id -g "$MIRROR_USER")" '$4 == g' | wc -l)" = 1 ] || die "$MIRROR_USER must be an ordinary account in its own group only (it is in: $(id -Gn "$MIRROR_USER")); it must hold nothing else"
  install -d -o "$MIRROR_USER" -g "$MIRROR_USER" -m 0700 /var/lib/miu-mirror /var/lib/miu-mirror/keys /var/lib/miu-mirror/mirrors
  {
    echo "# $MIU_USER may fetch each repository $ETC/ci-mirrors lists, as $MIRROR_USER, and nothing else."
    if [ -f "$ETC/ci-mirrors" ]; then
      [[ ! -L "$ETC/ci-mirrors" && $(stat -c '%u %a' "$ETC/ci-mirrors") =~ ^0\ [0-7][0145][45]$ ]] || die "$ETC/ci-mirrors must be root's own file, mode 644"
      while read -r r _ || [ -n "$r" ]; do
        [[ -z $r || $r == \#* ]] && continue
        [[ $r =~ ^[A-Za-z0-9-]+/[A-Za-z0-9_.-]+$ ]] || die "$ETC/ci-mirrors: not a repository name: $r"
        echo "$MIU_USER ALL=($MIRROR_USER) NOPASSWD: $LIB/ci-mirror $r"
      done < "$ETC/ci-mirrors"
    fi
  } > /etc/sudoers.d/miu-ci-mirror.tmp
  visudo -cqf /etc/sudoers.d/miu-ci-mirror.tmp || die "the deploy-key sudoers rules did not validate"
  chmod 0440 /etc/sudoers.d/miu-ci-mirror.tmp && mv /etc/sudoers.d/miu-ci-mirror.tmp /etc/sudoers.d/miu-ci-mirror
  setenv MIU_CI_MIRROR_USER "$MIRROR_USER"
  setenv MIU_CI_MIRROR_HELPER "$LIB/ci-mirror"
  # Sandbox runs act with --pull=false, so the runner image has to be here already.
  # Miu runs jobs with --as-runner: ubuntu-latest and ubuntu-22.04 run in this image.
  sudo -u "$SANDBOX_USER" -H docker pull -q catthehacker/ubuntu:runner-22.04 >/dev/null || say "Could not pull the CI runner image as $SANDBOX_USER; CI workflows will fail until it is there."
  # The job's runner user is uid 1001 and writes to the workspace this account owns.
  [ "$(id -u "$SANDBOX_USER")" = 1001 ] || say "$SANDBOX_USER is uid $(id -u "$SANDBOX_USER"), not 1001, the runner user in CI jobs; CI reports \"not run\" until the Sandbox account is uid 1001."
  sudo -u "$SANDBOX_USER" -H sh -c 'command -v act' >/dev/null || say "act is not installed for $SANDBOX_USER; CI workflows will report \"not run\" until it is."
fi

# The unit below loads the key itself; an older drop-in that did would load it twice.
rm -f /etc/systemd/system/miu.service.d/secrets.conf
cat > /etc/systemd/system/miu.service <<EOF
[Unit]
Description=Miu, pull request QA
After=network-online.target rexenv-headless.service
Wants=network-online.target rexenv-headless.service

[Service]
User=$MIU_USER
UMask=0027
WorkingDirectory=$APP
Environment=HOME=$MIU_HOME
Environment=PATH=$OPT/node/bin:/usr/local/bin:/usr/bin:/bin
Environment=XDG_RUNTIME_DIR=/run/user/$MIU_UID
Environment=MIU_HOST=127.0.0.1
EnvironmentFile=-$ENVF
LoadCredentialEncrypted=miu-secrets-key:$CRED
ExecStart=$OPT/node/bin/node bin/qa-dashboard --port 4747
Restart=on-failure
RestartSec=5
KillMode=process

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable miu.service >/dev/null
systemctl restart miu.service

# ---------------------------------------------------------------- QA sites
# The two WordPress sites every run uses. Made now, so the first test does not
# wait while rexenv downloads MySQL and PHP; a second try finishes what a slow
# first one left.
say "Preparing the QA sites (the first time takes a few minutes)"
prep() { (cd "$APP" && as_miu env HOME="$MIU_HOME" QA_CACHE_DIR="$DATA/.cache" MIU_PROFILES="$ETC/profiles" timeout 1500 \
  node --input-type=module -e 'await (await import("./lib/warmsites.mjs")).ensureSites(() => {}, ["pr", "dev"]);') >/tmp/miu-sites.log 2>&1; }
prep || prep || say "The QA sites are not ready yet (see /tmp/miu-sites.log); the first test makes them."

# ------------------------------------------------------------------- caddy
if [ -n "$DOMAIN" ]; then
  if ! command -v caddy >/dev/null; then
    say "Installing Caddy for https://$DOMAIN"
    curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/caddy-stable.gpg
    chmod 0644 /etc/apt/keyrings/caddy-stable.gpg
    echo "deb [signed-by=/etc/apt/keyrings/caddy-stable.gpg] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main" > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq && apt-get install -y -qq caddy >/dev/null
  fi
  install -d -m 0755 /etc/caddy/conf.d
  grep -q 'import conf.d/\*' /etc/caddy/Caddyfile 2>/dev/null || printf '\nimport conf.d/*\n' >> /etc/caddy/Caddyfile
  cat > /etc/caddy/conf.d/miu <<EOF
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:4747
}
EOF
  caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1 || die "the Caddy config did not validate; see: caddy validate --config /etc/caddy/Caddyfile"
  systemctl reload caddy 2>/dev/null || systemctl restart caddy
fi

# -------------------------------------------------------------------- done
# Any HTTP answer counts: with sign-in on, the page answers with the sign-in step.
answers() { [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4747/)" != 000 ]; }
for _ in $(seq 1 30); do answers && break; sleep 1; done
answers || die "Miu did not start; see: journalctl -u miu -n 50"
CODE=$(cat "$MIU_HOME/.config/miu/setup-code" 2>/dev/null || true)
URL=${DOMAIN:+https://$DOMAIN}
echo
say "Miu is running"
if [ -n "$URL" ]; then
  echo "  Open:        $URL"
else
  echo "  It listens on 127.0.0.1:4747 only. From your computer:"
  echo "    ssh -N -L 4747:127.0.0.1:4747 <you>@<this server>   then open http://localhost:4747"
  echo "  To give it an address of its own: sudo bash install.sh --domain miu.example.com"
fi
[ -n "$CODE" ] && echo "  Setup code:  $CODE   (for the owner account at /auth/setup)"
echo "  Next:        add a repo to test ($ETC/profiles, see docs/profiles.md), create the GitHub App"
echo "               and sign in to Claude or ChatGPT from Settings. docs/install.md has each step."
echo "  Logs:        journalctl -u miu -f"

#!/usr/bin/env bash
# OpenBot on your own server, private to your devices through Tailscale, with every Bot's computer
# on Boat (boat.dev).
#
# Run on the server (Ubuntu 22.04 or 24.04, or Debian 12):
#
#   curl -fsSL https://raw.githubusercontent.com/ZMAWline/OpenBot/main/deploy/office-server/install.sh | sudo bash
#
# or, from a copy of the repository:
#
#   sudo bash deploy/office-server/install.sh
#
# Safe to run again: it keeps an existing .env and only asks for what is missing.
set -euo pipefail

REPO_URL="${OPENBOT_REPO_URL:-https://github.com/ZMAWline/OpenBot.git}"
BRANCH="${OPENBOT_BRANCH:-main}"
INSTALL_DIR="${OPENBOT_DIR:-/opt/openbot}"
KIT="deploy/office-server"

say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
ok() { printf '\033[1;32m    %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m    %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mStopped: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run this with sudo: sudo bash $0"
command -v apt-get >/dev/null || die "This installer is for Ubuntu or Debian."

# When piped from curl, stdin is the script itself, so questions are read from the keyboard instead.
if [ -t 0 ]; then TTY=/dev/stdin; else TTY=/dev/tty; fi
ask() { # ask VAR "Question" [secret]
  local answer
  if [ "${3:-}" = secret ]; then
    read -r -s -p "    $2: " answer <"$TTY"; echo
  else
    read -r -p "    $2: " answer <"$TTY"
  fi
  printf -v "$1" '%s' "$answer"
}

# ---------------------------------------------------------------------------------------------------
say "1/6  Installing the basics (git, curl, openssl)"
apt-get update -qq
apt-get install -y -qq git curl openssl ca-certificates jq >/dev/null
ok "done"

say "2/6  Installing Docker"
if command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then
  ok "already installed ($(docker --version | cut -d, -f1))"
else
  curl -fsSL https://get.docker.com | sh >/dev/null
  systemctl enable --now docker >/dev/null
  ok "installed"
fi

say "3/6  Installing Tailscale and joining your private network"
if ! command -v tailscale >/dev/null; then
  curl -fsSL https://tailscale.com/install.sh | sh >/dev/null
fi
systemctl enable --now tailscaled >/dev/null 2>&1 || true
if ! tailscale status >/dev/null 2>&1; then
  warn "A link will appear below. Open it on any device, sign in to Tailscale"
  warn "(use the same account you will use on your phone and laptops), and approve this server."
  tailscale up --hostname=openbot
fi
TS_NAME="$(tailscale status --json | jq -r '.Self.DNSName' | sed 's/\.$//')"
[ -n "$TS_NAME" ] && [ "$TS_NAME" != "null" ] || die "Tailscale is running but gave this server no name. In the Tailscale admin console, turn on MagicDNS and HTTPS certificates, then run this again."
ok "this server is https://$TS_NAME on your tailnet"

say "4/6  Getting OpenBot (your fork)"
if [ -d "$INSTALL_DIR/.git" ]; then
  git -C "$INSTALL_DIR" fetch -q origin "$BRANCH"
  git -C "$INSTALL_DIR" checkout -q "$BRANCH"
  git -C "$INSTALL_DIR" pull -q --ff-only origin "$BRANCH"
  ok "updated $INSTALL_DIR"
else
  git clone -q --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
  ok "downloaded to $INSTALL_DIR"
fi
cd "$INSTALL_DIR/$KIT"

say "5/6  Settings"
ENV_FILE="$INSTALL_DIR/$KIT/.env"
touch "$ENV_FILE"
chmod 600 "$ENV_FILE"
has() { grep -qE "^$1=.+" "$ENV_FILE"; }
put() { # put KEY VALUE: replace the line if it is there, add it if not
  local key="$1" value="$2"
  if grep -qE "^$key=" "$ENV_FILE"; then
    VALUE="$value" awk -v k="$key" 'BEGIN{FS=OFS="="} $1==k {print k "=" ENVIRON["VALUE"]; next} {print}' \
      "$ENV_FILE" >"$ENV_FILE.tmp" && mv "$ENV_FILE.tmp" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >>"$ENV_FILE"
  fi
  chmod 600 "$ENV_FILE"
}
need() { # need KEY "Question" [secret]
  if has "$1"; then ok "$1 is already set"; return; fi
  local value=""
  while [ -z "$value" ]; do ask value "$2" "${3:-}"; done
  put "$1" "$value"
}

# Fixed values: where it lives and how it runs.
URL="https://$TS_NAME"
put OPENBOT_SINGLE_USER true
put OPENBOT_PUBLIC_URL "$URL"
put OPENBOT_APP_URL "$URL"
put TRUSTED_ORIGINS "$URL"
put DEPLOYMENT_ID "${OPENBOT_DEPLOYMENT_ID:-office}"
put INTELLIGENCE_API_URL "https://api.intelligence.copilotkit.ai"
put INTELLIGENCE_GATEWAY_WS_URL "wss://realtime.intelligence.copilotkit.ai"
put TENANT_PACKAGE_DIR "../examples/fintech"
has BOAT_MACHINE_TYPE || put BOAT_MACHINE_TYPE small
has BOAT_IDLE_AFTER || put BOAT_IDLE_AFTER 30m

# Secrets this server makes for itself. Made once and kept, because changing them later locks the
# server out of what it already encrypted.
has KEY_ENCRYPTION_KEY || put KEY_ENCRYPTION_KEY "$(openssl rand -base64 32)"
has COMPUTER_TOKEN || put COMPUTER_TOKEN "$(openssl rand -hex 32)"
has AGENT_TOOL_TOKEN || put AGENT_TOOL_TOKEN "$(openssl rand -hex 32)"
has WORKER_SHARED_SECRET || put WORKER_SHARED_SECRET "$(openssl rand -hex 32)"
ok "made the private keys this server needs"

# What only you can supply. Typing is hidden for the secret ones.
echo
warn "Now paste in your keys (the printed guide says where each one comes from)."
need OPENAI_API_KEY "OpenAI API key (starts sk-)" secret
need BOAT_API_KEY "Boat API key (from boat.dev dashboard > API keys)" secret
need INTELLIGENCE_API_KEY "CopilotKit Intelligence key (starts cpk-)" secret
need COPILOTKIT_LICENSE_TOKEN "CopilotKit license token" secret

say "6/6  Building and starting OpenBot (the first build takes 10-20 minutes)"
docker compose build
docker compose up -d
printf '    waiting for OpenBot to answer'
for _ in $(seq 1 180); do
  if curl -fsS http://127.0.0.1:3001/health >/dev/null 2>&1; then echo; break; fi
  printf '.'; sleep 2
done
curl -fsS http://127.0.0.1:3001/health >/dev/null 2>&1 \
  || die "OpenBot did not start. See what it said with: cd $INSTALL_DIR/$KIT && docker compose logs --tail 80 openbot"
ok "OpenBot is running"

# HTTPS on the tailnet only. `serve`, never `funnel`: funnel would put it on the public internet,
# and this setup has no sign-in screen because only your own devices can reach it.
tailscale serve --bg --https=443 http://127.0.0.1:3001 >/dev/null
ok "published privately at $URL"

cat <<DONE

$(printf '\033[1;32m')All done.$(printf '\033[0m')

  Open OpenBot:  $URL

  On each phone, PC and laptop: install Tailscale, sign in with the same account,
  then open the address above. On a phone, use "Add to Home Screen" to get an app icon.

  Update later:  sudo bash $INSTALL_DIR/$KIT/update.sh
  See the logs:  cd $INSTALL_DIR/$KIT && sudo docker compose logs -f openbot

DONE

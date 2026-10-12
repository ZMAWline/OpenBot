#!/usr/bin/env bash
# Bring the server up to the newest version of your fork. Keeps your settings and data.
#
#   sudo bash /opt/openbot/deploy/office-server/update.sh
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Run this with sudo." >&2; exit 1; }

KIT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$KIT_DIR/../.." && pwd)"
BRANCH="${OPENBOT_BRANCH:-$(git -C "$REPO_DIR" rev-parse --abbrev-ref HEAD)}"

FORK_URL="https://github.com/ZMAWline/OpenBot"
stop() {
  printf '\nNot updated: %s\nOpenBot keeps running the version it had.\n' "$1" >&2
  exit 1
}

# Only ever update from the fork, never from CopilotKit's original.
case "$(git -C "$REPO_DIR" config --get remote.origin.url)" in
  "$FORK_URL" | "$FORK_URL.git" | https://github.com/[Zz][Mm][Aa][Ww]line/[Oo]pen[Bb]ot*) ;;
  *) stop "this copy downloads from $(git -C "$REPO_DIR" config --get remote.origin.url), not your fork ($FORK_URL)." ;;
esac

before="$(git -C "$REPO_DIR" rev-parse HEAD)"
echo "==> Downloading the latest version of your fork ($BRANCH)"
# --ff-only: a fork whose history was replaced (GitHub's "Discard commits") cannot fast-forward, so it
# is refused here rather than swapping the server onto CopilotKit's version.
git -C "$REPO_DIR" fetch -q origin "$BRANCH" \
  || stop "could not reach GitHub."
git -C "$REPO_DIR" merge -q --ff-only "origin/$BRANCH" 2>/dev/null \
  || stop "your fork's history on GitHub was replaced (did someone press \"Discard commits\" on GitHub?). Restore it before updating."

# The fork's own parts must still be there; if they are gone, this is not the fork's code any more.
for part in server/src/computer/boat.ts deploy/office-server/install.sh; do
  if [ ! -f "$REPO_DIR/$part" ]; then
    git -C "$REPO_DIR" reset -q --hard "$before"
    stop "the new version is missing $part, so it is CopilotKit's original rather than your fork. Put back the previous version."
  fi
done

echo "==> Rebuilding (a few minutes)"
cd "$KIT_DIR"
docker compose build
docker compose up -d

echo "==> Waiting for OpenBot to answer"
for _ in $(seq 1 180); do
  if curl -fsS http://127.0.0.1:3001/health >/dev/null 2>&1; then
    echo "Updated and running."
    exit 0
  fi
  sleep 2
done
echo "OpenBot did not come back. See: cd $KIT_DIR && sudo docker compose logs --tail 80 openbot" >&2
exit 1

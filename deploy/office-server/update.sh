#!/usr/bin/env bash
# Bring the server up to the newest version of your fork. Keeps your settings and data.
#
#   sudo bash /opt/openbot/deploy/office-server/update.sh
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Run this with sudo." >&2; exit 1; }

KIT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$KIT_DIR/../.." && pwd)"
BRANCH="${OPENBOT_BRANCH:-$(git -C "$REPO_DIR" rev-parse --abbrev-ref HEAD)}"

echo "==> Downloading the latest version ($BRANCH)"
git -C "$REPO_DIR" pull --ff-only origin "$BRANCH"

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

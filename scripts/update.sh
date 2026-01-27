#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "Updating Bijaz in $ROOT_DIR"

echo "- Fetching latest code"
git pull --ff-only

echo "- Installing dependencies"
pnpm install

echo "- Building"
pnpm build

echo "- Restarting service"
if command -v systemctl >/dev/null 2>&1; then
  sudo systemctl restart bijaz
  sudo systemctl status bijaz --no-pager
else
  echo "systemctl not found; skipping service restart"
fi

echo "Update complete"

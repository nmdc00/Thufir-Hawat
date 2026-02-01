#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "Updating Thufir in $ROOT_DIR"

echo "- Fetching latest code"
git pull --ff-only

echo "- Installing dependencies"
pnpm install

echo "- Building"
pnpm build

echo "- Restarting service"
if command -v systemctl >/dev/null 2>&1; then
  sudo systemctl restart thufir
  sudo systemctl status thufir --no-pager
  if systemctl list-unit-files --type=service --no-legend | awk '{print $1}' | grep -qx 'llm-mux.service'; then
    echo "- Restarting llm-mux"
    sudo systemctl restart llm-mux
    sudo systemctl status llm-mux --no-pager
  fi
else
  echo "systemctl not found; skipping service restart"
fi

echo "Update complete"

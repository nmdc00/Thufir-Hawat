#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "Updating Thufir in $ROOT_DIR"

echo "- Fetching latest code"
git pull --ff-only

echo "- Installing dependencies"
pnpm install

if [ -d "$ROOT_DIR/vendor/openclaw/.git" ]; then
  echo "- Updating OpenClaw vendor"
  git -C "$ROOT_DIR/vendor/openclaw" pull --ff-only
  echo "- Installing OpenClaw dependencies"
  pnpm --dir "$ROOT_DIR/vendor/openclaw" install
fi

echo "- Syncing workspace files"
WORKSPACE_DIR="${THUFIR_WORKSPACE:-$HOME/.thufir}"
mkdir -p "$WORKSPACE_DIR"
for f in "$ROOT_DIR/workspace/"*.md; do
  cp "$f" "$WORKSPACE_DIR/" 2>/dev/null || true
done

echo "- Building"
pnpm build

if [ -x "$ROOT_DIR/scripts/patch_qmd_safe_query.sh" ]; then
  echo "- Patching QMD safe query mode"
  "$ROOT_DIR/scripts/patch_qmd_safe_query.sh" || true
fi

echo "- Restarting service"
if command -v systemctl >/dev/null 2>&1; then
  if systemctl list-unit-files --type=service --no-legend | awk '{print $1}' | grep -qx 'bijaz.service'; then
    echo "- Disabling legacy bijaz service"
    sudo systemctl disable --now bijaz || true
  fi
  if systemctl --user list-unit-files --no-legend 2>/dev/null | awk '{print $1}' | grep -qx 'thufir.service'; then
    echo "- Restarting user services"
    systemctl --user restart launchdock.service ollama.service thufir.service
    systemctl --user --no-pager --plain status launchdock.service ollama.service thufir.service
  else
    sudo systemctl restart thufir
    sudo systemctl status thufir --no-pager
  fi
  if systemctl list-unit-files --type=service --no-legend | awk '{print $1}' | grep -qx 'openclaw-gateway.service'; then
    echo "- Restarting openclaw-gateway"
    sudo systemctl restart openclaw-gateway
    sudo systemctl status openclaw-gateway --no-pager
  fi
else
  echo "systemctl not found; skipping service restart"
fi

echo "Update complete"

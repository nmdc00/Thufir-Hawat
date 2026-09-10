#!/usr/bin/env bash
set -euo pipefail

# Compatibility entrypoint. The production installer is the canonical path.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec "$ROOT_DIR/scripts/install_production.sh" "$@"

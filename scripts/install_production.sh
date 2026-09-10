#!/usr/bin/env bash
set -euo pipefail

# Fork-friendly Ubuntu/Debian installer for a paper-mode Thufir deployment.
# launchdock authentication is intentionally interactive and never handled by
# this script as a secret or committed file.

INSTALL_PATH="${THUFIR_INSTALL_PATH:-$HOME/thufir}"
REPO_URL="${THUFIR_REPO_URL:-$(git remote get-url origin 2>/dev/null || true)}"
NODE_MAJOR="${THUFIR_NODE_MAJOR:-22}"

die() { echo "ERROR: $*" >&2; exit 1; }
need_cmd() { command -v "$1" >/dev/null 2>&1 || die "Missing command: $1"; }

[[ "$(uname -s)" == "Linux" ]] || die "This installer supports Linux only."
need_cmd sudo
need_cmd curl
need_cmd git

if [[ -z "$REPO_URL" ]]; then
  read -r -p "Thufir repository URL: " REPO_URL
fi

echo "==> Installing system dependencies"
sudo apt-get update
sudo apt-get install -y curl git build-essential ca-certificates zstd python3

if ! command -v node >/dev/null 2>&1 || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt "$NODE_MAJOR" ]]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
  sudo apt-get install -y nodejs
fi
sudo corepack enable
sudo corepack prepare pnpm@9.15.4 --activate

echo "==> Installing/updating Thufir at $INSTALL_PATH"
if [[ -d "$INSTALL_PATH/.git" ]]; then
  git -C "$INSTALL_PATH" pull --ff-only
else
  git clone "$REPO_URL" "$INSTALL_PATH"
fi
cd "$INSTALL_PATH"
pnpm install
pnpm build

echo "==> Creating complete Thufir configuration"
mkdir -p "$HOME/.thufir"
cp config/default.yaml "$HOME/.thufir/config.yaml"
sed -i \
  -e 's/^  useResponsesApi: .*/  useResponsesApi: false/' \
  -e 's/^  executorProvider: .*/  executorProvider: openai/' \
  -e '0,/^  provider: .*/s//  provider: openai/' \
  -e 's/^  useProxy: .*/  useProxy: true/' \
  -e 's#^  proxyBaseUrl: .*#  proxyBaseUrl: http://127.0.0.1:8090#' \
  -e 's#^  localBaseUrl: .*#  localBaseUrl: http://127.0.0.1:11434#' \
  -e 's/^  trivialTaskProvider: .*/  trivialTaskProvider: local/' \
  -e 's/^  trivialTaskModel: .*/  trivialTaskModel: qwen2.5:1.5b-instruct/' \
  -e 's/^  mode: .*/  mode: paper/' \
  "$HOME/.thufir/config.yaml"

echo "==> Installing launchdock"
curl -fsSL https://raw.githubusercontent.com/nghyane/launchdock/main/install.sh | bash
LAUNCHDOCK_BIN="$(command -v launchdock || true)"
[[ -n "$LAUNCHDOCK_BIN" ]] || LAUNCHDOCK_BIN="$HOME/.local/bin/launchdock"
[[ -x "$LAUNCHDOCK_BIN" ]] || die "launchdock was not installed"

mkdir -p "$HOME/.config/systemd/user"
cat > "$HOME/.config/systemd/user/launchdock.service" <<EOF
[Unit]
Description=launchdock AI gateway
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=$LAUNCHDOCK_BIN
WorkingDirectory=$HOME
Environment=HOME=$HOME
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now launchdock.service

echo
echo "============================================================"
echo "Authenticate launchdock now in this same user account:"
echo
echo "  $LAUNCHDOCK_BIN auth login openai --no-browser"
echo
echo "Complete the OpenAI login, then return here."
echo "============================================================"
read -r -p "Press Enter after authentication has succeeded... " _

echo "==> Discovering models available to this authenticated account"
MODEL_JSON="$(curl -fsS --max-time 30 http://127.0.0.1:8090/v1/models)"
mapfile -t CANDIDATE_MODELS < <(python3 -c 'import json,sys; print("\\n".join(str(x["id"]) for x in json.load(sys.stdin).get("data",[]) if x.get("id")))' <<<"$MODEL_JSON")
[[ "${#CANDIDATE_MODELS[@]}" -gt 0 ]] || die "launchdock returned no models"

USABLE_MODELS=()
for candidate in "${CANDIDATE_MODELS[@]}"; do
  payload=$(python3 -c 'import json,sys; print(json.dumps({"model":sys.argv[1],"messages":[{"role":"user","content":"Reply with exactly OK"}],"max_tokens":8}))' "$candidate")
  status=$(curl -sS --max-time 60 -o /tmp/thufir-model-test.json -w '%{http_code}' \
    http://127.0.0.1:8090/v1/chat/completions \
    -H 'Authorization: Bearer unused' -H 'Content-Type: application/json' -d "$payload")
  if [[ "$status" == "200" ]]; then
    USABLE_MODELS+=("$candidate")
    echo "  [$(( ${#USABLE_MODELS[@]} ))] $candidate"
  else
    echo "  [unavailable] $candidate"
  fi
done
[[ "${#USABLE_MODELS[@]}" -gt 0 ]] || die "No advertised launchdock model is usable by this account"

if [[ "${#USABLE_MODELS[@]}" == 1 ]]; then
  SELECTED_MODEL="${USABLE_MODELS[0]}"
else
  read -r -p "Select the primary model [1-${#USABLE_MODELS[@]}]: " MODEL_INDEX
  [[ "$MODEL_INDEX" =~ ^[0-9]+$ ]] || die "Model selection must be a number"
  (( MODEL_INDEX >= 1 && MODEL_INDEX <= ${#USABLE_MODELS[@]} )) || die "Invalid model selection"
  SELECTED_MODEL="${USABLE_MODELS[$((MODEL_INDEX - 1))]}"
fi
echo "Selected model: $SELECTED_MODEL"

# Apply the account-specific model only after discovery and validation.
sed -i \
  -e "s/^  model: .*/  model: $SELECTED_MODEL/" \
  -e "s/^  openaiModel: .*/  openaiModel: $SELECTED_MODEL/" \
  -e "s/^  executorModel: .*/  executorModel: $SELECTED_MODEL/" \
  -e "s/^  fallbackModel: .*/  fallbackModel: $SELECTED_MODEL/" \
  "$HOME/.thufir/config.yaml"

echo "==> Installing Ollama"
curl -fsSL https://ollama.com/install.sh | sh
OLLAMA_BIN="$(command -v ollama)"
# The official installer may create a system service. Use one user service so
# the model server and Thufir share the same HOME/configuration and linger.
sudo systemctl disable --now ollama.service 2>/dev/null || true
cat > "$HOME/.config/systemd/user/ollama.service" <<EOF
[Unit]
Description=Ollama local fallback model server
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=$OLLAMA_BIN serve
WorkingDirectory=$HOME
Environment=HOME=$HOME
Environment=OLLAMA_HOST=127.0.0.1:11434
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now ollama.service
sleep 2
ollama pull qwen2.5:1.5b-instruct

echo "==> Creating persistent Thufir service"
cat > "$HOME/.config/systemd/user/thufir.service" <<EOF
[Unit]
Description=Thufir Gateway
After=launchdock.service ollama.service
Requires=launchdock.service ollama.service

[Service]
ExecStart=$(command -v node) $INSTALL_PATH/dist/gateway/index.js
WorkingDirectory=$INSTALL_PATH
Environment=HOME=$HOME
Environment=PATH=$(dirname "$(command -v node)"):$HOME/.local/bin:/usr/bin:/bin
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF

sudo loginctl enable-linger "$(id -un)" 2>/dev/null || true
systemctl --user daemon-reload
systemctl --user enable --now thufir.service

echo "==> Running smoke tests"
sleep 5
curl -fsS http://127.0.0.1:11434/v1/models >/dev/null
curl -fsS http://127.0.0.1:18789/health >/dev/null
systemctl --user is-active launchdock.service ollama.service thufir.service
echo "Installation complete: Thufir is in paper mode."

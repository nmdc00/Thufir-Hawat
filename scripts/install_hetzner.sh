#!/usr/bin/env bash
set -euo pipefail

echo "Thufir Hetzner Installer (Ubuntu/Debian)"
echo "This script will:"
echo "  - Install Node 22 + pnpm (via NodeSource + corepack)"
echo "  - Clone/update Thufir to /opt/thufir (default)"
echo "  - Create .env and ~/.thufir/config.yaml"
echo "  - Install a systemd service and start it"
echo

read -rp "Install path [/opt/thufir]: " INSTALL_PATH
INSTALL_PATH=${INSTALL_PATH:-/opt/thufir}

read -rp "Git repo URL (e.g. https://github.com/you/thufir.git): " REPO_URL
if [[ -z "${REPO_URL}" ]]; then
  echo "Repo URL is required."
  exit 1
fi

read -rp "System user to run Thufir as [$(whoami)]: " RUN_USER
RUN_USER=${RUN_USER:-$(whoami)}

read -rp "Execution mode (paper|live) [paper]: " EXEC_MODE
EXEC_MODE=${EXEC_MODE:-paper}

read -rp "Enable Telegram? (y/n) [n]: " ENABLE_TELEGRAM
ENABLE_TELEGRAM=${ENABLE_TELEGRAM:-n}

read -rp "Enable Intel sources? (y/n) [n]: " ENABLE_INTEL
ENABLE_INTEL=${ENABLE_INTEL:-n}

echo
echo "Collecting secrets for .env (leave blank to skip optional keys)"
read -rsp "ANTHROPIC_API_KEY: " ANTHROPIC_API_KEY; echo
read -rsp "OPENAI_API_KEY: " OPENAI_API_KEY; echo

NEWSAPI_KEY=""
SERPAPI_KEY=""
TWITTER_BEARER=""
if [[ "${ENABLE_INTEL}" =~ ^[Yy]$ ]]; then
  read -rsp "NEWSAPI_KEY: " NEWSAPI_KEY; echo
  read -rsp "SERPAPI_KEY: " SERPAPI_KEY; echo
  read -rsp "TWITTER_BEARER: " TWITTER_BEARER; echo
fi

TELEGRAM_BOT_TOKEN=""
TELEGRAM_ALLOWED_CHAT_IDS=""
if [[ "${ENABLE_TELEGRAM}" =~ ^[Yy]$ ]]; then
  read -rsp "TELEGRAM_BOT_TOKEN: " TELEGRAM_BOT_TOKEN; echo
  read -rp "Telegram allowed chat IDs (comma-separated): " TELEGRAM_ALLOWED_CHAT_IDS
fi

THUFIR_WALLET_PASSWORD=""
THUFIR_KEYSTORE_PATH=""
if [[ "${EXEC_MODE}" == "live" ]]; then
  read -rsp "THUFIR_WALLET_PASSWORD: " THUFIR_WALLET_PASSWORD; echo
  read -rp "THUFIR_KEYSTORE_PATH [~/.thufir/keystore.json]: " THUFIR_KEYSTORE_PATH
  THUFIR_KEYSTORE_PATH=${THUFIR_KEYSTORE_PATH:-~/.thufir/keystore.json}
fi

echo
echo "Installing system dependencies..."
sudo apt update
sudo apt install -y curl unzip git build-essential

echo "Installing Node 22 + pnpm..."
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo corepack enable
sudo corepack prepare pnpm@10.28.1 --activate

echo "Installing bun (required for QMD)..."
curl -fsSL https://bun.sh/install | bash
export BUN_INSTALL="${HOME}/.bun"
export PATH="${BUN_INSTALL}/bin:${PATH}"

echo "Installing QMD (local knowledge search)..."
bun install -g github:tobi/qmd || echo "Warning: QMD install failed, will retry after deploy"

echo "Cloning/updating repo..."
sudo mkdir -p "${INSTALL_PATH}"
sudo chown -R "${RUN_USER}":"${RUN_USER}" "${INSTALL_PATH}"
if [[ -d "${INSTALL_PATH}/.git" ]]; then
  git -C "${INSTALL_PATH}" pull
else
  git clone "${REPO_URL}" "${INSTALL_PATH}"
fi

cd "${INSTALL_PATH}"
printf "a\ny\n" | pnpm approve-builds
pnpm install
pnpm build

echo "Writing .env..."
cat > "${INSTALL_PATH}/.env" <<EOF
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
OPENAI_API_KEY=${OPENAI_API_KEY}
NEWSAPI_KEY=${NEWSAPI_KEY}
SERPAPI_KEY=${SERPAPI_KEY}
TWITTER_BEARER=${TWITTER_BEARER}
TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
THUFIR_WALLET_PASSWORD=${THUFIR_WALLET_PASSWORD}
THUFIR_KEYSTORE_PATH=${THUFIR_KEYSTORE_PATH}
EOF

echo "Setting up QMD knowledge collections..."
mkdir -p "${HOME}/.thufir/knowledge"/{research,intel,markets}
if command -v qmd &> /dev/null; then
    qmd collection add "${HOME}/.thufir/knowledge/research" --name thufir-research 2>/dev/null || true
    qmd collection add "${HOME}/.thufir/knowledge/intel" --name thufir-intel 2>/dev/null || true
    qmd collection add "${HOME}/.thufir/knowledge/markets" --name thufir-markets 2>/dev/null || true
    qmd context add qmd://thufir-research "Web search results and articles for prediction market research" 2>/dev/null || true
    qmd context add qmd://thufir-intel "News, social media intel, market commentary" 2>/dev/null || true
    qmd context add qmd://thufir-markets "Market analysis and trading notes" 2>/dev/null || true
    echo "QMD collections configured"
fi

echo "Writing ~/.thufir/config.yaml..."
mkdir -p "${HOME}/.thufir"
cat > "${HOME}/.thufir/config.yaml" <<EOF
gateway:
  port: 18789
  bind: loopback

agent:
  model: claude-sonnet-4-5-20251101
  openaiModel: gpt-5.2
  provider: anthropic
  apiBaseUrl: https://api.openai.com
  workspace: ~/.thufir

execution:
  mode: ${EXEC_MODE}

wallet:
  keystorePath: ~/.thufir/keystore.json
  limits:
    daily: 100
    perTrade: 25
    confirmationThreshold: 10

polymarket:
  api:
    gamma: https://gamma-api.polymarket.com
    clob: https://clob.polymarket.com

memory:
  dbPath: ~/.thufir/thufir.sqlite
  sessionsPath: ~/.thufir/sessions
  maxHistoryMessages: 50
  compactAfterTokens: 12000
  keepRecentMessages: 12
  retentionDays: 90
  embeddings:
    enabled: false
    provider: openai
    model: text-embedding-3-small
    apiBaseUrl: https://api.openai.com

channels:
  telegram:
    enabled: ${ENABLE_TELEGRAM}
    token: "${TELEGRAM_BOT_TOKEN}"
    allowedChatIds: [${TELEGRAM_ALLOWED_CHAT_IDS}]
EOF

SERVICE_PATH="/etc/systemd/system/thufir.service"
echo "Writing systemd service to ${SERVICE_PATH}..."
sudo tee "${SERVICE_PATH}" >/dev/null <<EOF
[Unit]
Description=Thufir Gateway
After=network.target

[Service]
WorkingDirectory=${INSTALL_PATH}
Environment=NODE_ENV=production
Environment=PATH=/usr/local/bin:/usr/bin:/bin:${HOME}/.bun/bin
EnvironmentFile=${INSTALL_PATH}/.env
ExecStart=/usr/bin/pnpm thufir gateway
Restart=always
User=${RUN_USER}
Group=${RUN_USER}

[Install]
WantedBy=multi-user.target
EOF

echo "Enabling service..."
sudo systemctl daemon-reload
sudo systemctl enable thufir
sudo systemctl start thufir

echo "Installing update helper..."
sudo tee /usr/local/bin/thufir-update >/dev/null <<EOF
#!/usr/bin/env bash
set -euo pipefail
cd "${INSTALL_PATH}"
git pull
pnpm install
pnpm build
sudo systemctl restart thufir
sudo systemctl status thufir --no-pager
if systemctl list-unit-files --type=service --no-legend | awk '{print \$1}' | grep -qx 'llm-mux.service'; then
  sudo systemctl restart llm-mux
  sudo systemctl status llm-mux --no-pager
fi
EOF
sudo chmod +x /usr/local/bin/thufir-update

echo
echo "Done. Service status:"
sudo systemctl status thufir --no-pager

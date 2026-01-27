#!/usr/bin/env bash
set -euo pipefail

echo "Bijaz Hetzner Installer (Ubuntu/Debian)"
echo "This script will:"
echo "  - Install Node 22 + pnpm (via NodeSource + corepack)"
echo "  - Clone/update Bijaz to /opt/bijaz (default)"
echo "  - Create .env and ~/.bijaz/config.yaml"
echo "  - Install a systemd service and start it"
echo

read -rp "Install path [/opt/bijaz]: " INSTALL_PATH
INSTALL_PATH=${INSTALL_PATH:-/opt/bijaz}

read -rp "Git repo URL (e.g. https://github.com/you/bijaz.git): " REPO_URL
if [[ -z "${REPO_URL}" ]]; then
  echo "Repo URL is required."
  exit 1
fi

read -rp "System user to run Bijaz as [$(whoami)]: " RUN_USER
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

BIJAZ_WALLET_PASSWORD=""
BIJAZ_KEYSTORE_PATH=""
if [[ "${EXEC_MODE}" == "live" ]]; then
  read -rsp "BIJAZ_WALLET_PASSWORD: " BIJAZ_WALLET_PASSWORD; echo
  read -rp "BIJAZ_KEYSTORE_PATH [~/.bijaz/keystore.json]: " BIJAZ_KEYSTORE_PATH
  BIJAZ_KEYSTORE_PATH=${BIJAZ_KEYSTORE_PATH:-~/.bijaz/keystore.json}
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
BIJAZ_WALLET_PASSWORD=${BIJAZ_WALLET_PASSWORD}
BIJAZ_KEYSTORE_PATH=${BIJAZ_KEYSTORE_PATH}
EOF

echo "Writing ~/.bijaz/config.yaml..."
mkdir -p "${HOME}/.bijaz"
cat > "${HOME}/.bijaz/config.yaml" <<EOF
gateway:
  port: 18789
  bind: loopback

agent:
  model: claude-sonnet-4-5-20251101
  openaiModel: gpt-5.2
  provider: anthropic
  apiBaseUrl: https://api.openai.com
  workspace: ~/.bijaz

execution:
  mode: ${EXEC_MODE}

wallet:
  keystorePath: ~/.bijaz/keystore.json
  limits:
    daily: 100
    perTrade: 25
    confirmationThreshold: 10

polymarket:
  api:
    gamma: https://gamma-api.polymarket.com
    clob: https://clob.polymarket.com

memory:
  dbPath: ~/.bijaz/bijaz.sqlite
  sessionsPath: ~/.bijaz/sessions
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

SERVICE_PATH="/etc/systemd/system/bijaz.service"
echo "Writing systemd service to ${SERVICE_PATH}..."
sudo tee "${SERVICE_PATH}" >/dev/null <<EOF
[Unit]
Description=Bijaz Gateway
After=network.target

[Service]
WorkingDirectory=${INSTALL_PATH}
Environment=NODE_ENV=production
EnvironmentFile=${INSTALL_PATH}/.env
ExecStart=/usr/bin/pnpm bijaz gateway
Restart=always
User=${RUN_USER}
Group=${RUN_USER}

[Install]
WantedBy=multi-user.target
EOF

echo "Enabling service..."
sudo systemctl daemon-reload
sudo systemctl enable bijaz
sudo systemctl start bijaz

echo "Installing update helper..."
sudo tee /usr/local/bin/bijaz-update >/dev/null <<EOF
#!/usr/bin/env bash
set -euo pipefail
cd "${INSTALL_PATH}"
git pull
pnpm install
pnpm build
sudo systemctl restart bijaz
sudo systemctl status bijaz --no-pager
EOF
sudo chmod +x /usr/local/bin/bijaz-update

echo
echo "Done. Service status:"
sudo systemctl status bijaz --no-pager

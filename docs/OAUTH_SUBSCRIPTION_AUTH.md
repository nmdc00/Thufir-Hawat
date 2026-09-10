# Subscription Authentication with launchdock

Thufir uses launchdock as a local OpenAI-compatible gateway for a subscribed
OpenAI/Codex account. Small, non-critical tasks use Ollama locally.

```text
Thufir → launchdock :8090 → authenticated OpenAI/Codex account
Thufir → Ollama :11434 → qwen2.5:1.5b-instruct
```

## Recommended installation

```bash
git clone https://github.com/YOUR_ACCOUNT/Thufir-Hawat.git
cd Thufir-Hawat
bash scripts/install_production.sh
```

The installer copies the complete configuration, enables paper mode, installs
launchdock and Ollama, and creates persistent user-level services.

## Authentication

Run this as the same user that will run Thufir:

```bash
launchdock auth login openai --no-browser
```

The installer queries `http://127.0.0.1:8090/v1/models`, tests each advertised
model with a real request, and asks you to select one. Model IDs are not
hard-coded because availability depends on the account and may change.

Credentials are stored by launchdock at `~/.config/launchdock/config.json`.
Do not commit or paste that file into the repository.

## Thufir configuration

```yaml
agent:
  provider: openai
  useProxy: true
  proxyBaseUrl: http://127.0.0.1:8090
  localBaseUrl: http://127.0.0.1:11434
  trivialTaskProvider: local
  trivialTaskModel: qwen2.5:1.5b-instruct

execution:
  mode: paper
```

The selected launchdock model is written to `model`, `openaiModel`, and
`executorModel` by the installer. `fallbackModel` is provider-specific and is
not the Ollama fallback.

## Services and checks

```bash
systemctl --user status launchdock.service
systemctl --user status ollama.service
systemctl --user status thufir.service
curl http://127.0.0.1:8090/v1/models
curl http://127.0.0.1:11434/v1/models
curl http://127.0.0.1:18789/health
```

The gateway binds to loopback by default. Expose it externally only through a
separately authenticated and secured reverse proxy or operational channel.

## Manual recovery

```bash
systemctl --user restart launchdock.service ollama.service thufir.service
journalctl --user -u launchdock.service -n 50 --no-pager
journalctl --user -u ollama.service -n 50 --no-pager
journalctl --user -u thufir.service -n 50 --no-pager
```

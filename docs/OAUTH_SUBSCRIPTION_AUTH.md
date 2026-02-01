# Subscription-Based Authentication for Thufir

Use your Claude Pro/Max and OpenAI subscriptions instead of API keys by running [llm-mux](https://github.com/nghyane/llm-mux) as a local proxy.

## Overview

```
Thufir → localhost:8317 (llm-mux) → Claude Pro / OpenAI / Copilot
```

| Provider | Subscription | Support |
|----------|-------------|---------|
| Anthropic | Claude Pro ($20/mo) | Yes |
| Anthropic | Claude Max ($100-200/mo) | Yes |
| GitHub | Copilot (OpenAI models) | Yes |
| Google | Gemini (Antigravity) | Yes |

## Quick Start

### 1. Install llm-mux

```bash
curl -fsSL https://raw.githubusercontent.com/nghyane/llm-mux/main/install.sh | bash
```

### 2. Login to Providers

```bash
llm-mux login claude    # Claude Pro/Max
llm-mux login copilot   # GitHub Copilot
```

A browser window opens for OAuth authentication.

### 3. Start the Proxy

```bash
llm-mux
# Server runs on http://localhost:8317
```

### 4. Configure Thufir

In `~/.thufir/config.yaml`:

```yaml
agent:
  model: claude-sonnet-4-5-20251101
  provider: anthropic
  useProxy: true
  proxyBaseUrl: http://localhost:8317
```

### 5. Run Thufir

```bash
# No ANTHROPIC_API_KEY needed!
thufir
```

## Hetzner / Cloud Deployment

OAuth requires a browser, so authenticate locally first, then copy credentials to your server.

### Step 1: Authenticate Locally

```bash
# On your local machine (with browser)
llm-mux login claude
llm-mux login copilot
```

### Step 2: Copy Credentials to Server

```bash
scp -r ~/.config/llm-mux user@your-hetzner-ip:~/.config/
```

### Step 3: Run on Server

**Option A: Direct**
```bash
ssh user@your-hetzner-ip
llm-mux
```

**Option B: Docker (Recommended)**
```bash
docker run -d \
  --name llm-mux \
  --restart unless-stopped \
  -p 8317:8317 \
  -v ~/.config/llm-mux:/root/.config/llm-mux \
  nghyane/llm-mux
```

**Option C: Systemd Service**
```bash
# Install as service
llm-mux service install
llm-mux service start
```

## llm-mux Features

- **Multi-Account**: Load balance across multiple accounts
- **Auto-Retry**: Automatically retry on quota limits
- **Multi-Format**: OpenAI, Anthropic, Gemini compatible endpoints
- **Management API**: Usage stats at `http://localhost:8317/api/stats`

## Checking Status

```bash
# List authenticated providers
llm-mux status

# Test connection
curl http://localhost:8317/v1/models

# View usage stats
curl http://localhost:8317/api/stats
```

## Configuration Reference

### Thufir Config (`~/.thufir/config.yaml`)

```yaml
agent:
  model: claude-sonnet-4-5-20251101
  fallbackModel: claude-3-5-haiku-20241022
  provider: anthropic
  useProxy: true                        # Enable llm-mux proxy
  proxyBaseUrl: http://localhost:8317   # llm-mux endpoint
```

### Environment Variables (Fallback)

If proxy is disabled or unavailable, Thufir falls back to API keys:

```bash
export ANTHROPIC_API_KEY="sk-..."
export OPENAI_API_KEY="sk-..."
```

## Troubleshooting

### "Connection refused" to localhost:8317

llm-mux isn't running. Start it:
```bash
llm-mux
```

### Token expired / Auth errors

Re-authenticate:
```bash
llm-mux login claude --force
```

### Quota exceeded

llm-mux auto-retries, but if all accounts are exhausted:
- Wait for quota refresh
- Add another account: `llm-mux login claude` (logs into additional account)
- Fall back to API keys: set `useProxy: false`

### Browser doesn't open on server

Do OAuth locally, copy credentials:
```bash
# Local
llm-mux login claude

# Copy to server
scp -r ~/.config/llm-mux user@server:~/.config/
```

## Terms of Service Note

Using llm-mux to access subscriptions programmatically may violate provider terms of service. This is a personal project tool - use at your own discretion.

## References

- [llm-mux Documentation](https://nghyane.github.io/llm-mux/)
- [llm-mux GitHub](https://github.com/nghyane/llm-mux)
- [Docker Hub](https://hub.docker.com/r/nghyane/llm-mux)

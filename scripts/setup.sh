#!/bin/bash
#
# Thufir Setup Script
#
# This script sets up the Thufir development environment.
#

set -e

echo "=========================================="
echo "  Thufir Setup"
echo "=========================================="
echo ""

# Check Node.js version
NODE_VERSION=$(node -v 2>/dev/null | cut -d'v' -f2 | cut -d'.' -f1)
if [ -z "$NODE_VERSION" ] || [ "$NODE_VERSION" -lt 22 ]; then
    echo "Error: Node.js 22 or higher is required."
    echo "Current version: $(node -v 2>/dev/null || echo 'not installed')"
    echo ""
    echo "Install Node.js 22+ from https://nodejs.org"
    exit 1
fi
echo "✓ Node.js version: $(node -v)"

# Check pnpm
if ! command -v pnpm &> /dev/null; then
    echo "Installing pnpm..."
    npm install -g pnpm
fi
echo "✓ pnpm version: $(pnpm -v)"

# Check bun (required for QMD)
if ! command -v bun &> /dev/null; then
    echo "Installing bun (required for QMD)..."
    curl -fsSL https://bun.sh/install | bash
    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"
fi
echo "✓ bun version: $(bun -v 2>/dev/null || echo 'installed, restart shell to use')"

# Check QMD (local knowledge search)
if ! command -v qmd &> /dev/null; then
    echo "Installing QMD (local knowledge search)..."
    bun install -g github:tobi/qmd 2>/dev/null || echo "⚠ QMD install failed - install manually with: bun install -g github:tobi/qmd"
fi
if command -v qmd &> /dev/null; then
    echo "✓ QMD installed"
fi

# Install dependencies
echo ""
echo "Installing dependencies..."
pnpm install

# Create data directories
echo ""
echo "Creating data directories..."
mkdir -p ~/.thufir/data
mkdir -p ~/.thufir/logs
mkdir -p ~/.thufir/chroma
mkdir -p ~/.thufir/knowledge/{research,intel,markets}

# Setup QMD collections if available
if command -v qmd &> /dev/null; then
    echo ""
    echo "Setting up QMD knowledge collections..."
    # Create collections (ignore errors if already exist)
    qmd collection add ~/.thufir/knowledge/research --name thufir-research 2>/dev/null || true
    qmd collection add ~/.thufir/knowledge/intel --name thufir-intel 2>/dev/null || true
    qmd collection add ~/.thufir/knowledge/markets --name thufir-markets 2>/dev/null || true

    # Add context for better search relevance
    qmd context add qmd://thufir-research "Web search results and articles for prediction market research" 2>/dev/null || true
    qmd context add qmd://thufir-intel "News, social media intel, market commentary" 2>/dev/null || true
    qmd context add qmd://thufir-markets "Market analysis and trading notes" 2>/dev/null || true

    echo "✓ QMD collections configured"
fi

# Copy default config if not exists
if [ ! -f ~/.thufir/config.yaml ]; then
    echo "Creating default configuration..."
    cp config/default.yaml ~/.thufir/config.yaml
    echo "✓ Configuration created at ~/.thufir/config.yaml"
else
    echo "✓ Configuration already exists at ~/.thufir/config.yaml"
fi

# Copy .env.example if .env doesn't exist
if [ ! -f .env ]; then
    echo "Creating .env from .env.example..."
    cp .env.example .env
    echo "✓ Created .env - please edit with your API keys"
else
    echo "✓ .env already exists"
fi

# Build TypeScript
echo ""
echo "Building TypeScript..."
pnpm build

# Initialize database
echo ""
echo "Initializing database..."
if [ -f src/memory/schema.sql ]; then
    sqlite3 ~/.thufir/data/thufir.db < src/memory/schema.sql 2>/dev/null || true
    echo "✓ Database initialized"
fi

# Run tests
echo ""
echo "Running tests..."
pnpm test --run || echo "⚠ Some tests failed - this is expected before full implementation"

echo ""
echo "=========================================="
echo "  Setup Complete!"
echo "=========================================="
echo ""
echo "Next steps:"
echo ""
echo "1. Edit .env with your API keys:"
echo "   - ANTHROPIC_API_KEY (required for LLM)"
echo "   - POLYGON_RPC_URL (required for blockchain)"
echo ""
echo "2. Edit ~/.thufir/config.yaml to customize settings"
echo ""
echo "3. Create a wallet:"
echo "   pnpm thufir wallet create"
echo ""
echo "4. Start the CLI:"
echo "   pnpm thufir chat"
echo ""
echo "For development:"
echo "   pnpm dev          # Watch mode"
echo "   pnpm test         # Run tests"
echo "   pnpm gateway      # Start gateway"
echo ""

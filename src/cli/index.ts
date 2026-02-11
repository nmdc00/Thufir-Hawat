#!/usr/bin/env node
import 'dotenv/config';
/**
 * Thufir CLI
 *
 * Command-line interface for Thufir autonomous market discovery companion.
 */

import { Command } from 'commander';
import { VERSION } from '../index.js';
import { loadConfig } from '../core/config.js';
import { createMarketClient } from '../execution/market-client.js';
import { addWatchlist, listWatchlist } from '../memory/watchlist.js';
import { runIntelPipeline } from '../intel/pipeline.js';
import { listRecentIntel } from '../intel/store.js';
import { listProactiveQueryStats } from '../memory/proactive_queries.js';
import { rankIntelAlerts } from '../intel/alerts.js';
import { listIntelSources, isSourceAllowedForRoaming } from '../intel/sources_registry.js';
import { formatProactiveSummary, runProactiveSearch } from '../core/proactive_search.js';
import { listCalibrationSummaries } from '../memory/calibration.js';
import { listOpenPositionsFromTrades } from '../memory/trades.js';
import { adjustCashBalance, getCashBalance, setCashBalance } from '../memory/portfolio.js';
import { getUserContext, updateUserContext } from '../memory/user.js';
import { encryptPrivateKey, saveKeystore } from '../execution/wallet/keystore.js';
import { loadWallet } from '../execution/wallet/manager.js';
import { DbSpendingLimitEnforcer } from '../execution/wallet/limits_db.js';
import { ethers } from 'ethers';
import inquirer from 'inquirer';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Timeframe } from '../technical/types.js';
import yaml from 'yaml';
import { openDatabase } from '../memory/db.js';
import { pruneChatMessages } from '../memory/chat.js';
import { SessionStore } from '../memory/session_store.js';
import { executeToolCall } from '../core/tool-executor.js';
import { getEvaluationSummary } from '../core/evaluation.js';
import { runOrchestrator } from '../agent/orchestrator/orchestrator.js';
import { AgentToolRegistry } from '../agent/tools/registry.js';
import { registerAllTools } from '../agent/tools/adapters/index.js';
import { loadThufirIdentity } from '../agent/identity/identity.js';
import type { ToolExecution } from '../agent/tools/types.js';
import type { AgentPlan } from '../agent/planning/types.js';
import type { CriticResult } from '../agent/critic/types.js';
import { withExecutionContext } from '../core/llm_infra.js';
import type { ExecutionAdapter } from '../execution/executor.js';
import type { ThufirConfig } from '../core/config.js';

/**
 * Create the appropriate executor based on config execution mode.
 * The CLI agent command currently supports paper/webhook execution paths.
 */
async function createExecutorForConfig(
  config: ThufirConfig,
  _password?: string
): Promise<ExecutionAdapter> {
  if (config.execution.mode === 'live') {
    const { UnsupportedLiveExecutor } = await import('../execution/modes/unsupported-live.js');
    return new UnsupportedLiveExecutor();
  }

  if (config.execution.mode === 'webhook' && config.execution.webhookUrl) {
    const { WebhookExecutor } = await import('../execution/modes/webhook.js');
    return new WebhookExecutor(config.execution.webhookUrl);
  }

  const { PaperExecutor } = await import('../execution/modes/paper.js');
  return new PaperExecutor();
}

function formatToolTrace(executions: ToolExecution[]): string {
  if (executions.length === 0) {
    return 'No tools called.';
  }
  const lines: string[] = [];
  for (const exec of executions) {
    const status = exec.result.success ? 'SUCCESS' : 'FAILED';
    lines.push(`- ${exec.toolName} [${status}]`);
  }
  return lines.join('\n');
}

function formatCriticNotes(criticResult: CriticResult | null): string {
  if (!criticResult) {
    return 'Critic not run.';
  }
  const lines: string[] = [];
  lines.push(`Approved: ${criticResult.approved ? 'yes' : 'no'}`);
  lines.push(`Assessment: ${criticResult.assessment}`);
  if (criticResult.issues.length === 0) {
    lines.push('Issues: none');
    return lines.join('\n');
  }
  lines.push('Issues:');
  for (const issue of criticResult.issues) {
    const detail = issue.suggestion ? ` (fix: ${issue.suggestion})` : '';
    lines.push(`- [${issue.severity}] ${issue.type}: ${issue.description}${detail}`);
  }
  return lines.join('\n');
}

function formatPlanTrace(plan: AgentPlan | null): string {
  if (!plan) {
    return 'No plan available.';
  }
  const lines: string[] = [];
  lines.push(`Goal: ${plan.goal}`);
  lines.push(`Confidence: ${(plan.confidence * 100).toFixed(0)}%`);
  lines.push(`Revisions: ${plan.revisionCount}`);
  if (plan.blockers.length > 0) {
    lines.push(`Blockers: ${plan.blockers.join('; ')}`);
  }
  lines.push('Steps:');
  for (const step of plan.steps) {
    const tool = step.requiresTool ? ` tool=${step.toolName ?? 'unknown'}` : '';
    lines.push(`- [${step.status}] ${step.description}${tool}`);
  }
  return lines.join('\n');
}

function formatFragilityTrace(fragility?: {
  fragilityScore: number;
  riskSignalCount: number;
  fragilityCardCount: number;
  topRiskSignals: string[];
  highFragility: boolean;
}): string {
  if (!fragility) {
    return 'No fragility analysis available.';
  }
  const lines: string[] = [];
  const scorePercent = (fragility.fragilityScore * 100).toFixed(0);
  const warning = fragility.highFragility ? ' ⚠️ HIGH' : '';
  lines.push(`Fragility Score: ${scorePercent}%${warning}`);
  lines.push(`Risk Signals: ${fragility.riskSignalCount}`);
  lines.push(`Fragility Cards: ${fragility.fragilityCardCount}`);
  if (fragility.topRiskSignals.length > 0) {
    lines.push('');
    lines.push('Top Risks:');
    for (const signal of fragility.topRiskSignals) {
      lines.push(`- ${signal}`);
    }
  }
  return lines.join('\n');
}

function attachOrchestratorNotes(
  response: string,
  params: {
    showPlan: boolean;
    showTools: boolean;
    showCritic: boolean;
    showFragility: boolean;
    toolExecutions: ToolExecution[];
    criticResult: CriticResult | null;
    plan: AgentPlan | null;
    fragility?: {
      fragilityScore: number;
      riskSignalCount: number;
      fragilityCardCount: number;
      topRiskSignals: string[];
      highFragility: boolean;
    };
  }
): string {
  const sections: string[] = [];
  if (params.showPlan) {
    sections.push(`## Plan Trace\n${formatPlanTrace(params.plan)}`);
  }
  if (params.showTools) {
    sections.push(`## Tool Trace\n${formatToolTrace(params.toolExecutions)}`);
  }
  if (params.showCritic) {
    sections.push(`## Critic Notes\n${formatCriticNotes(params.criticResult)}`);
  }
  if (params.showFragility) {
    sections.push(`## Fragility Analysis\n${formatFragilityTrace(params.fragility)}`);
  }
  if (sections.length === 0) {
    return response;
  }
  return `${response}\n\n---\n\n${sections.join('\n\n')}`;
}

function getConfigPath(): string {
  return (
    process.env.THUFIR_CONFIG_PATH ?? join(homedir(), '.thufir', 'config.yaml')
  );
}

const ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'NEWSAPI_KEY',
  'SERPAPI_KEY',
  'TWITTER_BEARER',
  'TELEGRAM_BOT_TOKEN',
  'WHATSAPP_VERIFY_TOKEN',
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID',
  'THUFIR_WALLET_PASSWORD',
  'THUFIR_KEYSTORE_PATH',
  'HYPERLIQUID_ACCOUNT_ADDRESS',
  'HYPERLIQUID_PRIVATE_KEY',
];

function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function buildEnvContent(values: Record<string, string>): string {
  const lines = ['# Thufir environment variables', '# Generated by thufir env init', ''];
  for (const key of ENV_KEYS) {
    const value = values[key] ?? '';
    lines.push(`${key}=${value}`);
  }
  lines.push('');
  return lines.join('\n');
}

async function runEnvChecks(values: Record<string, string>): Promise<void> {
  const env = { ...process.env, ...values };
  const results: Array<{ name: string; ok: boolean; detail: string }> = [];
  const timeoutMs = 8000;

  const fetchWithTimeout = async (input: RequestInfo, init?: RequestInit) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(input, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };

  const tryCheck = async (name: string, fn: () => Promise<Response>) => {
    try {
      const response = await fn();
      if (response.ok) {
        results.push({ name, ok: true, detail: `ok (${response.status})` });
      } else {
        results.push({ name, ok: false, detail: `failed (${response.status})` });
      }
    } catch (error) {
      results.push({ name, ok: false, detail: (error as Error).message });
    }
  };

  if (env.OPENAI_API_KEY) {
    await tryCheck('OpenAI', () =>
      fetchWithTimeout('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
      })
    );
  } else {
    results.push({ name: 'OpenAI', ok: false, detail: 'missing OPENAI_API_KEY' });
  }

  if (env.ANTHROPIC_API_KEY) {
    await tryCheck('Anthropic', () =>
      fetchWithTimeout('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': env.ANTHROPIC_API_KEY ?? '',
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-3-haiku-20240307',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        }),
      })
    );
  } else {
    results.push({ name: 'Anthropic', ok: false, detail: 'missing ANTHROPIC_API_KEY' });
  }

  if (env.GEMINI_API_KEY || env.GOOGLE_API_KEY) {
    const key = env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY ?? '';
    await tryCheck('Google (Gemini)', () =>
      fetchWithTimeout(`https://generativelanguage.googleapis.com/v1/models?key=${key}`)
    );
  } else {
    results.push({ name: 'Google (Gemini)', ok: false, detail: 'missing GOOGLE_API_KEY' });
  }

  if (env.NEWSAPI_KEY) {
    await tryCheck('NewsAPI', () =>
      fetchWithTimeout('https://newsapi.org/v2/top-headlines?language=en&pageSize=1', {
        headers: { 'X-Api-Key': env.NEWSAPI_KEY ?? '' },
      })
    );
  } else {
    results.push({ name: 'NewsAPI', ok: false, detail: 'missing NEWSAPI_KEY' });
  }

  if (env.SERPAPI_KEY) {
    await tryCheck('SerpAPI', () =>
      fetchWithTimeout(
        `https://serpapi.com/search.json?engine=google_news&q=perp%20market&api_key=${env.SERPAPI_KEY}`
      )
    );
  } else {
    results.push({ name: 'SerpAPI', ok: false, detail: 'missing SERPAPI_KEY' });
  }

  if (env.TWITTER_BEARER) {
    await tryCheck('X/Twitter', () =>
      fetchWithTimeout(
        'https://api.twitter.com/2/tweets/search/recent?query=perp%20market&max_results=10',
        {
          headers: { Authorization: `Bearer ${env.TWITTER_BEARER}` },
        }
      )
    );
  } else {
    results.push({ name: 'X/Twitter', ok: false, detail: 'missing TWITTER_BEARER' });
  }

  if (env.TELEGRAM_BOT_TOKEN) {
    await tryCheck('Telegram', () =>
      fetchWithTimeout(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getMe`)
    );
  } else {
    results.push({ name: 'Telegram', ok: false, detail: 'missing TELEGRAM_BOT_TOKEN' });
  }

  if (env.WHATSAPP_ACCESS_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID) {
    await tryCheck('WhatsApp', () =>
      fetchWithTimeout(
        `https://graph.facebook.com/v18.0/${env.WHATSAPP_PHONE_NUMBER_ID}?fields=id,display_phone_number,verified_name`,
        {
          headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` },
        }
      )
    );
  } else {
    results.push({ name: 'WhatsApp', ok: false, detail: 'missing WhatsApp tokens' });
  }

  await tryCheck('Hyperliquid API', () =>
    fetchWithTimeout('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'meta' }),
    })
  );

  const hasHyperPrivateKey = Boolean(env.HYPERLIQUID_PRIVATE_KEY?.trim());
  const hasHyperAccountAddress = Boolean(env.HYPERLIQUID_ACCOUNT_ADDRESS?.trim());
  results.push({
    name: 'Hyperliquid auth',
    ok: hasHyperPrivateKey || hasHyperAccountAddress,
    detail: hasHyperPrivateKey
      ? 'HYPERLIQUID_PRIVATE_KEY set'
      : hasHyperAccountAddress
        ? 'HYPERLIQUID_ACCOUNT_ADDRESS set (read-only)'
        : 'missing HYPERLIQUID_PRIVATE_KEY',
  });

  if (env.THUFIR_KEYSTORE_PATH) {
    const exists = existsSync(env.THUFIR_KEYSTORE_PATH);
    results.push({
      name: 'Keystore',
      ok: exists,
      detail: exists ? 'found' : 'missing THUFIR_KEYSTORE_PATH file',
    });
  } else {
    results.push({ name: 'Keystore', ok: false, detail: 'missing THUFIR_KEYSTORE_PATH' });
  }

  console.log('Env Checks');
  console.log('─'.repeat(40));
  for (const result of results) {
    const status = result.ok ? 'ok' : 'fail';
    console.log(`${result.name}: ${status} (${result.detail})`);
  }
}

const program = new Command();
const config = loadConfig();
if (config.memory?.dbPath) {
  process.env.THUFIR_DB_PATH = config.memory.dbPath;
}
const marketClient = createMarketClient(config);

function requireMarketClient(): typeof marketClient | null {
  if (!marketClient.isAvailable()) {
    console.log('Market client is not configured. Market commands are unavailable.');
    return null;
  }
  return marketClient;
}

program
  .name('thufir')
  .description('Autonomous Market Discovery Companion')
  .version(VERSION);

// ============================================================================
// Env Commands
// ============================================================================

const env = program.command('env').description('Environment setup');

env
  .command('init')
  .description('Create/update a .env file with required keys')
  .option('--skip-test', 'Skip API checks after saving', false)
  .action(async (options) => {
    const envPath = join(process.cwd(), '.env');
    const existing = existsSync(envPath) ? parseEnvFile(readFileSync(envPath, 'utf8')) : {};
    const defaults = { ...existing, ...process.env } as Record<string, string>;

    const answers = await inquirer.prompt(
      ENV_KEYS.map((key) => ({
        type: key.includes('PATH') ? 'input' : 'password',
        name: key,
        message: `${key}:`,
        default: defaults[key] ?? '',
      }))
    );

    const content = buildEnvContent(answers as Record<string, string>);
    writeFileSync(envPath, content, 'utf8');
    console.log(`Wrote ${envPath}`);

    if (!options.skipTest) {
      await runEnvChecks(answers as Record<string, string>);
    }
  });

env
  .command('check')
  .description('Validate env vars and test external API keys')
  .action(async () => {
    const envPath = join(process.cwd(), '.env');
    const values = existsSync(envPath) ? parseEnvFile(readFileSync(envPath, 'utf8')) : {};
    await runEnvChecks(values);
  });

env
  .command('verify-live')
  .description('Run Hyperliquid live smoke checks (read-only)')
  .option('--symbol <symbol>', 'Perp symbol for mid-price check', 'BTC')
  .action(async (options: { symbol?: string }) => {
    const { HyperliquidClient } = await import('../execution/hyperliquid/client.js');
    const client = new HyperliquidClient(config);
    const symbol = String(options.symbol ?? 'BTC').trim().toUpperCase();
    const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

    try {
      const markets = await client.listPerpMarkets();
      const hasSymbol = markets.some((market) => market.symbol === symbol);
      checks.push({
        name: 'Perp markets',
        ok: markets.length > 0,
        detail: `loaded ${markets.length} market(s)`,
      });
      checks.push({
        name: `Symbol ${symbol}`,
        ok: hasSymbol,
        detail: hasSymbol ? 'found in market metadata' : 'not found in market metadata',
      });
    } catch (error) {
      checks.push({
        name: 'Perp markets',
        ok: false,
        detail: error instanceof Error ? error.message : 'unknown error',
      });
    }

    try {
      const mids = await client.getAllMids();
      const mid = mids[symbol];
      checks.push({
        name: 'Mid prices',
        ok: Object.keys(mids).length > 0,
        detail:
          typeof mid === 'number'
            ? `${symbol} mid=${mid}`
            : `${Object.keys(mids).length} symbol(s) loaded`,
      });
    } catch (error) {
      checks.push({
        name: 'Mid prices',
        ok: false,
        detail: error instanceof Error ? error.message : 'unknown error',
      });
    }

    const accountAddress = client.getAccountAddress();
    if (accountAddress) {
      try {
        const state = await client.getClearinghouseState();
        const stateKeys =
          state && typeof state === 'object'
            ? Object.keys(state as Record<string, unknown>).length
            : 0;
        checks.push({
          name: 'Account state',
          ok: true,
          detail: `loaded for ${accountAddress.slice(0, 10)}... (${stateKeys} field(s))`,
        });
      } catch (error) {
        checks.push({
          name: 'Account state',
          ok: false,
          detail: error instanceof Error ? error.message : 'unknown error',
        });
      }
    } else {
      checks.push({
        name: 'Account state',
        ok: false,
        detail:
          'missing HYPERLIQUID_ACCOUNT_ADDRESS/HYPERLIQUID_PRIVATE_KEY (required for authenticated checks)',
      });
    }

    console.log('Live Verification (Hyperliquid)');
    console.log('─'.repeat(40));
    for (const check of checks) {
      const status = check.ok ? 'ok' : 'fail';
      console.log(`${check.name}: ${status} (${check.detail})`);
    }

    const failed = checks.filter((check) => !check.ok).length;
    process.exitCode = failed === 0 ? 0 : 1;
  });

// ============================================================================
// Wallet Commands
// ============================================================================

const wallet = program.command('wallet').description('Wallet management');

wallet
  .command('create')
  .description('Create a new wallet')
  .action(async () => {
    const answers = await inquirer.prompt([
      { type: 'password', name: 'password', message: 'Set keystore password:' },
    ]);
    const wallet = ethers.Wallet.createRandom();
    const store = encryptPrivateKey(wallet.privateKey, answers.password, wallet.address);
    const path =
      config.wallet?.keystorePath ??
      process.env.THUFIR_KEYSTORE_PATH ??
      `${process.env.HOME ?? ''}/.thufir/keystore.json`;
    saveKeystore(path, store);
    console.log(`Wallet created: ${wallet.address}`);
  });

wallet
  .command('import')
  .description('Import an existing wallet')
  .action(async () => {
    const answers = await inquirer.prompt([
      { type: 'password', name: 'privateKey', message: 'Private key:' },
      { type: 'password', name: 'password', message: 'Set keystore password:' },
    ]);
    const wallet = new ethers.Wallet(answers.privateKey.trim());
    const store = encryptPrivateKey(wallet.privateKey, answers.password, wallet.address);
    const path =
      config.wallet?.keystorePath ??
      process.env.THUFIR_KEYSTORE_PATH ??
      `${process.env.HOME ?? ''}/.thufir/keystore.json`;
    saveKeystore(path, store);
    console.log(`Wallet imported: ${wallet.address}`);
  });

wallet
  .command('status')
  .description('Show wallet status and balance')
  .action(async () => {
    console.log('Wallet Status');
    console.log('─'.repeat(40));
    const answers = await inquirer.prompt([
      { type: 'password', name: 'password', message: 'Keystore password:' },
    ]);
    const wallet = loadWallet(config, answers.password);
    console.log(`Address: ${wallet.address}`);
    if (wallet.provider) {
      const balance = await wallet.provider.getBalance(wallet.address);
      console.log(`MATIC: ${ethers.utils.formatEther(balance)}`);
      const { getWalletBalances } = await import('../execution/wallet/balances.js');
      const tokenBalances = await getWalletBalances(wallet);
      if (tokenBalances) {
        console.log(`USDC: ${tokenBalances.usdc.toFixed(2)} (${tokenBalances.usdcAddress})`);
      }
    } else {
      console.log('No RPC provider configured.');
    }
  });

const walletLimits = wallet.command('limits').description('Spending limits');

walletLimits
  .command('show')
  .description('Show current spending limits')
  .action(async () => {
    console.log('Spending Limits');
    console.log('─'.repeat(40));
    const limits = config.wallet?.limits ?? { daily: 100, perTrade: 25, confirmationThreshold: 10 };
    const limiter = new DbSpendingLimitEnforcer({
      daily: limits.daily ?? 100,
      perTrade: limits.perTrade ?? 25,
      confirmationThreshold: limits.confirmationThreshold ?? 10,
    });
    const remaining = limiter.getRemainingDaily();

    let todaySpent = 0;
    let todayTradeCount = 0;
    try {
      const db = openDatabase();
      const row = db
        .prepare(
          `SELECT today_spent as todaySpent, today_trade_count as todayTradeCount
           FROM spending_state WHERE id = 1`
        )
        .get() as { todaySpent?: number; todayTradeCount?: number } | undefined;
      if (row) {
        todaySpent = row.todaySpent ?? 0;
        todayTradeCount = row.todayTradeCount ?? 0;
      }
    } catch {
      // Ignore if DB not available
    }

    console.log(`Daily limit: $${Number(limits.daily ?? 100).toFixed(2)}`);
    console.log(`Per-trade limit: $${Number(limits.perTrade ?? 25).toFixed(2)}`);
    console.log(
      `Confirmation threshold: $${Number(limits.confirmationThreshold ?? 10).toFixed(2)}`
    );
    console.log('');
    console.log(`Today spent: $${todaySpent.toFixed(2)} (${todayTradeCount} trades)`);
    console.log(`Remaining daily: $${remaining.toFixed(2)}`);
  });

walletLimits
  .command('set')
  .description('Set spending limits')
  .option('--daily <amount>', 'Daily spending limit (USD)')
  .option('--per-trade <amount>', 'Per-trade limit (USD)')
  .option('--confirmation-threshold <amount>', 'Confirmation threshold (USD)')
  .action(async (options) => {
    const daily = options.daily !== undefined ? Number(options.daily) : undefined;
    const perTrade = options.perTrade !== undefined ? Number(options.perTrade) : undefined;
    const confirmation =
      options.confirmationThreshold !== undefined
        ? Number(options.confirmationThreshold)
        : undefined;

    if (
      daily === undefined &&
      perTrade === undefined &&
      confirmation === undefined
    ) {
      console.log('No limits provided. Use --daily, --per-trade, or --confirmation-threshold.');
      return;
    }

    const invalid =
      (daily !== undefined && (!Number.isFinite(daily) || daily <= 0)) ||
      (perTrade !== undefined && (!Number.isFinite(perTrade) || perTrade <= 0)) ||
      (confirmation !== undefined &&
        (!Number.isFinite(confirmation) || confirmation <= 0));
    if (invalid) {
      console.log('All limit values must be positive numbers.');
      return;
    }

    const path = getConfigPath();
    if (!existsSync(path)) {
      console.log(`Config not found: ${path}`);
      return;
    }

    const raw = readFileSync(path, 'utf-8');
    const parsed = (yaml.parse(raw) ?? {}) as Record<string, unknown>;
    const wallet = (parsed.wallet ?? {}) as Record<string, unknown>;
    const limits = (wallet.limits ?? {}) as Record<string, unknown>;

    if (daily !== undefined) {
      limits.daily = daily;
    }
    if (perTrade !== undefined) {
      limits.perTrade = perTrade;
    }
    if (confirmation !== undefined) {
      limits.confirmationThreshold = confirmation;
    }

    wallet.limits = limits;
    parsed.wallet = wallet;

    writeFileSync(path, yaml.stringify(parsed));
    console.log('Limits updated in config.');
  });

// ============================================================================
// Market Commands
// ============================================================================

const markets = program.command('markets').description('Market data');

markets
  .command('list')
  .description('List active markets')
  .option('-c, --category <category>', 'Filter by category')
  .option('-l, --limit <number>', 'Limit results', '20')
  .action(async (options) => {
    const client = requireMarketClient();
    if (!client) return;
    console.log('Active Markets');
    console.log('─'.repeat(60));
    const list = await client.listMarkets(Number(options.limit));
    for (const market of list) {
      console.log(`${market.id} | ${market.question}`);
    }
  });

markets
  .command('show <id>')
  .description('Show market details')
  .action(async (id) => {
    const client = requireMarketClient();
    if (!client) return;
    console.log(`Market: ${id}`);
    console.log('─'.repeat(40));
    const market = await client.getMarket(id);
    console.log(`Question: ${market.question}`);
    console.log(`Outcomes: ${market.outcomes.join(', ')}`);
    console.log(`Prices: ${JSON.stringify(market.prices)}`);
  });

markets
  .command('watch <id>')
  .description('Add market to watchlist')
  .action(async (id) => {
    console.log(`Adding ${id} to watchlist...`);
    addWatchlist(id);
    console.log('Done.');
  });

markets
  .command('sync')
  .description('Sync market cache for faster lookups')
  .option('-l, --limit <number>', 'Limit results', '200')
  .action(async (options) => {
    const { syncMarketCache } = await import('../core/markets_sync.js');
    const ora = await import('ora');
    const spinner = ora.default('Syncing market cache...').start();
    try {
      const result = await syncMarketCache(config, Number(options.limit));
      spinner.succeed(`Stored ${result.stored} market(s) in cache.`);
    } catch (error) {
      spinner.fail(
        `Market sync failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  });

markets
  .command('watchlist')
  .description('List watched markets')
  .action(async () => {
    const watchlist = listWatchlist();
    if (watchlist.length === 0) {
      console.log('Watchlist is empty.');
      return;
    }
    console.log('Watchlist');
    console.log('─'.repeat(40));
    for (const item of watchlist) {
      console.log(item.marketId);
    }
  });


// ============================================================================
// Portfolio Commands
// ============================================================================

program
  .command('portfolio')
  .description('Show portfolio and positions')
  .option('--set-cash <amount>', 'Set cash balance (USD)')
  .option('--add-cash <amount>', 'Add to cash balance (USD)')
  .option('--withdraw-cash <amount>', 'Withdraw from cash balance (USD)')
  .option('--reconcile', 'Compare ledger cash vs on-chain USDC')
  .action(async (options) => {
    if (options.reconcile) {
      const answers = await inquirer.prompt([
        { type: 'password', name: 'password', message: 'Keystore password:' },
      ]);
      const { reconcileBalances } = await import('../core/reconcile.js');
      const result = await reconcileBalances({ config, password: answers.password });
      if ('error' in result) {
        console.log(result.error);
        return;
      }
      console.log('Balance Reconciliation');
      console.log('─'.repeat(60));
      console.log(`Ledger cash: $${result.ledgerCash.toFixed(2)}`);
      console.log(`On-chain USDC: $${result.chainUsdc.toFixed(2)}`);
      const delta = result.delta;
      const deltaSign = delta >= 0 ? '+' : '';
      console.log(`Delta: ${deltaSign}$${delta.toFixed(2)} (${result.deltaPercent.toFixed(1)}%)`);
      return;
    }
    const setCash = options.setCash !== undefined ? Number(options.setCash) : undefined;
    const addCash = options.addCash !== undefined ? Number(options.addCash) : undefined;
    const withdrawCash =
      options.withdrawCash !== undefined ? Number(options.withdrawCash) : undefined;

    if (setCash !== undefined || addCash !== undefined || withdrawCash !== undefined) {
      if (setCash !== undefined) {
        if (!Number.isFinite(setCash)) {
          console.log('Cash amount must be a number.');
          return;
        }
        setCashBalance(setCash);
      } else if (addCash !== undefined) {
        if (!Number.isFinite(addCash)) {
          console.log('Cash amount must be a number.');
          return;
        }
        adjustCashBalance(addCash);
      } else if (withdrawCash !== undefined) {
        if (!Number.isFinite(withdrawCash)) {
          console.log('Cash amount must be a number.');
          return;
        }
        adjustCashBalance(-withdrawCash);
      }

      const updated = getCashBalance();
      console.log(`Cash balance: $${updated.toFixed(2)}`);
      return;
    }

    console.log('Portfolio');
    console.log('═'.repeat(60));
    const canUseLive =
      config.execution.mode === 'live' && Boolean(process.env.THUFIR_WALLET_PASSWORD);
    if (canUseLive) {
      const marketClient = createMarketClient(config);
      const executor = await createExecutorForConfig(config);
      const limiter = new DbSpendingLimitEnforcer({
        daily: config.wallet?.limits?.daily ?? 100,
        perTrade: config.wallet?.limits?.perTrade ?? 25,
        confirmationThreshold: config.wallet?.limits?.confirmationThreshold ?? 10,
      });
      const toolResult = await executeToolCall('get_portfolio', {}, {
        config,
        marketClient,
        executor,
        limiter,
      });
      if (toolResult.success) {
        const data = toolResult.data as {
          perp_positions?: Array<{
            symbol?: string;
            side?: string;
            size?: number;
            entry_price?: number | null;
            position_value?: number | null;
            unrealized_pnl?: number | null;
            leverage?: number | null;
          }>;
          perp_summary?: {
            account_value?: number | null;
            total_notional?: number | null;
            total_margin_used?: number | null;
            withdrawable?: number | null;
          } | null;
          perp_error?: string | null;
        };
        const perpPositions = data.perp_positions ?? [];
        if (perpPositions.length === 0) {
          console.log('No open positions.');
          return;
        }
        if (perpPositions.length > 0) {
          console.log('Perp Positions');
          console.log('─'.repeat(40));
          for (const position of perpPositions) {
            const symbol = position.symbol ?? 'Unknown';
            const side = position.side ?? 'n/a';
            const size = position.size != null ? position.size.toFixed(4) : 'n/a';
            const entry =
              position.entry_price != null ? position.entry_price.toFixed(2) : 'n/a';
            const value =
              position.position_value != null ? position.position_value.toFixed(2) : 'n/a';
            const pnl =
              position.unrealized_pnl != null ? position.unrealized_pnl.toFixed(2) : 'n/a';
            const leverage =
              position.leverage != null ? position.leverage.toFixed(2) : 'n/a';
            console.log(
              `- ${symbol} ${side} size=${size} entry=${entry} value=${value} pnl=${pnl} lev=${leverage}`
            );
          }
          const perpSummary = data.perp_summary ?? null;
          if (perpSummary) {
            console.log('─'.repeat(40));
            console.log(`Account Value: $${(perpSummary.account_value ?? 0).toFixed(2)}`);
            console.log(`Total Notional: $${(perpSummary.total_notional ?? 0).toFixed(2)}`);
            console.log(
              `Margin Used: $${(perpSummary.total_margin_used ?? 0).toFixed(2)}`
            );
            if (perpSummary.withdrawable != null) {
              console.log(`Withdrawable: $${perpSummary.withdrawable.toFixed(2)}`);
            }
          }
        }
        if (data.perp_error) {
          console.log('');
          console.log(`Perp error: ${data.perp_error}`);
        }
        return;
      }
    }
    const positions = listOpenPositionsFromTrades(200);
    const cashBalance = getCashBalance();
    if (positions.length === 0) {
      console.log('No open positions.');
      console.log(`Cash Balance: $${cashBalance.toFixed(2)}`);
      return;
    }

    let totalValue = 0;
    let totalCost = 0;

    for (const position of positions) {
      const outcome = position.predictedOutcome ?? 'YES';
      const prices = position.currentPrices ?? null;
      let currentPrice: number | null = null;
      if (Array.isArray(prices)) {
        currentPrice = outcome === 'YES' ? prices[0] ?? null : prices[1] ?? null;
      } else if (prices) {
        currentPrice =
          prices[outcome] ??
          prices[outcome.toUpperCase()] ??
          prices[outcome.toLowerCase()] ??
          prices[outcome === 'YES' ? 'Yes' : 'No'] ??
          prices[outcome === 'YES' ? 'yes' : 'no'] ??
          null;
      }

      const averagePrice = position.executionPrice ?? currentPrice ?? 0;
      const positionSize = position.positionSize ?? 0;
      const netShares =
        typeof (position as { netShares?: number | null }).netShares === 'number'
          ? Number((position as { netShares?: number | null }).netShares)
          : null;
      const shares =
        netShares !== null ? netShares : averagePrice > 0 ? positionSize / averagePrice : 0;
      const price = currentPrice ?? averagePrice;
      const value = shares * price;
      const unrealizedPnl = value - positionSize;
      const unrealizedPnlPercent =
        positionSize > 0 ? (unrealizedPnl / positionSize) * 100 : 0;

      totalValue += value;
      totalCost += positionSize;

      console.log(`${position.marketTitle}`);
      console.log(
        `  Outcome: ${outcome} | Shares: ${shares.toFixed(2)} | Avg: ${averagePrice.toFixed(4)} | Now: ${price.toFixed(4)}`
      );
      console.log(
        `  Value: $${value.toFixed(2)} | PnL: ${unrealizedPnl >= 0 ? '+' : ''}$${unrealizedPnl.toFixed(2)} (${unrealizedPnlPercent.toFixed(1)}%)`
      );
      const realizedPnl =
        typeof (position as { realizedPnl?: number | null }).realizedPnl === 'number'
          ? Number((position as { realizedPnl?: number | null }).realizedPnl)
          : null;
      if (realizedPnl !== null) {
        console.log(`  Realized: ${realizedPnl >= 0 ? '+' : ''}$${realizedPnl.toFixed(2)}`);
      }
      console.log(`  Market ID: ${position.marketId}`);
      console.log('');
    }

    const totalPnl = totalValue - totalCost;
    const totalPnlPercent = totalCost > 0 ? (totalPnl / totalCost) * 100 : 0;
    const totalEquity = cashBalance + totalValue;

    console.log('Totals');
    console.log('─'.repeat(60));
    console.log(`Total Value: $${totalValue.toFixed(2)}`);
    console.log(`Total Cost: $${totalCost.toFixed(2)}`);
    console.log(`Total PnL: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)} (${totalPnlPercent.toFixed(1)}%)`);
    console.log(`Cash Balance: $${cashBalance.toFixed(2)}`);
    console.log(`Total Equity: $${totalEquity.toFixed(2)}`);
  });

// ============================================================================
// Calibration Commands
// ============================================================================

const calibration = program.command('calibration').description('Calibration stats');

calibration
  .command('show')
  .description('Show calibration statistics')
  .option('-d, --domain <domain>', 'Filter by domain')
  .action(async (options) => {
    console.log('Calibration Report');
    console.log('═'.repeat(60));
    const summaries = listCalibrationSummaries();
    for (const summary of summaries) {
      if (options.domain && summary.domain !== options.domain) {
        continue;
      }
      const accuracy =
        summary.accuracy === null ? '-' : `${(summary.accuracy * 100).toFixed(1)}%`;
      const brier =
        summary.avgBrier === null ? '-' : summary.avgBrier.toFixed(4);
      console.log(
        `${summary.domain} | total=${summary.totalPredictions} | resolved=${summary.resolvedPredictions} | acc=${accuracy} | brier=${brier}`
      );
    }
  });

// ============================================================================
// PnL Commands
// ============================================================================

program
  .command('pnl')
  .description('Show daily PnL rollup')
  .option('--date <YYYY-MM-DD>', 'Date to report (default: today)')
  .action(async (options) => {
    const { getDailyPnLRollup } = await import('../core/daily_pnl.js');
    const date = options.date ? String(options.date) : undefined;
    const rollup = getDailyPnLRollup(date);

    console.log(`PnL Rollup (${rollup.date})`);
    console.log('═'.repeat(60));
    console.log(`Realized: ${rollup.realizedPnl >= 0 ? '+' : ''}$${rollup.realizedPnl.toFixed(2)}`);
    console.log(`Unrealized: ${rollup.unrealizedPnl >= 0 ? '+' : ''}$${rollup.unrealizedPnl.toFixed(2)}`);
    console.log(`Total: ${rollup.totalPnl >= 0 ? '+' : ''}$${rollup.totalPnl.toFixed(2)}`);
    console.log('');

    if (rollup.byDomain.length > 0) {
      console.log('By Domain');
      console.log('─'.repeat(60));
      for (const row of rollup.byDomain) {
        console.log(
          `${row.domain} | realized ${row.realizedPnl >= 0 ? '+' : ''}$${row.realizedPnl.toFixed(2)} | ` +
            `unrealized ${row.unrealizedPnl >= 0 ? '+' : ''}$${row.unrealizedPnl.toFixed(2)} | ` +
            `total ${row.totalPnl >= 0 ? '+' : ''}$${row.totalPnl.toFixed(2)}`
        );
      }
    }
  });

// ============================================================================
// Evaluation Dashboard
// ============================================================================

program
  .command('eval')
  .description('Show evaluation dashboard (live-mode metrics)')
  .option('-w, --window <days>', 'Window length in days (omit for all-time)')
  .option('-d, --domain <domain>', 'Filter by domain')
  .option('--json', 'Output raw JSON')
  .action(async (options) => {
    const windowDays = options.window ? Number(options.window) : undefined;
    const summary = getEvaluationSummary({
      windowDays,
      domain: options.domain ? String(options.domain) : undefined,
    });

    if (options.json) {
      console.log(JSON.stringify(summary, null, 2));
      return;
    }

    const heading = windowDays ? `Evaluation Summary (last ${windowDays}d)` : 'Evaluation Summary (all-time)';
    const pct = (value: number | null): string => (value == null ? '-' : `${(value * 100).toFixed(1)}%`);
    const num = (value: number | null): string => (value == null ? '-' : value.toFixed(4));
    const usd = (value: number): string =>
      `${value >= 0 ? '+' : ''}$${value.toFixed(2)}`;

    console.log(heading);
    console.log('═'.repeat(72));
    console.log(`Decisions: ${summary.totals.predictions}`);
    console.log(`Executed: ${summary.totals.executedPredictions}`);
    console.log(`Resolved: ${summary.totals.resolvedPredictions}`);
    console.log(`Accuracy: ${pct(summary.totals.accuracy)} | Brier: ${num(summary.totals.avgBrier)}`);
    console.log(`Avg edge: ${pct(summary.totals.avgEdge)}`);
    console.log(
      `PnL: ${usd(summary.totals.realizedPnl)} realized | ${usd(summary.totals.unrealizedPnl)} unrealized | ${usd(summary.totals.totalPnl)} total`
    );

    if (summary.process) {
      console.log('');
      console.log('Process Metrics');
      console.log('─'.repeat(72));
      console.log(`Decisions: ${summary.process.decisions}`);
      console.log(
        `Critic: ${summary.process.criticApproved} approved | ${summary.process.criticRejected} rejected`
      );
      console.log(`Avg fragility: ${num(summary.process.avgFragility)}`);
      console.log(`Tool traces: ${summary.process.withToolTrace}`);
    }

    if (summary.byDomain.length > 0) {
      console.log('');
      console.log('By Domain');
      console.log('─'.repeat(72));
      console.log(
        'domain | pnl_total | pnl_realized | pnl_unrealized | accuracy | brier | avg_edge | resolved'
      );
      for (const row of summary.byDomain) {
        console.log(
          `${row.domain} | ${usd(row.totalPnl)} | ${usd(row.realizedPnl)} | ${usd(row.unrealizedPnl)} | ` +
            `${pct(row.accuracy)} | ${num(row.avgBrier)} | ${pct(row.avgEdge)} | ${row.resolvedPredictions}`
        );
      }
    }
  });

// ============================================================================
// Intel Commands
// ============================================================================

const intel = program.command('intel').description('Intelligence sources');

intel
  .command('status')
  .description('Show intel source status')
  .action(async () => {
    console.log('Intel Sources');
    console.log('─'.repeat(60));
    const entries = listIntelSources(config);
    for (const entry of entries) {
      const enabled = entry.enabled ? 'enabled' : 'disabled';
      const configured = entry.configured ? 'configured' : 'missing-keys';
      const roaming = isSourceAllowedForRoaming(config, entry) ? 'roam' : 'no-roam';
      console.log(
        `${entry.name}: ${enabled} (${configured}, ${entry.type}, trust=${entry.trust}, ${roaming})`
      );
    }
    const embed = config.intel?.embeddings?.enabled ? 'enabled' : 'disabled';
    console.log(`embeddings: ${embed}`);
  });

intel
  .command('search <query>')
  .description('Search intel')
  .option('-l, --limit <number>', 'Limit results', '10')
  .option('--from <days>', 'Days back to search', '7')
  .action(async (query, options) => {
    const { searchIntel } = await import('../intel/store.js');
    const items = searchIntel({
      query,
      limit: Number(options.limit),
      fromDays: Number(options.from),
    });
    if (items.length === 0) {
      console.log('No results.');
      return;
    }
    for (const item of items) {
      console.log(`${item.timestamp} | ${item.title}`);
    }
  });

intel
  .command('recent')
  .description('Show recent intel')
  .option('-l, --limit <number>', 'Limit results', '20')
  .action(async (options) => {
    console.log('Recent Intel');
    console.log('─'.repeat(60));
    const items = listRecentIntel(Number(options.limit));
    for (const item of items) {
      console.log(`${item.timestamp} | ${item.title}`);
    }
  });

intel
  .command('alerts')
  .description('Preview intel alerts with current config')
  .option('-l, --limit <number>', 'Limit items scanned', '50')
  .option('--show-score', 'Show alert scores')
  .option('--show-reasons', 'Show alert reasons')
  .option('--min-score <number>', 'Minimum score threshold')
  .option('--sentiment <preset>', 'Sentiment preset: any|positive|negative|neutral')
  .action(async (options) => {
    const alertsConfig = config.notifications?.intelAlerts;
    if (!alertsConfig?.enabled) {
      console.log('Intel alerts are disabled in config.');
      return;
    }

    const previewConfig = { ...alertsConfig };
    if (options.showScore) {
      previewConfig.showScore = true;
    }
    if (options.showReasons) {
      previewConfig.showReasons = true;
    }
    if (options.minScore !== undefined) {
      const minScore = Number(options.minScore);
      if (!Number.isNaN(minScore)) {
        previewConfig.minScore = minScore;
      }
    }
    if (options.sentiment) {
      previewConfig.sentimentPreset = String(options.sentiment) as 'any' | 'positive' | 'negative' | 'neutral';
    }

    const limit = Number(options.limit);
    const items = listRecentIntel(Number.isNaN(limit) ? 50 : limit);
    if (items.length === 0) {
      console.log('No intel items to preview.');
      return;
    }

    let watchlistTitles: string[] = [];
    if (alertsConfig.watchlistOnly) {
      const markets = createMarketClient(config);
      if (!markets.isAvailable()) {
        watchlistTitles = [];
      } else {
      const watchlist = listWatchlist(50);
      for (const item of watchlist) {
        try {
          const market = await markets.getMarket(item.marketId);
          if (market.question) {
            watchlistTitles.push(market.question);
          }
        } catch {
          continue;
        }
      }
      }
    }

    const alerts = rankIntelAlerts(
      items.map((item) => ({
        title: item.title,
        source: item.source,
        url: item.url,
        content: item.content,
      })),
      previewConfig,
      watchlistTitles
    ).map((item) => item.text);

    if (alerts.length === 0) {
      console.log('No alerts matched current config.');
      return;
    }
    console.log('Intel Alerts Preview');
    console.log('─'.repeat(60));
    for (const alert of alerts) {
      console.log(alert);
    }
  });

intel
  .command('fetch')
  .description('Fetch RSS intel now')
  .action(async () => {
    const stored = await runIntelPipeline(config);
    console.log(`Intel updated. New items stored: ${stored}.`);
  });

intel
  .command('proactive')
  .description('Run proactive search (Clawdbot-style)')
  .option('--send', 'Send a direct summary to configured channels')
  .option('--max-queries <number>', 'Max search queries', '8')
  .option('--iterations <number>', 'Research rounds', '2')
  .option('--watchlist-limit <number>', 'Watchlist markets to scan', '20')
  .option('--recent-intel-limit <number>', 'Recent intel items to seed queries', '25')
  .option('--web-limit <number>', 'Web search results per query', '5')
  .option('--fetch-per-query <number>', 'Pages to fetch per query', '1')
  .option('--fetch-max-chars <number>', 'Max chars to keep when fetching pages', '4000')
  .option('--learned-query-limit <number>', 'Number of learned queries to reuse', '8')
  .option('--no-learned-queries', 'Disable learned query reuse')
  .option('--no-llm', 'Disable LLM query refinement')
  .option('--extra <query...>', 'Extra queries to include')
  .action(async (options) => {
    const result = await runProactiveSearch(config, {
      maxQueries: Number(options.maxQueries),
      iterations: Number(options.iterations),
      watchlistLimit: Number(options.watchlistLimit),
      useLlm: options.llm !== false,
      recentIntelLimit: Number(options.recentIntelLimit),
      extraQueries: Array.isArray(options.extra) ? options.extra : [],
      includeLearnedQueries: options.learnedQueries !== false,
      learnedQueryLimit: Number(options.learnedQueryLimit),
      webLimitPerQuery: Number(options.webLimit),
      fetchPerQuery: Number(options.fetchPerQuery),
      fetchMaxChars: Number(options.fetchMaxChars),
    });
    console.log(`Rounds: ${result.rounds}`);
    if (result.learnedSeedQueries.length > 0) {
      console.log(`Learned seeds: ${result.learnedSeedQueries.join(' | ')}`);
    }
    console.log(`Queries: ${result.queries.join(' | ')}`);
    console.log(`Stored items: ${result.storedCount}`);
    if (options.send) {
      const summary = formatProactiveSummary(result);
      const channels = config.notifications?.proactiveSearch?.channels ?? [];
      if (channels.includes('telegram')) {
        const { TelegramAdapter } = await import('../interface/telegram.js');
        const telegram = new TelegramAdapter(config);
        for (const chatId of config.channels.telegram.allowedChatIds ?? []) {
          await telegram.sendMessage(String(chatId), summary);
        }
      }
      if (channels.includes('whatsapp')) {
        const { WhatsAppAdapter } = await import('../interface/whatsapp.js');
        const whatsapp = new WhatsAppAdapter(config);
        for (const number of config.channels.whatsapp.allowedNumbers ?? []) {
          await whatsapp.sendMessage(number, summary);
        }
      }
    }
  });

intel
  .command('proactive-stats')
  .description('Show learned proactive query performance stats')
  .option('--limit <number>', 'Max rows', '20')
  .action((options) => {
    const stats = listProactiveQueryStats(Number(options.limit));
    if (stats.length === 0) {
      console.log('No proactive query stats yet.');
      return;
    }

    for (const row of stats) {
      console.log(
        `${row.query} | score=${row.score.toFixed(2)} runs=${row.runs} success=${row.successes} new_items=${row.totalNewItems} web=${row.totalWebResults} fetch=${row.totalWebFetches}`
      );
      if (row.lastError) {
        console.log(`  last_error: ${row.lastError}`);
      }
    }
  });

// ============================================================================
// Agent Commands
// ============================================================================

program
  .command('chat')
  .description('Interactive chat with Thufir')
  .action(async () => {
    const { createLlmClient, createTrivialTaskClient } = await import('../core/llm.js');
    const { ConversationHandler } = await import('../core/conversation.js');
    const readline = await import('node:readline');

    console.log('Starting Thufir chat...');
    console.log('Ask me about markets, positioning, or anything you want to analyze.');
    console.log('Type "exit" or "quit" to end the conversation.\n');

    const llm = createLlmClient(config);
    const marketClient = createMarketClient(config);
    const infoLlm = createTrivialTaskClient(config) ?? undefined;
    const conversation = new ConversationHandler(llm, marketClient, config, infoLlm);
    const userId = 'cli-user';

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const prompt = () => {
      rl.question('\nYou: ', async (input) => {
        const trimmed = input.trim();
        if (!trimmed) {
          prompt();
          return;
        }
        if (trimmed.toLowerCase() === 'exit' || trimmed.toLowerCase() === 'quit') {
          console.log('\nGoodbye!');
          rl.close();
          return;
        }
        if (trimmed === '/clear') {
          conversation.clearHistory(userId);
          console.log('\nThufir: Conversation cleared.');
          prompt();
          return;
        }

        try {
          console.log('\nThufir: Thinking...');
          const response = await conversation.chat(userId, trimmed);
          console.log(`\nThufir: ${response}`);
        } catch (error) {
          console.error('\nError:', error instanceof Error ? error.message : 'Unknown error');
        }
        prompt();
      });
    };

    prompt();
  });

const agent = program.command('agent').description('Agentic orchestrator commands');

agent
  .command('run')
  .description('Run the agentic orchestrator on a goal')
  .argument('<goal...>', 'Goal or request for the agent')
  .option('--mode <mode>', 'Force mode: chat | trade | mentat')
  .option('--show-plan', 'Show plan trace')
  .option('--show-tools', 'Show tool trace')
  .option('--show-critic', 'Show critic notes')
  .option('--show-fragility', 'Show fragility analysis')
  .option('--mentat-report', 'Append a mentat report')
  .option('--resume', 'Resume the last saved plan')
  .option('--user <id>', 'User/session id for plan persistence', 'cli-user')
  .option('--password <password>', 'Wallet password for live trading (optional)')
  .action(async (goalParts, options) => {
    const goal = Array.isArray(goalParts) ? goalParts.join(' ') : String(goalParts ?? '').trim();
    if (!goal) {
      console.error('Goal is required.');
      return;
    }
    if (options.mode && !['chat', 'trade', 'mentat'].includes(options.mode)) {
      console.error('Invalid mode. Use: chat | trade | mentat');
      return;
    }

    const { createLlmClient } = await import('../core/llm.js');
    const { SessionStore } = await import('../memory/session_store.js');

    const llm = createLlmClient(config);
    const marketClient = createMarketClient(config);
    const executor = await createExecutorForConfig(config, options.password);
    const limiter = new DbSpendingLimitEnforcer({
      daily: config.wallet?.limits?.daily ?? 100,
      perTrade: config.wallet?.limits?.perTrade ?? 25,
      confirmationThreshold: config.wallet?.limits?.confirmationThreshold ?? 10,
    });

    const toolContext = {
      config,
      marketClient,
      executor,
      limiter,
    };

    const registry = new AgentToolRegistry();
    registerAllTools(registry);
    const identity = loadThufirIdentity({
      workspacePath: config.agent?.workspace,
    }).identity;

    const sessions = new SessionStore(config);
    const priorPlan = options.resume ? sessions.getPlan(options.user) : null;

    const result = await withExecutionContext(
      { mode: 'FULL_AGENT', critical: false, reason: 'agent_run', source: 'cli' },
      () =>
        runOrchestrator(
          goal,
          {
            llm,
            toolRegistry: registry,
            identity,
            toolContext,
          },
          {
            forceMode: options.mode,
            initialPlan: priorPlan ?? undefined,
            resumePlan: Boolean(options.resume),
          }
        )
    );

    if (result.state.plan && !result.state.plan.complete) {
      sessions.setPlan(options.user, result.state.plan);
    } else {
      sessions.clearPlan(options.user);
    }

    const showPlan = options.showPlan ?? config.agent?.showPlanTrace ?? false;
    const showTools = options.showTools ?? config.agent?.showToolTrace ?? false;
    const showCritic = options.showCritic ?? config.agent?.showCriticNotes ?? false;
    const showFragility =
      options.showFragility ??
      (config.agent?.showFragilityTrace ?? false) ??
      false;

    let output = attachOrchestratorNotes(result.response, {
      showPlan,
      showTools,
      showCritic,
      showFragility,
      toolExecutions: result.state.toolExecutions,
      criticResult: result.state.criticResult,
      plan: result.state.plan,
      fragility: result.summary.fragility,
    });

    const shouldAppendMentat =
      options.mentatReport ??
      config.agent?.mentatAutoScan ??
      result.state.mode === 'mentat';

    if (shouldAppendMentat) {
      try {
        const { runMentatScan } = await import('../mentat/scan.js');
        const { generateMentatReport, formatMentatReport } = await import('../mentat/report.js');
        const scan = await withExecutionContext(
          { mode: 'FULL_AGENT', critical: false, reason: 'mentat_report', source: 'cli' },
          () =>
            runMentatScan({
              system: config.agent?.mentatSystem ?? 'Markets',
              llm,
              config,
              marketClient,
              marketQuery: config.agent?.mentatMarketQuery,
              limit: config.agent?.mentatMarketLimit,
              intelLimit: config.agent?.mentatIntelLimit,
            })
        );
        const report = generateMentatReport({
          system: scan.system,
          detectors: scan.detectors,
        });
        output = `${output}\n\n---\n\n${formatMentatReport(report)}`;
      } catch (error) {
        console.error('Mentat report failed:', error instanceof Error ? error.message : 'Unknown error');
      }
    }

    console.log(output);
  });

program
  .command('analyze <market>')
  .description('Deep analysis of a market')
  .option('--json', 'Return structured JSON')
  .action(async (market, options) => {
    const { createLlmClient, createTrivialTaskClient } = await import('../core/llm.js');
    const { ConversationHandler } = await import('../core/conversation.js');
    const ora = await import('ora');

    console.log(`Analyzing market: ${market}`);
    console.log('─'.repeat(60));

    const spinner = ora.default('Fetching market data and analyzing...').start();

    try {
      const llm = createLlmClient(config);
      const markets = createMarketClient(config);
      if (!markets.isAvailable()) {
        throw new Error('Market client is not configured.');
      }
      const infoLlm = createTrivialTaskClient(config) ?? undefined;
      const conversation = new ConversationHandler(llm, markets, config, infoLlm);

      const analysis = options.json
        ? await conversation.analyzeMarketStructured('cli-user', market)
        : await conversation.analyzeMarket('cli-user', market);
      spinner.stop();
      console.log(typeof analysis === 'string' ? analysis : JSON.stringify(analysis, null, 2));
    } catch (error) {
      spinner.stop();
      console.error('Analysis failed:', error instanceof Error ? error.message : 'Unknown error');
    }
  });

program
  .command('briefing')
  .description('Generate daily briefing')
  .action(async () => {
    console.log('Daily Briefing');
    console.log('═'.repeat(60));
    const { buildBriefing } = await import('../core/briefing.js');
    console.log(buildBriefing(10));
  });

const mentat = program.command('mentat').description('Mentat fragility analysis');

mentat
  .command('scan')
  .description('Run mentat fragility scan')
  .option('--system <name>', 'System/domain name', 'global_markets')
  .option('--market <id...>', 'Specific market IDs to scan')
  .option('--query <query>', 'Search query for markets')
  .option('--limit <number>', 'Maximum markets to scan', '25')
  .option('--intel-limit <number>', 'Recent intel items to include', '40')
  .option('--no-store', 'Do not store results')
  .action(async (options) => {
    const { createLlmClient } = await import('../core/llm.js');
    const { runMentatScan, formatMentatScan } = await import('../mentat/scan.js');
    const ora = await import('ora');

    const spinner = ora.default('Running mentat scan...').start();

    try {
      const llm = createLlmClient(config);
      const markets = createMarketClient(config);

      const scan = await runMentatScan({
        system: String(options.system),
        llm,
        config,
        marketClient: markets,
        marketIds: Array.isArray(options.market) ? options.market : undefined,
        marketQuery: options.query ? String(options.query) : undefined,
        limit: Number(options.limit),
        intelLimit: Number(options.intelLimit),
        store: options.store !== false,
      });

      spinner.stop();
      console.log(formatMentatScan(scan));
    } catch (error) {
      spinner.stop();
      console.error('Mentat scan failed:', error instanceof Error ? error.message : 'Unknown error');
    }
  });

mentat
  .command('report')
  .description('Generate mentat report')
  .option('--system <name>', 'System/domain name', 'global_markets')
  .option('--limit <number>', 'Max items per section', '10')
  .option('--refresh', 'Recompute detector scores from current signals')
  .option('--market <id...>', 'Specific market IDs to use for refresh')
  .option('--query <query>', 'Search query for markets')
  .option('--intel-limit <number>', 'Recent intel items to include', '40')
  .action(async (options) => {
    const { collectMentatSignals } = await import('../mentat/scan.js');
    const { computeDetectorBundle } = await import('../mentat/detectors.js');
    const { generateMentatReport, formatMentatReport } = await import('../mentat/report.js');
    const ora = await import('ora');

    const spinner = ora.default('Generating mentat report...').start();

    try {
      let detectors: ReturnType<typeof computeDetectorBundle> | undefined;
      if (options.refresh) {
        const markets = createMarketClient(config);
        const signals = await collectMentatSignals({
          system: String(options.system),
          marketClient: markets,
          marketIds: Array.isArray(options.market) ? options.market : undefined,
          marketQuery: options.query ? String(options.query) : undefined,
          limit: Number(options.limit),
          intelLimit: Number(options.intelLimit),
        });
        detectors = computeDetectorBundle(signals);
      }

      const report = generateMentatReport({
        system: String(options.system),
        limit: Number(options.limit),
        detectors,
      });

      spinner.stop();
      console.log(formatMentatReport(report));
    } catch (error) {
      spinner.stop();
      console.error('Mentat report failed:', error instanceof Error ? error.message : 'Unknown error');
    }
  });

program
  .command('ask <topic...>')
  .description('Ask about a topic and find relevant markets')
  .action(async (topicParts) => {
    const { createLlmClient, createTrivialTaskClient } = await import('../core/llm.js');
    const { ConversationHandler } = await import('../core/conversation.js');
    const ora = await import('ora');

    const topic = topicParts.join(' ');
    console.log(`Researching: ${topic}`);
    console.log('─'.repeat(60));

    const spinner = ora.default('Searching markets and analyzing...').start();

    try {
      const llm = createLlmClient(config);
      const markets = createMarketClient(config);
      const infoLlm = createTrivialTaskClient(config) ?? undefined;
      const conversation = new ConversationHandler(llm, markets, config, infoLlm);

      const response = await conversation.askAbout('cli-user', topic);
      spinner.stop();
      console.log(response);
    } catch (error) {
      spinner.stop();
      console.error('Failed:', error instanceof Error ? error.message : 'Unknown error');
    }
  });

// ============================================================================
// Autonomous Mode Commands
// ============================================================================

program
  .command('top10')
  .alias('opportunities')
  .description('Get today\'s top 10 trading opportunities')
  .action(async () => {
    const { createLlmClient } = await import('../core/llm.js');
    const { generateDailyReport, formatDailyReport } = await import('../core/opportunities.js');
    const ora = await import('ora');

    const spinner = ora.default('Scanning markets and analyzing opportunities...').start();

    try {
      const llm = createLlmClient(config);
      const markets = createMarketClient(config);

      const report = await generateDailyReport(llm, markets, config);
      spinner.stop();
      console.log(formatDailyReport(report));
    } catch (error) {
      spinner.stop();
      console.error('Failed:', error instanceof Error ? error.message : 'Unknown error');
    }
  });

const auto = program.command('auto').description('Autonomous trading controls');

auto
  .command('status')
  .description('Show autonomous mode status')
  .action(async () => {
    const { createLlmClient } = await import('../core/llm.js');
    const { PaperExecutor } = await import('../execution/modes/paper.js');
    const { DbSpendingLimitEnforcer } = await import('../execution/wallet/limits_db.js');
    const { AutonomousManager } = await import('../core/autonomous.js');

    const llm = createLlmClient(config);
    const markets = createMarketClient(config);
    const executor = new PaperExecutor();
    const limiter = new DbSpendingLimitEnforcer({
      daily: config.wallet?.limits?.daily ?? 100,
      perTrade: config.wallet?.limits?.perTrade ?? 25,
      confirmationThreshold: config.wallet?.limits?.confirmationThreshold ?? 10,
    });

    const autonomous = new AutonomousManager(llm, markets, executor, limiter, config);
    const status = autonomous.getStatus();
    const pnl = autonomous.getDailyPnL();

    console.log('Autonomous Mode Status');
    console.log('═'.repeat(40));
    console.log(`Enabled: ${status.enabled ? 'YES' : 'NO'}`);
    console.log(`Full Auto: ${status.fullAuto ? 'ON' : 'OFF'}`);
    console.log(`Paused: ${status.isPaused ? `YES (${status.pauseReason})` : 'NO'}`);
    console.log(`Consecutive losses: ${status.consecutiveLosses}`);
    console.log(`Remaining daily budget: $${status.remainingDaily.toFixed(2)}`);
    console.log('');
    console.log('Today\'s Activity');
    console.log('─'.repeat(40));
    console.log(`Trades: ${pnl.tradesExecuted} (W:${pnl.wins} L:${pnl.losses} P:${pnl.pending})`);
    console.log(`Realized P&L: ${pnl.realizedPnl >= 0 ? '+' : ''}$${pnl.realizedPnl.toFixed(2)}`);
  });

auto
  .command('on')
  .description('Enable full autonomous mode')
  .action(async () => {
    console.log('To enable full auto mode, set autonomy.fullAuto: true in your config.');
    console.log('Or use the /fullauto on command when running the gateway.');
    console.log('');
    console.log('Config path: ~/.thufir/config.yaml');
  });

auto
  .command('off')
  .description('Disable full autonomous mode')
  .action(async () => {
    console.log('To disable full auto mode, set autonomy.fullAuto: false in your config.');
    console.log('Or use the /fullauto off command when running the gateway.');
  });

auto
  .command('report')
  .description('Generate full daily report')
  .action(async () => {
    const { createLlmClient } = await import('../core/llm.js');
    const { PaperExecutor } = await import('../execution/modes/paper.js');
    const { DbSpendingLimitEnforcer } = await import('../execution/wallet/limits_db.js');
    const { AutonomousManager } = await import('../core/autonomous.js');
    const ora = await import('ora');

    const spinner = ora.default('Generating daily report...').start();

    try {
      const llm = createLlmClient(config);
      const markets = createMarketClient(config);
      const executor = new PaperExecutor();
      const limiter = new DbSpendingLimitEnforcer({
        daily: config.wallet?.limits?.daily ?? 100,
        perTrade: config.wallet?.limits?.perTrade ?? 25,
        confirmationThreshold: config.wallet?.limits?.confirmationThreshold ?? 10,
      });

      const autonomous = new AutonomousManager(llm, markets, executor, limiter, config);
      const report = await autonomous.generateDailyPnLReport();
      spinner.stop();
      console.log(report);
    } catch (error) {
      spinner.stop();
      console.error('Failed:', error instanceof Error ? error.message : 'Unknown error');
    }
  });

// ============================================================================
// User Commands
// ============================================================================

const user = program.command('user').description('User profile memory');

user
  .command('show <id>')
  .description('Show user profile')
  .action(async (id) => {
    const profile = getUserContext(id);
    if (!profile) {
      console.log('No profile found.');
      return;
    }
    console.log(JSON.stringify(profile, null, 2));
  });

user
  .command('set <id>')
  .description('Update user profile')
  .option('--domains <list>', 'Comma-separated domains')
  .option('--risk <level>', 'conservative|moderate|aggressive')
  .option('--pref <key=value>', 'Preference key=value', (value, prev) => {
    const list = Array.isArray(prev) ? prev : [];
    return [...list, value];
  })
  .action(async (id, options) => {
    const prefs: Record<string, string> = {};
    for (const entry of options.pref ?? []) {
      const [key, value] = String(entry).split('=');
      if (key && value !== undefined) {
        prefs[key] = value;
      }
    }
    updateUserContext(id, {
      domainsOfInterest: options.domains
        ? String(options.domains)
            .split(',')
            .map((item) => item.trim())
        : undefined,
      riskTolerance: options.risk,
      preferences: Object.keys(prefs).length > 0 ? prefs : undefined,
    });
    console.log('Profile updated.');
  });

// ============================================================================
// Gateway Commands
// ============================================================================

program
  .command('gateway')
  .description('Start the Thufir gateway')
  .option('-p, --port <port>', 'Port to listen on', '18789')
  .option('-v, --verbose', 'Verbose logging')
  .option('--openclaw', 'Start the OpenClaw gateway (vendor/openclaw)')
  .action(async (options) => {
    const { spawn } = await import('node:child_process');
    const { existsSync } = await import('node:fs');
    const { resolve } = await import('node:path');

    if (options.openclaw) {
      const openclawRoot = resolve(process.cwd(), 'vendor', 'openclaw');
      const openclawPkg = resolve(openclawRoot, 'package.json');
      const openclawNodeModules = resolve(openclawRoot, 'node_modules');
      if (!existsSync(openclawPkg)) {
        console.error('OpenClaw repo not found at vendor/openclaw.');
        console.error('Run: git clone https://github.com/openclaw/openclaw vendor/openclaw');
        process.exit(1);
      }
      if (!existsSync(openclawNodeModules)) {
        console.error('OpenClaw dependencies are not installed.');
        console.error('Run: pnpm --dir vendor/openclaw install');
        process.exit(1);
      }
      if (options.port) {
        process.env.OPENCLAW_GATEWAY_PORT = String(options.port);
      }
      if (options.verbose) {
        process.env.OPENCLAW_LOG_LEVEL = 'debug';
      }
      const child = spawn(process.execPath, ['scripts/run-node.mjs', 'gateway'], {
        stdio: 'inherit',
        env: { ...process.env },
        cwd: openclawRoot,
      });
      child.on('exit', (code) => {
        process.exit(code ?? 0);
      });
      return;
    }

    if (options.port) {
      process.env.THUFIR_GATEWAY_PORT = String(options.port);
    }
    if (options.verbose) {
      process.env.THUFIR_LOG_LEVEL = 'debug';
    }

    const args = ['src/gateway/index.ts'];
    const child = spawn('tsx', args, {
      stdio: 'inherit',
      env: { ...process.env },
    });

    child.on('exit', (code) => {
      process.exit(code ?? 0);
    });
  });

// ============================================================================
// Memory Commands
// ============================================================================

const memory = program.command('memory').description('Persistent chat memory');

memory
  .command('sessions')
  .description('List known sessions')
  .action(async () => {
    const store = new SessionStore(config);
    const sessions = store.listSessions();
    if (sessions.length === 0) {
      console.log('No sessions found.');
      return;
    }
    console.log('Sessions');
    console.log('─'.repeat(60));
    for (const session of sessions) {
      console.log(`${session.userId} | ${session.sessionId} | last: ${session.lastActive}`);
    }
  });

memory
  .command('show <userId>')
  .description('Show transcript entries for a user')
  .option('-l, --limit <number>', 'Limit entries', '50')
  .action(async (userId, options) => {
    const store = new SessionStore(config);
    const entries = store.listEntries(userId);
    const limit = Number(options.limit);
    const slice = entries.slice(-Math.max(1, limit));
    if (slice.length === 0) {
      console.log('No transcript entries.');
      return;
    }
    for (const entry of slice) {
      const label =
        entry.type === 'summary' ? 'summary' : entry.role ?? 'message';
      console.log(`[${entry.timestamp}] ${label}: ${entry.content}`);
    }
  });

memory
  .command('compact <userId>')
  .description('Force compaction for a user session')
  .action(async (userId) => {
    const { createLlmClient } = await import('../core/llm.js');
    const llm = createLlmClient(config);
    const store = new SessionStore(config);
    await store.compactIfNeeded({
      userId,
      llm,
      maxMessages: config.memory?.maxHistoryMessages ?? 50,
      compactAfterTokens: 1,
      keepRecent: config.memory?.keepRecentMessages ?? 12,
    });
    console.log('Compaction complete.');
  });

memory
  .command('prune')
  .description('Prune old chat messages')
  .option('-d, --days <number>', 'Retention days', '90')
  .action(async (options) => {
    const days = Number(options.days);
    if (Number.isNaN(days) || days <= 0) {
      console.log('Days must be a positive number.');
      return;
    }
    const pruned = pruneChatMessages(days);
    console.log(`Pruned ${pruned} chat message(s).`);
  });

// ============================================================================
// Technical Analysis Commands
// ============================================================================

program
  .command('ta <symbol>')
  .description('Show technical snapshot for a symbol (e.g., BTC/USDT)')
  .option('-t, --timeframe <tf>', 'Timeframe (1m|5m|15m|1h|4h|1d)')
  .option('-l, --limit <number>', 'Candle limit (default: 120)', '120')
  .action(async (symbol, options) => {
    const { getTechnicalSnapshot } = await import('../technical/snapshot.js');
    const timeframe =
      (options.timeframe as string | undefined) ??
      config.technical?.timeframes?.[0] ??
      '1h';

    const snapshot = await getTechnicalSnapshot({
      config,
      symbol,
      timeframe: timeframe as Timeframe,
      limit: Number(options.limit) || 120,
    });

    console.log(`\nTechnical Snapshot: ${snapshot.symbol} (${snapshot.timeframe})`);
    console.log(`Price: ${snapshot.price}`);
    console.log(`Bias: ${snapshot.overallBias} (confidence ${snapshot.confidence.toFixed(2)})`);
    console.log('Indicators:');
    for (const indicator of snapshot.indicators) {
      const value = Array.isArray(indicator.value)
        ? indicator.value.map((v) => Number(v).toFixed(4)).join(', ')
        : Number(indicator.value).toFixed(4);
      console.log(`- ${indicator.name}: ${indicator.signal} (${value})`);
    }
  });

program
  .command('signals')
  .description('Generate technical + news signals for configured symbols')
  .option('-s, --symbol <symbol>', 'Symbol override (e.g., BTC/USDT)')
  .option('-t, --timeframe <tf>', 'Timeframe override')
  .action(async (options) => {
    const { getTechnicalSnapshot } = await import('../technical/snapshot.js');
    const { buildTradeSignal } = await import('../technical/signals.js');

    const symbols = options.symbol
      ? [String(options.symbol)]
      : config.technical?.symbols ?? ['BTC/USDT'];
    const timeframes = (options.timeframe
      ? [String(options.timeframe)]
      : config.technical?.timeframes ?? ['1h']) as Timeframe[];

    for (const symbol of symbols) {
      for (const timeframe of timeframes) {
        const snapshot = await getTechnicalSnapshot({
          config,
          symbol,
          timeframe,
          limit: 120,
        });
        const signal = await buildTradeSignal({
          config,
          snapshot,
          timeframe: snapshot.timeframe,
        });

        console.log(`\nSignal: ${signal.symbol} (${signal.timeframe})`);
        console.log(`Direction: ${signal.direction} (confidence ${signal.confidence.toFixed(2)})`);
        console.log(`Scores: technical=${signal.technicalScore.toFixed(2)} news=${signal.newsScore.toFixed(2)} onchain=${signal.onChainScore.toFixed(2)}`);
        console.log(`Entry: ${signal.entryPrice.toFixed(2)} Stop: ${signal.stopLoss.toFixed(2)} TP: ${signal.takeProfit.map((v) => v.toFixed(2)).join(', ')}`);
      }
    }
  });

program
  .command('strategy <name>')
  .description('Run a named strategy against current signals')
  .option('-s, --symbol <symbol>', 'Symbol override (e.g., BTC/USDT)')
  .option('-t, --timeframe <tf>', 'Timeframe override')
  .action(async (name, options) => {
    const { getTechnicalSnapshot } = await import('../technical/snapshot.js');
    const { buildTradeSignal } = await import('../technical/signals.js');
    const { getStrategy } = await import('../technical/strategies.js');

    const strategy = getStrategy(String(name));
    if (!strategy) {
      console.log('Unknown strategy. Available: trend_following, mean_reversion, news_catalyst');
      process.exitCode = 1;
      return;
    }

    const symbols = options.symbol
      ? [String(options.symbol)]
      : config.technical?.symbols ?? ['BTC/USDT'];
    const timeframes = (options.timeframe
      ? [String(options.timeframe)]
      : strategy.timeframes) as Timeframe[];

    for (const symbol of symbols) {
      for (const timeframe of timeframes) {
        const snapshot = await getTechnicalSnapshot({
          config,
          symbol,
          timeframe,
          limit: 120,
        });
        const signal = await buildTradeSignal({
          config,
          snapshot,
          timeframe: snapshot.timeframe,
        });

        const shouldEnter = strategy.shouldEnter(signal);
        console.log(`\n${strategy.name} ${symbol} (${timeframe}) => ${shouldEnter ? 'ENTER' : 'SKIP'}`);
        console.log(`Direction: ${signal.direction} confidence ${signal.confidence.toFixed(2)}`);
        console.log(`Scores: technical=${signal.technicalScore.toFixed(2)} news=${signal.newsScore.toFixed(2)} onchain=${signal.onChainScore.toFixed(2)}`);
      }
    }
  });

// ============================================================================
// Debug Commands
// ============================================================================

const debug = program.command('debug').description('Debug utilities');

debug
  .command('whoami')
  .description('Verify identity invariance')
  .action(async () => {
    const { createLlmClient } = await import('../core/llm.js');
    const llm = createLlmClient(config);
    const response = await llm.complete(
      [{ role: 'user', content: 'Who are you? Reply with only your name.' }],
      { temperature: 0 }
    );
    const name = response.content.trim();
    if (name === 'Thufir Hawat') {
      console.log('PASS: Thufir Hawat');
      return;
    }
    console.log(`FAIL: ${name}`);
    process.exitCode = 1;
  });

// ============================================================================
// Parse and Run
// ============================================================================

program.parse();

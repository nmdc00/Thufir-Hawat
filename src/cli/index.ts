#!/usr/bin/env node
import 'dotenv/config';
/**
 * Thufir CLI
 *
 * Command-line interface for Thufir prediction market companion.
 */

import { Command } from 'commander';
import { VERSION } from '../index.js';
import { loadConfig } from '../core/config.js';
import {
  createPrediction,
  getPrediction,
  listPredictions,
} from '../memory/predictions.js';
import { PolymarketMarketClient } from '../execution/polymarket/markets.js';
import { addWatchlist, listWatchlist } from '../memory/watchlist.js';
import { runIntelPipeline } from '../intel/pipeline.js';
import { listRecentIntel } from '../intel/store.js';
import { rankIntelAlerts } from '../intel/alerts.js';
import { listIntelSources, isSourceAllowedForRoaming } from '../intel/sources_registry.js';
import { formatProactiveSummary, runProactiveSearch } from '../core/proactive_search.js';
import {
  listCalibrationSummaries,
  listResolvedPredictions,
} from '../memory/calibration.js';
import { listOpenPositions } from '../memory/predictions.js';
import { listOpenPositionsFromTrades } from '../memory/trades.js';
import { adjustCashBalance, getCashBalance, setCashBalance } from '../memory/portfolio.js';
import { resolveOutcomes } from '../core/resolver.js';
import { getUserContext, updateUserContext } from '../memory/user.js';
import { encryptPrivateKey, saveKeystore } from '../execution/wallet/keystore.js';
import { loadWallet } from '../execution/wallet/manager.js';
import { DbSpendingLimitEnforcer } from '../execution/wallet/limits_db.js';
import { ethers } from 'ethers';
import inquirer from 'inquirer';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import yaml from 'yaml';
import { openDatabase } from '../memory/db.js';
import { pruneChatMessages } from '../memory/chat.js';
import { SessionStore } from '../memory/session_store.js';
import { checkExposureLimits } from '../core/exposure.js';
import { explainPrediction } from '../core/explain.js';
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
 * For live mode, requires password (from env or passed in).
 */
async function createExecutorForConfig(
  config: ThufirConfig,
  password?: string
): Promise<ExecutionAdapter> {
  if (config.execution.mode === 'live') {
    const { LiveExecutor } = await import('../execution/modes/live.js');
    const pwd = password ?? process.env.THUFIR_WALLET_PASSWORD;
    if (!pwd) {
      throw new Error(
        'Live execution mode requires THUFIR_WALLET_PASSWORD environment variable or --password option'
      );
    }
    return new LiveExecutor({ config, password: pwd });
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
  'POLYMARKET_WS_URL',
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
        `https://serpapi.com/search.json?engine=google_news&q=polymarket&api_key=${env.SERPAPI_KEY}`
      )
    );
  } else {
    results.push({ name: 'SerpAPI', ok: false, detail: 'missing SERPAPI_KEY' });
  }

  if (env.TWITTER_BEARER) {
    await tryCheck('X/Twitter', () =>
      fetchWithTimeout(
        'https://api.twitter.com/2/tweets/search/recent?query=polymarket&max_results=10',
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

program
  .name('thufir')
  .description('Prediction Market AI Companion')
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
const marketClient = new PolymarketMarketClient(config);

markets
  .command('list')
  .description('List active markets')
  .option('-c, --category <category>', 'Filter by category')
  .option('-l, --limit <number>', 'Limit results', '20')
  .action(async (options) => {
    console.log('Active Markets');
    console.log('─'.repeat(60));
    const list = await marketClient.listMarkets(Number(options.limit));
    for (const market of list) {
      console.log(`${market.id} | ${market.question}`);
    }
  });

markets
  .command('show <id>')
  .description('Show market details')
  .action(async (id) => {
    console.log(`Market: ${id}`);
    console.log('─'.repeat(40));
    const market = await marketClient.getMarket(id);
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

markets
  .command('tokens <id>')
  .description('Fetch token IDs from CLOB API (needed for trading)')
  .action(async (id) => {
    const { PolymarketCLOBClient } = await import('../execution/polymarket/clob.js');
    const clobClient = new PolymarketCLOBClient(config);

    console.log(`Fetching token IDs for: ${id}`);
    console.log('─'.repeat(50));

    try {
      const market = await clobClient.getMarket(id);
      console.log(`Condition ID: ${market.condition_id}`);
      console.log(`Negative Risk: ${market.neg_risk ?? false}`);
      console.log(`\nTokens:`);
      if (market.tokens && market.tokens.length > 0) {
        for (const token of market.tokens) {
          const priceStr = token.price ? ` @ ${token.price}` : '';
          console.log(`  ${token.outcome}: ${token.token_id}${priceStr}`);
        }
      } else {
        console.log('  No tokens found');
      }

      // Also try order book for price info
      const firstToken = market.tokens?.[0];
      if (firstToken) {
        console.log(`\nOrder Book (first token):`);
        try {
          const book = await clobClient.getOrderBook(firstToken.token_id);
          const bestBid = book.bids[0];
          const bestAsk = book.asks[0];
          if (bestBid) console.log(`  Best Bid: ${bestBid.price} (${bestBid.size} shares)`);
          if (bestAsk) console.log(`  Best Ask: ${bestAsk.price} (${bestAsk.size} shares)`);
          if (!bestBid && !bestAsk) console.log('  Empty order book');
        } catch {
          console.log('  Could not fetch order book');
        }
      }
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      console.log('\nNote: The ID should be the condition_id from Polymarket.');
      console.log('You can find this in the market URL or by using `thufir markets search`.');
    }
  });

markets
  .command('clob-status')
  .description('Test CLOB API connectivity')
  .action(async () => {
    const { PolymarketCLOBClient } = await import('../execution/polymarket/clob.js');
    const clobClient = new PolymarketCLOBClient(config);

    console.log('Testing CLOB API connectivity...');
    console.log('─'.repeat(40));
    console.log(`CLOB URL: ${config.polymarket.api.clob}`);

    try {
      const result = await clobClient.listMarkets();
      console.log(`✓ Connected - ${result.data.length} markets returned`);

      const sample = result.data[0];
      if (sample) {
        console.log(`\nSample market:`);
        console.log(`  Condition ID: ${sample.condition_id}`);
        console.log(`  Tokens: ${sample.tokens?.length ?? 0}`);
        console.log(`  Neg Risk: ${sample.neg_risk ?? false}`);
      }
    } catch (error) {
      console.error(`✗ Connection failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  });

// ============================================================================
// Trade Commands
// ============================================================================

const trade = program.command('trade').description('Execute trades');

trade
  .command('buy <market> <outcome>')
  .description('Buy shares in a market')
  .requiredOption('-a, --amount <usd>', 'Amount in USD')
  .option('-p, --price <price>', 'Limit price (0-1)')
  .option('--dry-run', 'Simulate without executing')
  .action(async (market, outcome, options) => {
    const { DbSpendingLimitEnforcer } = await import('../execution/wallet/limits_db.js');

    const amount = Number(options.amount);
    if (Number.isNaN(amount) || amount <= 0) {
      console.log('Amount must be a positive number.');
      return;
    }
    const price = options.price ? Number(options.price) : undefined;
    if (price !== undefined && (Number.isNaN(price) || price <= 0 || price > 1)) {
      console.log('Price must be a number between 0 and 1.');
      return;
    }

    const normalizedOutcome = String(outcome).toUpperCase();
    if (!['YES', 'NO'].includes(normalizedOutcome)) {
      console.log('Outcome must be YES or NO.');
      return;
    }

    const marketClient = new PolymarketMarketClient(config);
    const executor = await createExecutorForConfig(config);
    const limiter = new DbSpendingLimitEnforcer({
      daily: config.wallet?.limits?.daily ?? 100,
      perTrade: config.wallet?.limits?.perTrade ?? 25,
      confirmationThreshold: config.wallet?.limits?.confirmationThreshold ?? 10,
    });

    try {
      const marketData = await marketClient.getMarket(market);
      if (price !== undefined) {
        marketData.prices = { ...marketData.prices, [normalizedOutcome]: price };
      }

      const exposureCheck = checkExposureLimits({
        config,
        market: marketData,
        outcome: normalizedOutcome as 'YES' | 'NO',
        amount,
        side: 'buy',
      });
      if (!exposureCheck.allowed) {
        console.log(`Trade blocked: ${exposureCheck.reason ?? 'exposure limit exceeded'}`);
        return;
      }

      const limitCheck = await limiter.checkAndReserve(amount);
      if (!limitCheck.allowed) {
        console.log(`Trade blocked: ${limitCheck.reason ?? 'limit exceeded'}`);
        return;
      }

      if (options.dryRun) {
        limiter.release(amount);
        console.log('Dry run: trade not executed.');
        return;
      }

      const result = await executor.execute(marketData, {
        action: 'buy',
        outcome: normalizedOutcome as 'YES' | 'NO',
        amount,
        confidence: 'medium',
        reasoning: 'Manual CLI trade',
      });

      if (result.executed) {
        limiter.confirm(amount);
      } else {
        limiter.release(amount);
      }
      console.log(result.message);
    } catch (error) {
      console.error('Trade failed:', error instanceof Error ? error.message : 'Unknown error');
    }
  });

trade
  .command('sell <market> <outcome>')
  .description('Sell shares in a market')
  .requiredOption('-a, --amount <usd>', 'Amount in USD')
  .option('-p, --price <price>', 'Limit price (0-1)')
  .option('--dry-run', 'Simulate without executing')
  .action(async (market, outcome, options) => {
    const { DbSpendingLimitEnforcer } = await import('../execution/wallet/limits_db.js');

    const amount = Number(options.amount);
    if (Number.isNaN(amount) || amount <= 0) {
      console.log('Amount must be a positive number.');
      return;
    }
    const price = options.price ? Number(options.price) : undefined;
    if (price !== undefined && (Number.isNaN(price) || price <= 0 || price > 1)) {
      console.log('Price must be a number between 0 and 1.');
      return;
    }

    const normalizedOutcome = String(outcome).toUpperCase();
    if (!['YES', 'NO'].includes(normalizedOutcome)) {
      console.log('Outcome must be YES or NO.');
      return;
    }

    const marketClient = new PolymarketMarketClient(config);
    const executor = await createExecutorForConfig(config);
    const limiter = new DbSpendingLimitEnforcer({
      daily: config.wallet?.limits?.daily ?? 100,
      perTrade: config.wallet?.limits?.perTrade ?? 25,
      confirmationThreshold: config.wallet?.limits?.confirmationThreshold ?? 10,
    });

    try {
      const marketData = await marketClient.getMarket(market);
      if (price !== undefined) {
        marketData.prices = { ...marketData.prices, [normalizedOutcome]: price };
      }

      const exposureCheck = checkExposureLimits({
        config,
        market: marketData,
        outcome: normalizedOutcome as 'YES' | 'NO',
        amount,
        side: 'sell',
      });
      if (!exposureCheck.allowed) {
        console.log(`Trade blocked: ${exposureCheck.reason ?? 'exposure limit exceeded'}`);
        return;
      }

      const limitCheck = await limiter.checkAndReserve(amount);
      if (!limitCheck.allowed) {
        console.log(`Trade blocked: ${limitCheck.reason ?? 'limit exceeded'}`);
        return;
      }

      if (options.dryRun) {
        limiter.release(amount);
        console.log('Dry run: trade not executed.');
        return;
      }

      const result = await executor.execute(marketData, {
        action: 'sell',
        outcome: normalizedOutcome as 'YES' | 'NO',
        amount,
        confidence: 'medium',
        reasoning: 'Manual CLI trade',
      });

      if (result.executed) {
        limiter.confirm(amount);
      } else {
        limiter.release(amount);
      }
      console.log(result.message);
    } catch (error) {
      console.error('Trade failed:', error instanceof Error ? error.message : 'Unknown error');
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
    const canUseClob =
      config.execution.mode === 'live' && Boolean(process.env.THUFIR_WALLET_PASSWORD);
    if (canUseClob) {
      const marketClient = new PolymarketMarketClient(config);
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
          positions?: Array<{
            market_question?: string;
            outcome?: string;
            shares?: number | null;
            avg_price?: number | null;
            current_price?: number | null;
            unrealized_pnl?: number | null;
          }>;
          summary?: {
            total_positions?: number;
            total_value?: number;
            total_cost?: number;
            unrealized_pnl?: number;
            positions_source?: string;
          };
        };
        const positions = data.positions ?? [];
        if (positions.length === 0) {
          console.log('No open positions.');
          return;
        }
        for (const position of positions) {
          const title = position.market_question ?? 'Unknown market';
          const shares = position.shares != null ? position.shares.toFixed(2) : 'n/a';
          const avg = position.avg_price != null ? position.avg_price.toFixed(3) : 'n/a';
          const current = position.current_price != null ? position.current_price.toFixed(3) : 'n/a';
          const pnl = position.unrealized_pnl != null ? position.unrealized_pnl.toFixed(2) : 'n/a';
          console.log(`- ${title} [${position.outcome ?? 'YES'}] shares=${shares} avg=${avg} current=${current} pnl=${pnl}`);
        }
        const summary = data.summary;
        if (summary) {
          const source = summary.positions_source ?? 'clob';
          console.log('─'.repeat(40));
          console.log(`Source: ${source}`);
          console.log(`Total Value: $${(summary.total_value ?? 0).toFixed(2)}`);
          console.log(`Total Cost: $${(summary.total_cost ?? 0).toFixed(2)}`);
          console.log(`Unrealized PnL: $${(summary.unrealized_pnl ?? 0).toFixed(2)}`);
        }
        return;
      }
    }
    const positions = (() => {
      const fromTrades = listOpenPositionsFromTrades(200);
      return fromTrades.length > 0 ? fromTrades : listOpenPositions(200);
    })();
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
// Prediction Commands
// ============================================================================

const predictions = program.command('predictions').description('Prediction tracking');

predictions
  .command('add')
  .description('Record a new prediction')
  .requiredOption('--market-id <id>', 'Market ID')
  .requiredOption('--title <title>', 'Market title')
  .option('--outcome <YES|NO>', 'Predicted outcome (YES/NO)')
  .option('--prob <number>', 'Predicted probability (0-1)')
  .option('--confidence <low|medium|high>', 'Confidence level')
  .option('--domain <domain>', 'Prediction domain/category')
  .option('--reasoning <text>', 'Short reasoning summary')
  .action(async (options) => {
    if (options.outcome && !['YES', 'NO'].includes(options.outcome)) {
      console.log('Outcome must be YES or NO.');
      return;
    }

    const probability = options.prob ? Number(options.prob) : undefined;
    if (probability !== undefined && (probability < 0 || probability > 1)) {
      console.log('Probability must be between 0 and 1.');
      return;
    }

    const id = createPrediction({
      marketId: options.marketId,
      marketTitle: options.title,
      predictedOutcome: options.outcome,
      predictedProbability: probability,
      confidenceLevel: options.confidence,
      domain: options.domain,
      reasoning: options.reasoning,
    });

    console.log(`Recorded prediction ${id}`);
  });

predictions
  .command('list')
  .description('List recent predictions')
  .option('-d, --domain <domain>', 'Filter by domain')
  .option('-l, --limit <number>', 'Limit results', '20')
  .action(async (options) => {
    const records = listPredictions({
      domain: options.domain,
      limit: Number(options.limit),
    });

    console.log('Recent Predictions');
    console.log('─'.repeat(80));
    for (const record of records) {
      const outcome = record.predictedOutcome ?? '-';
      const prob =
        record.predictedProbability !== undefined
          ? record.predictedProbability.toFixed(2)
          : '-';
      const domain = record.domain ?? '-';
      console.log(
        `${record.id} | ${outcome} | p=${prob} | ${domain} | ${record.marketTitle}`
      );
    }
  });

predictions
  .command('show <id>')
  .description('Show prediction details')
  .action(async (id) => {
    const record = getPrediction(id);
    if (!record) {
      console.log(`Prediction not found: ${id}`);
      return;
    }

    console.log(`Prediction: ${record.id}`);
    console.log('─'.repeat(60));
    console.log(`Market: ${record.marketTitle}`);
    console.log(`Outcome: ${record.predictedOutcome ?? '-'}`);
    console.log(
      `Probability: ${
        record.predictedProbability !== undefined
          ? record.predictedProbability.toFixed(2)
          : '-'
      }`
    );
    console.log(`Confidence: ${record.confidenceLevel ?? '-'}`);
    console.log(`Domain: ${record.domain ?? '-'}`);
    console.log(`Created: ${record.createdAt}`);
    if (record.reasoning) {
      console.log(`Reasoning: ${record.reasoning}`);
    }
  });

predictions
  .command('explain <id>')
  .description('Explain a prediction decision')
  .action(async (id) => {
    const explanation = await explainPrediction({ predictionId: id, config });
    console.log(explanation);
  });

predictions
  .command('resolve')
  .description('Resolve outcomes for recent predictions')
  .option('-l, --limit <number>', 'Limit predictions checked', '25')
  .action(async (options) => {
    const updated = await resolveOutcomes(config, Number(options.limit));
    console.log(`Resolved ${updated} prediction(s).`);
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
    console.log(`Predictions: ${summary.totals.predictions}`);
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

calibration
  .command('history')
  .description('Show prediction outcome history')
  .option('-d, --domain <domain>', 'Filter by domain')
  .option('-l, --limit <number>', 'Limit results', '20')
  .action(async (options) => {
    console.log('Prediction History');
    console.log('─'.repeat(60));
    const history = listResolvedPredictions(Number(options.limit));
    for (const item of history) {
      if (options.domain && item.domain !== options.domain) {
        continue;
      }
      const prob =
        item.predictedProbability === undefined
          ? '-'
          : item.predictedProbability.toFixed(2);
      const brier = item.brier === undefined ? '-' : item.brier.toFixed(4);
      console.log(
        `${item.outcomeTimestamp ?? ''} | ${item.marketTitle} | pred=${item.predictedOutcome ?? '-'} p=${prob} | outcome=${item.outcome ?? '-'} | brier=${brier}`
      );
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
      const markets = new PolymarketMarketClient(config);
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
  .option('--watchlist-limit <number>', 'Watchlist markets to scan', '20')
  .option('--recent-intel-limit <number>', 'Recent intel items to seed queries', '25')
  .option('--no-llm', 'Disable LLM query refinement')
  .option('--extra <query...>', 'Extra queries to include')
  .action(async (options) => {
    const result = await runProactiveSearch(config, {
      maxQueries: Number(options.maxQueries),
      watchlistLimit: Number(options.watchlistLimit),
      useLlm: options.llm !== false,
      recentIntelLimit: Number(options.recentIntelLimit),
      extraQueries: Array.isArray(options.extra) ? options.extra : [],
    });
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

// ============================================================================
// Agent Commands
// ============================================================================

program
  .command('chat')
  .description('Interactive chat with Thufir')
  .action(async () => {
    const { createLlmClient, createTrivialTaskClient } = await import('../core/llm.js');
    const { ConversationHandler } = await import('../core/conversation.js');
    const { PolymarketMarketClient } = await import('../execution/polymarket/markets.js');
    const readline = await import('node:readline');

    console.log('Starting Thufir chat...');
    console.log('Ask me about future events, prediction markets, or anything you want to forecast.');
    console.log('Type "exit" or "quit" to end the conversation.\n');

    const llm = createLlmClient(config);
    const marketClient = new PolymarketMarketClient(config);
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
    const { PolymarketMarketClient } = await import('../execution/polymarket/markets.js');
    const { SessionStore } = await import('../memory/session_store.js');

    const llm = createLlmClient(config);
    const marketClient = new PolymarketMarketClient(config);
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
              system: config.agent?.mentatSystem ?? 'Polymarket',
              llm,
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
    const { createLlmClient } = await import('../core/llm.js');
    const { ConversationHandler } = await import('../core/conversation.js');
    const { PolymarketMarketClient } = await import('../execution/polymarket/markets.js');
    const ora = await import('ora');

    console.log(`Analyzing market: ${market}`);
    console.log('─'.repeat(60));

    const spinner = ora.default('Fetching market data and analyzing...').start();

    try {
      const llm = createLlmClient(config);
      const markets = new PolymarketMarketClient(config);
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
    const { createLlmClient, createTrivialTaskClient } = await import('../core/llm.js');
    const { PolymarketMarketClient } = await import('../execution/polymarket/markets.js');
    const { runMentatScan, formatMentatScan } = await import('../mentat/scan.js');
    const ora = await import('ora');

    const spinner = ora.default('Running mentat scan...').start();

    try {
      const llm = createLlmClient(config);
      const markets = new PolymarketMarketClient(config);

      const scan = await runMentatScan({
        system: String(options.system),
        llm,
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
    const { PolymarketMarketClient } = await import('../execution/polymarket/markets.js');
    const { collectMentatSignals } = await import('../mentat/scan.js');
    const { computeDetectorBundle } = await import('../mentat/detectors.js');
    const { generateMentatReport, formatMentatReport } = await import('../mentat/report.js');
    const ora = await import('ora');

    const spinner = ora.default('Generating mentat report...').start();

    try {
      let detectors: ReturnType<typeof computeDetectorBundle> | undefined;
      if (options.refresh) {
        const markets = new PolymarketMarketClient(config);
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
    const { PolymarketMarketClient } = await import('../execution/polymarket/markets.js');
    const ora = await import('ora');

    const topic = topicParts.join(' ');
    console.log(`Researching: ${topic}`);
    console.log('─'.repeat(60));

    const spinner = ora.default('Searching markets and analyzing...').start();

    try {
      const llm = createLlmClient(config);
      const markets = new PolymarketMarketClient(config);
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
    const { PolymarketMarketClient } = await import('../execution/polymarket/markets.js');
    const { generateDailyReport, formatDailyReport } = await import('../core/opportunities.js');
    const ora = await import('ora');

    const spinner = ora.default('Scanning markets and analyzing opportunities...').start();

    try {
      const llm = createLlmClient(config);
      const markets = new PolymarketMarketClient(config);

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
    const { PolymarketMarketClient } = await import('../execution/polymarket/markets.js');
    const { PaperExecutor } = await import('../execution/modes/paper.js');
    const { DbSpendingLimitEnforcer } = await import('../execution/wallet/limits_db.js');
    const { AutonomousManager } = await import('../core/autonomous.js');

    const llm = createLlmClient(config);
    const markets = new PolymarketMarketClient(config);
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
    const { PolymarketMarketClient } = await import('../execution/polymarket/markets.js');
    const { PaperExecutor } = await import('../execution/modes/paper.js');
    const { DbSpendingLimitEnforcer } = await import('../execution/wallet/limits_db.js');
    const { AutonomousManager } = await import('../core/autonomous.js');
    const ora = await import('ora');

    const spinner = ora.default('Generating daily report...').start();

    try {
      const llm = createLlmClient(config);
      const markets = new PolymarketMarketClient(config);
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
// Parse and Run
// ============================================================================

program.parse();

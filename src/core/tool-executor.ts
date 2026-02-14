import type { ThufirConfig } from './config.js';
import type { Market } from '../execution/markets.js';
import type { MarketClient } from '../execution/market-client.js';
import type { ExecutionAdapter, TradeDecision } from '../execution/executor.js';
import type { LimitCheckResult } from '../execution/wallet/limits.js';
import { ethers } from 'ethers';
import { checkPerpRiskLimits } from '../execution/perp-risk.js';
import { listCalibrationSummaries } from '../memory/calibration.js';
import { listRecentIntel, searchIntel, type StoredIntel } from '../intel/store.js';
import { upsertAssumption, upsertFragilityCard, upsertMechanism } from '../memory/mentat.js';
import { HyperliquidClient } from '../execution/hyperliquid/client.js';
import { runDiscovery } from '../discovery/engine.js';
import {
  signalPriceVolRegime,
  signalHyperliquidFundingOISkew,
  signalHyperliquidOrderflowImbalance,
} from '../discovery/signals.js';
import { listPerpTrades } from '../memory/perp_trades.js';
import { recordPerpTrade } from '../memory/perp_trades.js';
import { recordPerpTradeJournal, listPerpTradeJournals } from '../memory/perp_trade_journal.js';
import type { ExpressionPlan } from '../discovery/types.js';
import { buildTradeEnvelopeFromExpression } from '../trade-management/envelope.js';
import { listOpenTradeEnvelopes, listRecentTradeCloses, recordTradeEnvelope, recordTradeSignals } from '../trade-management/db.js';
import { placeExchangeSideTpsl } from '../trade-management/hyperliquid-stops.js';
import { reconcileEntryFill } from '../trade-management/reconcile.js';
import { createHyperliquidCloid } from '../execution/hyperliquid/cloid.js';
import { buildTradeJournalSummary } from '../trade-management/summary.js';
import { listRecentAgentIncidents } from '../memory/incidents.js';
import { getPlaybook, searchPlaybooks, upsertPlaybook } from '../memory/playbooks.js';
import { getRpcUrl, getUsdcConfig, type EvmChain } from '../execution/evm/chains.js';
import { getErc20Balance, transferErc20 } from '../execution/evm/erc20.js';
import { cctpV1BridgeUsdc } from '../execution/evm/cctp_v1.js';

/** Minimal interface for spending limit enforcement used in tool execution */
export interface ToolSpendingLimiter {
  checkAndReserve(amount: number): Promise<LimitCheckResult>;
  confirm(amount: number): void;
  release(amount: number): void;
  getState?(): { todaySpent: number; reserved: number } & Record<string, unknown>;
}
import { getCashBalance } from '../memory/portfolio.js';
import { getWalletBalances } from '../execution/wallet/balances.js';
import { loadWallet } from '../execution/wallet/manager.js';
import { loadKeystore } from '../execution/wallet/keystore.js';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import { isIP } from 'node:net';
import { exec, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';

const execAsync = promisify(exec);

type InstallManager = 'npm' | 'pnpm' | 'bun';

interface SystemToolPolicy {
  enabled: boolean;
  allowedCommands: Set<string>;
  allowedManagers: Set<InstallManager>;
  allowGlobalInstall: boolean;
  timeoutMs: number;
  maxOutputChars: number;
}

export interface ToolExecutorContext {
  config: ThufirConfig;
  marketClient: MarketClient;
  executor?: ExecutionAdapter;
  limiter?: ToolSpendingLimiter;
}

export type ToolResult =
  | { success: true; data: unknown }
  | { success: false; error: string };

function getSystemToolPolicy(config: ThufirConfig): SystemToolPolicy {
  const settings = config.agent?.systemTools;
  const allowedCommands = Array.isArray(settings?.allowedCommands)
    ? settings.allowedCommands
    : ['node', 'npm', 'pnpm', 'bun', 'qmd'];
  const allowedManagersRaw = Array.isArray(settings?.allowedManagers)
    ? settings.allowedManagers
    : ['pnpm', 'npm', 'bun'];
  const allowedManagers = new Set<InstallManager>(
    allowedManagersRaw.filter((manager): manager is InstallManager =>
      manager === 'npm' || manager === 'pnpm' || manager === 'bun'
    )
  );

  return {
    enabled: settings?.enabled ?? false,
    allowedCommands: new Set(
      allowedCommands
        .map((command) => command.trim())
        .filter((command) => command.length > 0)
    ),
    allowedManagers,
    allowGlobalInstall: settings?.allowGlobalInstall ?? false,
    timeoutMs: Math.min(Math.max(settings?.timeoutMs ?? 120000, 1000), 10 * 60 * 1000),
    maxOutputChars: Math.min(Math.max(settings?.maxOutputChars ?? 12000, 1000), 200000),
  };
}

function isSafeCommandName(command: string): boolean {
  if (!command) return false;
  if (command.includes('/') || command.includes('\\')) return false;
  return /^[a-zA-Z0-9._-]+$/.test(command);
}

function isSafePackageSpec(spec: string): boolean {
  if (!spec) return false;
  if (spec.length > 150) return false;
  return /^[a-zA-Z0-9@._/:+\-#~]+$/.test(spec);
}

async function runCommand(
  command: string,
  args: string[],
  options: {
    timeoutMs: number;
    maxOutputChars: number;
    cwd?: string;
  }
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      shell: false,
      cwd: options.cwd,
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    let done = false;
    let timedOut = false;

    const trimToLimit = (text: string): string => {
      if (text.length <= options.maxOutputChars) return text;
      return text.slice(text.length - options.maxOutputChars);
    };

    const finish = (exitCode: number) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({
        exitCode,
        stdout: trimToLimit(stdout),
        stderr: trimToLimit(stderr),
        timedOut,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1500).unref();
    }, options.timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > options.maxOutputChars * 2) {
        stdout = stdout.slice(stdout.length - options.maxOutputChars * 2);
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > options.maxOutputChars * 2) {
        stderr = stderr.slice(stderr.length - options.maxOutputChars * 2);
      }
    });

    child.on('error', (error) => {
      stderr += error.message;
      finish(1);
    });

    child.on('close', (code) => {
      finish(code ?? 0);
    });
  });
}

export async function executeToolCall(
  toolName: string,
  toolInput: Record<string, unknown>,
  ctx: ToolExecutorContext
): Promise<ToolResult> {
  try {
    switch (toolName) {
      case 'agent_incidents_recent': {
        const limit = Math.max(1, Math.min(200, Number(toolInput.limit ?? 20) || 20));
        const incidents = listRecentAgentIncidents(limit);
        return { success: true, data: { incidents } };
      }

      case 'playbook_search': {
        const query = String(toolInput.query ?? '').trim();
        if (!query) return { success: false, error: 'Missing query' };
        const limit = Math.max(1, Math.min(50, Number(toolInput.limit ?? 8) || 8));
        const results = searchPlaybooks({ query, limit });
        return { success: true, data: { results } };
      }

      case 'playbook_get': {
        const key = String(toolInput.key ?? '').trim();
        if (!key) return { success: false, error: 'Missing key' };
        const playbook = getPlaybook(key);
        if (!playbook) return { success: false, error: `Playbook not found: ${key}` };
        return { success: true, data: playbook };
      }

      case 'playbook_upsert': {
        const key = String(toolInput.key ?? '').trim();
        const title = String(toolInput.title ?? '').trim();
        const content = String(toolInput.content ?? '').trim();
        const tags = Array.isArray(toolInput.tags) ? toolInput.tags.map(String) : [];
        if (!key || !title || !content) {
          return { success: false, error: 'Missing key/title/content' };
        }
        upsertPlaybook({ key, title, content, tags });
        return { success: true, data: { upserted: true, key } };
      }

      case 'hyperliquid_verify_live': {
        const symbol = String(toolInput.symbol ?? 'BTC').trim().toUpperCase();
        const client = new HyperliquidClient(ctx.config);
        const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

        try {
          const markets = await client.listPerpMarkets();
          const hasSymbol = markets.some((m) => m.symbol === symbol);
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

          try {
            const openOrders = await client.getOpenOrders();
            checks.push({
              name: 'Open orders',
              ok: Array.isArray(openOrders),
              detail: Array.isArray(openOrders)
                ? `${openOrders.length} open order(s)`
                : 'unexpected payload shape',
            });
          } catch (error) {
            checks.push({
              name: 'Open orders',
              ok: false,
              detail: error instanceof Error ? error.message : 'unknown error',
            });
          }

          try {
            client.getExchangeClient();
            checks.push({
              name: 'Exchange signer',
              ok: true,
              detail: 'private key loaded',
            });
          } catch (error) {
            checks.push({
              name: 'Exchange signer',
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
          checks.push({
            name: 'Open orders',
            ok: false,
            detail:
              'missing HYPERLIQUID_ACCOUNT_ADDRESS/HYPERLIQUID_PRIVATE_KEY (required for authenticated checks)',
          });
          checks.push({
            name: 'Exchange signer',
            ok: false,
            detail: 'missing HYPERLIQUID_PRIVATE_KEY',
          });
        }

        const ok = checks.every((c) => c.ok);
        return { success: true, data: { ok, checks } };
      }

      case 'hyperliquid_order_roundtrip': {
        const symbol = String(toolInput.symbol ?? 'BTC').trim().toUpperCase();
        const size = Number(toolInput.size ?? 0);
        const side = String(toolInput.side ?? 'buy').trim().toLowerCase() === 'sell' ? 'sell' : 'buy';
        const priceOffsetBps = Number(toolInput.price_offset_bps ?? 5000); // 50% away by default
        if (!Number.isFinite(size) || size <= 0) {
          return { success: false, error: 'Missing or invalid size' };
        }

        const client = new HyperliquidClient(ctx.config);
        const exchange = client.getExchangeClient();
        const markets = await client.listPerpMarkets();
        const marketMeta = markets.find((m) => m.symbol === symbol);
        if (!marketMeta) {
          return { success: false, error: `Unknown Hyperliquid symbol: ${symbol}` };
        }

        const mids = await client.getAllMids();
        const mid = mids[symbol];
        if (typeof mid !== 'number' || !Number.isFinite(mid) || mid <= 0) {
          return { success: false, error: `Missing mid price for ${symbol}` };
        }

        const bps = Math.max(100, Math.min(9000, Number.isFinite(priceOffsetBps) ? priceOffsetBps : 5000));
        const offset = bps / 10000;
        const limitPx = side === 'buy' ? mid * (1 - offset) : mid * (1 + offset);

        const formatDecimal = (value: number, decimals: number): string => {
          const fixed = value.toFixed(decimals);
          return fixed.replace(/\\.?0+$/, '');
        };

        const sizeStr = formatDecimal(size, marketMeta.szDecimals ?? 6);
        const priceStr = formatDecimal(limitPx, 8);

        const result = await exchange.order({
          orders: [
            {
              a: marketMeta.assetId,
              b: side === 'buy',
              p: priceStr,
              s: sizeStr,
              r: false,
              t: { limit: { tif: 'Gtc' } },
            },
          ],
          grouping: 'na',
        } as any);

        const status = (result as any)?.response?.data?.statuses?.[0];
        const oid =
          status && typeof status === 'object' && 'resting' in status
            ? (status as any)?.resting?.oid
            : status && typeof status === 'object' && 'filled' in status
              ? (status as any)?.filled?.oid
              : null;

        if (!oid) {
          return { success: false, error: 'Order did not return an order id (oid)' };
        }

        // Cancel immediately.
        await exchange.cancel({ cancels: [{ a: marketMeta.assetId, o: Number(oid) }] } as any);

        // Verify it is not present anymore (best-effort).
        let stillOpen: boolean | null = null;
        try {
          const openOrders = await client.getOpenOrders();
          if (Array.isArray(openOrders)) {
            stillOpen = openOrders.some((o) => Number((o as any)?.oid) === Number(oid));
          }
        } catch {
          stillOpen = null;
        }

        return {
          success: true,
          data: {
            symbol,
            side,
            size: Number(sizeStr),
            mid,
            limitPx,
            oid: String(oid),
            cancelled: true,
            stillOpen,
          },
        };
      }

      case 'evm_erc20_balance': {
        const chain = String(toolInput.chain ?? '').trim().toLowerCase() as EvmChain;
        if (chain !== 'polygon' && chain !== 'arbitrum') {
          return { success: false, error: 'Invalid chain (use polygon|arbitrum)' };
        }
        const rpc = String(toolInput.rpc_url ?? '').trim() || getRpcUrl(ctx.config, chain);
        if (!rpc) return { success: false, error: `Missing RPC for ${chain}` };
        const provider = new ethers.providers.JsonRpcProvider(rpc);
        const token =
          String(toolInput.token_address ?? '').trim() || getUsdcConfig(ctx.config, chain).address;
        const owner = String(toolInput.address ?? '').trim();
        if (!token) return { success: false, error: 'Missing token_address' };
        if (!owner) return { success: false, error: 'Missing address' };
        const bal = await getErc20Balance({ provider, token, owner });
        return {
          success: true,
          data: {
            chain,
            token,
            owner,
            balance: Number(bal.formatted),
            decimals: bal.decimals,
            raw: bal.raw,
          },
        };
      }

      case 'evm_usdc_balances': {
        let address = String(toolInput.address ?? '').trim();
        if (!address) {
          // Read address from keystore without decrypting the private key.
          const path =
            ctx.config.wallet?.keystorePath ??
            process.env.THUFIR_KEYSTORE_PATH ??
            `${process.env.HOME ?? ''}/.thufir/keystore.json`;
          const store = loadKeystore(path);
          address = String(store.address ?? '').trim();
        }
        if (!address) return { success: false, error: 'Missing address (and keystore has no address)' };
        const chains: EvmChain[] = ['polygon', 'arbitrum'];
        const results: Record<string, unknown> = {};
        for (const chain of chains) {
          const rpc = getRpcUrl(ctx.config, chain);
          if (!rpc) {
            results[chain] = { ok: false, error: `Missing RPC for ${chain}` };
            continue;
          }
          const provider = new ethers.providers.JsonRpcProvider(rpc);
          const usdc = getUsdcConfig(ctx.config, chain);
          try {
            const [native, erc20] = await Promise.all([
              provider.getBalance(address),
              getErc20Balance({ provider, token: usdc.address, owner: address }),
            ]);
            results[chain] = {
              ok: true,
              rpc,
              native: Number(ethers.utils.formatEther(native)),
              usdc: Number(erc20.formatted),
              usdcAddress: usdc.address,
            };
          } catch (error) {
            results[chain] = {
              ok: false,
              rpc,
              error: error instanceof Error ? error.message : 'Unknown error',
            };
          }
        }
        return { success: true, data: { address, results } };
      }

      case 'cctp_bridge_usdc': {
        const fromChain = String(toolInput.from_chain ?? 'polygon').trim().toLowerCase() as EvmChain;
        const toChain = String(toolInput.to_chain ?? 'arbitrum').trim().toLowerCase() as EvmChain;
        const amountUsdc = Number(toolInput.amount_usdc ?? 0);
        const recipient = toolInput.recipient ? String(toolInput.recipient) : undefined;
        if (!['polygon', 'arbitrum'].includes(fromChain) || !['polygon', 'arbitrum'].includes(toChain)) {
          return { success: false, error: 'Invalid from_chain/to_chain' };
        }
        const password = process.env.THUFIR_WALLET_PASSWORD ?? '';
        if (!password) {
          return { success: false, error: 'Missing THUFIR_WALLET_PASSWORD (required for signing)' };
        }
        const path =
          ctx.config.wallet?.keystorePath ??
          process.env.THUFIR_KEYSTORE_PATH ??
          `${process.env.HOME ?? ''}/.thufir/keystore.json`;
        const store = loadKeystore(path);
        const { decryptPrivateKey } = await import('../execution/wallet/keystore.js');
        const privateKey = decryptPrivateKey(store, password);

        const res = await cctpV1BridgeUsdc({
          config: ctx.config,
          privateKey,
          fromChain,
          toChain,
          amountUsdc,
          recipient,
          pollSeconds: toolInput.poll_seconds ? Number(toolInput.poll_seconds) : undefined,
          maxWaitSeconds: toolInput.max_wait_seconds ? Number(toolInput.max_wait_seconds) : undefined,
        });
        return { success: true, data: res };
      }

      case 'hyperliquid_deposit_usdc': {
        const amountUsdc = Number(toolInput.amount_usdc ?? 0);
        if (!Number.isFinite(amountUsdc) || amountUsdc <= 0) {
          return { success: false, error: 'Invalid amount_usdc' };
        }
        const password = process.env.THUFIR_WALLET_PASSWORD ?? '';
        if (!password) {
          return { success: false, error: 'Missing THUFIR_WALLET_PASSWORD (required for signing)' };
        }
        const chain: EvmChain = 'arbitrum';
        const rpc = getRpcUrl(ctx.config, chain);
        if (!rpc) {
          return {
            success: false,
            error: 'Missing Arbitrum RPC (THUFIR_EVM_RPC_ARBITRUM or config.evm.rpcUrls.arbitrum)',
          };
        }
        const path =
          ctx.config.wallet?.keystorePath ??
          process.env.THUFIR_KEYSTORE_PATH ??
          `${process.env.HOME ?? ''}/.thufir/keystore.json`;
        const store = loadKeystore(path);
        const { decryptPrivateKey } = await import('../execution/wallet/keystore.js');
        const privateKey = decryptPrivateKey(store, password);
        const provider = new ethers.providers.JsonRpcProvider(rpc);
        const wallet = new ethers.Wallet(privateKey, provider);

        const depositAddress =
          String(toolInput.deposit_address ?? '').trim() ||
          String(ctx.config.hyperliquid?.bridge?.depositAddress ?? '').trim();
        if (!depositAddress) {
          return { success: false, error: 'Missing deposit_address' };
        }
        const minDeposit = Number(ctx.config.hyperliquid?.bridge?.minDepositUsdc ?? 5);
        if (amountUsdc < minDeposit) {
          return { success: false, error: `Deposit too small. Minimum is ${minDeposit} USDC.` };
        }

        const usdc = getUsdcConfig(ctx.config, chain);
        const raw = ethers.utils.parseUnits(String(amountUsdc), usdc.decimals);
        const tx = await transferErc20({
          signer: wallet,
          token: usdc.address,
          to: depositAddress,
          amount: raw,
        });
        await provider.waitForTransaction(tx.txHash, 1);

        return {
          success: true,
          data: {
            chain,
            token: usdc.address,
            depositAddress,
            amountUsdc,
            txHash: tx.txHash,
          },
        };
      }

      case 'perp_market_list': {
        const limit = Math.min(Number(toolInput.limit ?? 20), 200);
        const markets = await ctx.marketClient.listMarkets(limit);
        return { success: true, data: formatMarketsForTool(markets) };
      }

      case 'perp_market_get': {
        const symbol = String(toolInput.symbol ?? '');
        if (!symbol) {
          return { success: false, error: 'Missing symbol' };
        }
        try {
          const market = await ctx.marketClient.getMarket(symbol);
          return { success: true, data: formatMarketForTool(market) };
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          return { success: false, error: message };
        }
      }

      case 'perp_place_order': {
        if (!ctx.executor) {
          return { success: false, error: 'Trading is not enabled (no executor configured)' };
        }
        if (!ctx.limiter) {
          return { success: false, error: 'Trading is not enabled (no spending limiter configured)' };
        }
        const symbol = String(toolInput.symbol ?? '');
        const side = String(toolInput.side ?? '').toLowerCase();
        const size = Number(toolInput.size ?? 0);
        const orderTypeRaw = String(toolInput.order_type ?? 'market').toLowerCase();
        const orderType: 'market' | 'limit' = orderTypeRaw === 'limit' ? 'limit' : 'market';
        const price = toolInput.price !== undefined ? Number(toolInput.price) : undefined;
        const leverage = toolInput.leverage !== undefined ? Number(toolInput.leverage) : undefined;
        const reduceOnly = Boolean(toolInput.reduce_only ?? false);
        const reasoningRaw = toolInput.reasoning !== undefined ? String(toolInput.reasoning) : '';
        const reasoning =
          reasoningRaw.trim() ||
          `perp_place_order(${symbol.toUpperCase()} ${side} size=${size}${orderType === 'limit' && Number.isFinite(price) ? ` price=${price}` : ''}${reduceOnly ? ' reduceOnly' : ''})`;
        if (!symbol || !size || (side !== 'buy' && side !== 'sell')) {
          return { success: false, error: 'Missing or invalid order fields' };
        }
        if (orderType === 'limit' && (!Number.isFinite(price) || (price as number) <= 0)) {
          return { success: false, error: 'Limit orders require a valid positive price' };
        }
        const market = await ctx.marketClient.getMarket(symbol);
        const notionalUsd =
          typeof market.markPrice === 'number' && Number.isFinite(market.markPrice) && market.markPrice > 0
            ? market.markPrice * size
            : size;
        const riskCheck = await checkPerpRiskLimits({
          config: ctx.config,
          symbol,
          side: side as 'buy' | 'sell',
          size,
          leverage,
          reduceOnly,
          markPrice: market.markPrice ?? null,
          notionalUsd,
          marketMaxLeverage:
            typeof market.metadata?.maxLeverage === 'number'
              ? (market.metadata.maxLeverage as number)
              : null,
        });
        if (!riskCheck.allowed) {
          try {
            recordPerpTradeJournal({
              kind: 'perp_trade_journal',
              tradeId: null,
              hypothesisId: null,
              symbol,
              side: side as 'buy' | 'sell',
              size,
              leverage: leverage ?? null,
              orderType,
              reduceOnly,
              markPrice: market.markPrice ?? null,
              confidence: null,
              reasoning: `Risk check blocked: ${riskCheck.reason ?? 'perp risk limits exceeded'}`,
              outcome: 'blocked',
              error: riskCheck.reason ?? 'perp risk limits exceeded',
              snapshot: {
                requestedPrice: orderType === 'limit' ? price ?? null : null,
                notionalUsd,
              },
            });
          } catch {
            // Best-effort journaling: never block trading due to local DB issues.
          }
          return { success: false, error: riskCheck.reason ?? 'perp risk limits exceeded' };
        }
        const limitCheck = await ctx.limiter.checkAndReserve(notionalUsd);
        if (!limitCheck.allowed) {
          try {
            recordPerpTradeJournal({
              kind: 'perp_trade_journal',
              tradeId: null,
              hypothesisId: null,
              symbol,
              side: side as 'buy' | 'sell',
              size,
              leverage: leverage ?? null,
              orderType,
              reduceOnly,
              markPrice: market.markPrice ?? null,
              confidence: null,
              reasoning: `Spending limiter blocked: ${limitCheck.reason ?? 'limit exceeded'}`,
              outcome: 'blocked',
              error: limitCheck.reason ?? 'limit exceeded',
              snapshot: {
                requestedPrice: orderType === 'limit' ? price ?? null : null,
                notionalUsd,
              },
            });
          } catch {
            // Best-effort journaling: never block trading due to local DB issues.
          }
          return { success: false, error: limitCheck.reason ?? 'limit exceeded' };
        }
        const decision: TradeDecision = {
          action: side as 'buy' | 'sell',
          symbol,
          side: side as 'buy' | 'sell',
          size,
          orderType,
          price,
          leverage,
          reduceOnly,
          clientOrderId: createHyperliquidCloid(),
          confidence: 'medium' as const,
          reasoning,
        };
        const decisionStartMs = Date.now();
        const result = await ctx.executor.execute(market, decision);
        if (!result.executed) {
          ctx.limiter.release(notionalUsd);
          try {
            const tradeId = recordPerpTrade({
              hypothesisId: null,
              symbol,
              side: side as 'buy' | 'sell',
              size,
              price: market.markPrice ?? null,
              leverage: leverage ?? null,
              orderType,
              status: 'failed',
            });
            recordPerpTradeJournal({
              kind: 'perp_trade_journal',
              tradeId,
              hypothesisId: null,
              symbol,
              side: side as 'buy' | 'sell',
              size,
              leverage: leverage ?? null,
              orderType,
              reduceOnly,
              markPrice: market.markPrice ?? null,
              confidence: 'medium',
              reasoning: decision.reasoning ?? null,
              outcome: 'failed',
              error: result.message,
              snapshot: {
                requestedPrice: orderType === 'limit' ? price ?? null : null,
                notionalUsd,
              },
            });
          } catch {
            // Best-effort journaling: never block trading due to local DB issues.
          }
          return { success: false, error: result.message };
        }
        ctx.limiter.confirm(notionalUsd);
        try {
          const tradeId = recordPerpTrade({
            hypothesisId: null,
            symbol,
            side: side as 'buy' | 'sell',
            size,
            price: market.markPrice ?? null,
            leverage: leverage ?? null,
            orderType,
            status: 'executed',
          });
          recordPerpTradeJournal({
            kind: 'perp_trade_journal',
            tradeId,
            hypothesisId: null,
            symbol,
            side: side as 'buy' | 'sell',
            size,
            leverage: leverage ?? null,
            orderType,
            reduceOnly,
            markPrice: market.markPrice ?? null,
            confidence: 'medium',
            reasoning: decision.reasoning ?? null,
            outcome: 'executed',
            message: result.message,
            snapshot: {
              requestedPrice: orderType === 'limit' ? price ?? null : null,
              notionalUsd,
            },
          });
          // Best-effort: record envelope + place exchange-side TP/SL triggers for any non-reduce-only entry.
          if (!reduceOnly && typeof market.markPrice === 'number' && market.markPrice > 0) {
            let entryPrice = market.markPrice;
            let entryFeesUsd: number | null = null;
            if (decision.clientOrderId && ctx.config.execution?.mode === 'live') {
              const rec = await reconcileEntryFill({
                config: ctx.config,
                symbol,
                entryCloid: decision.clientOrderId,
                startTimeMs: decisionStartMs,
              });
              if (rec.avgPx != null) entryPrice = rec.avgPx;
              entryFeesUsd = rec.feesUsd;
            }
            const expr: ExpressionPlan = {
              id: `manual_${tradeId}`,
              hypothesisId: `manual_${tradeId}`,
              symbol,
              side: side as 'buy' | 'sell',
              confidence: 0.5,
              expectedEdge: 0,
              entryZone: orderType,
              invalidation: '',
              expectedMove: '',
              orderType,
              leverage: leverage ?? ctx.config.hyperliquid?.maxLeverage ?? 1,
              probeSizeUsd: notionalUsd,
              thesis: reasoning,
              signalKinds: [],
            };

            const envelope = buildTradeEnvelopeFromExpression({
              config: ctx.config,
              tradeId: `perp_${tradeId}`,
              expr,
              entryPrice,
              size,
              notionalUsd,
              entryCloid: decision.clientOrderId ?? null,
              entryFeesUsd,
            });
            recordTradeEnvelope(envelope);
            recordTradeSignals({ tradeId: envelope.tradeId, symbol: envelope.symbol, signals: [] });

            const stops = await placeExchangeSideTpsl({ config: ctx.config, envelope });
            if (stops.tpOid || stops.slOid) {
              envelope.tpOid = stops.tpOid;
              envelope.slOid = stops.slOid;
              recordTradeEnvelope(envelope);
            }
          }
        } catch {
          // Best-effort journaling: never block trading due to local DB issues.
        }
        return { success: true, data: result };
      }

      case 'perp_open_orders': {
        if (!ctx.executor) {
          return { success: false, error: 'Trading is not enabled (no executor configured)' };
        }
        try {
          const orders = await ctx.executor.getOpenOrders();
          return { success: true, data: { orders } };
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          return { success: false, error: message };
        }
      }

      case 'perp_cancel_order': {
        if (!ctx.executor) {
          return { success: false, error: 'Trading is not enabled (no executor configured)' };
        }
        const orderId = String(toolInput.order_id ?? '').trim();
        if (!orderId) {
          return { success: false, error: 'Missing order_id' };
        }
        try {
          await ctx.executor.cancelOrder(orderId);
          return { success: true, data: { cancelled: true, order_id: orderId } };
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          return { success: false, error: message };
        }
      }

      case 'perp_positions': {
        const { HyperliquidClient } = await import('../execution/hyperliquid/client.js');
        try {
          const client = new HyperliquidClient(ctx.config);
          const state = await client.getClearinghouseState();
          return { success: true, data: state };
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          return { success: false, error: message };
        }
      }

      case 'trade_management_open_envelopes': {
        const limit = Math.min(Math.max(Number(toolInput.limit ?? 50), 1), 200);
        try {
          const envelopes = listOpenTradeEnvelopes().slice(0, limit);
          return { success: true, data: { envelopes } };
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          return { success: false, error: message };
        }
      }

      case 'trade_management_recent_closes': {
        const limit = Math.min(Math.max(Number(toolInput.limit ?? 20), 1), 200);
        try {
          const closes = listRecentTradeCloses(limit);
          return { success: true, data: { closes } };
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          return { success: false, error: message };
        }
      }

      case 'trade_management_summary': {
        const limit = Math.min(Math.max(Number(toolInput.limit ?? 20), 1), 200);
        try {
          const summary = buildTradeJournalSummary({ limit });
          return { success: true, data: { summary } };
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          return { success: false, error: message };
        }
      }
      case 'perp_analyze': {
        const symbol = String(toolInput.symbol ?? '').trim();
        const horizon = String(toolInput.horizon ?? '').trim();
        const probabilityMode = String(toolInput.probability_mode ?? '').trim();
        if (!symbol) {
          return { success: false, error: 'Missing symbol' };
        }
        try {
          const analysis = await analyzePerpMarket(
            ctx,
            symbol,
            horizon || undefined,
            probabilityMode || undefined
          );
          return { success: true, data: analysis };
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          return { success: false, error: message };
        }
      }

      case 'position_analysis': {
        const minBufferPct = Number(toolInput.min_liq_buffer_pct ?? 10);
        const maxConcentrationPct = Number(toolInput.max_concentration_pct ?? 40);
        const leverageWarning = Number(toolInput.leverage_warning ?? 5);
        try {
          const analysis = await analyzePositions(
            ctx,
            Number.isFinite(minBufferPct) ? minBufferPct : 12,
            Number.isFinite(maxConcentrationPct) ? maxConcentrationPct : 40,
            Number.isFinite(leverageWarning) ? leverageWarning : 5
          );
          return { success: true, data: analysis };
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          return { success: false, error: message };
        }
      }

      case 'discovery_report': {
        const limit = Math.min(Math.max(Number(toolInput.limit ?? 5), 1), 20);
        try {
          const report = await buildDiscoveryReport(ctx.config, limit);
          return { success: true, data: report };
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          return { success: false, error: message };
        }
      }

      case 'trade_review': {
        const limit = Math.min(Math.max(Number(toolInput.limit ?? 20), 1), 200);
        const symbol = String(toolInput.symbol ?? '').trim();
        try {
          const review = await buildTradeReview(ctx, symbol || undefined, limit);
          return { success: true, data: review };
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          return { success: false, error: message };
        }
      }

      case 'perp_trade_journal_list': {
        const limit = Math.min(Math.max(Number(toolInput.limit ?? 50), 1), 200);
        const symbol = String(toolInput.symbol ?? '').trim();
        try {
          const entries = listPerpTradeJournals({ symbol: symbol || undefined, limit });
          return { success: true, data: { entries } };
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          return { success: false, error: message };
        }
      }

      case 'intel_search': {
        const query = String(toolInput.query ?? '');
        const limit = Number(toolInput.limit ?? 5);
        const fromDays = Number(toolInput.from_days ?? 14);
        const items = searchIntel({ query, limit, fromDays });
        return { success: true, data: formatIntelForTool(items) };
      }

      case 'intel_recent': {
        const limit = Number(toolInput.limit ?? 10);
        const items = listRecentIntel(limit);
        return { success: true, data: formatIntelForTool(items) };
      }

      case 'proactive_search_run': {
        const { runProactiveSearch, formatProactiveSummary } = await import('./proactive_search.js');

        const toNumber = (value: unknown): number | undefined => {
          if (value === undefined || value === null || value === '') return undefined;
          const n = Number(value);
          return Number.isFinite(n) ? n : undefined;
        };
        const toBoolean = (value: unknown): boolean | undefined => {
          if (value === undefined || value === null) return undefined;
          if (typeof value === 'boolean') return value;
          if (typeof value === 'string') {
            const v = value.trim().toLowerCase();
            if (v === 'true') return true;
            if (v === 'false') return false;
          }
          return undefined;
        };

        const extraQueriesRaw =
          toolInput.extra_queries ?? toolInput.extraQueries ?? [];
        const extraQueries = Array.isArray(extraQueriesRaw)
          ? extraQueriesRaw.map((entry) => String(entry).trim()).filter(Boolean)
          : [];

        const result = await runProactiveSearch(ctx.config, {
          maxQueries: toNumber(toolInput.max_queries ?? toolInput.maxQueries),
          iterations: toNumber(toolInput.iterations),
          watchlistLimit: toNumber(toolInput.watchlist_limit ?? toolInput.watchlistLimit),
          useLlm: toBoolean(toolInput.use_llm ?? toolInput.useLlm),
          recentIntelLimit: toNumber(
            toolInput.recent_intel_limit ?? toolInput.recentIntelLimit
          ),
          extraQueries,
          includeLearnedQueries: toBoolean(
            toolInput.include_learned_queries ?? toolInput.includeLearnedQueries
          ),
          learnedQueryLimit: toNumber(
            toolInput.learned_query_limit ?? toolInput.learnedQueryLimit
          ),
          webLimitPerQuery: toNumber(
            toolInput.web_limit_per_query ?? toolInput.webLimitPerQuery
          ),
          fetchPerQuery: toNumber(toolInput.fetch_per_query ?? toolInput.fetchPerQuery),
          fetchMaxChars: toNumber(toolInput.fetch_max_chars ?? toolInput.fetchMaxChars),
        });

        return {
          success: true,
          data: {
            ...result,
            summary: formatProactiveSummary(result),
          },
        };
      }

      case 'signal_price_vol_regime': {
        const symbol = String(toolInput.symbol ?? '');
        if (!symbol) {
          return { success: false, error: 'Missing symbol' };
        }
        const { signalPriceVolRegime } = await import('../discovery/signals.js');
        const signal = await signalPriceVolRegime(ctx.config, symbol);
        if (!signal) {
          return { success: false, error: 'Insufficient data for signal' };
        }
        return { success: true, data: signal };
      }

      case 'signal_cross_asset_divergence': {
        const symbols = Array.isArray(toolInput.symbols) ? toolInput.symbols.map(String) : [];
        if (symbols.length < 2) {
          return { success: false, error: 'Need at least two symbols' };
        }
        const { signalCrossAssetDivergence } = await import('../discovery/signals.js');
        const signals = await signalCrossAssetDivergence(ctx.config, symbols);
        return { success: true, data: signals };
      }

      case 'signal_hyperliquid_funding_oi_skew': {
        const symbol = String(toolInput.symbol ?? '');
        if (!symbol) {
          return { success: false, error: 'Missing symbol' };
        }
        const { signalHyperliquidFundingOISkew } = await import('../discovery/signals.js');
        const signal = await signalHyperliquidFundingOISkew(ctx.config, symbol);
        if (!signal) {
          return { success: false, error: 'Insufficient data for signal' };
        }
        return { success: true, data: signal };
      }

      case 'signal_hyperliquid_orderflow_imbalance': {
        const symbol = String(toolInput.symbol ?? '');
        if (!symbol) {
          return { success: false, error: 'Missing symbol' };
        }
        const { signalHyperliquidOrderflowImbalance } = await import('../discovery/signals.js');
        const signal = await signalHyperliquidOrderflowImbalance(ctx.config, symbol);
        if (!signal) {
          return { success: false, error: 'Insufficient data for signal' };
        }
        return { success: true, data: signal };
      }

      case 'discovery_run': {
        const { runDiscovery } = await import('../discovery/engine.js');
        const result = await runDiscovery(ctx.config);
        return { success: true, data: result };
      }

      case 'calibration_stats': {
        const domain = toolInput.domain ? String(toolInput.domain) : undefined;
        const summaries = listCalibrationSummaries();
        const filtered = domain
          ? summaries.filter((summary) => summary.domain === domain)
          : summaries;
        return { success: true, data: filtered };
      }

      case 'evaluation_summary': {
        const { getEvaluationSummary } = await import('./evaluation.js');
        const windowDays =
          toolInput.window_days !== undefined ? Number(toolInput.window_days) : undefined;
        const domain = toolInput.domain ? String(toolInput.domain) : undefined;
        const summary = getEvaluationSummary({ windowDays, domain });
        return { success: true, data: summary };
      }

      case 'current_time': {
        const timezone = String(toolInput.timezone ?? 'UTC');
        const now = new Date();
        let formatted: string;
        try {
          formatted = now.toLocaleString('en-US', {
            timeZone: timezone,
            dateStyle: 'full',
            timeStyle: 'long',
          });
        } catch {
          formatted = now.toUTCString();
        }

        return {
          success: true,
          data: {
            iso: now.toISOString(),
            unix: Math.floor(now.getTime() / 1000),
            formatted,
            timezone,
            day_of_week: now.toLocaleDateString('en-US', { weekday: 'long' }),
          },
        };
      }

      case 'system_exec': {
        const policy = getSystemToolPolicy(ctx.config);
        if (!policy.enabled) {
          return { success: false, error: 'System tools are disabled in config (agent.systemTools.enabled=false)' };
        }

        const command = String(toolInput.command ?? '').trim();
        if (!isSafeCommandName(command)) {
          return { success: false, error: 'Invalid command' };
        }
        if (!policy.allowedCommands.has(command)) {
          return { success: false, error: `Command not allowed: ${command}` };
        }

        const argsInput = Array.isArray(toolInput.args) ? toolInput.args : [];
        const args = argsInput.map((arg) => String(arg)).map((arg) => arg.trim());
        if (args.length > 50) {
          return { success: false, error: 'Too many arguments' };
        }
        for (const arg of args) {
          if (arg.length > 1000 || /[\r\n]/.test(arg)) {
            return { success: false, error: 'Invalid argument content' };
          }
        }

        const cwdRaw = typeof toolInput.cwd === 'string' ? toolInput.cwd.trim() : '';
        const cwd = cwdRaw.length > 0 ? cwdRaw : undefined;
        const run = await runCommand(command, args, {
          timeoutMs: policy.timeoutMs,
          maxOutputChars: policy.maxOutputChars,
          cwd,
        });
        if (run.exitCode !== 0) {
          const error = [
            `Command failed (exit ${run.exitCode})`,
            run.timedOut ? 'Timed out' : '',
            run.stderr,
          ]
            .filter(Boolean)
            .join(': ');
          return { success: false, error };
        }
        return {
          success: true,
          data: {
            command,
            args,
            stdout: run.stdout,
            stderr: run.stderr,
            exitCode: run.exitCode,
            timedOut: run.timedOut,
          },
        };
      }

      case 'system_install': {
        const policy = getSystemToolPolicy(ctx.config);
        if (!policy.enabled) {
          return { success: false, error: 'System tools are disabled in config (agent.systemTools.enabled=false)' };
        }

        const manager = String(toolInput.manager ?? 'pnpm').trim().toLowerCase() as InstallManager;
        if (!policy.allowedManagers.has(manager)) {
          return { success: false, error: `Package manager not allowed: ${manager}` };
        }

        const isGlobal = Boolean(toolInput.global ?? false);
        if (isGlobal && !policy.allowGlobalInstall) {
          return { success: false, error: 'Global installs are disabled (agent.systemTools.allowGlobalInstall=false)' };
        }

        const packages = Array.isArray(toolInput.packages)
          ? toolInput.packages.map((entry) => String(entry).trim()).filter(Boolean)
          : [];
        if (packages.length === 0) {
          return { success: false, error: 'Missing packages' };
        }
        if (packages.length > 20) {
          return { success: false, error: 'Too many packages' };
        }
        if (!packages.every(isSafePackageSpec)) {
          return { success: false, error: 'Package spec contains invalid characters' };
        }

        let args: string[];
        switch (manager) {
          case 'pnpm':
            args = ['add', ...(isGlobal ? ['-g'] : []), ...packages];
            break;
          case 'npm':
            args = ['install', ...(isGlobal ? ['-g'] : []), ...packages];
            break;
          case 'bun':
            args = ['add', ...(isGlobal ? ['-g'] : []), ...packages];
            break;
          default:
            return { success: false, error: `Unsupported manager: ${manager}` };
        }

        const cwdRaw = typeof toolInput.cwd === 'string' ? toolInput.cwd.trim() : '';
        const cwd = cwdRaw.length > 0 ? cwdRaw : undefined;
        const run = await runCommand(manager, args, {
          timeoutMs: policy.timeoutMs,
          maxOutputChars: policy.maxOutputChars,
          cwd,
        });

        if (run.exitCode !== 0) {
          const error = [
            `Install failed (exit ${run.exitCode})`,
            run.timedOut ? 'Timed out' : '',
            run.stderr,
          ]
            .filter(Boolean)
            .join(': ');
          return { success: false, error };
        }

        return {
          success: true,
          data: {
            manager,
            packages,
            global: isGlobal,
            args,
            stdout: run.stdout,
            stderr: run.stderr,
            exitCode: run.exitCode,
            timedOut: run.timedOut,
          },
        };
      }

      case 'get_wallet_info': {
        return getWalletInfo(ctx);
      }

      case 'twitter_search': {
        const query = String(toolInput.query ?? '').trim();
        const limit = Math.min(Math.max(Number(toolInput.limit ?? 10), 1), 50);
        if (!query) {
          return { success: false, error: 'Missing query' };
        }

        // Try Twitter API v2 first
        const twitterResult = await searchTwitterDirect(query, limit, ctx);
        if (twitterResult.success) {
          return twitterResult;
        }

        // Fallback to SerpAPI
        const serpResult = await searchTwitterViaSerpApi(query, limit);
        if (serpResult.success) {
          return serpResult;
        }

        // Both failed
        return {
          success: false,
          error: `Twitter search failed: ${twitterResult.error}. SerpAPI fallback: ${serpResult.error}`,
        };
      }

      case 'web_search': {
        const query = String(toolInput.query ?? '').trim();
        const limit = Math.min(Math.max(Number(toolInput.limit ?? 5), 1), 10);
        if (!query) {
          return { success: false, error: 'Missing query' };
        }

        const serpResult = await searchWebViaSerpApi(query, limit);
        if (serpResult.success) {
          // Auto-index to QMD if enabled (fire-and-forget)
          if (ctx.config.qmd?.enabled && ctx.config.qmd?.autoIndexWebSearch) {
            autoIndexWebSearchResults(query, serpResult.data, ctx).catch(() => {});
          }
          return serpResult;
        }

        const braveResult = await searchWebViaBrave(query, limit);
        if (braveResult.success) {
          // Auto-index to QMD if enabled (fire-and-forget)
          if (ctx.config.qmd?.enabled && ctx.config.qmd?.autoIndexWebSearch) {
            autoIndexWebSearchResults(query, braveResult.data, ctx).catch(() => {});
          }
          return braveResult;
        }

        const ddgResult = await searchWebViaDuckDuckGo(query, limit);
        if (ddgResult.success) {
          if (ctx.config.qmd?.enabled && ctx.config.qmd?.autoIndexWebSearch) {
            autoIndexWebSearchResults(query, ddgResult.data, ctx).catch(() => {});
          }
          return ddgResult;
        }

        return {
          success: false,
          error: `Web search failed: SerpAPI: ${serpResult.error}. Brave: ${braveResult.error}. DuckDuckGo: ${ddgResult.error}`,
        };
      }

      case 'get_portfolio': {
        return getPortfolio(ctx);
      }

      case 'get_positions': {
        try {
          const data = await loadPerpPositions(ctx);
          return { success: true, data };
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          return { success: false, error: message };
        }
      }

      case 'get_open_orders': {
        if (!ctx.executor) {
          return { success: false, error: 'Trading is not enabled (no executor configured)' };
        }
        try {
          const orders = await ctx.executor.getOpenOrders();
          return { success: true, data: { orders } };
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          return { success: false, error: message };
        }
      }

      case 'web_fetch': {
        const url = String(toolInput.url ?? '').trim();
        const maxChars = Math.min(Math.max(Number(toolInput.max_chars ?? 10000), 100), 50000);
        if (!url) {
          return { success: false, error: 'Missing URL' };
        }
        if (!isSafeUrl(url)) {
          return { success: false, error: 'URL is not allowed' };
        }
        const fetchResult = await fetchAndExtract(url, maxChars);
        // Auto-index to QMD if enabled (fire-and-forget)
        if (fetchResult.success && ctx.config.qmd?.enabled && ctx.config.qmd?.autoIndexWebFetch) {
          autoIndexWebFetchResult(fetchResult.data, ctx).catch(() => {});
        }
        return fetchResult;
      }

      
      case 'qmd_query': {
        return qmdQuery(toolInput, ctx);
      }

      case 'qmd_index': {
        return qmdIndex(toolInput, ctx);
      }

      case 'mentat_store_assumption': {
        return mentatStoreAssumption(toolInput, ctx);
      }

      case 'mentat_store_fragility': {
        return mentatStoreFragility(toolInput, ctx);
      }

      case 'mentat_store_mechanism': {
        return mentatStoreMechanism(toolInput, ctx);
      }

      case 'mentat_query': {
        return mentatQuery(toolInput, ctx);
      }

      default:
        return { success: false, error: `Unknown tool: ${toolName}` };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: message };
  }
}

function normalizePrice(market: Market, outcome: 'Yes' | 'No'): number | null {
  const fromMap =
    market.prices?.[outcome] ??
    market.prices?.[outcome.toUpperCase()] ??
    market.prices?.[outcome.toLowerCase()] ??
    undefined;
  if (typeof fromMap === 'number') {
    return fromMap;
  }
  if (typeof fromMap === 'string') {
    const parsed = Number(fromMap);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (market.prices && typeof market.prices === 'object') {
    const key = outcome === 'Yes' ? '0' : '1';
    const indexed = (market.prices as Record<string, unknown>)[key];
    if (typeof indexed === 'number') {
      return indexed;
    }
    if (typeof indexed === 'string') {
      const parsed = Number(indexed);
      return Number.isFinite(parsed) ? parsed : null;
    }
  }
  if (Array.isArray(market.prices)) {
    const index = outcome === 'Yes' ? 0 : 1;
    const value = market.prices[index];
    if (typeof value === 'number') {
      return value;
    }
    if (typeof value === 'string') {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }
  return null;
}

function formatMarketsForTool(markets: Market[]): object[] {
  return markets.map((market) => ({
    id: market.id,
    question: market.question,
    outcomes: market.outcomes,
    yes_price: normalizePrice(market, 'Yes'),
    no_price: normalizePrice(market, 'No'),
    volume: market.volume ?? null,
    category: market.category ?? null,
    symbol: market.symbol ?? null,
    mark_price: market.markPrice ?? null,
    kind: market.kind ?? null,
    platform: market.platform ?? null,
  }));
}

function formatMarketForTool(market: Market): object {
  return {
    id: market.id,
    question: market.question,
    outcomes: market.outcomes,
    yes_price: normalizePrice(market, 'Yes'),
    no_price: normalizePrice(market, 'No'),
    volume: market.volume ?? null,
    liquidity: market.liquidity ?? null,
    category: market.category ?? null,
    end_date: market.endDate ?? null,
    resolved: market.resolved ?? false,
    symbol: market.symbol ?? null,
    mark_price: market.markPrice ?? null,
    kind: market.kind ?? null,
    platform: market.platform ?? null,
  };
}

function formatIntelForTool(items: StoredIntel[]): object[] {
  return items.map((item) => ({
    id: item.id,
    title: item.title,
    source: item.source,
    timestamp: item.timestamp,
    url: item.url,
    summary: item.content?.slice(0, 500) ?? null,
  }));
}

function getWalletInfo(ctx: ToolExecutorContext): ToolResult {
  try {
    if (ctx.config.execution?.provider === 'hyperliquid') {
      return {
        success: true,
        data: {
          address: ctx.config.hyperliquid?.accountAddress ?? null,
          chain: 'hyperliquid',
          token: 'USDC',
          rpc_url: ctx.config.hyperliquid?.baseUrl ?? null,
          keystore_path: null,
        },
      };
    }
    const keystorePath =
      ctx.config.wallet?.keystorePath ??
      process.env.THUFIR_KEYSTORE_PATH ??
      `${process.env.HOME ?? ''}/.thufir/keystore.json`;
    const store = loadKeystore(keystorePath);
    const address = store.address
      ? store.address.startsWith('0x')
        ? store.address
        : `0x${store.address}`
      : null;

    return {
      success: true,
      data: {
        address,
        chain: null,
        token: null,
        keystore_path: keystorePath,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: message };
  }
}

async function getPortfolio(ctx: ToolExecutorContext): Promise<ToolResult> {
  try {
    const balances = await getBalances(ctx);
    const limiterState = ctx.limiter?.getState?.();
    const dailyLimit = ctx.config.wallet?.limits?.daily ?? 100;
    const remainingDaily =
      limiterState != null
        ? Math.max(0, dailyLimit - limiterState.todaySpent - limiterState.reserved)
        : null;
    const hasHyperliquid =
      Boolean(ctx.config.hyperliquid?.enabled) ||
      Boolean(ctx.config.hyperliquid?.accountAddress) ||
      Boolean(ctx.config.hyperliquid?.privateKey) ||
      Boolean(process.env.HYPERLIQUID_ACCOUNT_ADDRESS) ||
      Boolean(process.env.HYPERLIQUID_PRIVATE_KEY);
    let perpPositions: {
      positions: Array<Record<string, unknown>>;
      summary: Record<string, unknown>;
    } | null = null;
    let perpError: string | null = null;
    let spotBalances: {
      balances: Array<Record<string, unknown>>;
      escrows: Array<Record<string, unknown>>;
      summary: Record<string, unknown>;
    } | null = null;
    let spotError: string | null = null;
    let hyperliquidFees: Record<string, unknown> | null = null;
    let hyperliquidFeesError: string | null = null;
    let hyperliquidPortfolio: Record<string, unknown> | null = null;
    let hyperliquidPortfolioError: string | null = null;
    if (hasHyperliquid) {
      try {
        perpPositions = await loadPerpPositions(ctx);
      } catch (error) {
        perpError = error instanceof Error ? error.message : 'Unknown error';
      }
      try {
        spotBalances = await loadSpotBalances(ctx);
      } catch (error) {
        spotError = error instanceof Error ? error.message : 'Unknown error';
      }
      try {
        hyperliquidFees = await loadHyperliquidFees(ctx);
      } catch (error) {
        hyperliquidFeesError = error instanceof Error ? error.message : 'Unknown error';
      }
      try {
        hyperliquidPortfolio = await loadHyperliquidPortfolio(ctx);
      } catch (error) {
        hyperliquidPortfolioError = error instanceof Error ? error.message : 'Unknown error';
      }
    }

    return {
      success: true,
      data: {
        balances,
        positions: [],
        summary: {
          available_balance: balances.usdc ?? 0,
          remaining_daily_limit: remainingDaily,
          positions_source: 'none',
          perp_enabled: hasHyperliquid,
        },
        perp_positions: perpPositions?.positions ?? [],
        perp_summary: perpPositions?.summary ?? null,
        perp_error: perpError,
        spot_balances: spotBalances?.balances ?? [],
        spot_escrows: spotBalances?.escrows ?? [],
        spot_summary: spotBalances?.summary ?? null,
        spot_error: spotError,
        hyperliquid_fees: hyperliquidFees,
        hyperliquid_fees_error: hyperliquidFeesError,
        hyperliquid_portfolio: hyperliquidPortfolio,
        hyperliquid_portfolio_error: hyperliquidPortfolioError,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: message };
  }
}

async function loadPerpPositions(
  ctx: ToolExecutorContext
): Promise<{
  positions: Array<{
    symbol: string;
    side: string;
    size: number;
    entry_price: number | null;
    position_value: number | null;
    unrealized_pnl: number | null;
    return_on_equity: number | null;
    liquidation_price: number | null;
    margin_used: number | null;
    leverage_type: string | null;
    leverage: number | null;
    max_leverage: number | null;
  }>;
  summary: {
    account_value: number | null;
    total_notional: number | null;
    total_margin_used: number | null;
    cross_account_value: number | null;
    cross_total_notional: number | null;
    cross_total_margin_used: number | null;
    cross_maintenance_margin_used: number | null;
    withdrawable: number | null;
  };
}> {
  const client = new HyperliquidClient(ctx.config);
  const state = (await client.getClearinghouseState()) as {
    assetPositions?: Array<{ position?: Record<string, unknown> }>;
    marginSummary?: Record<string, unknown>;
    crossMarginSummary?: Record<string, unknown>;
    withdrawable?: string | number;
    crossMaintenanceMarginUsed?: string | number;
  };

  const toNumber = (value: unknown): number | null => {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  };

  const positions = (state.assetPositions ?? [])
    .map((entry) => entry?.position ?? {})
    .map((position) => {
      const size = toNumber((position as { szi?: unknown }).szi);
      if (size == null || size === 0) return null;
      const side = size > 0 ? 'long' : 'short';
      const leverage = (position as { leverage?: { type?: string; value?: number | string } })
        .leverage;
      const leverageValue = toNumber(leverage?.value);
      return {
        symbol: String((position as { coin?: unknown }).coin ?? ''),
        side,
        size: Math.abs(size),
        entry_price: toNumber((position as { entryPx?: unknown }).entryPx),
        position_value: toNumber((position as { positionValue?: unknown }).positionValue),
        unrealized_pnl: toNumber((position as { unrealizedPnl?: unknown }).unrealizedPnl),
        return_on_equity: toNumber((position as { returnOnEquity?: unknown }).returnOnEquity),
        liquidation_price: toNumber((position as { liquidationPx?: unknown }).liquidationPx),
        margin_used: toNumber((position as { marginUsed?: unknown }).marginUsed),
        leverage_type: leverage?.type ?? null,
        leverage: leverageValue,
        max_leverage: toNumber((position as { maxLeverage?: unknown }).maxLeverage),
      };
    })
    .filter((position): position is NonNullable<typeof position> => Boolean(position));

  const marginSummary = state.marginSummary ?? {};
  const crossSummary = state.crossMarginSummary ?? {};
  return {
    positions,
    summary: {
      account_value: toNumber((marginSummary as { accountValue?: unknown }).accountValue),
      total_notional: toNumber((marginSummary as { totalNtlPos?: unknown }).totalNtlPos),
      total_margin_used: toNumber(
        (marginSummary as { totalMarginUsed?: unknown }).totalMarginUsed
      ),
      cross_account_value: toNumber((crossSummary as { accountValue?: unknown }).accountValue),
      cross_total_notional: toNumber((crossSummary as { totalNtlPos?: unknown }).totalNtlPos),
      cross_total_margin_used: toNumber(
        (crossSummary as { totalMarginUsed?: unknown }).totalMarginUsed
      ),
      cross_maintenance_margin_used: toNumber(state.crossMaintenanceMarginUsed),
      withdrawable: toNumber(state.withdrawable),
    },
  };
}

function computeMaxDrawdownPct(series: Array<[number, number]>): number | null {
  if (!Array.isArray(series) || series.length < 2) return null;
  let peak = series[0]![1];
  let maxDd = 0;
  for (const [, value] of series) {
    if (!Number.isFinite(value)) continue;
    if (value > peak) peak = value;
    if (peak > 0) {
      const dd = (peak - value) / peak;
      if (dd > maxDd) maxDd = dd;
    }
  }
  return Number.isFinite(maxDd) ? maxDd * 100 : null;
}

function computePnlForPeriod(series: Array<[number, number]>): number | null {
  if (!Array.isArray(series) || series.length < 2) return null;
  const first = series[0]![1];
  const last = series[series.length - 1]![1];
  if (!Number.isFinite(first) || !Number.isFinite(last)) return null;
  return last - first;
}

async function loadHyperliquidFees(ctx: ToolExecutorContext): Promise<Record<string, unknown>> {
  const client = new HyperliquidClient(ctx.config);
  const fees = (await client.getUserFees()) as {
    feeSchedule?: Record<string, unknown>;
    dailyUserVlm?: Array<{ date?: string; userCross?: string | number; userAdd?: string | number }>;
    userCrossRate?: string | number;
    userAddRate?: string | number;
    userSpotCrossRate?: string | number;
    userSpotAddRate?: string | number;
  };

  const daily = Array.isArray(fees.dailyUserVlm) ? fees.dailyUserVlm : [];
  const toNum = (v: unknown): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  const dailyWithTotals = daily.map((d) => {
    const cross = toNum(d.userCross);
    const add = toNum(d.userAdd);
    return { date: d.date ?? null, user_cross: cross, user_add: add, user_total: cross + add };
  });

  const last14 = dailyWithTotals.slice(-14);
  const volume14d = last14.reduce((sum, d) => sum + (d.user_total ?? 0), 0);

  return {
    rates: {
      perps: { taker: toNum(fees.userCrossRate), maker: toNum(fees.userAddRate) },
      spot: { taker: toNum(fees.userSpotCrossRate), maker: toNum(fees.userSpotAddRate) },
    },
    fee_schedule: fees.feeSchedule ?? null,
    volume_14d: volume14d,
    daily_volume: dailyWithTotals,
  };
}

async function loadHyperliquidPortfolio(
  ctx: ToolExecutorContext
): Promise<Record<string, unknown>> {
  const client = new HyperliquidClient(ctx.config);
  const response = (await client.getPortfolioMetrics()) as unknown;
  const tuples = (Array.isArray(response) ? response : []) as Array<
    [string, { accountValueHistory?: Array<[number, string | number]>; pnlHistory?: Array<[number, string | number]>; vlm?: string | number }]
  >;

  const toNumSeries = (
    series: Array<[number, string | number]> | undefined
  ): Array<[number, number]> =>
    (series ?? [])
      .map((pair) => [Number(pair[0]), Number(pair[1])] as [number, number])
      .filter(([t, v]) => Number.isFinite(t) && Number.isFinite(v));

  const periods: Record<string, unknown> = {};
  for (const [name, data] of tuples) {
    const account = toNumSeries(data?.accountValueHistory);
    const pnl = toNumSeries(data?.pnlHistory);
    const vlm = Number(data?.vlm ?? 0);
    periods[name] = {
      volume: Number.isFinite(vlm) ? vlm : 0,
      pnl_delta: computePnlForPeriod(pnl),
      max_drawdown_pct: computeMaxDrawdownPct(account),
      points: {
        account_value: account.length,
        pnl: pnl.length,
      },
    };
  }

  return { periods };
}

async function loadSpotBalances(
  ctx: ToolExecutorContext
): Promise<{
  balances: Array<{
    coin: string;
    token: number | null;
    total: number | null;
    hold: number | null;
    free: number | null;
    entry_notional: number | null;
  }>;
  escrows: Array<{
    coin: string;
    token: number | null;
    total: number | null;
  }>;
  summary: {
    tokens: number;
    total_free: number;
    total_hold: number;
  };
}> {
  const client = new HyperliquidClient(ctx.config);
  const state = (await client.getSpotClearinghouseState()) as {
    balances?: Array<Record<string, unknown>>;
    evmEscrows?: Array<Record<string, unknown>>;
  };

  const toNumber = (value: unknown): number | null => {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  };

  const balances = (state.balances ?? []).map((b) => {
    const total = toNumber((b as { total?: unknown }).total);
    const hold = toNumber((b as { hold?: unknown }).hold);
    const free =
      total != null && hold != null ? Math.max(0, total - hold) : null;
    return {
      coin: String((b as { coin?: unknown }).coin ?? ''),
      token: toNumber((b as { token?: unknown }).token),
      total,
      hold,
      free,
      entry_notional: toNumber((b as { entryNtl?: unknown }).entryNtl),
    };
  });

  const escrows = (state.evmEscrows ?? []).map((e) => ({
    coin: String((e as { coin?: unknown }).coin ?? ''),
    token: toNumber((e as { token?: unknown }).token),
    total: toNumber((e as { total?: unknown }).total),
  }));

  const totalFree = balances.reduce((sum, b) => sum + (b.free ?? 0), 0);
  const totalHold = balances.reduce((sum, b) => sum + (b.hold ?? 0), 0);

  return {
    balances,
    escrows,
    summary: {
      tokens: balances.length,
      total_free: totalFree,
      total_hold: totalHold,
    },
  };
}

function formatSignalSymbol(symbol: string): string {
  if (!symbol) return symbol;
  if (symbol.includes('/')) return symbol;
  return `${symbol}/USDT`;
}

function biasToScore(bias?: string | null): number {
  if (!bias) return 0;
  if (bias === 'up') return 1;
  if (bias === 'down') return -1;
  return 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

async function analyzePerpMarket(
  ctx: ToolExecutorContext,
  symbol: string,
  horizon?: string,
  probabilityMode?: string
): Promise<Record<string, unknown>> {
  const market = await ctx.marketClient.getMarket(symbol);
  const baseSymbol = market.symbol ?? market.id;
  const signalSymbol = formatSignalSymbol(baseSymbol);

  const [priceVol, funding, orderflow] = await Promise.all([
    signalPriceVolRegime(ctx.config, signalSymbol),
    signalHyperliquidFundingOISkew(ctx.config, signalSymbol),
    signalHyperliquidOrderflowImbalance(ctx.config, signalSymbol),
  ]);

  const signals = [priceVol, funding, orderflow].filter(Boolean) as Array<{
    kind: string;
    directionalBias: string;
    confidence: number;
    metrics?: Record<string, unknown>;
  }>;

  const biasScore = signals.reduce(
    (acc, s) => acc + biasToScore(s.directionalBias) * (s.confidence ?? 0),
    0
  );
  const avgConfidence = signals.length
    ? signals.reduce((acc, s) => acc + (s.confidence ?? 0), 0) / signals.length
    : 0;
  const mode = probabilityMode?.toLowerCase() ?? 'balanced';
  const [capLow, capHigh] =
    mode === 'conservative'
      ? [0.35, 0.65]
      : mode === 'aggressive'
        ? [0.1, 0.9]
        : [0.2, 0.8];
  const probUp =
    signals.length === 0 ? 0.5 : clamp(0.5 + biasScore * 0.15, capLow, capHigh);
  const direction =
    probUp > 0.55 ? 'up' : probUp < 0.45 ? 'down' : 'neutral';

  const risks: string[] = [];
  if (signals.length === 0) {
    risks.push('No signal data available for this symbol.');
  }
  if (avgConfidence < 0.25) {
    risks.push('Low signal confidence; consider smaller sizing.');
  }
  if (!market.markPrice) {
    risks.push('Missing mark price; verify market data.');
  }

  return {
    symbol: baseSymbol,
    horizon: horizon ?? 'hours',
    mark_price: market.markPrice ?? null,
    max_leverage: market.metadata?.maxLeverage ?? null,
    probability_mode: mode,
    direction,
    prob_up: Number(probUp.toFixed(2)),
    confidence: Number(avgConfidence.toFixed(2)),
    signals: signals.map((s) => ({
      kind: s.kind,
      bias: s.directionalBias,
      confidence: s.confidence,
      metrics: s.metrics ?? null,
    })),
    risks,
  };
}

async function analyzePositions(
  ctx: ToolExecutorContext,
  minLiqBufferPct: number,
  maxConcentrationPct: number,
  leverageWarning: number
): Promise<Record<string, unknown>> {
  const data = await loadPerpPositions(ctx);
  const positions = data.positions ?? [];
  const enriched = await Promise.all(
    positions.map(async (pos) => {
      const symbol = pos.symbol;
      let markPrice: number | null = null;
      try {
        const market = await ctx.marketClient.getMarket(symbol);
        markPrice = market.markPrice ?? null;
      } catch {
        markPrice = null;
      }
      const liq = pos.liquidation_price ?? null;
      const side = pos.side ?? 'long';
      let bufferPct: number | null = null;
      if (markPrice != null && liq != null) {
        const distance = side === 'long' ? markPrice - liq : liq - markPrice;
        bufferPct = markPrice > 0 ? (distance / markPrice) * 100 : null;
      }
      const notional =
        pos.position_value ??
        (markPrice != null ? Math.abs(pos.size) * markPrice : null);
      const leverageFlag =
        typeof pos.leverage === 'number' && pos.leverage > leverageWarning;
      return {
        ...pos,
        mark_price: markPrice,
        notional,
        liq_buffer_pct: bufferPct,
        liq_risk: bufferPct != null && bufferPct < minLiqBufferPct,
        leverage_warning: leverageFlag,
      };
    })
  );

  const totalNotional = enriched.reduce((sum, p) => sum + (p.notional ?? 0), 0);
  const concentration = enriched
    .map((p) => ({
      symbol: p.symbol,
      share: totalNotional > 0 ? (p.notional ?? 0) / totalNotional : 0,
    }))
    .sort((a, b) => b.share - a.share);

  const warnings: string[] = [];
  for (const p of enriched) {
    if (p.liq_risk) {
      warnings.push(`${p.symbol}: liquidation buffer ${p.liq_buffer_pct?.toFixed(1)}%`);
    }
    if (p.leverage_warning) {
      warnings.push(`${p.symbol}: leverage ${p.leverage}x exceeds ${leverageWarning}x`);
    }
  }
  if ((concentration[0]?.share ?? 0) * 100 > maxConcentrationPct) {
    warnings.push(
      `Concentration risk: ${concentration[0]!.symbol} at ${(concentration[0]!.share * 100).toFixed(
        1
      )}%`
    );
  }

  return {
    summary: {
      total_positions: enriched.length,
      total_notional: totalNotional,
      max_concentration: concentration[0]?.share ?? 0,
      min_liq_buffer_pct: minLiqBufferPct,
      max_concentration_pct: maxConcentrationPct,
      leverage_warning: leverageWarning,
    },
    concentration,
    warnings,
    positions: enriched,
  };
}

async function buildDiscoveryReport(
  config: ThufirConfig,
  limit: number
): Promise<Record<string, unknown>> {
  const result = await runDiscovery(config);
  const expressions = result.expressions.slice(0, limit);
  return {
    clusters: result.clusters.map((cluster) => ({
      symbol: cluster.symbol,
      bias: cluster.directionalBias,
      confidence: cluster.confidence,
      time_horizon: cluster.timeHorizon,
      signals: cluster.signals.map((s) => s.kind),
    })),
    hypotheses: result.hypotheses.slice(0, limit),
    expressions,
  };
}

async function buildTradeReview(
  ctx: ToolExecutorContext,
  symbol?: string,
  limit = 20
): Promise<Record<string, unknown>> {
  const trades = listPerpTrades({ symbol, limit });
  const reviewed = await Promise.all(
    trades.map(async (trade) => {
      let markPrice: number | null = null;
      try {
        const market = await ctx.marketClient.getMarket(trade.symbol);
        markPrice = market.markPrice ?? null;
      } catch {
        markPrice = null;
      }
      const entry = trade.price ?? null;
      let unrealizedPnl: number | null = null;
      if (entry != null && markPrice != null) {
        const delta = trade.side === 'buy' ? markPrice - entry : entry - markPrice;
        unrealizedPnl = delta * trade.size;
      }
      return {
        id: trade.id,
        created_at: trade.createdAt,
        symbol: trade.symbol,
        side: trade.side,
        size: trade.size,
        entry_price: entry,
        mark_price: markPrice,
        leverage: trade.leverage ?? null,
        order_type: trade.orderType ?? null,
        status: trade.status ?? null,
        unrealized_pnl: unrealizedPnl,
      };
    })
  );

  const totalPnl = reviewed.reduce((sum, t) => sum + (t.unrealized_pnl ?? 0), 0);

  return {
    count: reviewed.length,
    total_unrealized_pnl: totalPnl,
    trades: reviewed,
    note: 'Unrealized PnL uses current mark price; realized PnL not tracked yet.',
  };
}

async function getBalances(ctx: ToolExecutorContext): Promise<{
  usdc?: number;
  matic?: number;
  source: string;
}> {
  if (ctx.config.execution?.mode !== 'live') {
    return { usdc: getCashBalance(), matic: 0, source: 'paper' };
  }

  const password = process.env.THUFIR_WALLET_PASSWORD;
  if (!password) {
    return { usdc: getCashBalance(), matic: 0, source: 'memory' };
  }

  try {
    const wallet = loadWallet(ctx.config, password);
    const balances = await getWalletBalances(wallet);
    if (!balances) {
      return { usdc: getCashBalance(), matic: 0, source: 'memory' };
    }
    return { usdc: balances.usdc ?? 0, matic: balances.matic ?? 0, source: 'chain' };
  } catch {
    return { usdc: getCashBalance(), matic: 0, source: 'memory' };
  }
}

/**
 * Search Twitter directly via Twitter API v2
 */
async function searchTwitterDirect(
  query: string,
  limit: number,
  ctx: ToolExecutorContext
): Promise<ToolResult> {
  const bearer =
    ctx.config.intel?.sources?.twitter?.bearerToken ?? process.env.TWITTER_BEARER;
  if (!bearer) {
    return { success: false, error: 'Twitter bearer token not configured' };
  }

  try {
    const baseUrl =
      ctx.config.intel?.sources?.twitter?.baseUrl ?? 'https://api.twitter.com/2';
    const url = new URL(`${baseUrl}/tweets/search/recent`);
    url.searchParams.set('query', `${query} -is:retweet lang:en`);
    url.searchParams.set('max_results', String(Math.max(10, limit)));
    url.searchParams.set('tweet.fields', 'created_at,author_id,public_metrics');
    url.searchParams.set('expansions', 'author_id');
    url.searchParams.set('user.fields', 'username,name');

    const response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${bearer}` },
    });

    if (!response.ok) {
      return { success: false, error: `Twitter API: ${response.status}` };
    }

    const data = (await response.json()) as {
      data?: Array<{
        id: string;
        text: string;
        created_at?: string;
        author_id?: string;
        public_metrics?: {
          like_count: number;
          retweet_count: number;
          reply_count: number;
        };
      }>;
      includes?: {
        users?: Array<{ id: string; username: string; name: string }>;
      };
    };

    const users = new Map(
      (data.includes?.users ?? []).map((u) => [u.id, u])
    );

    const tweets = (data.data ?? []).map((tweet) => {
      const text = (tweet.text ?? '').replace(/\s+/g, ' ').trim();
      return {
        id: tweet.id,
        text,
        author: users.get(tweet.author_id ?? '')?.username ?? 'unknown',
        likes: tweet.public_metrics?.like_count ?? 0,
        retweets: tweet.public_metrics?.retweet_count ?? 0,
        url: `https://twitter.com/i/status/${tweet.id}`,
        timestamp: tweet.created_at ?? null,
      };
    });

    return { success: true, data: tweets };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: message };
  }
}

/**
 * Search Twitter via SerpAPI (fallback)
 */
async function searchTwitterViaSerpApi(
  query: string,
  limit: number
): Promise<ToolResult> {
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) {
    return { success: false, error: 'SerpAPI key not configured' };
  }

  try {
    const url = new URL('https://serpapi.com/search.json');
    url.searchParams.set('engine', 'twitter');
    url.searchParams.set('q', query);
    url.searchParams.set('api_key', apiKey);

    const response = await fetch(url.toString());
    if (!response.ok) {
      return { success: false, error: `SerpAPI: ${response.status}` };
    }

    const data = (await response.json()) as {
      tweets?: Array<{
        text?: string;
        user?: { screen_name?: string };
        created_at?: string;
        likes?: number;
        retweets?: number;
        link?: string;
      }>;
    };

    const tweets = (data.tweets ?? []).slice(0, limit).map((tweet) => ({
      text: (tweet.text ?? '').replace(/\s+/g, ' ').trim(),
      author: tweet.user?.screen_name ?? 'unknown',
      likes: tweet.likes ?? 0,
      retweets: tweet.retweets ?? 0,
      url: tweet.link ?? null,
      timestamp: tweet.created_at ?? null,
    }));

    return { success: true, data: tweets };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: message };
  }
}

async function searchWebViaSerpApi(
  query: string,
  limit: number
): Promise<ToolResult> {
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) {
    return { success: false, error: 'SerpAPI key not configured' };
  }

  try {
    const url = new URL('https://serpapi.com/search.json');
    url.searchParams.set('engine', 'google');
    url.searchParams.set('q', query);
    url.searchParams.set('num', String(limit));
    url.searchParams.set('api_key', apiKey);

    const response = await fetch(url.toString());
    if (!response.ok) {
      return { success: false, error: `SerpAPI: ${response.status}` };
    }

    const data = (await response.json()) as {
      organic_results?: Array<{
        title?: string;
        link?: string;
        snippet?: string;
        date?: string;
        source?: string;
      }>;
    };

    const results = (data.organic_results ?? []).slice(0, limit).map((item) => ({
      title: item.title ?? '',
      url: item.link ?? '',
      snippet: item.snippet ?? '',
      date: item.date ?? null,
      source: item.source ?? null,
    }));

    return { success: true, data: { query, provider: 'serpapi', results } };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: message };
  }
}

async function searchWebViaBrave(
  query: string,
  limit: number
): Promise<ToolResult> {
  const apiKey = process.env.BRAVE_API_KEY;
  if (!apiKey) {
    return { success: false, error: 'Brave API key not configured' };
  }

  try {
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(limit));

    const response = await fetch(url.toString(), {
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': apiKey,
      },
    });

    if (!response.ok) {
      return { success: false, error: `Brave: ${response.status}` };
    }

    const data = (await response.json()) as {
      web?: {
        results?: Array<{
          title?: string;
          url?: string;
          description?: string;
          age?: string;
        }>;
      };
    };

    const results = (data.web?.results ?? []).slice(0, limit).map((item) => ({
      title: item.title ?? '',
      url: item.url ?? '',
      snippet: item.description ?? '',
      date: item.age ?? null,
    }));

    return { success: true, data: { query, provider: 'brave', results } };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: message };
  }
}

type DuckDuckGoTopic = {
  Text?: string;
  FirstURL?: string;
  Result?: string;
  Name?: string;
  Topics?: DuckDuckGoTopic[];
};

function flattenDuckDuckGoTopics(topics: DuckDuckGoTopic[]): DuckDuckGoTopic[] {
  const result: DuckDuckGoTopic[] = [];
  for (const topic of topics) {
    if (Array.isArray(topic.Topics) && topic.Topics.length > 0) {
      result.push(...flattenDuckDuckGoTopics(topic.Topics));
      continue;
    }
    result.push(topic);
  }
  return result;
}

async function searchWebViaDuckDuckGo(
  query: string,
  limit: number
): Promise<ToolResult> {
  try {
    const url = new URL('https://api.duckduckgo.com/');
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('no_redirect', '1');
    url.searchParams.set('no_html', '1');
    url.searchParams.set('skip_disambig', '1');

    const response = await fetch(url.toString(), {
      headers: {
        Accept: 'application/json',
      },
    });
    if (!response.ok) {
      return { success: false, error: `DuckDuckGo: ${response.status}` };
    }

    const data = (await response.json()) as {
      AbstractText?: string;
      AbstractURL?: string;
      Heading?: string;
      RelatedTopics?: DuckDuckGoTopic[];
    };

    const results: Array<{
      title: string;
      url: string;
      snippet: string;
      date: null;
      source: string;
    }> = [];

    if (data.AbstractURL && data.AbstractText) {
      results.push({
        title: data.Heading?.trim() || query,
        url: data.AbstractURL,
        snippet: data.AbstractText,
        date: null,
        source: 'duckduckgo',
      });
    }

    const flat = flattenDuckDuckGoTopics(data.RelatedTopics ?? []);
    for (const topic of flat) {
      if (results.length >= limit) {
        break;
      }
      const text = (topic.Text ?? '').trim();
      const link = (topic.FirstURL ?? '').trim();
      if (!text || !link) {
        continue;
      }
      const title = text.split(' - ')[0]?.trim() || text.slice(0, 80);
      results.push({
        title,
        url: link,
        snippet: text,
        date: null,
        source: 'duckduckgo',
      });
    }

    const trimmed = results.slice(0, limit);
    if (trimmed.length === 0) {
      return { success: false, error: 'DuckDuckGo returned no results' };
    }
    return { success: true, data: { query, provider: 'duckduckgo', results: trimmed } };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: message };
  }
}

function isSafeUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    return false;
  }
  if (hostname === 'metadata.google.internal') {
    return false;
  }

  const ipType = isIP(hostname);
  if (ipType === 0) {
    return true;
  }

  if (ipType === 4) {
    const parts = hostname.split('.').map((part) => Number(part));
    if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) {
      return false;
    }
    const [a, b] = parts;
    if (a === 10 || a === 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 192 && b === 168) return false;
    if (a === 172 && typeof b === 'number' && b >= 16 && b <= 31) return false;
    return true;
  }

  if (ipType === 6) {
    const normalized = hostname.replace(/^\[/, '').replace(/\]$/, '');
    if (normalized === '::1') return false;
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return false;
    if (normalized.startsWith('fe80')) return false;
  }

  return true;
}

async function fetchAndExtract(url: string, maxChars: number): Promise<ToolResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Thufir/1.0; +https://github.com/thufir)',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      redirect: 'follow',
      signal: controller.signal,
    });

    if (!response.ok) {
      return { success: false, error: `Fetch failed: ${response.status}` };
    }

    const maxBytes = 2_000_000;
    const contentLength = response.headers.get('content-length');
    if (contentLength && Number(contentLength) > maxBytes) {
      return { success: false, error: 'Response too large' };
    }

    const contentType = response.headers.get('content-type') ?? '';
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) {
      return { success: false, error: 'Response too large' };
    }

    const body = new TextDecoder().decode(buffer);

    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
      const truncated = body.length > maxChars;
      return {
        success: true,
        data: {
          url,
          title: null,
          content: body.slice(0, maxChars),
          truncated,
        },
      };
    }

    const dom = new JSDOM(body, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();

    if (!article) {
      const text = dom.window.document.body?.textContent ?? '';
      const cleaned = text.replace(/\s+/g, ' ').trim();
      return {
        success: true,
        data: {
          url,
          title: dom.window.document.title ?? null,
          content: cleaned.slice(0, maxChars),
          truncated: cleaned.length > maxChars,
        },
      };
    }

    const content = article.textContent.replace(/\s+/g, ' ').trim();
    return {
      success: true,
      data: {
        url,
        title: article.title ?? null,
        byline: article.byline ?? null,
        content: content.slice(0, maxChars),
        truncated: content.length > maxChars,
        length: article.length,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: message };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Check if QMD is available on the system.
 */
async function isQmdAvailable(): Promise<boolean> {
  try {
    await execAsync('qmd --version');
    return true;
  } catch {
    return false;
  }
}

/**
 * Get QMD knowledge base path from config or default.
 */
function getQmdKnowledgePath(ctx: ToolExecutorContext): string {
  return ctx.config.qmd?.knowledgePath ?? join(homedir(), '.thufir', 'knowledge');
}

/**
 * Search the local knowledge base using QMD hybrid search.
 */
async function qmdQuery(
  toolInput: Record<string, unknown>,
  ctx: ToolExecutorContext
): Promise<ToolResult> {
  const query = String(toolInput.query ?? '').trim();
  const mode = String(toolInput.mode ?? 'query');
  const limit = Math.min(Math.max(Number(toolInput.limit ?? 10), 1), 50);
  const collection = toolInput.collection ? String(toolInput.collection) : undefined;

  if (!query) {
    return { success: false, error: 'Missing query' };
  }

  if (!['query', 'search', 'vsearch'].includes(mode)) {
    return { success: false, error: 'Invalid mode. Use: query, search, or vsearch' };
  }

  if (!ctx.config.qmd?.enabled) {
    return { success: false, error: 'QMD is not enabled in config' };
  }

  const available = await isQmdAvailable();
  if (!available) {
    return { success: false, error: 'QMD is not installed. Run: bun install -g github:tobi/qmd' };
  }

  try {
    const args = [mode, JSON.stringify(query), '--format', 'json', '--limit', String(limit)];
    if (collection) {
      args.push('--collection', collection);
    }

    const { stdout, stderr } = await execAsync(`qmd ${args.join(' ')}`, {
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024,
    });

    if (stderr && !stdout) {
      return { success: false, error: stderr.trim() };
    }

    let results: unknown;
    try {
      results = JSON.parse(stdout);
    } catch {
      // QMD might return non-JSON for some outputs
      results = { raw: stdout.trim() };
    }

    return {
      success: true,
      data: {
        query,
        mode,
        collection: collection ?? 'all',
        results,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: `QMD query failed: ${message}` };
  }
}

/**
 * Index content into the QMD knowledge base.
 */
async function qmdIndex(
  toolInput: Record<string, unknown>,
  ctx: ToolExecutorContext
): Promise<ToolResult> {
  const content = String(toolInput.content ?? '').trim();
  const title = String(toolInput.title ?? 'Untitled');
  const collection = String(toolInput.collection ?? 'thufir-research');
  const source = toolInput.source ? String(toolInput.source) : undefined;

  if (!content) {
    return { success: false, error: 'Missing content' };
  }

  if (!ctx.config.qmd?.enabled) {
    return { success: false, error: 'QMD is not enabled in config' };
  }

  const available = await isQmdAvailable();
  if (!available) {
    return { success: false, error: 'QMD is not installed. Run: bun install -g github:tobi/qmd' };
  }

  const knowledgePath = getQmdKnowledgePath(ctx);

  try {
    // Create a temporary markdown file for QMD to index
    const filename = `${Date.now()}-${randomUUID().slice(0, 8)}.md`;
    const collectionPath = join(knowledgePath, collection.replace('thufir-', ''));
    await mkdir(collectionPath, { recursive: true });
    const filepath = join(collectionPath, filename);

    // Build markdown content with frontmatter
    const frontmatter = [
      '---',
      `title: "${title.replace(/"/g, '\\"')}"`,
      `indexed: ${new Date().toISOString()}`,
    ];
    if (source) {
      frontmatter.push(`source: "${source.replace(/"/g, '\\"')}"`);
    }
    frontmatter.push('---', '', content);

    await writeFile(filepath, frontmatter.join('\n'), 'utf-8');

    // Run qmd embed to update embeddings
    try {
      await execAsync(`qmd embed --collection ${collection}`, {
        timeout: 60000,
      });
    } catch {
      // Embedding failure is non-fatal, content is still indexed for BM25 search
    }

    return {
      success: true,
      data: {
        indexed: true,
        title,
        collection,
        filepath,
        source: source ?? null,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: `QMD index failed: ${message}` };
  }
}

/**
 * Auto-index web search results into QMD (fire-and-forget).
 * Combines all search results into a single document for efficient storage.
 */
async function autoIndexWebSearchResults(
  query: string,
  data: unknown,
  ctx: ToolExecutorContext
): Promise<void> {
  const available = await isQmdAvailable();
  if (!available) return;

  const searchData = data as {
    query?: string;
    provider?: string;
    results?: Array<{
      title?: string;
      url?: string;
      snippet?: string;
      date?: string;
      source?: string;
    }>;
  };

  const results = searchData.results ?? [];
  if (results.length === 0) return;

  // Build markdown content from search results
  const lines: string[] = [
    `# Web Search: ${query}`,
    '',
    `**Provider:** ${searchData.provider ?? 'unknown'}`,
    `**Date:** ${new Date().toISOString()}`,
    `**Results:** ${results.length}`,
    '',
    '---',
    '',
  ];

  for (const result of results) {
    lines.push(`## ${result.title ?? 'Untitled'}`);
    if (result.url) {
      lines.push(`**URL:** ${result.url}`);
    }
    if (result.date) {
      lines.push(`**Date:** ${result.date}`);
    }
    if (result.snippet) {
      lines.push('', result.snippet);
    }
    lines.push('', '---', '');
  }

  const content = lines.join('\n');
  const title = `Web Search: ${query}`;

  // Index using qmdIndex internally
  await qmdIndex(
    {
      content,
      title,
      collection: 'thufir-research',
      source: `web_search:${searchData.provider ?? 'unknown'}`,
    },
    ctx
  );
}

/**
 * Auto-index web fetch result into QMD (fire-and-forget).
 */
async function autoIndexWebFetchResult(
  data: unknown,
  ctx: ToolExecutorContext
): Promise<void> {
  const available = await isQmdAvailable();
  if (!available) return;

  const fetchData = data as {
    url?: string;
    title?: string;
    byline?: string;
    content?: string;
    truncated?: boolean;
  };

  const content = fetchData.content;
  if (!content || content.length < 100) return; // Skip very short content

  const title = fetchData.title ?? fetchData.url ?? 'Web Page';
  const url = fetchData.url ?? '';

  // Build markdown with metadata
  const lines: string[] = [
    `# ${title}`,
    '',
  ];
  if (fetchData.byline) {
    lines.push(`**Author:** ${fetchData.byline}`);
  }
  if (url) {
    lines.push(`**Source:** ${url}`);
  }
  lines.push(`**Fetched:** ${new Date().toISOString()}`);
  if (fetchData.truncated) {
    lines.push(`**Note:** Content was truncated`);
  }
  lines.push('', '---', '', content);

  const fullContent = lines.join('\n');

  // Index using qmdIndex internally
  await qmdIndex(
    {
      content: fullContent,
      title,
      collection: 'thufir-research',
      source: url || 'web_fetch',
    },
    ctx
  );
}

/**
 * Store an assumption in the mentat knowledge base.
 */
async function mentatStoreAssumption(
  toolInput: Record<string, unknown>,
  ctx: ToolExecutorContext
): Promise<ToolResult> {
  const statement = String(toolInput.statement ?? '').trim();
  const system = String(toolInput.system ?? '').trim();
  const evidenceFor = Array.isArray(toolInput.evidence_for) ? toolInput.evidence_for : [];
  const evidenceAgainst = Array.isArray(toolInput.evidence_against) ? toolInput.evidence_against : [];
  const dependencies = Array.isArray(toolInput.dependencies) ? toolInput.dependencies : [];
  const stressScore = toolInput.stress_score === undefined ? null : Number(toolInput.stress_score);
  const lastTested = toolInput.last_tested ? String(toolInput.last_tested) : null;
  const criticality = String(toolInput.criticality ?? 'medium');

  if (!statement) {
    return { success: false, error: 'Missing statement' };
  }
  if (!system) {
    return { success: false, error: 'Missing system' };
  }

  const assumptionId = upsertAssumption({
    system,
    statement,
    dependencies,
    evidenceFor,
    evidenceAgainst,
    stressScore: Number.isFinite(stressScore ?? undefined) ? stressScore : null,
    lastTested,
  });

  // Build markdown content for the assumption
  const lines: string[] = [
    '---',
    'type: assumption',
    `system: "${system}"`,
    `criticality: "${criticality}"`,
    `stress_score: ${typeof stressScore === 'number' ? stressScore.toFixed(2) : 'null'}`,
    `last_tested: ${lastTested ?? 'null'}`,
    `created: ${new Date().toISOString()}`,
    `validated: false`,
    '---',
    '',
    `# Assumption: ${statement}`,
    '',
    `**System:** ${system}`,
    `**Criticality:** ${criticality}`,
    '',
  ];

  if (evidenceFor.length > 0) {
    lines.push('## Evidence For');
    for (const e of evidenceFor) {
      lines.push(`- ${e}`);
    }
    lines.push('');
  }

  if (evidenceAgainst.length > 0) {
    lines.push('## Evidence Against');
    for (const e of evidenceAgainst) {
      lines.push(`- ${e}`);
    }
    lines.push('');
  }

  if (dependencies.length > 0) {
    lines.push('## Dependencies');
    for (const d of dependencies) {
      lines.push(`- ${d}`);
    }
    lines.push('');
  }

  const content = lines.join('\n');
  const title = `Assumption: ${statement.slice(0, 50)}${statement.length > 50 ? '...' : ''}`;

  if (!ctx.config.qmd?.enabled) {
    return {
      success: true,
      data: {
        id: assumptionId,
        stored: 'db',
        indexed: false,
      },
    };
  }

  const qmdResult = await qmdIndex(
    {
      content,
      title,
      collection: 'thufir-markets',
      source: `mentat:assumption:${system}`,
    },
    ctx
  );

  if (!qmdResult.success) {
    return qmdResult;
  }

  return {
    success: true,
    data: {
      id: assumptionId,
      stored: 'db',
      indexed: true,
      qmd: qmdResult.data,
    },
  };
}

/**
 * Store a fragility card in the mentat knowledge base.
 */
async function mentatStoreFragility(
  toolInput: Record<string, unknown>,
  ctx: ToolExecutorContext
): Promise<ToolResult> {
  const system = String(toolInput.system ?? '').trim();
  const mechanism = String(toolInput.mechanism ?? '').trim();
  const exposureSurface = String(toolInput.exposure_surface ?? '').trim();
  const earlySignals = Array.isArray(toolInput.early_signals) ? toolInput.early_signals : [];
  const falsifiers = Array.isArray(toolInput.falsifiers) ? toolInput.falsifiers : [];
  const downside = String(toolInput.downside ?? '');
  const convexity = toolInput.convexity ? String(toolInput.convexity) : '';
  const recoveryCapacity = toolInput.recovery_capacity ? String(toolInput.recovery_capacity) : '';
  const score = Number(toolInput.score ?? 0);

  if (!system) {
    return { success: false, error: 'Missing system' };
  }
  if (!mechanism) {
    return { success: false, error: 'Missing mechanism' };
  }
  if (!exposureSurface) {
    return { success: false, error: 'Missing exposure_surface' };
  }

  const cardId = upsertFragilityCard({
    system,
    mechanismId: null,
    exposureSurface,
    convexity: convexity || null,
    earlySignals,
    falsifiers,
    downside: downside || null,
    recoveryCapacity: recoveryCapacity || null,
    score: Number.isFinite(score) ? score : null,
  });

  // Build markdown content for the fragility card
  const lines: string[] = [
    '---',
    'type: fragility_card',
    `system: "${system}"`,
    `score: ${score.toFixed(2)}`,
    `convexity: "${convexity || 'unknown'}"`,
    `recovery_capacity: "${recoveryCapacity || 'unknown'}"`,
    `created: ${new Date().toISOString()}`,
    '---',
    '',
    `# Fragility Card: ${system}`,
    '',
    `**Mechanism:** ${mechanism}`,
    '',
    `**Exposure Surface:** ${exposureSurface}`,
    '',
    `**Fragility Score:** ${score.toFixed(2)}`,
    '',
  ];

  if (downside) {
    lines.push(`## Downside`);
    lines.push(downside);
    lines.push('');
  }

  if (convexity) {
    lines.push('## Convexity');
    lines.push(convexity);
    lines.push('');
  }

  if (recoveryCapacity) {
    lines.push('## Recovery Capacity');
    lines.push(recoveryCapacity);
    lines.push('');
  }

  if (earlySignals.length > 0) {
    lines.push('## Early Warning Signals');
    for (const s of earlySignals) {
      lines.push(`- ${s}`);
    }
    lines.push('');
  }

  if (falsifiers.length > 0) {
    lines.push('## Falsifiers');
    lines.push('*Conditions that would invalidate this fragility assessment:*');
    for (const f of falsifiers) {
      lines.push(`- ${f}`);
    }
    lines.push('');
  }

  const content = lines.join('\n');
  const title = `Fragility: ${system} - ${mechanism.slice(0, 30)}`;

  if (!ctx.config.qmd?.enabled) {
    return {
      success: true,
      data: {
        id: cardId,
        stored: 'db',
        indexed: false,
      },
    };
  }

  const qmdResult = await qmdIndex(
    {
      content,
      title,
      collection: 'thufir-intel',
      source: `mentat:fragility:${system}`,
    },
    ctx
  );

  if (!qmdResult.success) {
    return qmdResult;
  }

  return {
    success: true,
    data: {
      id: cardId,
      stored: 'db',
      indexed: true,
      qmd: qmdResult.data,
    },
  };
}

/**
 * Store a mechanism in the mentat knowledge base.
 */
async function mentatStoreMechanism(
  toolInput: Record<string, unknown>,
  ctx: ToolExecutorContext
): Promise<ToolResult> {
  const name = String(toolInput.name ?? '').trim();
  const system = String(toolInput.system ?? '').trim();
  const causalChain = Array.isArray(toolInput.causal_chain) ? toolInput.causal_chain : [];
  const triggerClass = toolInput.trigger_class ? String(toolInput.trigger_class) : '';
  const propagationPath = Array.isArray(toolInput.propagation_path) ? toolInput.propagation_path : [];

  if (!name) {
    return { success: false, error: 'Missing name' };
  }
  if (!system) {
    return { success: false, error: 'Missing system' };
  }

  const mechanismId = upsertMechanism({
    system,
    name,
    causalChain,
    triggerClass: triggerClass || null,
    propagationPath,
  });

  const lines: string[] = [
    '---',
    'type: mechanism',
    `system: "${system}"`,
    `trigger_class: "${triggerClass || 'unknown'}"`,
    `created: ${new Date().toISOString()}`,
    '---',
    '',
    `# Mechanism: ${name}`,
    '',
    `**System:** ${system}`,
  ];

  if (causalChain.length > 0) {
    lines.push('', '## Causal Chain');
    for (const step of causalChain) {
      lines.push(`- ${step}`);
    }
  }

  if (propagationPath.length > 0) {
    lines.push('', '## Propagation Path');
    for (const step of propagationPath) {
      lines.push(`- ${step}`);
    }
  }

  const content = lines.join('\n');
  const title = `Mechanism: ${name.slice(0, 50)}${name.length > 50 ? '...' : ''}`;

  if (!ctx.config.qmd?.enabled) {
    return {
      success: true,
      data: {
        id: mechanismId,
        stored: 'db',
        indexed: false,
      },
    };
  }

  const qmdResult = await qmdIndex(
    {
      content,
      title,
      collection: 'thufir-markets',
      source: `mentat:mechanism:${system}`,
    },
    ctx
  );

  if (!qmdResult.success) {
    return qmdResult;
  }

  return {
    success: true,
    data: {
      id: mechanismId,
      stored: 'db',
      indexed: true,
      qmd: qmdResult.data,
    },
  };
}

/**
 * Query the mentat knowledge base for assumptions, fragility cards, or mechanisms.
 */
async function mentatQuery(
  toolInput: Record<string, unknown>,
  ctx: ToolExecutorContext
): Promise<ToolResult> {
  const query = String(toolInput.query ?? '').trim();
  const type = String(toolInput.type ?? 'all');
  const system = toolInput.system ? String(toolInput.system) : undefined;
  const limit = Math.min(Math.max(Number(toolInput.limit ?? 10), 1), 50);

  if (!query) {
    return { success: false, error: 'Missing query' };
  }

  if (!ctx.config.qmd?.enabled) {
    return { success: false, error: 'QMD is not enabled in config' };
  }

  // Build enhanced query with type filter
  let enhancedQuery = query;
  if (type !== 'all') {
    enhancedQuery = `type:${type} ${query}`;
  }
  if (system) {
    enhancedQuery = `system:${system} ${enhancedQuery}`;
  }

  // Determine which collection to search
  let collection: string | undefined;
  if (type === 'assumption') {
    collection = 'thufir-markets';
  } else if (type === 'fragility') {
    collection = 'thufir-intel';
  }
  // 'all' or 'mechanism' searches all collections

  // Use qmd_query internally
  return qmdQuery(
    {
      query: enhancedQuery,
      mode: 'query',
      limit,
      collection,
    },
    ctx
  );
}

import type { ThufirConfig } from '../../core/config.js';
import { HttpTransport, InfoClient, ExchangeClient } from '@nktkas/hyperliquid';
import type {
  FundingHistoryResponse,
  L2BookResponse,
  MetaAndAssetCtxsResponse,
  PerpDexsResponse,
  PortfolioResponse,
  RecentTradesResponse,
  SpotClearinghouseStateResponse,
  UserFeesResponse,
} from '@nktkas/hyperliquid/api/info';
import { privateKeyToAccount } from 'viem/accounts';

export type HyperliquidMetaUniverse = Array<{
  name: string;
  szDecimals?: number;
  maxLeverage?: number;
}>;

export type HyperliquidMarket = {
  symbol: string;
  assetId: number;
  dex?: string | null;
  maxLeverage?: number;
  szDecimals?: number;
};

export type HyperliquidMergedMetaAndAssetCtxsResponse = [
  { universe: HyperliquidMetaUniverse },
  unknown[],
];

type HyperliquidPerpAssetCtx = {
  markPx?: string | number | null;
};

const DEFAULT_SHARED_CACHE_TTL_MS = 3_000;
const DEFAULT_SHARED_MIDS_CACHE_TTL_MS = 30_000;
const DEFAULT_INFO_CONCURRENCY = 3;
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 1_500;

type SharedCacheEntry<T> = {
  expiresAt: number;
  value: T;
};

type SharedRateLimitState = {
  active: number;
  cooldownUntil: number;
  waiters: Array<() => void>;
};

const perpDexsCache = new Map<string, SharedCacheEntry<string[]>>();
const mergedMetaCache = new Map<string, SharedCacheEntry<HyperliquidMergedMetaAndAssetCtxsResponse>>();
const midsCache = new Map<string, SharedCacheEntry<Record<string, number>>>();
const inFlightPerpDexs = new Map<string, Promise<string[]>>();
const inFlightMergedMeta = new Map<string, Promise<HyperliquidMergedMetaAndAssetCtxsResponse>>();
const inFlightMids = new Map<string, Promise<Record<string, number>>>();
const sharedRateLimitStates = new Map<string, SharedRateLimitState>();

function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientInfoError(error: unknown): boolean {
  const status = typeof error === 'object' && error !== null ? Number((error as { status?: unknown }).status) : NaN;
  if (status === 429 || status >= 500) {
    return true;
  }

  const responseStatus =
    typeof error === 'object' && error !== null
      ? Number(((error as { response?: { status?: unknown } }).response?.status as unknown) ?? NaN)
      : NaN;
  if (responseStatus === 429 || responseStatus >= 500) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error ?? '');
  const lower = message.toLowerCase();
  return (
    message.includes('429') ||
    lower.includes('too many requests') ||
    message.includes('500') ||
    lower.includes('internal server error')
  );
}

export class HyperliquidClient {
  private transport: HttpTransport;
  private info: InfoClient;
  private exchange?: ExchangeClient;

  constructor(private config: ThufirConfig) {
    const baseUrl = config.hyperliquid?.baseUrl ?? 'https://api.hyperliquid.xyz';
    this.transport = new HttpTransport({ apiUrl: baseUrl });
    this.info = new InfoClient({ transport: this.transport });
  }

  getInfoClient(): InfoClient {
    return this.info;
  }

  private getRateLimitState(): SharedRateLimitState {
    const key = this.getBaseUrl();
    let state = sharedRateLimitStates.get(key);
    if (!state) {
      state = { active: 0, cooldownUntil: 0, waiters: [] };
      sharedRateLimitStates.set(key, state);
    }
    return state;
  }

  private getMaxConcurrentInfoRequests(): number {
    const configured = Number((this.config.hyperliquid as { maxConcurrentInfoRequests?: unknown } | undefined)?.maxConcurrentInfoRequests);
    return Number.isFinite(configured) && configured >= 1
      ? Math.floor(configured)
      : DEFAULT_INFO_CONCURRENCY;
  }

  private getRateLimitCooldownMs(): number {
    const configured = Number((this.config.hyperliquid as { rateLimitCooldownMs?: unknown } | undefined)?.rateLimitCooldownMs);
    return Number.isFinite(configured) && configured >= 0
      ? Math.floor(configured)
      : DEFAULT_RATE_LIMIT_COOLDOWN_MS;
  }

  private async acquireInfoRequestSlot(): Promise<SharedRateLimitState> {
    const state = this.getRateLimitState();
    const maxConcurrent = this.getMaxConcurrentInfoRequests();
    while (state.active >= maxConcurrent) {
      await new Promise<void>((resolve) => state.waiters.push(resolve));
    }
    state.active += 1;
    return state;
  }

  private releaseInfoRequestSlot(state: SharedRateLimitState): void {
    state.active = Math.max(0, state.active - 1);
    const next = state.waiters.shift();
    next?.();
  }

  private async withInfoRequestLimit<T>(fn: () => Promise<T>): Promise<T> {
    const state = await this.acquireInfoRequestSlot();
    try {
      const waitMs = state.cooldownUntil - Date.now();
      if (waitMs > 0) {
        await sleep(waitMs);
      }
      return await fn();
    } catch (error) {
      if (isTransientInfoError(error)) {
        state.cooldownUntil = Math.max(state.cooldownUntil, Date.now() + this.getRateLimitCooldownMs());
      }
      throw error;
    } finally {
      this.releaseInfoRequestSlot(state);
    }
  }

  async getUserDexAbstraction(): Promise<boolean | null> {
    const user = this.getAccountAddress();
    if (!user) {
      throw new Error(
        'Hyperliquid account address not configured (hyperliquid.accountAddress or HYPERLIQUID_ACCOUNT_ADDRESS).'
      );
    }
    // HIP-3 DEX abstraction (unified account) state. Returns boolean or null.
    return this.withInfoRequestLimit(() => this.info.userDexAbstraction({ user }));
  }

  getAccountAddress(): string | null {
    const configured =
      this.config.hyperliquid?.accountAddress ??
      process.env.HYPERLIQUID_ACCOUNT_ADDRESS ??
      '';
    if (configured) {
      return configured.startsWith('0x') ? configured : `0x${configured}`;
    }
    const key =
      this.config.hyperliquid?.privateKey ?? process.env.HYPERLIQUID_PRIVATE_KEY ?? '';
    if (!key) {
      return null;
    }
    const normalized = key.startsWith('0x') ? key : `0x${key}`;
    const wallet = privateKeyToAccount(normalized as `0x${string}`);
    return wallet.address;
  }

  getExchangeClient(): ExchangeClient {
    if (this.exchange) return this.exchange;
    const key =
      this.config.hyperliquid?.privateKey ?? process.env.HYPERLIQUID_PRIVATE_KEY ?? '';
    if (!key) {
      throw new Error('Hyperliquid private key not configured (HYPERLIQUID_PRIVATE_KEY).');
    }
    const normalized = key.startsWith('0x') ? key : `0x${key}`;
    const wallet = privateKeyToAccount(normalized as `0x${string}`);
    this.exchange = new ExchangeClient({ wallet, transport: this.transport });
    return this.exchange;
  }

  private getBaseUrl(): string {
    return this.config.hyperliquid?.baseUrl ?? 'https://api.hyperliquid.xyz';
  }

  private getSharedCacheTtlMs(): number {
    const ttl = Number((this.config.hyperliquid as { cacheTtlMs?: unknown } | undefined)?.cacheTtlMs);
    return Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_SHARED_CACHE_TTL_MS;
  }

  private getSharedMidsCacheTtlMs(): number {
    const ttl = Number((this.config.hyperliquid as { midsCacheTtlMs?: unknown } | undefined)?.midsCacheTtlMs);
    return Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_SHARED_MIDS_CACHE_TTL_MS;
  }

  private getSharedCacheKey(scope: string): string {
    return `${this.getBaseUrl()}:${scope}`;
  }

  async listPerpDexs(): Promise<string[]> {
    const cacheKey = this.getSharedCacheKey('perpDexs');
    const now = Date.now();
    const cached = perpDexsCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }

    const existing = inFlightPerpDexs.get(cacheKey);
    if (existing) {
      return existing;
    }

    const request = (async () => {
      const response = await this.withInfoRequestLimit(() => this.info.perpDexs());
      const dexs = (response as PerpDexsResponse)
        .flatMap((entry) => (entry?.name ? [entry.name] : []))
        .filter((name) => name.trim().length > 0);
      perpDexsCache.set(cacheKey, {
        value: dexs,
        expiresAt: Date.now() + this.getSharedCacheTtlMs(),
      });
      return dexs;
    })();

    inFlightPerpDexs.set(cacheKey, request);
    try {
      return await request;
    } finally {
      inFlightPerpDexs.delete(cacheKey);
    }
  }

  async listPerpMarkets(): Promise<HyperliquidMarket[]> {
    const dexs = await this.listPerpDexs();
    const metas = await Promise.all([
      this.withInfoRequestLimit(() => this.info.meta()),
      ...dexs.map((dex) => this.withInfoRequestLimit(() => this.info.meta({ dex }))),
    ]);

    return metas.flatMap((meta, metaIndex) => {
      const dex = metaIndex === 0 ? null : dexs[metaIndex - 1] ?? null;
      const universe = (meta as { universe?: HyperliquidMetaUniverse }).universe ?? [];
      return universe.map((item, idx) => ({
        symbol: item.name,
        assetId: idx,
        dex,
        maxLeverage: item.maxLeverage,
        szDecimals: item.szDecimals,
      }));
    });
  }

  async getAllMids(): Promise<Record<string, number>> {
    const cacheKey = this.getSharedCacheKey('allMids');
    const now = Date.now();
    const cached = midsCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }

    const existing = inFlightMids.get(cacheKey);
    if (existing) {
      return existing;
    }

    const request = (async () => {
      try {
        const [mids, dexs] = await Promise.all([
          this.withInfoRequestLimit(() => this.info.allMids()),
          this.listPerpDexs(),
        ]);
        const out: Record<string, number> = {};
        for (const [symbol, value] of Object.entries(mids ?? {})) {
          const num = Number(value);
          if (Number.isFinite(num)) {
            out[symbol] = num;
          }
        }

        const dexContexts = await Promise.all(
          dexs.map(async (dex) => ({
            dex,
            response: await this.withInfoRequestLimit(() => this.info.metaAndAssetCtxs({ dex })),
          }))
        );
        for (const { response } of dexContexts) {
          const [meta, assetCtxs] = response as MetaAndAssetCtxsResponse;
          const universe = (meta as { universe?: HyperliquidMetaUniverse }).universe ?? [];
          for (const [idx, market] of universe.entries()) {
            const ctx = assetCtxs[idx] as HyperliquidPerpAssetCtx | undefined;
            const num = Number(ctx?.markPx ?? NaN);
            if (Number.isFinite(num)) {
              out[market.name] = num;
            }
          }
        }
        midsCache.set(cacheKey, {
          value: out,
          expiresAt: Date.now() + this.getSharedMidsCacheTtlMs(),
        });
        return out;
      } catch (error) {
        if (cached && isTransientInfoError(error)) {
          return cached.value;
        }
        throw error;
      }
    })();

    inFlightMids.set(cacheKey, request);
    try {
      return await request;
    } finally {
      inFlightMids.delete(cacheKey);
    }
  }

  async getMetaAndAssetCtxs(): Promise<MetaAndAssetCtxsResponse> {
    return this.withInfoRequestLimit(() => this.info.metaAndAssetCtxs());
  }

  async getMergedMetaAndAssetCtxs(): Promise<HyperliquidMergedMetaAndAssetCtxsResponse> {
    const cacheKey = this.getSharedCacheKey('mergedMetaAndAssetCtxs');
    const now = Date.now();
    const cached = mergedMetaCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }

    const existing = inFlightMergedMeta.get(cacheKey);
    if (existing) {
      return existing;
    }

    const request = (async () => {
      const dexs = await this.listPerpDexs();
      const responses = await Promise.all([
        this.withInfoRequestLimit(() => this.info.metaAndAssetCtxs()),
        ...dexs.map((dex) => this.withInfoRequestLimit(() => this.info.metaAndAssetCtxs({ dex }))),
      ]);

      const universe: HyperliquidMetaUniverse = [];
      const assetCtxs: unknown[] = [];
      for (const response of responses) {
        const [meta, contexts] = response as MetaAndAssetCtxsResponse;
        const scopedUniverse = (meta as { universe?: HyperliquidMetaUniverse }).universe ?? [];
        const scopedCtxs = Array.isArray(contexts) ? contexts : [];
        for (const [idx, market] of scopedUniverse.entries()) {
          universe.push(market);
          assetCtxs.push(scopedCtxs[idx] ?? {});
        }
      }

      const merged: HyperliquidMergedMetaAndAssetCtxsResponse = [{ universe }, assetCtxs];
      mergedMetaCache.set(cacheKey, {
        value: merged,
        expiresAt: Date.now() + this.getSharedCacheTtlMs(),
      });
      return merged;
    })();

    inFlightMergedMeta.set(cacheKey, request);
    try {
      return await request;
    } finally {
      inFlightMergedMeta.delete(cacheKey);
    }
  }

  async getFundingHistory(
    coin: string,
    startTime: number,
    endTime?: number
  ): Promise<FundingHistoryResponse> {
    return this.withInfoRequestLimit(() => this.info.fundingHistory({ coin, startTime, endTime }));
  }

  async getRecentTrades(coin: string): Promise<RecentTradesResponse> {
    return this.withInfoRequestLimit(() => this.info.recentTrades({ coin }));
  }

  async getL2Book(coin: string): Promise<L2BookResponse> {
    return this.withInfoRequestLimit(() => this.info.l2Book({ coin }));
  }

  async getCandleSnapshot(params: {
    coin: string;
    interval: '1m' | '3m' | '5m' | '15m' | '30m' | '1h' | '2h' | '4h' | '8h' | '12h' | '1d' | '3d' | '1w' | '1M';
    startTime: number;
    endTime?: number;
  }): Promise<Array<{ t: number; o: string; h: string; l: string; c: string; v: string }>> {
    return this.withInfoRequestLimit(() => this.info.candleSnapshot(params)) as Promise<
      Array<{ t: number; o: string; h: string; l: string; c: string; v: string }>
    >;
  }

  async getOpenOrders(): Promise<unknown[]> {
    const user = this.getAccountAddress();
    if (!user) {
      throw new Error(
        'Hyperliquid account address not configured (hyperliquid.accountAddress or HYPERLIQUID_ACCOUNT_ADDRESS).'
      );
    }
    return this.withInfoRequestLimit(() => this.info.openOrders({ user }));
  }

  async getClearinghouseState(): Promise<unknown> {
    const user = this.getAccountAddress();
    if (!user) {
      throw new Error(
        'Hyperliquid account address not configured (hyperliquid.accountAddress or HYPERLIQUID_ACCOUNT_ADDRESS).'
      );
    }
    return this.withInfoRequestLimit(() => this.info.clearinghouseState({ user }));
  }

  async getSpotClearinghouseState(params?: {
    dex?: string;
  }): Promise<SpotClearinghouseStateResponse> {
    const user = this.getAccountAddress();
    if (!user) {
      throw new Error(
        'Hyperliquid account address not configured (hyperliquid.accountAddress or HYPERLIQUID_ACCOUNT_ADDRESS).'
      );
    }
    return this.withInfoRequestLimit(() => this.info.spotClearinghouseState({ user, dex: params?.dex }));
  }

  async getUserFees(): Promise<UserFeesResponse> {
    const user = this.getAccountAddress();
    if (!user) {
      throw new Error(
        'Hyperliquid account address not configured (hyperliquid.accountAddress or HYPERLIQUID_ACCOUNT_ADDRESS).'
      );
    }
    return this.withInfoRequestLimit(() => this.info.userFees({ user }));
  }

  async getUserFillsByTime(params: {
    startTime: number;
    endTime?: number;
    aggregateByTime?: boolean;
  }): Promise<unknown[]> {
    const user = this.getAccountAddress();
    if (!user) {
      throw new Error(
        'Hyperliquid account address not configured (hyperliquid.accountAddress or HYPERLIQUID_ACCOUNT_ADDRESS).'
      );
    }
    return this.withInfoRequestLimit(() =>
      this.info.userFillsByTime({
        user,
        startTime: params.startTime,
        endTime: params.endTime,
        aggregateByTime: params.aggregateByTime,
      })
    );
  }

  async getPortfolioMetrics(): Promise<PortfolioResponse> {
    const user = this.getAccountAddress();
    if (!user) {
      throw new Error(
        'Hyperliquid account address not configured (hyperliquid.accountAddress or HYPERLIQUID_ACCOUNT_ADDRESS).'
      );
    }
    return this.withInfoRequestLimit(() => this.info.portfolio({ user }));
  }
}

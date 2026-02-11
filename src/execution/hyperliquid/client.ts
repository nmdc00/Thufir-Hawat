import type { ThufirConfig } from '../../core/config.js';
import { HttpTransport, InfoClient, ExchangeClient } from '@nktkas/hyperliquid';
import type {
  FundingHistoryResponse,
  L2BookResponse,
  MetaAndAssetCtxsResponse,
  RecentTradesResponse,
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
  maxLeverage?: number;
  szDecimals?: number;
};

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

  async listPerpMarkets(): Promise<HyperliquidMarket[]> {
    const meta = await this.info.meta();
    const universe = (meta as { universe?: HyperliquidMetaUniverse }).universe ?? [];
    return universe.map((item, idx) => ({
      symbol: item.name,
      assetId: idx,
      maxLeverage: item.maxLeverage,
      szDecimals: item.szDecimals,
    }));
  }

  async getAllMids(): Promise<Record<string, number>> {
    const mids = await this.info.allMids();
    const out: Record<string, number> = {};
    for (const [symbol, value] of Object.entries(mids ?? {})) {
      const num = Number(value);
      if (Number.isFinite(num)) {
        out[symbol] = num;
      }
    }
    return out;
  }

  async getMetaAndAssetCtxs(): Promise<MetaAndAssetCtxsResponse> {
    return this.info.metaAndAssetCtxs();
  }

  async getFundingHistory(
    coin: string,
    startTime: number,
    endTime?: number
  ): Promise<FundingHistoryResponse> {
    return this.info.fundingHistory({ coin, startTime, endTime });
  }

  async getRecentTrades(coin: string): Promise<RecentTradesResponse> {
    return this.info.recentTrades({ coin });
  }

  async getL2Book(coin: string): Promise<L2BookResponse> {
    return this.info.l2Book({ coin });
  }

  async getOpenOrders(): Promise<unknown[]> {
    const user = this.getAccountAddress();
    if (!user) {
      throw new Error(
        'Hyperliquid account address not configured (hyperliquid.accountAddress or HYPERLIQUID_ACCOUNT_ADDRESS).'
      );
    }
    return this.info.openOrders({ user });
  }

  async getClearinghouseState(): Promise<unknown> {
    const user = this.getAccountAddress();
    if (!user) {
      throw new Error(
        'Hyperliquid account address not configured (hyperliquid.accountAddress or HYPERLIQUID_ACCOUNT_ADDRESS).'
      );
    }
    return this.info.clearinghouseState({ user });
  }
}

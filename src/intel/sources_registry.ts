import type { ThufirConfig } from '../core/config.js';

export type IntelSourceName =
  | 'rss'
  | 'newsapi'
  | 'googlenews'
  | 'twitter'
  | 'polymarketComments';

export type IntelSourceType = 'news' | 'social' | 'market';
export type IntelTrust = 'low' | 'medium' | 'high';

export interface IntelSourceDescriptor {
  name: IntelSourceName;
  label: string;
  type: IntelSourceType;
  trust: IntelTrust;
  queryCapable: boolean;
  enabled: boolean;
  configured: boolean;
  roamable: boolean;
}

const trustOrder: Record<IntelTrust, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

export function listIntelSources(config: ThufirConfig): IntelSourceDescriptor[] {
  const sources = config.intel?.sources ?? {};
  const rss = sources.rss as { enabled?: boolean; feeds?: Array<{ url: string }> } | undefined;
  const newsapi = sources.newsapi as { enabled?: boolean; apiKey?: string } | undefined;
  const googlenews = sources.googlenews as { enabled?: boolean; serpApiKey?: string } | undefined;
  const twitter = sources.twitter as { enabled?: boolean; bearerToken?: string } | undefined;
  const polymarketComments = sources.polymarketComments as { enabled?: boolean } | undefined;

  const entries: IntelSourceDescriptor[] = [
    {
      name: 'rss',
      label: 'RSS',
      type: 'news',
      trust: 'high',
      queryCapable: false,
      enabled: rss?.enabled ?? false,
      configured: (rss?.feeds ?? []).length > 0,
      roamable: true,
    },
    {
      name: 'newsapi',
      label: 'NewsAPI',
      type: 'news',
      trust: 'medium',
      queryCapable: true,
      enabled: newsapi?.enabled ?? false,
      configured: Boolean(newsapi?.apiKey),
      roamable: true,
    },
    {
      name: 'googlenews',
      label: 'Google News',
      type: 'news',
      trust: 'medium',
      queryCapable: true,
      enabled: googlenews?.enabled ?? false,
      configured: Boolean(googlenews?.serpApiKey),
      roamable: true,
    },
    {
      name: 'twitter',
      label: 'X/Twitter',
      type: 'social',
      trust: 'low',
      queryCapable: true,
      enabled: twitter?.enabled ?? false,
      configured: Boolean(twitter?.bearerToken),
      roamable: true,
    },
    {
      name: 'polymarketComments',
      label: 'Polymarket Comments',
      type: 'market',
      trust: 'medium',
      queryCapable: false,
      enabled: polymarketComments?.enabled ?? false,
      configured: true,
      roamable: true,
    },
  ];

  return entries;
}

export function isSourceEnabled(config: ThufirConfig, name: IntelSourceName): boolean {
  const sources = config.intel?.sources ?? {};
  const entry = sources[name] as { enabled?: boolean } | undefined;
  return entry?.enabled ?? false;
}

export function isSourceAllowedForRoaming(
  config: ThufirConfig,
  descriptor: IntelSourceDescriptor
): boolean {
  const roaming = config.intel?.roaming;
  if (!roaming?.enabled) return false;
  if (!descriptor.roamable) return false;

  if (descriptor.type === 'social' && !roaming.socialOptIn) return false;

  const minTrust = roaming.minTrust ?? 'medium';
  if (trustOrder[descriptor.trust] < trustOrder[minTrust]) return false;

  if (roaming.allowSources && roaming.allowSources.length > 0) {
    return roaming.allowSources.includes(descriptor.name);
  }

  if (roaming.allowTypes && roaming.allowTypes.length > 0) {
    return roaming.allowTypes.includes(descriptor.type);
  }

  return true;
}

export function listRoamingSources(config: ThufirConfig): IntelSourceDescriptor[] {
  return listIntelSources(config).filter(
    (entry) => entry.enabled && isSourceAllowedForRoaming(config, entry)
  );
}

export function listQueryCapableRoamingSources(config: ThufirConfig): IntelSourceDescriptor[] {
  return listRoamingSources(config).filter((entry) => entry.queryCapable);
}

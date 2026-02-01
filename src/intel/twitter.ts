import type { ThufirConfig } from '../core/config.js';

export interface TwitterItem {
  title: string;
  content?: string;
  url?: string;
  publishedAt: string;
  source: string;
  category?: string;
}

export class TwitterFetcher {
  private bearer: string | undefined;
  private baseUrl: string;

  constructor(private config: ThufirConfig) {
    this.bearer =
      this.config.intel?.sources?.twitter?.bearerToken ??
      process.env.TWITTER_BEARER;
    this.baseUrl =
      this.config.intel?.sources?.twitter?.baseUrl ??
      'https://api.twitter.com/2';
  }

  async fetch(): Promise<TwitterItem[]> {
    if (!this.bearer) {
      return [];
    }

    const cfg = this.config.intel?.sources?.twitter;
    const keywords = cfg?.keywords ?? [];
    const accounts = cfg?.accounts ?? [];
    const max = Math.max(1, Math.min(100, cfg?.maxTweetsPerFetch ?? 25));
    const results: TwitterItem[] = [];

    const queries: string[] = [];
    if (keywords.length > 0) {
      queries.push(keywords.slice(0, 5).join(' OR '));
    }
    if (accounts.length > 0) {
      const handles = accounts.slice(0, 5).map((a) => `from:${a}`);
      queries.push(handles.join(' OR '));
    }
    if (queries.length === 0) {
      queries.push('prediction market OR polymarket');
    }

    for (const query of queries) {
      const url = new URL(`${this.baseUrl}/tweets/search/recent`);
      url.searchParams.set('query', query);
      url.searchParams.set('max_results', String(Math.min(100, max)));
      url.searchParams.set('tweet.fields', 'created_at,author_id');

      try {
        const response = await fetch(url.toString(), {
          headers: { Authorization: `Bearer ${this.bearer}` },
        });
        if (!response.ok) {
          continue;
        }
        const data = (await response.json()) as {
          data?: Array<{
            id: string;
            text: string;
            created_at?: string;
            author_id?: string;
          }>;
        };

        for (const tweet of data.data ?? []) {
          const text = tweet.text ?? '';
          const trimmed = text.replace(/\s+/g, ' ').trim();
          results.push({
            title: trimmed.slice(0, 120) || 'Tweet',
            content: trimmed,
            url: `https://twitter.com/i/web/status/${tweet.id}`,
            publishedAt: tweet.created_at ?? new Date().toISOString(),
            source: 'Twitter/X',
          });
        }
      } catch {
        // ignore fetch errors to keep pipeline running
      }
    }

    return results.slice(0, max);
  }
}

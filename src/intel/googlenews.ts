import type { ThufirConfig } from '../core/config.js';

export interface GoogleNewsItem {
  title: string;
  content?: string;
  url?: string;
  publishedAt: string;
  source: string;
  category?: string;
}

export class GoogleNewsFetcher {
  private apiKey: string | undefined;
  private baseUrl: string;

  constructor(private config: ThufirConfig) {
    this.apiKey =
      this.config.intel?.sources?.googlenews?.serpApiKey ??
      process.env.SERPAPI_KEY;
    this.baseUrl =
      this.config.intel?.sources?.googlenews?.baseUrl ??
      'https://serpapi.com/search.json';
  }

  async fetch(): Promise<GoogleNewsItem[]> {
    if (!this.apiKey) {
      return [];
    }

    const cfg = this.config.intel?.sources?.googlenews;
    const queries = cfg?.queries ?? [];
    const gl = cfg?.country ?? 'us';
    const hl = cfg?.language ?? 'en';
    const num = Math.max(1, Math.min(100, cfg?.maxArticlesPerFetch ?? 20));

    const requests: string[] = [];
    const selectedQueries = queries.length > 0 ? queries.slice(0, 5) : ['latest'];

    for (const query of selectedQueries) {
      const url = new URL(this.baseUrl);
      url.searchParams.set('engine', 'google_news');
      url.searchParams.set('q', query);
      url.searchParams.set('api_key', this.apiKey);
      url.searchParams.set('hl', hl);
      url.searchParams.set('gl', gl);
      url.searchParams.set('num', String(num));
      requests.push(url.toString());
    }

    const items: GoogleNewsItem[] = [];

    for (const requestUrl of requests) {
      try {
        const response = await fetch(requestUrl);
        if (!response.ok) {
          continue;
        }
        const data = (await response.json()) as {
          news_results?: Array<{
            title?: string;
            link?: string;
            snippet?: string;
            source?: string;
            date?: string;
          }>;
        };

        for (const entry of data.news_results ?? []) {
          items.push({
            title: entry.title ?? 'Untitled',
            content: entry.snippet ?? undefined,
            url: entry.link ?? undefined,
            publishedAt: entry.date ?? new Date().toISOString(),
            source: entry.source ?? 'Google News',
          });
        }
      } catch {
        // ignore fetch errors to keep pipeline running
      }
    }

    return items;
  }
}

import type { ThufirConfig } from '../core/config.js';

export interface NewsApiItem {
  title: string;
  content?: string;
  url?: string;
  publishedAt: string;
  source: string;
  category?: string;
}

export class NewsApiFetcher {
  private apiKey: string | undefined;
  private baseUrl: string;

  constructor(private config: ThufirConfig) {
    this.apiKey =
      this.config.intel?.sources?.newsapi?.apiKey ?? process.env.NEWSAPI_KEY;
    this.baseUrl =
      this.config.intel?.sources?.newsapi?.baseUrl ?? 'https://newsapi.org/v2';
  }

  async fetch(): Promise<NewsApiItem[]> {
    if (!this.apiKey) {
      return [];
    }

    const cfg = this.config.intel?.sources?.newsapi;
    const categories = cfg?.categories ?? [];
    const countries = cfg?.countries ?? [];
    const queries = cfg?.queries ?? [];
    const pageSize = Math.max(1, Math.min(100, cfg?.maxArticlesPerFetch ?? 50));

    const requests: string[] = [];

    if (queries.length > 0) {
      for (const query of queries.slice(0, 5)) {
        const url = new URL(`${this.baseUrl}/everything`);
        url.searchParams.set('q', query);
        url.searchParams.set('pageSize', String(pageSize));
        url.searchParams.set('language', cfg?.language ?? 'en');
        requests.push(url.toString());
      }
    } else if (categories.length > 0 || countries.length > 0) {
      const url = new URL(`${this.baseUrl}/top-headlines`);
      if (categories.length > 0) {
        url.searchParams.set('category', categories[0]!);
      }
      if (countries.length > 0) {
        url.searchParams.set('country', countries[0]!);
      }
      url.searchParams.set('pageSize', String(pageSize));
      requests.push(url.toString());
    } else {
      const url = new URL(`${this.baseUrl}/top-headlines`);
      url.searchParams.set('country', 'us');
      url.searchParams.set('pageSize', String(pageSize));
      requests.push(url.toString());
    }

    const items: NewsApiItem[] = [];

    for (const requestUrl of requests) {
      try {
        const response = await fetch(requestUrl, {
          headers: {
            'X-Api-Key': this.apiKey,
          },
        });
        if (!response.ok) {
          continue;
        }
        const data = (await response.json()) as {
          status: string;
          articles?: Array<{
            title?: string;
            description?: string;
            content?: string;
            url?: string;
            publishedAt?: string;
            source?: { name?: string };
          }>;
        };

        for (const article of data.articles ?? []) {
          items.push({
            title: article.title ?? 'Untitled',
            content: article.description ?? article.content ?? undefined,
            url: article.url ?? undefined,
            publishedAt: article.publishedAt ?? new Date().toISOString(),
            source: article.source?.name ?? 'NewsAPI',
          });
        }
      } catch {
        // ignore fetch errors to keep pipeline running
      }
    }

    return items;
  }
}

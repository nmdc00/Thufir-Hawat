import Parser from 'rss-parser';

import type { ThufirConfig } from '../core/config.js';

export interface RssItem {
  title: string;
  content?: string;
  url?: string;
  publishedAt: string;
  source: string;
  category?: string;
}

export class RssFetcher {
  private parser = new Parser();

  constructor(private config: ThufirConfig) {}

  async fetch(): Promise<RssItem[]> {
    const feeds = this.config.intel?.sources?.rss?.feeds ?? [];
    const items: RssItem[] = [];

    for (const feed of feeds) {
      try {
        const parsed = await this.parser.parseURL(feed.url);
        for (const entry of parsed.items ?? []) {
          items.push({
            title: entry.title ?? 'Untitled',
            content: entry.contentSnippet ?? entry.content ?? undefined,
            url: entry.link ?? undefined,
            publishedAt: entry.isoDate ?? new Date().toISOString(),
            source: parsed.title ?? feed.url,
            category: feed.category,
          });
        }
      } catch {
        // ignore feed errors to keep pipeline running
      }
    }

    return items;
  }
}

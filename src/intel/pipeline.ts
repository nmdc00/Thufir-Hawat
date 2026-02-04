import { randomUUID } from 'node:crypto';

import type { ThufirConfig } from '../core/config.js';
import { RssFetcher } from './rss.js';
import { NewsApiFetcher } from './newsapi.js';
import { GoogleNewsFetcher } from './googlenews.js';
import { TwitterFetcher } from './twitter.js';
import { storeIntel, type StoredIntel } from './store.js';
import { IntelVectorStore } from './vectorstore.js';

export interface IntelPipelineResult {
  storedCount: number;
  storedItems: StoredIntel[];
}

export interface IntelPipelineOverrides {
  newsapiQueries?: string[];
  googlenewsQueries?: string[];
  twitterKeywords?: string[];
}

export async function runIntelPipeline(config: ThufirConfig): Promise<number> {
  const result = await runIntelPipelineDetailed(config);
  return result.storedCount;
}

export async function runIntelPipelineDetailedWithOverrides(
  config: ThufirConfig,
  overrides: IntelPipelineOverrides
): Promise<IntelPipelineResult> {
  const cloned = JSON.parse(JSON.stringify(config)) as ThufirConfig;

  if (overrides.newsapiQueries && cloned.intel?.sources?.newsapi) {
    cloned.intel.sources.newsapi.queries = overrides.newsapiQueries;
  }
  if (overrides.googlenewsQueries && cloned.intel?.sources?.googlenews) {
    cloned.intel.sources.googlenews.queries = overrides.googlenewsQueries;
  }
  if (overrides.twitterKeywords && cloned.intel?.sources?.twitter) {
    cloned.intel.sources.twitter.keywords = overrides.twitterKeywords;
  }

  return runIntelPipelineDetailed(cloned);
}

export async function runIntelPipelineDetailed(
  config: ThufirConfig
): Promise<IntelPipelineResult> {
  let stored = 0;
  const storedItems: StoredIntel[] = [];
  const vectorStore = new IntelVectorStore(config);
  const rssEnabled = config.intel?.sources?.rss?.enabled ?? false;
  const newsApiEnabled = config.intel?.sources?.newsapi?.enabled ?? false;
  const googleNewsEnabled = config.intel?.sources?.googlenews?.enabled ?? false;
  const twitterEnabled = config.intel?.sources?.twitter?.enabled ?? false;
  const commentsEnabled = false;

  if (rssEnabled) {
    const fetcher = new RssFetcher(config);
    const items = await fetcher.fetch();
    for (const item of items) {
      const id = randomUUID();
      const record: StoredIntel = {
        id,
        title: item.title,
        content: item.content,
        source: item.source,
        sourceType: 'news',
        category: item.category,
        url: item.url,
        timestamp: item.publishedAt,
      };
      const inserted = storeIntel(record);
      if (inserted) {
        await vectorStore.add({
          id,
          text: `${item.title}\n${item.content ?? ''}`.trim(),
        });
        storedItems.push(record);
        stored += 1;
      }
    }
  }

  if (newsApiEnabled) {
    const fetcher = new NewsApiFetcher(config);
    const items = await fetcher.fetch();
    for (const item of items) {
      const id = randomUUID();
      const record: StoredIntel = {
        id,
        title: item.title,
        content: item.content,
        source: item.source,
        sourceType: 'news',
        category: item.category,
        url: item.url,
        timestamp: item.publishedAt,
      };
      const inserted = storeIntel(record);
      if (inserted) {
        await vectorStore.add({
          id,
          text: `${item.title}\n${item.content ?? ''}`.trim(),
        });
        storedItems.push(record);
        stored += 1;
      }
    }
  }

  if (googleNewsEnabled) {
    const fetcher = new GoogleNewsFetcher(config);
    const items = await fetcher.fetch();
    for (const item of items) {
      const id = randomUUID();
      const record: StoredIntel = {
        id,
        title: item.title,
        content: item.content,
        source: item.source,
        sourceType: 'news',
        category: item.category,
        url: item.url,
        timestamp: item.publishedAt,
      };
      const inserted = storeIntel(record);
      if (inserted) {
        await vectorStore.add({
          id,
          text: `${item.title}\n${item.content ?? ''}`.trim(),
        });
        storedItems.push(record);
        stored += 1;
      }
    }
  }

  if (twitterEnabled) {
    const fetcher = new TwitterFetcher(config);
    const items = await fetcher.fetch();
    for (const item of items) {
      const id = randomUUID();
      const record: StoredIntel = {
        id,
        title: item.title,
        content: item.content,
        source: item.source,
        sourceType: 'social',
        category: item.category,
        url: item.url,
        timestamp: item.publishedAt,
      };
      const inserted = storeIntel(record);
      if (inserted) {
        await vectorStore.add({
          id,
          text: `${item.title}\n${item.content ?? ''}`.trim(),
        });
        storedItems.push(record);
        stored += 1;
      }
    }
  }

  if (commentsEnabled) {
    // Some market platforms do not provide public comment feeds.
  }

  return { storedCount: stored, storedItems };
}

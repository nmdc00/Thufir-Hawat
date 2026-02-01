import type { ThufirConfig } from '../core/config.js';

export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
}

interface EmbedderOptions {
  model?: string;
  apiBaseUrl?: string;
}

type EmbeddingScope = 'intel' | 'memory';

export function createEmbedder(config: ThufirConfig, scope: EmbeddingScope): Embedder {
  const settings = scope === 'intel' ? config.intel?.embeddings : config.memory?.embeddings;
  const provider = settings?.provider ?? 'openai';
  const model = settings?.model;
  const apiBaseUrl = settings?.apiBaseUrl;

  if (provider === 'google') {
    return new GoogleGeminiEmbedder(config, { model, apiBaseUrl });
  }
  return new OpenAiEmbedder(config, { model, apiBaseUrl });
}

export class OpenAiEmbedder implements Embedder {
  private apiKey: string;
  private model: string;
  private baseUrl: string;

  constructor(config: ThufirConfig, options?: EmbedderOptions) {
    this.apiKey = process.env.OPENAI_API_KEY ?? '';
    const fallbackModel =
      config.intel?.embeddings?.model ??
      config.memory?.embeddings?.model ??
      'text-embedding-3-small';
    const fallbackBase =
      config.intel?.embeddings?.apiBaseUrl ??
      config.memory?.embeddings?.apiBaseUrl ??
      'https://api.openai.com';
    this.model = options?.model ?? fallbackModel;
    this.baseUrl = options?.apiBaseUrl ?? fallbackBase;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!this.apiKey) {
      return [];
    }

    const response = await fetch(`${this.baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
      }),
    });

    if (!response.ok) {
      return [];
    }

    const data = (await response.json()) as {
      data?: Array<{ embedding: number[] }>;
    };

    return (data.data ?? []).map((item) => item.embedding);
  }
}

export class GoogleGeminiEmbedder implements Embedder {
  private apiKey: string;
  private model: string;
  private baseUrl: string;

  constructor(config: ThufirConfig, options?: EmbedderOptions) {
    this.apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? '';
    this.model =
      options?.model ??
      config.intel?.embeddings?.model ??
      config.memory?.embeddings?.model ??
      'gemini-embedding-001';
    this.baseUrl =
      options?.apiBaseUrl ??
      config.intel?.embeddings?.apiBaseUrl ??
      config.memory?.embeddings?.apiBaseUrl ??
      'https://generativelanguage.googleapis.com/v1beta';
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!this.apiKey) {
      return [];
    }

    const modelPath = this.model.startsWith('models/') ? this.model : `models/${this.model}`;
    const url = new URL(`${this.baseUrl}/${modelPath}:batchEmbedContents`);
    url.searchParams.set('key', this.apiKey);

    const body = {
      requests: texts.map((text) => ({
        model: modelPath,
        content: { parts: [{ text }] },
      })),
    };

    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      return [];
    }

    const data = (await response.json()) as {
      embeddings?: Array<{ values?: number[] }>;
    };

    return (data.embeddings ?? []).map((item) => item.values ?? []);
  }
}

import type { ThufirConfig } from '../core/config.js';
import { openDatabase } from '../memory/db.js';
import { createEmbedder, type Embedder } from './embeddings.js';

export interface VectorHit {
  id: string;
  score: number;
}

export class IntelVectorStore {
  private enabled: boolean;
  private embedder: Embedder;

  constructor(config: ThufirConfig, embedder?: Embedder) {
    this.enabled = config.intel?.embeddings?.enabled ?? false;
    this.embedder = embedder ?? createEmbedder(config, 'intel');
  }

  async add(params: { id: string; text: string }): Promise<boolean> {
    if (!this.enabled) {
      return false;
    }

    const vectors = await this.embedder.embed([params.text]);
    const vector = vectors[0];
    if (!vector || vector.length === 0) {
      return false;
    }

    const db = openDatabase();
    db.prepare(
      `
        INSERT OR REPLACE INTO intel_embeddings (intel_id, embedding, created_at)
        VALUES (?, ?, datetime('now'))
      `
    ).run(params.id, JSON.stringify(vector));

    return true;
  }

  async query(text: string, limit = 5): Promise<VectorHit[]> {
    if (!this.enabled) {
      return [];
    }

    const vectors = await this.embedder.embed([text]);
    const query = vectors[0];
    if (!query || query.length === 0) {
      return [];
    }

    const db = openDatabase();
    const rows = db
      .prepare(`SELECT intel_id as id, embedding FROM intel_embeddings`)
      .all() as Array<{ id: string; embedding: string }>;

    const hits: VectorHit[] = [];
    for (const row of rows) {
      const vector = parseEmbedding(row.embedding);
      if (!vector || vector.length === 0) {
        continue;
      }
      const score = cosineSimilarity(query, vector);
      hits.push({ id: String(row.id), score });
    }

    return hits
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, limit));
  }
}

function parseEmbedding(raw: string): number[] | null {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed as number[];
    }
  } catch {
    return null;
  }
  return null;
}

function cosineSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  if (length === 0) {
    return 0;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < length; i++) {
    const av = a[i]!;
    const bv = b[i]!;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }

  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

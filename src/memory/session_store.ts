import { mkdirSync, existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { ChatMessage } from '../core/llm.js';
import type { LlmClient } from '../core/llm.js';
import type { ThufirConfig } from '../core/config.js';

export interface SessionMeta {
  sessionId: string;
  userId: string;
  lastActive: string;
  summary?: string;
  updatedAt: string;
}

export interface TranscriptEntry {
  type: 'message' | 'summary';
  role?: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
}

export class SessionStore {
  private baseDir: string;
  private sessionsPath: string;
  private transcriptsDir: string;
  private meta: Record<string, SessionMeta> = {};

  constructor(_config: ThufirConfig) {
    const base =
      _config.memory?.sessionsPath ?? join(homedir(), '.thufir', 'sessions');
    this.baseDir = base;
    this.sessionsPath = join(base, 'sessions.json');
    this.transcriptsDir = join(base, 'transcripts');
    this.ensureDirs();
    this.meta = this.loadMeta();
  }

  getSessionId(userId: string): string {
    if (this.meta[userId]) {
      return this.meta[userId]!.sessionId;
    }
    const sessionId = sanitizeId(userId);
    const now = new Date().toISOString();
    this.meta[userId] = {
      sessionId,
      userId,
      lastActive: now,
      updatedAt: now,
    };
    this.saveMeta();
    return sessionId;
  }

  getSummary(userId: string): string | undefined {
    return this.meta[userId]?.summary;
  }

  updateSummary(userId: string, summary: string): void {
    const now = new Date().toISOString();
    const sessionId = this.getSessionId(userId);
    this.meta[userId] = {
      sessionId,
      userId,
      lastActive: now,
      updatedAt: now,
      summary,
    };
    this.saveMeta();
  }

  appendEntry(userId: string, entry: TranscriptEntry): void {
    const sessionId = this.getSessionId(userId);
    const path = this.transcriptPath(sessionId);
    appendFileSync(path, JSON.stringify(entry) + '\n', 'utf-8');
    this.touch(userId);
  }

  listMessageEntries(userId: string): TranscriptEntry[] {
    const sessionId = this.getSessionId(userId);
    const path = this.transcriptPath(sessionId);
    if (!existsSync(path)) {
      return [];
    }
    const lines = readFileSync(path, 'utf-8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const entries: TranscriptEntry[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as TranscriptEntry;
        if (parsed.type === 'message') {
          entries.push(parsed);
        }
      } catch {
        continue;
      }
    }
    return entries;
  }

  listEntries(userId: string): TranscriptEntry[] {
    const sessionId = this.getSessionId(userId);
    const path = this.transcriptPath(sessionId);
    if (!existsSync(path)) {
      return [];
    }
    const lines = readFileSync(path, 'utf-8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const entries: TranscriptEntry[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as TranscriptEntry;
        entries.push(parsed);
      } catch {
        continue;
      }
    }
    return entries;
  }

  buildContextMessages(userId: string, maxMessages: number): ChatMessage[] {
    const entries = this.listMessageEntries(userId);
    const slice = entries.slice(-Math.max(1, maxMessages));
    return slice.map((entry) => ({
      role: entry.role ?? 'user',
      content: entry.content,
    }));
  }

  async compactIfNeeded(params: {
    userId: string;
    llm: LlmClient;
    maxMessages: number;
    compactAfterTokens: number;
    keepRecent: number;
  }): Promise<void> {
    const { userId, llm, maxMessages, compactAfterTokens, keepRecent } = params;
    const entries = this.listMessageEntries(userId);
    if (entries.length <= maxMessages) {
      return;
    }

    const recent = entries.slice(-Math.max(1, keepRecent));
    const older = entries.slice(0, Math.max(0, entries.length - keepRecent));

    const summaryText = this.getSummary(userId);
    const messagesText = older
      .map((entry) => `${entry.role ?? 'user'}: ${entry.content}`)
      .join('\n');

    const approxTokens = Math.ceil(messagesText.length / 4);
    if (approxTokens < compactAfterTokens) {
      return;
    }

    const prompt = `
Summarize the conversation so far into concise, factual memory for future context.
Focus on: user preferences, decisions, trade rationale, and any named entities.
Keep it under 200 words.

Existing summary (if any):
${summaryText ?? '(none)'}

New content to summarize:
${messagesText}
`.trim();

    const response = await llm.complete(
      [
        { role: 'system', content: 'You are a precise summarizer.' },
        { role: 'user', content: prompt },
      ],
      { temperature: 0.2 }
    );

    const summary = response.content.trim();
    this.updateSummary(userId, summary);
    const summaryEntry: TranscriptEntry = {
      type: 'summary',
      content: summary,
      timestamp: new Date().toISOString(),
    };

    // Rewrite transcript to keep summary + recent messages only
    const sessionId = this.getSessionId(userId);
    const path = this.transcriptPath(sessionId);
    const entriesToKeep: TranscriptEntry[] = [
      summaryEntry,
      ...recent.map((entry) => ({
        type: 'message' as const,
        role: entry.role,
        content: entry.content,
        timestamp: entry.timestamp,
      })),
    ];
    writeFileSync(
      path,
      entriesToKeep.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
      'utf-8'
    );
  }

  clearSession(userId: string): void {
    const sessionId = this.getSessionId(userId);
    const path = this.transcriptPath(sessionId);
    if (existsSync(path)) {
      writeFileSync(path, '', 'utf-8');
    }
    if (this.meta[userId]) {
      delete this.meta[userId];
      this.saveMeta();
    }
  }

  listSessions(): SessionMeta[] {
    return Object.values(this.meta).sort((a, b) =>
      a.lastActive < b.lastActive ? 1 : -1
    );
  }

  private touch(userId: string): void {
    const now = new Date().toISOString();
    const sessionId = this.getSessionId(userId);
    this.meta[userId] = {
      ...this.meta[userId],
      sessionId,
      userId,
      lastActive: now,
      updatedAt: now,
    };
    this.saveMeta();
  }

  private transcriptPath(sessionId: string): string {
    return join(this.transcriptsDir, `${sessionId}.jsonl`);
  }

  private loadMeta(): Record<string, SessionMeta> {
    if (!existsSync(this.sessionsPath)) {
      return {};
    }
    try {
      const raw = readFileSync(this.sessionsPath, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, SessionMeta>;
      return parsed ?? {};
    } catch {
      return {};
    }
  }

  private saveMeta(): void {
    writeFileSync(this.sessionsPath, JSON.stringify(this.meta, null, 2), 'utf-8');
  }

  private ensureDirs(): void {
    mkdirSync(this.baseDir, { recursive: true });
    mkdirSync(this.transcriptsDir, { recursive: true });
  }
}

function sanitizeId(input: string): string {
  const normalized = input.trim().replace(/[^\w.-]+/g, '_');
  return normalized.length > 0 ? normalized : `session_${Date.now()}`;
}

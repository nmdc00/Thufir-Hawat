import fetch from 'node-fetch';

import type { ThufirConfig } from '../core/config.js';
import type { IncomingMessage, ChannelAdapter } from './channels.js';

const TELEGRAM_MAX_MESSAGE_CHARS = 4000; // Telegram hard limit is 4096; keep headroom.

function splitTelegramMessage(text: string, maxChars: number = TELEGRAM_MAX_MESSAGE_CHARS): string[] {
  const normalized = (text ?? '').toString();
  if (normalized.length <= maxChars) return [normalized];

  // Pack by lines first to preserve readability.
  const lines = normalized.split('\n');
  const out: string[] = [];
  let buf = '';

  const pushBuf = () => {
    const trimmed = buf.trimEnd();
    if (trimmed.length > 0) out.push(trimmed);
    buf = '';
  };

  const pushLong = (s: string) => {
    let rest = s;
    while (rest.length > maxChars) {
      // Try a word boundary split.
      let cut = rest.lastIndexOf(' ', maxChars);
      if (cut < Math.floor(maxChars * 0.5)) {
        // Fallback: hard split (e.g. long URLs / unbroken text).
        cut = maxChars;
      }
      out.push(rest.slice(0, cut).trimEnd());
      rest = rest.slice(cut).trimStart();
    }
    if (rest.length > 0) out.push(rest);
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const candidate = buf.length === 0 ? line : `${buf}\n${line}`;
    if (candidate.length <= maxChars) {
      buf = candidate;
      continue;
    }

    // Buffer can't fit this line. Flush buffer first, then handle the line.
    pushBuf();
    if (line.length > maxChars) {
      pushLong(line);
    } else {
      buf = line;
    }
  }

  pushBuf();
  return out.length > 0 ? out : [''];
}

export class TelegramAdapter implements ChannelAdapter {
  name = 'telegram';
  private token: string;
  private allowedChatIds: Set<string>;
  private pollingInterval: number;
  private lastUpdateId = 0;
  private onMessageTimeoutMs: number;

  constructor(config: ThufirConfig) {
    this.token = config.channels.telegram.token ?? '';
    this.allowedChatIds = new Set(
      (config.channels.telegram.allowedChatIds ?? []).map((id) => String(id))
    );
    this.pollingInterval = config.channels.telegram.pollingInterval ?? 5;
    this.onMessageTimeoutMs = Math.max(
      1_000,
      Number(process.env.THUFIR_CHANNEL_HANDLER_TIMEOUT_MS ?? 45_000)
    );
  }

  async sendMessage(target: string, text: string): Promise<void> {
    const chunks = splitTelegramMessage(text);
    for (const chunk of chunks) {
      const response = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: target, text: chunk }),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(
          `Telegram send failed (${response.status}): ${body || 'no response body'}`
        );
      }
    }
  }

  startPolling(onMessage: (msg: IncomingMessage) => Promise<void>): void {
    const callHandler = async (msg: IncomingMessage) => {
      const timeoutError = new Error(
        `Telegram onMessage timed out after ${this.onMessageTimeoutMs}ms`
      );
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(timeoutError), this.onMessageTimeoutMs);
      });
      await Promise.race([onMessage(msg), timeoutPromise]);
    };

    const loop = async () => {
      try {
        const url = new URL(`https://api.telegram.org/bot${this.token}/getUpdates`);
        if (this.lastUpdateId > 0) {
          url.searchParams.set('offset', String(this.lastUpdateId + 1));
        }
        const response = await fetch(url.toString());
        if (response.ok) {
          const data = (await response.json()) as { result: Array<any> };
          for (const update of data.result ?? []) {
            this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id);
            const message = update.message ?? update.edited_message;
            if (!message?.text) {
              continue;
            }
            const chatId = String(message.chat.id);
            const chatType = String(message.chat.type ?? 'private');
            const peerKind =
              chatType === 'group' || chatType === 'supergroup'
                ? 'group'
                : chatType === 'channel'
                  ? 'channel'
                  : 'dm';
            if (this.allowedChatIds.size > 0 && !this.allowedChatIds.has(chatId)) {
              continue;
            }
            try {
              await callHandler({
                channel: 'telegram',
                senderId: chatId,
                peerKind,
                text: message.text.trim(),
              });
            } catch (error) {
              const detail = error instanceof Error ? error.message : String(error);
              console.error(`Telegram polling handler failed for chat ${chatId}: ${detail}`);
            }
          }
        }
      } catch (error) {
        // Keep polling even if transport fails.
        const detail = error instanceof Error ? error.message : String(error);
        console.error(`Telegram polling loop error: ${detail}`);
      } finally {
        setTimeout(loop, this.pollingInterval * 1000);
      }
    };

    loop();
  }
}

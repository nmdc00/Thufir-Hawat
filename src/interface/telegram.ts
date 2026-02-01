import fetch from 'node-fetch';

import type { ThufirConfig } from '../core/config.js';
import type { IncomingMessage, ChannelAdapter } from './channels.js';

export class TelegramAdapter implements ChannelAdapter {
  name = 'telegram';
  private token: string;
  private allowedChatIds: Set<string>;
  private pollingInterval: number;
  private lastUpdateId = 0;

  constructor(config: ThufirConfig) {
    this.token = config.channels.telegram.token ?? '';
    this.allowedChatIds = new Set(
      (config.channels.telegram.allowedChatIds ?? []).map((id) => String(id))
    );
    this.pollingInterval = config.channels.telegram.pollingInterval ?? 5;
  }

  async sendMessage(target: string, text: string): Promise<void> {
    const response = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: target, text }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `Telegram send failed (${response.status}): ${body || 'no response body'}`
      );
    }
  }

  startPolling(onMessage: (msg: IncomingMessage) => Promise<void>): void {
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
            await onMessage({
              channel: 'telegram',
              senderId: chatId,
              peerKind,
              text: message.text.trim(),
            });
          }
        }
      } catch {
        // swallow errors to keep polling
      } finally {
        setTimeout(loop, this.pollingInterval * 1000);
      }
    };

    loop();
  }
}

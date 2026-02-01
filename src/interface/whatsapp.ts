import fetch from 'node-fetch';

import type { ThufirConfig } from '../core/config.js';
import type { IncomingMessage, ChannelAdapter } from './channels.js';

export class WhatsAppAdapter implements ChannelAdapter {
  name = 'whatsapp';
  private accessToken: string;
  private phoneNumberId: string;
  private verifyToken: string;
  private allowedNumbers: Set<string>;

  constructor(config: ThufirConfig) {
    this.accessToken = config.channels.whatsapp.accessToken ?? '';
    this.phoneNumberId = config.channels.whatsapp.phoneNumberId ?? '';
    this.verifyToken = config.channels.whatsapp.verifyToken ?? '';
    this.allowedNumbers = new Set(config.channels.whatsapp.allowedNumbers ?? []);
  }

  getVerifyToken(): string {
    return this.verifyToken;
  }

  isAllowed(sender: string): boolean {
    return this.allowedNumbers.size === 0 || this.allowedNumbers.has(sender);
  }

  async sendMessage(target: string, text: string): Promise<void> {
    const url = `https://graph.facebook.com/v19.0/${this.phoneNumberId}/messages`;
    await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: target,
        type: 'text',
        text: { body: text },
      }),
    });
  }

  async handleWebhook(body: any, onMessage: (msg: IncomingMessage) => Promise<void>): Promise<void> {
    const entries = body?.entry ?? [];
    for (const entry of entries) {
      for (const change of entry.changes ?? []) {
        const value = change.value;
        const messages = value?.messages ?? [];
        for (const msg of messages) {
          if (msg.type !== 'text') {
            continue;
          }
          const sender = msg.from;
          if (!this.isAllowed(sender)) {
            continue;
          }
          await onMessage({
            channel: 'whatsapp',
            senderId: sender,
            peerKind: 'dm',
            text: msg.text?.body?.trim() ?? '',
          });
        }
      }
    }
  }
}

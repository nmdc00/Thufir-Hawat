export interface IncomingMessage {
  channel: 'telegram' | 'whatsapp' | 'cli';
  senderId: string;
  text: string;
  peerKind?: 'dm' | 'group' | 'channel';
  threadId?: string;
}

export interface ChannelAdapter {
  name: string;
  sendMessage(target: string, text: string): Promise<void>;
}

import { randomUUID } from 'crypto';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import {
  Channel,
  NewMessage,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';
import { registerChannel, ChannelOpts } from './registry.js';

interface OneBotEnvelope {
  [key: string]: unknown;
  echo?: string;
  status?: string;
  retcode?: number;
  data?: unknown;
  post_type?: string;
  message_type?: string;
  self_id?: number | string;
  user_id?: number | string;
  group_id?: number | string;
  message_id?: number | string;
  raw_message?: string;
  message?: string | OneBotMessageSegment[];
  sender?: {
    card?: string;
    nickname?: string;
    user_id?: number | string;
  };
}

interface OneBotMessageSegment {
  type: string;
  data?: Record<string, string>;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface QQChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

function buildWsUrl(url: string, token: string): string {
  const target = new URL(normalizeWsUrl(url));
  if (token && !target.searchParams.has('access_token')) {
    target.searchParams.set('access_token', token);
  }
  return target.toString();
}

function normalizeWsUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return trimmed;
  if (/^wss?:\/\//i.test(trimmed)) return trimmed;
  return `ws://${trimmed}`;
}

function toChatJid(event: OneBotEnvelope): string | null {
  if (event.message_type === 'group' && event.group_id != null) {
    return `qqg:${event.group_id}`;
  }
  if (event.message_type === 'private' && event.user_id != null) {
    return `qq:${event.user_id}`;
  }
  return null;
}

function isGroupEvent(event: OneBotEnvelope): boolean {
  return event.message_type === 'group';
}

function getSenderId(event: OneBotEnvelope): string {
  return String(event.sender?.user_id ?? event.user_id ?? '');
}

function getSenderName(event: OneBotEnvelope): string {
  return (
    event.sender?.card ||
    event.sender?.nickname ||
    String(event.sender?.user_id ?? event.user_id ?? 'Unknown')
  );
}

function extractTextFromSegments(segments: OneBotMessageSegment[]): string {
  const parts: string[] = [];

  for (const segment of segments) {
    switch (segment.type) {
      case 'text':
        if (segment.data?.text) parts.push(segment.data.text);
        break;
      case 'at':
        if (segment.data?.qq === 'all') {
          parts.push('@all');
        } else if (segment.data?.qq) {
          parts.push(`@${segment.data.qq}`);
        }
        break;
      case 'image':
        parts.push('[Image]');
        break;
      case 'face':
        parts.push('[Emoji]');
        break;
      case 'reply':
        parts.push('[Reply]');
        break;
      case 'record':
        parts.push('[Voice]');
        break;
      case 'video':
        parts.push('[Video]');
        break;
      case 'file':
        parts.push(segment.data?.name ? `[File: ${segment.data.name}]` : '[File]');
        break;
      case 'json':
        parts.push('[JSON]');
        break;
      case 'xml':
        parts.push('[XML]');
        break;
      default:
        parts.push(`[${segment.type}]`);
        break;
    }
  }

  return parts.join('').trim();
}

function extractMessageText(event: OneBotEnvelope): string {
  if (typeof event.raw_message === 'string' && event.raw_message.trim()) {
    return event.raw_message.trim();
  }
  if (typeof event.message === 'string') {
    return event.message.trim();
  }
  if (Array.isArray(event.message)) {
    return extractTextFromSegments(event.message);
  }
  return '';
}

function maybeTranslateMention(text: string, selfId: string | null): string {
  if (!selfId || !text) return text;
  if (TRIGGER_PATTERN.test(text)) return text;
  if (text.includes(`@${selfId}`)) {
    return `@${ASSISTANT_NAME} ${text}`;
  }
  return text;
}

export class QQChannel implements Channel {
  name = 'qq';

  private wsUrl: string;
  private accessToken: string;
  private opts: QQChannelOpts;
  private socket: WebSocket | null = null;
  private connected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pending = new Map<string, PendingRequest>();
  private selfId: string | null = null;

  constructor(wsUrl: string, accessToken: string, opts: QQChannelOpts) {
    this.wsUrl = normalizeWsUrl(wsUrl);
    this.accessToken = accessToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    await this.openSocket();
  }

  private async openSocket(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(buildWsUrl(this.wsUrl, this.accessToken));
      let settled = false;

      socket.addEventListener('open', () => {
        this.socket = socket;
        this.connected = true;
        if (!settled) {
          settled = true;
          resolve();
        }
        logger.info({ wsUrl: this.wsUrl }, 'QQ OneBot connected');
        console.log(`\n  QQ channel connected via OneBot: ${this.wsUrl}`);
        console.log('  Send /chatid in a QQ chat to get a registration ID for NanoClaw\n');
      });

      socket.addEventListener('message', (event) => {
        void this.handleSocketMessage(String(event.data));
      });

      socket.addEventListener('error', () => {
        if (!settled) {
          settled = true;
          reject(new Error(`Failed to connect to QQ OneBot WS: ${this.wsUrl}`));
        }
      });

      socket.addEventListener('close', (event) => {
        this.connected = false;
        this.socket = null;
        if (!settled) {
          settled = true;
          reject(
            new Error(`QQ OneBot WS closed during connect (${event.code} ${event.reason})`),
          );
        } else {
          logger.warn(
            { code: event.code, reason: event.reason || '' },
            'QQ OneBot disconnected, scheduling reconnect',
          );
          this.scheduleReconnect();
        }
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket().catch((err) => {
        logger.error({ err }, 'QQ OneBot reconnect failed');
        this.scheduleReconnect();
      });
    }, 5000);
  }

  private async handleSocketMessage(raw: string): Promise<void> {
    let payload: OneBotEnvelope;
    try {
      payload = JSON.parse(raw) as OneBotEnvelope;
    } catch (err) {
      logger.warn({ raw, err }, 'Failed to parse QQ OneBot payload');
      return;
    }

    if (payload.echo && this.pending.has(payload.echo)) {
      const request = this.pending.get(payload.echo)!;
      clearTimeout(request.timer);
      this.pending.delete(payload.echo);
      if (payload.status === 'ok' || payload.retcode === 0) {
        request.resolve(payload.data);
      } else {
        request.reject(new Error(`OneBot action failed: ${payload.retcode ?? 'unknown'}`));
      }
      return;
    }

    if (payload.self_id != null) {
      this.selfId = String(payload.self_id);
    }

    if (payload.post_type !== 'message') return;

    const chatJid = toChatJid(payload);
    if (!chatJid) return;

    const timestamp = new Date().toISOString();
    const isGroup = isGroupEvent(payload);
    const senderId = getSenderId(payload);

    if (this.selfId && senderId === this.selfId) {
      logger.debug({ chatJid }, 'Ignoring QQ self message event');
      return;
    }

    let content = maybeTranslateMention(extractMessageText(payload), this.selfId);
    if (!content) content = '[Unsupported message]';

    if (content === '/ping') {
      await this.sendMessage(chatJid, `${ASSISTANT_NAME} is online.`);
      return;
    }

    if (content === '/chatid') {
      await this.sendMessage(
        chatJid,
        `Chat ID: ${chatJid}\nName: ${isGroup ? `QQ Group ${payload.group_id}` : getSenderName(payload)}\nType: ${isGroup ? 'group' : 'private'}`,
      );
      return;
    }

    this.opts.onChatMetadata(
      chatJid,
      timestamp,
      isGroup ? `QQ Group ${payload.group_id}` : getSenderName(payload),
      'qq',
      isGroup,
    );

    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      logger.debug({ chatJid }, 'Message from unregistered QQ chat');
      return;
    }

    const message: NewMessage = {
      id: String(payload.message_id ?? randomUUID()),
      chat_jid: chatJid,
      sender: senderId,
      sender_name: getSenderName(payload),
      content,
      timestamp,
      is_from_me: false,
    };

    this.opts.onMessage(chatJid, message);
    logger.info({ chatJid, sender: message.sender_name }, 'QQ message stored');
  }

  private sendAction(action: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('QQ OneBot socket is not connected'));
    }

    const echo = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`QQ OneBot action timed out: ${action}`));
      }, 10000);

      this.pending.set(echo, { resolve, reject, timer });
      this.socket!.send(JSON.stringify({ action, params, echo }));
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    try {
      if (jid.startsWith('qqg:')) {
        await this.sendAction('send_group_msg', {
          group_id: Number(jid.slice(4)),
          message: text,
        });
      } else if (jid.startsWith('qq:')) {
        await this.sendAction('send_private_msg', {
          user_id: Number(jid.slice(3)),
          message: text,
        });
      } else {
        logger.warn({ jid }, 'QQ channel cannot send to unknown JID format');
      }
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send QQ message');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('qq:') || jid.startsWith('qqg:');
  }

  async disconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.connected = false;
    for (const [echo, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`QQ channel disconnected before response: ${echo}`));
    }
    this.pending.clear();
  }
}

registerChannel('qq', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['QQ_ONEBOT_WS_URL', 'QQ_ONEBOT_ACCESS_TOKEN']);
  const wsUrl = process.env.QQ_ONEBOT_WS_URL || envVars.QQ_ONEBOT_WS_URL || '';
  const accessToken =
    process.env.QQ_ONEBOT_ACCESS_TOKEN ||
    envVars.QQ_ONEBOT_ACCESS_TOKEN ||
    '';

  if (!wsUrl) {
    logger.warn('QQ: QQ_ONEBOT_WS_URL not set');
    return null;
  }

  return new QQChannel(wsUrl, accessToken, opts);
});

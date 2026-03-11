import { exec } from 'child_process';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { URL } from 'url';

import {
  ASSISTANT_NAME,
  CONTAINER_IMAGE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  MAX_CONCURRENT_CONTAINERS,
  STORE_DIR,
  TIMEZONE,
  TRIGGER_PATTERN,
  WEB_UI_ENABLED,
  WEB_UI_HOST,
  WEB_UI_PORT,
} from '../config.js';
import {
  getAllChats,
  getAllTasks,
  getMessagesSince,
  getRecentMessages,
  setSession,
  storeChatMetadata,
  storeMessageDirect,
} from '../db.js';
import { readEnvFile } from '../env.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { logger } from '../logger.js';
import { ContainerOutput, runContainerAgent } from '../container-runner.js';
import { stopContainer } from '../container-runtime.js';
import { formatMessages, formatOutbound } from '../router.js';
import { Channel, RegisteredGroup } from '../types.js';
import {
  readAppLogs,
  readGroupLogs,
  listGroupLogFiles,
} from './services/logs.js';
import { buildSummary } from './services/summary.js';
import { writeJson } from './types.js';

export interface WebServerOptions {
  host: string;
  port: number;
  assistantName?: string;
  channels: () => Channel[];
  registeredGroups: () => Record<string, RegisteredGroup>;
  sessions: () => Record<string, string>;
}

interface DirectChatPayload {
  message?: string;
  userAgent?: string;
}

interface DirectChatResult {
  reply: string;
  timestamp: string;
  sessionId: string | null;
}

interface DirectChatRunOptions {
  streamToHost?: boolean;
  onChunk?: (chunk: string) => void | Promise<void>;
}

const WEB_DIST_DIR = path.resolve(process.cwd(), 'apps', 'web', 'dist');
const DIRECT_CHAT_JID = 'web:direct';
const DIRECT_GROUP_FOLDER = 'web_console';
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const runtimeEnv = readEnvFile([
  'OLLAMA_HOST',
  'OLLAMA_MODEL',
  'OLLAMA_TEMPERATURE',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'TELEGRAM_BOT_TOKEN',
  'QQ_ONEBOT_WS_URL',
  'QQ_ONEBOT_ACCESS_TOKEN',
]);

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function sendText(res: ServerResponse, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end(body);
}

function sendNotFound(res: ServerResponse): void {
  sendJson(res, 404, { error: 'not_found' });
}

function sendMethodNotAllowed(res: ServerResponse): void {
  sendJson(res, 405, { error: 'method_not_allowed' });
}

function parseLimit(url: URL, fallback: number): number {
  const raw = Number(url.searchParams.get('limit') || fallback);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.min(raw, 500);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildDirectChatPrompt(
  messageHistory: ReturnType<typeof getRecentMessages>,
  userAgent: string | undefined,
): string {
  const basePrompt = formatMessages(messageHistory, TIMEZONE);
  if (!userAgent) return basePrompt;
  const clientContext = `<client channel="web" userAgent="${escapeXml(userAgent)}" />\n`;
  return `${clientContext}${basePrompt}`;
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) {
    throw new Error('empty_body');
  }
  return JSON.parse(raw) as T;
}

function getSummary(options: WebServerOptions, startedAt: string) {
  return buildSummary({
    assistantName: options.assistantName || ASSISTANT_NAME,
    startedAt,
    channels: options.channels,
    registeredGroups: options.registeredGroups,
    sessions: options.sessions,
    taskCount: () => getAllTasks().length,
    recentChatCount: () => getAllChats().length,
  });
}

function getRuntimeSnapshot(options: WebServerOptions, startedAt: string) {
  return {
    assistantName: options.assistantName || ASSISTANT_NAME,
    startedAt,
    provider: 'ollama',
    timezone: TIMEZONE,
    triggerPattern: TRIGGER_PATTERN.source,
    ollama: {
      host: runtimeEnv.OLLAMA_HOST || '',
      model: runtimeEnv.OLLAMA_MODEL || '',
      temperature: runtimeEnv.OLLAMA_TEMPERATURE || '',
    },
    webUi: {
      enabled: WEB_UI_ENABLED,
      host: WEB_UI_HOST,
      port: WEB_UI_PORT,
      staticDir: WEB_DIST_DIR,
      staticBuildReady: fs.existsSync(path.join(WEB_DIST_DIR, 'index.html')),
      mode: 'embedded',
    },
    proxy: {
      httpProxy: runtimeEnv.HTTP_PROXY || '',
      httpsProxy: runtimeEnv.HTTPS_PROXY || '',
      noProxy: runtimeEnv.NO_PROXY || '',
    },
    container: {
      image: CONTAINER_IMAGE,
      timeoutMs: CONTAINER_TIMEOUT,
      maxConcurrent: MAX_CONCURRENT_CONTAINERS,
    },
    paths: {
      projectRoot: process.cwd(),
      groupsDir: GROUPS_DIR,
      dataDir: DATA_DIR,
      storeDir: STORE_DIR,
    },
    channels: {
      installed: options.channels().map((channel) => channel.name),
      telegramConfigured: Boolean(runtimeEnv.TELEGRAM_BOT_TOKEN),
      qqConfigured: Boolean(runtimeEnv.QQ_ONEBOT_WS_URL),
      qqAccessTokenConfigured: Boolean(runtimeEnv.QQ_ONEBOT_ACCESS_TOKEN),
    },
    directChat: {
      jid: DIRECT_CHAT_JID,
      folder: DIRECT_GROUP_FOLDER,
    },
  };
}

function buildDirectGroup(): RegisteredGroup {
  return {
    name: 'Web 直接对话',
    folder: DIRECT_GROUP_FOLDER,
    trigger: `@${ASSISTANT_NAME}`,
    added_at: new Date(0).toISOString(),
    requiresTrigger: false,
    isMain: true,
  };
}

function writeNdjson(res: ServerResponse, payload: unknown): void {
  res.write(`${JSON.stringify(payload)}\n`);
}

async function runDirectChatTurn(
  options: WebServerOptions,
  body: DirectChatPayload,
  runOptions: DirectChatRunOptions = {},
): Promise<DirectChatResult> {
  const message = body.message?.trim();
  const userAgent = body.userAgent?.trim();
  if (!message) {
    throw new Error('message_required');
  }

  const assistantName = options.assistantName || ASSISTANT_NAME;
  const userTimestamp = new Date().toISOString();
  storeChatMetadata(
    DIRECT_CHAT_JID,
    userTimestamp,
    'Web 直接对话',
    'web',
    false,
  );
  storeMessageDirect({
    id: randomUUID(),
    chat_jid: DIRECT_CHAT_JID,
    sender: 'web:user',
    sender_name: '你',
    content: message,
    timestamp: userTimestamp,
    is_from_me: false,
  });

  const history = getRecentMessages(DIRECT_CHAT_JID, 60);
  const prompt = buildDirectChatPrompt(history, userAgent);
  const group = buildDirectGroup();
  const sessions = options.sessions();
  let activeContainerName = '';
  let streamedReply = '';
  let finalReply = '';
  let streamedSessionId: string | undefined;

  const output = await runContainerAgent(
    group,
    {
      prompt,
      sessionId: sessions[DIRECT_GROUP_FOLDER],
      groupFolder: DIRECT_GROUP_FOLDER,
      chatJid: DIRECT_CHAT_JID,
      isMain: true,
      assistantName,
      streamToHost: runOptions.streamToHost,
    },
    (_proc, containerName) => {
      activeContainerName = containerName;
    },
    async (chunk: ContainerOutput) => {
      if (chunk.newSessionId) {
        streamedSessionId = chunk.newSessionId;
      }
      if (chunk.stream && chunk.result) {
        streamedReply += chunk.result;
        await runOptions.onChunk?.(chunk.result);
        return;
      }
      if (chunk.done && chunk.result) {
        finalReply = formatOutbound(chunk.result);
      }
      if (chunk.done && activeContainerName) {
        exec(
          stopContainer(activeContainerName),
          { timeout: 15000 },
          () => undefined,
        );
      }
    },
  );

  if (streamedSessionId || output.newSessionId) {
    sessions[DIRECT_GROUP_FOLDER] =
      streamedSessionId || output.newSessionId || '';
    setSession(DIRECT_GROUP_FOLDER, sessions[DIRECT_GROUP_FOLDER]);
  }

  if (output.status !== 'success' && !streamedReply) {
    logger.error(
      { error: output.error, userAgent },
      'Direct chat request failed',
    );
    throw new Error(output.error || 'direct_chat_failed');
  }

  const reply = formatOutbound(
    streamedReply ||
      finalReply ||
      (typeof output.result === 'string'
        ? output.result
        : JSON.stringify(output.result ?? '')),
  );

  if (!reply) {
    throw new Error('empty_reply');
  }

  const replyTimestamp = new Date().toISOString();
  storeChatMetadata(
    DIRECT_CHAT_JID,
    replyTimestamp,
    'Web 直接对话',
    'web',
    false,
  );
  storeMessageDirect({
    id: randomUUID(),
    chat_jid: DIRECT_CHAT_JID,
    sender: 'web:assistant',
    sender_name: assistantName,
    content: reply,
    timestamp: replyTimestamp,
    is_from_me: true,
    is_bot_message: true,
  });

  return {
    reply,
    timestamp: replyTimestamp,
    sessionId: sessions[DIRECT_GROUP_FOLDER] || output.newSessionId || null,
  };
}

async function handleDirectChat(
  req: IncomingMessage,
  res: ServerResponse,
  options: WebServerOptions,
): Promise<void> {
  let body: DirectChatPayload;
  try {
    body = await readJsonBody<DirectChatPayload>(req);
  } catch {
    sendJson(res, 400, { error: 'invalid_json_body' });
    return;
  }

  try {
    const result = await runDirectChatTurn(options, body);
    sendJson(res, 200, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status =
      message === 'message_required'
        ? 400
        : message === 'empty_reply'
          ? 502
          : 500;
    sendJson(res, status, {
      error: status === 500 ? 'direct_chat_failed' : message,
      message,
    });
  }
}

async function handleDirectChatStream(
  req: IncomingMessage,
  res: ServerResponse,
  options: WebServerOptions,
): Promise<void> {
  let body: DirectChatPayload;
  try {
    body = await readJsonBody<DirectChatPayload>(req);
  } catch {
    sendJson(res, 400, { error: 'invalid_json_body' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });

  try {
    writeNdjson(res, { type: 'start' });
    const result = await runDirectChatTurn(options, body, {
      streamToHost: true,
      onChunk: (chunk) => {
        writeNdjson(res, { type: 'chunk', value: chunk });
      },
    });
    writeNdjson(res, { type: 'done', ...result });
    res.end();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeNdjson(res, { type: 'error', message });
    res.end();
  }
}

function safeStaticPath(pathname: string): string | null {
  const normalized = pathname === '/' ? '/index.html' : pathname;
  const candidate = path.resolve(WEB_DIST_DIR, `.${normalized}`);
  if (!candidate.startsWith(WEB_DIST_DIR)) return null;
  return candidate;
}

function tryServeStatic(pathname: string, res: ServerResponse): boolean {
  if (!fs.existsSync(WEB_DIST_DIR)) {
    sendText(
      res,
      503,
      'Web UI build not found. Run `npm run web:build` or `npm run build` first.',
    );
    return true;
  }

  const assetPath = safeStaticPath(pathname);
  if (!assetPath) {
    sendNotFound(res);
    return true;
  }

  if (fs.existsSync(assetPath) && fs.statSync(assetPath).isFile()) {
    const ext = path.extname(assetPath).toLowerCase();
    res.statusCode = 200;
    res.setHeader(
      'Content-Type',
      MIME_TYPES[ext] || 'application/octet-stream',
    );
    res.end(fs.readFileSync(assetPath));
    return true;
  }

  const indexPath = path.join(WEB_DIST_DIR, 'index.html');
  if (!fs.existsSync(indexPath)) {
    sendText(res, 503, 'Web UI entry file is missing.');
    return true;
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(fs.readFileSync(indexPath));
  return true;
}

export function startWebServer(options: WebServerOptions): Promise<void> {
  const sseClients = new Map<string, ServerResponse>();
  const startedAt = new Date().toISOString();

  const server = createServer(async (req, res) => {
    const method = req.method || 'GET';
    const requestUrl = new URL(
      req.url || '/',
      `http://${options.host}:${options.port}`,
    );
    const pathname = requestUrl.pathname;

    if (method === 'POST' && pathname === '/api/direct-chat') {
      await handleDirectChat(req, res, options);
      return;
    }

    if (method === 'POST' && pathname === '/api/direct-chat/stream') {
      await handleDirectChatStream(req, res, options);
      return;
    }

    if (method !== 'GET') {
      sendMethodNotAllowed(res);
      return;
    }

    if (pathname === '/api/health') {
      sendJson(res, 200, {
        status: 'ok',
        assistantName: options.assistantName || ASSISTANT_NAME,
        startedAt,
      });
      return;
    }

    if (pathname === '/api/summary') {
      sendJson(res, 200, getSummary(options, startedAt));
      return;
    }

    if (pathname === '/api/runtime') {
      sendJson(res, 200, getRuntimeSnapshot(options, startedAt));
      return;
    }

    if (pathname === '/api/direct-chat/messages') {
      sendJson(
        res,
        200,
        getRecentMessages(DIRECT_CHAT_JID, parseLimit(requestUrl, 100)),
      );
      return;
    }

    if (pathname === '/api/channels') {
      const channels = options.channels().map((channel) => ({
        name: channel.name,
        connected: channel.isConnected(),
        supportsTyping: typeof channel.setTyping === 'function',
        supportsSync: typeof channel.syncGroups === 'function',
      }));
      sendJson(res, 200, channels);
      return;
    }

    if (pathname === '/api/chats') {
      sendJson(res, 200, getAllChats());
      return;
    }

    if (pathname === '/api/tasks') {
      sendJson(res, 200, getAllTasks());
      return;
    }

    if (pathname === '/api/groups') {
      const groups = Object.entries(options.registeredGroups()).map(
        ([jid, group]) => ({
          jid,
          ...group,
        }),
      );
      sendJson(res, 200, groups);
      return;
    }

    if (pathname.startsWith('/api/groups/') && pathname.endsWith('/messages')) {
      const jid = decodeURIComponent(
        pathname.replace('/api/groups/', '').replace('/messages', ''),
      );
      const limit = parseLimit(requestUrl, 50);
      sendJson(
        res,
        200,
        getMessagesSince(
          jid,
          '',
          options.assistantName || ASSISTANT_NAME,
          limit,
        ),
      );
      return;
    }

    if (pathname.startsWith('/api/chats/') && pathname.endsWith('/messages')) {
      const jid = decodeURIComponent(
        pathname.replace('/api/chats/', '').replace('/messages', ''),
      );
      const limit = parseLimit(requestUrl, 50);
      sendJson(
        res,
        200,
        getMessagesSince(
          jid,
          '',
          options.assistantName || ASSISTANT_NAME,
          limit,
        ),
      );
      return;
    }

    if (pathname === '/api/sessions') {
      sendJson(res, 200, options.sessions());
      return;
    }

    if (pathname === '/api/logs/app') {
      sendJson(res, 200, { lines: readAppLogs(parseLimit(requestUrl, 200)) });
      return;
    }

    if (pathname.startsWith('/api/logs/group/')) {
      const folder = decodeURIComponent(
        pathname.replace('/api/logs/group/', ''),
      );
      try {
        resolveGroupFolderPath(folder);
      } catch {
        sendJson(res, 400, { error: 'invalid_group_folder' });
        return;
      }
      sendJson(res, 200, {
        files: listGroupLogFiles(folder),
        lines: readGroupLogs(folder, parseLimit(requestUrl, 200)),
      });
      return;
    }

    if (pathname === '/api/events') {
      const clientId = randomUUID();
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.write(': connected\n\n');
      sseClients.set(clientId, res);
      writeJson(res.write.bind(res), 'summary', getSummary(options, startedAt));
      req.on('close', () => {
        sseClients.delete(clientId);
        res.end();
      });
      return;
    }

    tryServeStatic(pathname, res);
  });

  const heartbeat = setInterval(() => {
    const summary = getSummary(options, startedAt);

    for (const res of sseClients.values()) {
      writeJson(res.write.bind(res), 'summary', summary);
      writeJson(res.write.bind(res), 'logs', { lines: readAppLogs(20) });
    }
  }, 10000);

  server.on('close', () => clearInterval(heartbeat));

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      logger.info(
        { host: options.host, port: options.port, staticDir: WEB_DIST_DIR },
        'Web control API listening',
      );
      resolve();
    });
  });
}

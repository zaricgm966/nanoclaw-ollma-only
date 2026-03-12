/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, and answers via Ollama.
 */

import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  browserBack,
  browserClick,
  browserForward,
  browserHover,
  browserLinks,
  browserNavigate,
  browserPress,
  browserRead,
  browserReload,
  browserScreenshot,
  browserScroll,
  browserSelect,
  browserSnapshot,
  browserType,
  browserWaitForText,
} from './browser-control.js';
import { webFetch, webSearch } from './browser-web.js';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  streamToHost?: boolean;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  stream?: boolean;
  streamKind?: 'thinking' | 'content';
  done?: boolean;
}

interface StreamToken {
  kind: 'thinking' | 'content';
  value: string;
}

interface ConversationMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ToolCall {
  tool:
    | 'web_search'
    | 'web_fetch'
    | 'open_app'
    | 'take_screenshot'
    | 'browser_navigate'
    | 'browser_snapshot'
    | 'browser_click'
    | 'browser_type'
    | 'browser_scroll'
    | 'browser_back'
    | 'browser_forward'
    | 'browser_reload'
    | 'browser_read'
    | 'browser_screenshot'
    | 'browser_links'
    | 'browser_press'
    | 'browser_select'
    | 'browser_hover'
    | 'browser_wait_for_text';
  input: {
    query?: string;
    url?: string;
    app?: string;
    elementId?: string;
    text?: string;
    direction?: 'up' | 'down';
    amount?: number;
    clear?: boolean;
    submit?: boolean;
    fullPage?: boolean;
    path?: string;
    key?: string;
    value?: string;
    timeoutMs?: number;
  };
}

interface HostToolResult {
  ok: boolean;
  message: string;
  screenshotPath?: string;
  screenshotUrl?: string;
}

interface ExecutedHostToolResult {
  summary: string;
  raw: HostToolResult;
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';
const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const HOST_TOOL_REQUEST_DIR = '/workspace/ipc/host-tools/requests';
const HOST_TOOL_RESULT_DIR = '/workspace/ipc/host-tools/results';
const IPC_POLL_MS = 500;
const SESSION_DIR = '/workspace/group/.nanoclaw-ollama';
const DEFAULT_OLLAMA_HOSTS = [
  'http://host.docker.internal:11434',
  'http://gateway.docker.internal:11434',
  'http://172.17.0.1:11434',
  'http://localhost:11434',
];
const MAX_TOOL_STEPS = 4;
const SUPPORTED_TOOLS: ToolCall['tool'][] = [
  'web_search',
  'web_fetch',
  'open_app',
  'take_screenshot',
  'browser_navigate',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_scroll',
  'browser_back',
  'browser_forward',
  'browser_reload',
  'browser_read',
  'browser_screenshot',
  'browser_links',
  'browser_press',
  'browser_select',
  'browser_hover',
  'browser_wait_for_text',
];
const INTERNET_REQUEST_PATTERN =
  /\b(search|latest|today|current|news|official|website|site|web|internet|online|github|docs|documentation|release|version|price|prices|lookup|look up|find)\b|\u4ef7\u683c|\u5b98\u7f51|\u65b0\u95fb|\u6700\u65b0|\u641c\u7d22|\u67e5\u4e00\u4e0b|\u641c\u4e00\u4e0b|\u8054\u7f51/i;
const SCREENSHOT_REQUEST_PATTERN =
  /(screenshot|screen shot|capture screen|take a screenshot|\u622a\u5c4f|\u622a\u56fe|\u5c4f\u5e55\u622a\u56fe|\u684c\u9762\u622a\u56fe)/i;
const OPEN_APP_REQUEST_PATTERN =
  /(open app|launch app|start app|open software|run app|run program|open\s+(notepad|steam|chrome|edge|calculator|calc|paint|explorer|terminal|cmd|powershell)|launch\s+(notepad|steam|chrome|edge|calculator|calc|paint|explorer|terminal|cmd|powershell)|start\s+(notepad|steam|chrome|edge|calculator|calc|paint|explorer|terminal|cmd|powershell)|\u6253\u5f00\s*(steam|Steam|\u8bb0\u4e8b\u672c|\u6d4f\u89c8\u5668|\u8ba1\u7b97\u5668|\u7ec8\u7aef|cmd|powershell)|\u542f\u52a8\s*(steam|Steam|\u8bb0\u4e8b\u672c|\u6d4f\u89c8\u5668|\u8ba1\u7b97\u5668|\u7ec8\u7aef|cmd|powershell)|\u8fd0\u884c\s*(steam|Steam|\u8bb0\u4e8b\u672c|\u6d4f\u89c8\u5668|\u8ba1\u7b97\u5668|\u7ec8\u7aef|cmd|powershell))/i;
const STALE_LIMITATION_PATTERN =
  /without Claude Code, external APIs, or remote tools|cannot access real[- ]?time network|do not have web search|cannot browse the web|as of 2024|repeat my final answer|repeat the final answer|previous answer to repeat|there's no previous conversation|there is no previous conversation|The user is asking me to repeat/i;

function log(message: string): void {
  console.error(`[ollama-runner] ${message}`);
}

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function buildCandidateHosts(): string[] {
  const configuredHosts = (process.env.OLLAMA_HOST || '')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean);

  return [...new Set([...configuredHosts, ...DEFAULT_OLLAMA_HOSTS])];
}

async function ollamaFetch(
  apiPath: string,
  options?: RequestInit,
): Promise<{ response: Response; host: string }> {
  const hosts = buildCandidateHosts();
  let lastError: unknown;

  for (const host of hosts) {
    try {
      const response = await fetch(`${host}${apiPath}`, options);
      return { response, host };
    } catch (err) {
      lastError = err;
      log(
        `Connection failed for ${host}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  throw new Error(
    `Failed to connect to Ollama on any host (${hosts.join(', ')}): ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

function getSessionId(input: ContainerInput): string {
  return input.sessionId || randomUUID();
}

function getSessionPath(sessionId: string): string {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  return path.join(SESSION_DIR, `${sessionId}.json`);
}

function loadHistory(sessionId: string): ConversationMessage[] {
  const filePath = getSessionPath(sessionId);
  if (!fs.existsSync(filePath)) return [];

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
      messages?: ConversationMessage[];
    };
    return parsed.messages || [];
  } catch (err) {
    log(`Failed to load session history: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function trimHistory(messages: ConversationMessage[]): ConversationMessage[] {
  const systemMessages = messages.filter((message) => message.role === 'system');
  const conversational = messages.filter((message) => message.role !== 'system');
  return [...systemMessages, ...conversational.slice(-24)];
}

function saveHistory(sessionId: string, messages: ConversationMessage[]): void {
  fs.writeFileSync(
    getSessionPath(sessionId),
    JSON.stringify({ messages: trimHistory(messages) }, null, 2),
  );
}

function readOptionalFile(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    return '';
  }
}

function sanitizeHistory(messages: ConversationMessage[]): ConversationMessage[] {
  return messages.filter((message) => {
    if (message.role !== 'assistant') return true;
    return !STALE_LIMITATION_PATTERN.test(message.content);
  });
}

function buildSystemPrompt(input: ContainerInput): string {
  const parts: string[] = [];
  const assistantName = input.assistantName || 'NanoClaw';

  parts.push(
    `You are ${assistantName}, a local NanoClaw assistant powered only by Ollama.`,
    'You are running without Claude Code or Anthropic services.',
    'You may use built-in tools when they help: web_search, web_fetch, open_app, take_screenshot, browser_navigate, browser_snapshot, browser_click, browser_type, browser_scroll, browser_back, browser_forward, browser_reload, browser_read, browser_screenshot, browser_links, browser_press, browser_select, browser_hover, and browser_wait_for_text.',
    'web_search uses a real browser to search the web. web_fetch uses a real browser to open a page and extract readable content.',
    'The browser_* tools control a persistent browser page for multi-step workflows. Start with browser_navigate to open a URL, use browser_snapshot to inspect the current page and get element IDs, then use browser_click, browser_type, browser_select, browser_hover, browser_scroll, browser_press, browser_back, browser_forward, browser_reload, browser_read, browser_links, browser_screenshot, and browser_wait_for_text as needed.',
    'open_app asks the host OS to open a desktop application by name or path. take_screenshot asks the host OS to capture the current desktop and returns the saved file path.',
    'If you want to use a tool, reply with ONLY compact JSON and no markdown fences.',
    'Tool call examples: {"tool":"web_search","input":{"query":"latest NanoClaw GitHub repo"}}, {"tool":"browser_navigate","input":{"url":"https://example.com"}}, {"tool":"browser_click","input":{"elementId":"el-2"}}, {"tool":"browser_type","input":{"elementId":"el-3","text":"hello","clear":true}}, or {"tool":"open_app","input":{"app":"Notepad"}}.',
    'Only call one tool at a time. After you receive tool output, continue reasoning and either call another tool or provide the final answer normally.',
    'If you already have enough information, answer normally and do not emit JSON.',
    'If the user asks for fresh facts, search results, prices, release info, docs, websites, GitHub links, news, or anything likely to change, prefer using the internet tools instead of answering from stale memory.',
    'Infer the reply language from the latest user prompt. If the latest user prompt is in Chinese, answer in Simplified Chinese even when search results or fetched pages are in English.',
    'When you answer using internet tool results, give a short direct answer first, then add a compact Sources section listing the source title and URL you relied on.',
    'If the user explicitly asks to only return a URL, name, version, or another minimal format, follow that output format and omit extra prose.',
    'Be honest about limitations. Do not claim to have executed commands or modified files unless the host explicitly did so outside this model.',
    'Reply in the same language as the user when practical, and keep answers useful and direct.',
    'If the prompt includes <client channel="web" ...>, markdown is allowed. When take_screenshot returns SCREENSHOT_URL, you may include a markdown image using that URL if the user asked to see the screenshot.',
  );

  const envPrompt = (process.env.OLLAMA_SYSTEM_PROMPT || '').trim();
  if (envPrompt) {
    parts.push('', 'Additional system instructions:', envPrompt);
  }

  const groupAgents = readOptionalFile('/workspace/group/AGENTS.md');
  if (groupAgents) {
    parts.push('', 'Group memory:', groupAgents);
  }

  const globalClaude = readOptionalFile('/workspace/global/CLAUDE.md');
  if (globalClaude) {
    parts.push('', 'Global memory:', globalClaude);
  }

  return parts.join('\n');
}

function isLikelyInternetRequest(prompt: string): boolean {
  return INTERNET_REQUEST_PATTERN.test(extractLatestUserText(prompt));
}

function isLikelyScreenshotRequest(prompt: string): boolean {
  return SCREENSHOT_REQUEST_PATTERN.test(extractLatestUserText(prompt));
}

function isLikelyOpenAppRequest(prompt: string): boolean {
  return OPEN_APP_REQUEST_PATTERN.test(extractLatestUserText(prompt));
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function extractLatestUserText(prompt: string): string {
  const matches = [...prompt.matchAll(/<message\s+[^>]*>([\s\S]*?)<\/message>/g)];
  const latestMessage = matches.length > 0 ? matches[matches.length - 1][1] : '';
  return decodeXmlEntities(latestMessage || prompt)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildAutomaticSearchQuery(prompt: string): string {
  return extractLatestUserText(prompt).slice(0, 240);
}

function buildAutomaticOpenAppName(prompt: string): string {
  const latest = extractLatestUserText(prompt);
  if (/steam|\u84b8\u6c7d\u5e73\u53f0/i.test(latest)) return 'Steam';
  if (/notepad|\u8bb0\u4e8b\u672c/i.test(latest)) return 'notepad.exe';
  if (/browser|chrome|edge|\u6d4f\u89c8\u5668/i.test(latest)) return 'msedge.exe';
  if (/calculator|calc|\u8ba1\u7b97\u5668/i.test(latest)) return 'calc.exe';
  if (/powershell/i.test(latest)) return 'powershell.exe';
  if (/cmd|command prompt|\u547d\u4ee4\u63d0\u793a\u7b26/i.test(latest)) return 'cmd.exe';
  return latest.slice(0, 120);
}

function normalizeFirstToolCall(prompt: string, toolCall: ToolCall): ToolCall {
  if (isLikelyOpenAppRequest(prompt) && toolCall.tool !== 'open_app') {
    return {
      tool: 'open_app',
      input: { app: buildAutomaticOpenAppName(prompt) },
    };
  }

  if (isLikelyScreenshotRequest(prompt) && toolCall.tool !== 'take_screenshot') {
    return {
      tool: 'take_screenshot',
      input: {},
    };
  }

  return toolCall;
}

function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try {
      fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
    } catch {
      // Ignore cleanup failures.
    }
    return true;
  }
  return false;
}

function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs
      .readdirSync(IPC_INPUT_DIR)
      .filter((file) => file.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
          type?: string;
          text?: string;
        };
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try {
          fs.unlinkSync(filePath);
        } catch {
          // Ignore cleanup failures.
        }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

function parseToolCall(text: string): ToolCall | null {
  const trimmed = text.trim();
  const withoutFences = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');

  try {
    const parsed = JSON.parse(withoutFences) as ToolCall;
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.tool !== 'string' || !SUPPORTED_TOOLS.includes(parsed.tool as ToolCall['tool'])) {
      return null;
    }
    if (!parsed.input || typeof parsed.input !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeHostToolRequest(call: ToolCall): string {
  fs.mkdirSync(HOST_TOOL_REQUEST_DIR, { recursive: true });
  fs.mkdirSync(HOST_TOOL_RESULT_DIR, { recursive: true });
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const payload = {
    id,
    type: call.tool,
    app: call.input.app,
    timestamp: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(HOST_TOOL_REQUEST_DIR, `${id}.json`),
    JSON.stringify(payload, null, 2),
  );
  return id;
}

async function waitForHostToolResult(id: string): Promise<HostToolResult> {
  const resultPath = path.join(HOST_TOOL_RESULT_DIR, `${id}.json`);
  const timeoutAt = Date.now() + 30000;

  while (Date.now() < timeoutAt) {
    if (fs.existsSync(resultPath)) {
      try {
        const parsed = JSON.parse(
          fs.readFileSync(resultPath, 'utf8'),
        ) as HostToolResult;
        fs.unlinkSync(resultPath);
        return parsed;
      } catch (err) {
        throw new Error('Failed to parse host tool result: ' + (err instanceof Error ? err.message : String(err)));
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error('Host tool timed out');
}

async function executeHostTool(call: ToolCall): Promise<ExecutedHostToolResult> {
  const requestId = writeHostToolRequest(call);
  const result = await waitForHostToolResult(requestId);
  if (!result.ok) {
    throw new Error(result.message || ('Host tool failed: ' + call.tool));
  }

  if (call.tool === 'take_screenshot') {
    return {
      raw: result,
      summary: [
        'HOST_SCREENSHOT_OK',
        'MESSAGE: ' + result.message,
        result.screenshotPath ? 'SCREENSHOT_PATH: ' + result.screenshotPath : '',
        result.screenshotUrl ? 'SCREENSHOT_URL: ' + result.screenshotUrl : '',
      ]
        .filter(Boolean)
        .join('\n'),
    };
  }

  return {
    raw: result,
    summary: 'HOST_ACTION_OK\nMESSAGE: ' + result.message,
  };
}

function stringifyToolOutput(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value, null, 2);
}

async function executeBrowserTool(call: ToolCall): Promise<string> {
  switch (call.tool) {
    case 'browser_navigate':
      return stringifyToolOutput(await browserNavigate(call.input.url || ''));
    case 'browser_snapshot':
      return stringifyToolOutput(await browserSnapshot());
    case 'browser_click':
      return stringifyToolOutput(await browserClick(call.input.elementId || ''));
    case 'browser_type':
      return stringifyToolOutput(
        await browserType(call.input.elementId || '', call.input.text || '', {
          clear: Boolean(call.input.clear),
          submit: Boolean(call.input.submit),
        }),
      );
    case 'browser_scroll':
      return stringifyToolOutput(
        await browserScroll(call.input.direction === 'up' ? 'up' : 'down', call.input.amount),
      );
    case 'browser_back':
      return stringifyToolOutput(await browserBack());
    case 'browser_forward':
      return stringifyToolOutput(await browserForward());
    case 'browser_reload':
      return stringifyToolOutput(await browserReload());
    case 'browser_read':
      return stringifyToolOutput(await browserRead());
    case 'browser_screenshot':
      return stringifyToolOutput(
        await browserScreenshot({
          fullPage: call.input.fullPage,
          path: call.input.path,
        }),
      );
    case 'browser_links':
      return stringifyToolOutput(await browserLinks());
    case 'browser_press':
      return stringifyToolOutput(await browserPress(call.input.key || ''));
    case 'browser_select':
      return stringifyToolOutput(
        await browserSelect(call.input.elementId || '', call.input.value || ''),
      );
    case 'browser_hover':
      return stringifyToolOutput(await browserHover(call.input.elementId || ''));
    case 'browser_wait_for_text':
      return stringifyToolOutput(
        await browserWaitForText(call.input.text || '', call.input.timeoutMs),
      );
    default:
      throw new Error('Unsupported browser tool: ' + call.tool);
  }
}
function hasChinese(text: string): boolean {
  return /[\u3400-\u9fff]/.test(text);
}

async function finalizeDirectHostAction(
  input: ContainerInput,
  sessionId: string,
  history: ConversationMessage[],
  systemPrompt: string,
  prompt: string,
  reply: string,
  onStream?: (chunk: StreamToken) => void | Promise<void>,
): Promise<string> {
  if (onStream) {
    await onStream({ kind: 'content', value: reply });
  }

  const finalMessages = trimHistory([
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: prompt },
    { role: 'assistant', content: reply },
  ]);
  saveHistory(sessionId, finalMessages);
  return reply;
}

function buildDirectHostActionReply(
  call: ToolCall,
  result: ExecutedHostToolResult,
  prompt: string,
  input: ContainerInput,
): string {
  const prefersChinese = hasChinese(prompt);
  const isWebClient = prompt.includes('<client channel="web"');

  if (call.tool === 'take_screenshot') {
    const intro = prefersChinese
      ? '\u597d\u7684\uff0c\u622a\u56fe\u5df2\u6210\u529f\u6355\u83b7\uff01'
      : 'Done. I captured the screenshot successfully.';
    const imageLine = isWebClient && result.raw.screenshotUrl
      ? `\n\n![Screenshot](${result.raw.screenshotUrl})`
      : '';
    return intro + imageLine;
  }

  const appName = call.input.app || (prefersChinese ? '\u76ee\u6807\u5e94\u7528' : 'the requested app');
  return prefersChinese
    ? `\u597d\u7684\uff0c\u5df2\u7ecf\u5c1d\u8bd5\u4e3a\u4f60\u6253\u5f00 ${appName}\u3002`
    : `Done. I attempted to open ${appName}.`;
}

async function executeToolCall(call: ToolCall): Promise<string> {
  if (call.tool === 'web_search') {
    return webSearch(call.input.query || '');
  }
  if (call.tool === 'web_fetch') {
    return webFetch(call.input.url || '');
  }
  if (call.tool.startsWith('browser_')) {
    return executeBrowserTool(call);
  }
  const hostResult = await executeHostTool(call);
  return hostResult.summary;
}

async function askModel(messages: ConversationMessage[]): Promise<{
  text: string;
  host: string;
  model: string;
  promptEvalCount: number;
  evalCount: number;
}> {
  const model = (process.env.OLLAMA_MODEL || '').trim();
  if (!model) {
    throw new Error('OLLAMA_MODEL is not configured');
  }

  const body: Record<string, unknown> = {
    model,
    messages,
    stream: false,
  };

  const temperature = Number(process.env.OLLAMA_TEMPERATURE || '');
  if (!Number.isNaN(temperature)) {
    body.options = { temperature };
  }

  const { response, host } = await ollamaFetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Ollama error from ${host} (${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as {
    message?: { content?: string };
    prompt_eval_count?: number;
    eval_count?: number;
  };

  const text = data.message?.content?.trim();
  if (!text) {
    throw new Error('Ollama returned an empty response');
  }

  return {
    text,
    host,
    model,
    promptEvalCount: data.prompt_eval_count || 0,
    evalCount: data.eval_count || 0,
  };
}

async function streamModelAnswer(
  messages: ConversationMessage[],
  onToken: (token: StreamToken) => void | Promise<void>,
  options?: {
    includeThinking?: boolean;
  },
): Promise<{ text: string; host: string; model: string }> {
  const model = (process.env.OLLAMA_MODEL || '').trim();
  if (!model) {
    throw new Error('OLLAMA_MODEL is not configured');
  }

  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true,
  };

  const temperature = Number(process.env.OLLAMA_TEMPERATURE || '');
  if (!Number.isNaN(temperature)) {
    body.options = { temperature };
  }

  const { response, host } = await ollamaFetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok || !response.body) {
    const errorText = await response.text();
    throw new Error(`Ollama stream error from ${host} (${response.status}): ${errorText}`);
  }

  const includeThinking = options?.includeThinking ?? true;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const data = JSON.parse(trimmed) as {
        message?: { content?: string; thinking?: string };
        done?: boolean;
      };
      const thinkingToken = data.message?.thinking || '';
      if (thinkingToken && includeThinking) {
        await onToken({ kind: 'thinking', value: thinkingToken });
      }
      const contentToken = data.message?.content || '';
      if (contentToken) {
        text += contentToken;
        await onToken({ kind: 'content', value: contentToken });
      }
    }

    if (done) {
      if (buffer.trim()) {
        const data = JSON.parse(buffer.trim()) as {
          message?: { content?: string; thinking?: string };
        };
        const thinkingToken = data.message?.thinking || '';
        if (thinkingToken && includeThinking) {
          await onToken({ kind: 'thinking', value: thinkingToken });
        }
        const contentToken = data.message?.content || '';
        if (contentToken) {
          text += contentToken;
          await onToken({ kind: 'content', value: contentToken });
        }
      }
      break;
    }
  }

  return { text: text.trim(), host, model };
}

async function generateReply(
  input: ContainerInput,
  sessionId: string,
  prompt: string,
  onStream?: (chunk: StreamToken) => void | Promise<void>,
): Promise<string> {
  const history = sanitizeHistory(loadHistory(sessionId)).filter(
    (message) => message.role !== 'system',
  );
  const systemPrompt = buildSystemPrompt(input);
  const messages: ConversationMessage[] = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: prompt },
  ];

  if (isLikelyScreenshotRequest(prompt)) {
    log('Direct host-action shortcut matched screenshot request');
    const call = {
      tool: 'take_screenshot',
      input: {},
    } as ToolCall;
    const hostResult = await executeHostTool(call);
    const reply = buildDirectHostActionReply(call, hostResult, prompt, input);
    return finalizeDirectHostAction(input, sessionId, history, systemPrompt, prompt, reply, onStream);
  }

  if (isLikelyOpenAppRequest(prompt)) {
    const appName = buildAutomaticOpenAppName(prompt);
    log(`Direct host-action shortcut matched app launch request: ${appName}`);
    const call = {
      tool: 'open_app',
      input: { app: appName },
    } as ToolCall;
    const hostResult = await executeHostTool(call);
    const reply = buildDirectHostActionReply(call, hostResult, prompt, input);
    return finalizeDirectHostAction(input, sessionId, history, systemPrompt, prompt, reply, onStream);
  }

  if (isLikelyInternetRequest(prompt)) {
    messages.splice(1, 0, {
      role: 'system',
      content:
        'The latest user request appears to need fresh web information. Prefer using web_search first, then web_fetch when a result page needs confirmation. Keep the final answer in the same language as the latest user prompt. Do not answer that you lack internet access unless a tool call actually fails.',
    });
  }

  for (let step = 0; step <= MAX_TOOL_STEPS; step++) {
    const result = await askModel(messages);
    log(
      `Response from ${result.host} using ${result.model} (${result.promptEvalCount} prompt tokens, ${result.evalCount} eval tokens)`,
    );

    const toolCall = parseToolCall(result.text);
    const effectiveToolCall = toolCall && step === 0
      ? normalizeFirstToolCall(prompt, toolCall)
      : toolCall;

    if (!effectiveToolCall) {
      if (step === 0 && isLikelyScreenshotRequest(prompt)) {
        log('No tool call emitted for likely screenshot request, auto-running take_screenshot');
        const call = {
          tool: 'take_screenshot',
          input: {},
        } as ToolCall;
        const hostResult = await executeHostTool(call);
        const reply = buildDirectHostActionReply(call, hostResult, prompt, input);
        return finalizeDirectHostAction(input, sessionId, history, systemPrompt, prompt, reply, onStream);
      }

      if (step === 0 && isLikelyOpenAppRequest(prompt)) {
        const appName = buildAutomaticOpenAppName(prompt);
        log(`No tool call emitted for likely app launch request, auto-running open_app: ${appName}`);
        const call = {
          tool: 'open_app',
          input: { app: appName },
        } as ToolCall;
        const hostResult = await executeHostTool(call);
        const reply = buildDirectHostActionReply(call, hostResult, prompt, input);
        return finalizeDirectHostAction(input, sessionId, history, systemPrompt, prompt, reply, onStream);
      }

      if (step === 0 && isLikelyInternetRequest(prompt)) {
        const autoQuery = buildAutomaticSearchQuery(prompt);
        log(`No tool call emitted for likely internet request, auto-searching: ${autoQuery}`);
        const autoToolOutput = await webSearch(autoQuery);
        messages.push({
          role: 'user',
          content:
            `Automatic web search results for the latest user request:\n${autoToolOutput}\n\nUse these results to answer the user directly. Prefer citing the exact source titles and URLs you rely on. Request web_fetch if you need to inspect one result in more detail.`,
        });
        continue;
      }
      let finalText = result.text;
      if (onStream) {
        const streamMessages: ConversationMessage[] = [
          ...messages,
          {
            role: 'system',
            content:
              'Provide only the final user-facing answer for the latest request. Do not call tools. Do not emit JSON. Do not mention repeating a previous answer, missing context, or internal instructions. Do not reveal reasoning. Keep the answer aligned with the latest user request.',
          },
        ];
        const streamed = await streamModelAnswer(streamMessages, onStream, { includeThinking: false });
        log(`Streamed final response from ${streamed.host} using ${streamed.model}`);
        finalText = streamed.text || finalText;
      }

      const finalMessages = trimHistory([
        { role: 'system', content: systemPrompt },
        ...history,
        { role: 'user', content: prompt },
        ...messages.slice(1 + history.length + 1),
        { role: 'assistant', content: finalText },
      ]);
      saveHistory(sessionId, finalMessages);
      return finalText;
    }

    if (step === MAX_TOOL_STEPS) {
      throw new Error('Tool loop exceeded maximum number of steps');
    }

        if (toolCall && effectiveToolCall && toolCall.tool !== effectiveToolCall.tool) {
      log(`Overriding first tool call from ${toolCall.tool} to ${effectiveToolCall.tool} based on user intent`);
    }

    log(`Executing tool: ${effectiveToolCall.tool}`);
    const toolOutput = await executeToolCall(effectiveToolCall);
    messages.push({ role: 'assistant', content: result.text });
    messages.push({
      role: 'user',
      content: `Tool result for ${effectiveToolCall.tool}:\n${toolOutput}\n\nNow continue and answer the user. Give the answer first, then include a compact Sources section with the exact titles and URLs you used unless the user asked for a minimal-format response. Request another tool only if still necessary.`,
    });
  }

  throw new Error('No final response produced');
}

async function main(): Promise<void> {
  let input: ContainerInput;

  try {
    const stdinData = await readStdin();
    input = JSON.parse(stdinData) as ContainerInput;
    log(`Received input for group: ${input.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
    return;
  }

  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
  } catch {
    // Ignore stale sentinel cleanup failure.
  }

  const sessionId = getSessionId(input);
  let prompt = input.prompt;
  if (input.isScheduledTask) {
    prompt = `[SCHEDULED TASK]\n\n${prompt}`;
  }

  const pending = drainIpcInput();
  if (pending.length > 0) {
    prompt += `\n${pending.join('\n')}`;
  }

  try {
    while (true) {
      const reply = await generateReply(
        input,
        sessionId,
        prompt,
        input.streamToHost
          ? async (chunk) => {
              writeOutput({
                status: 'success',
                result: chunk.value,
                newSessionId: sessionId,
                stream: true,
                streamKind: chunk.kind,
                done: false,
              });
            }
          : undefined,
      );
      writeOutput({
        status: 'success',
        result: reply,
        newSessionId: sessionId,
        done: true,
      });

      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      prompt = nextMessage;
    }
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: err instanceof Error ? err.message : String(err),
      done: true,
    });
    process.exit(1);
  }
}

main();

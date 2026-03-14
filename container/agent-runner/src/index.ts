/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, and answers via Ollama.
 */

import { execFile } from 'child_process';
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

type SupportedTool =
  | 'eastmoney_select_stock'
  | 'web_search'
  | 'web_fetch'
  | 'open_app'
  | 'take_screenshot'
  | 'apply_skill'
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

interface ToolCall {
  tool: SupportedTool;
  input: {
    keyword?: string;
    market?: string;
    query?: string;
    url?: string;
    app?: string;
    skill?: string;
    skillPath?: string;
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

type ScreenshotTarget = 'desktop' | 'browser-page' | 'unknown';
type DecisionSource = 'model' | 'override' | 'fallback';

type FirstActionDecision =
  | {
      kind: 'direct-answer';
      reason: string;
    }
  | {
      kind: 'tool';
      toolCall: ToolCall;
      reason: string;
      source: DecisionSource;
    };

interface IntentProfile {
  latestUserText: string;
  eastmoneyScore: number;
  screenshotTarget: ScreenshotTarget;
  browserWorkflowScore: number;
  browserSearchScore: number;
  internetScore: number;
  openAppScore: number;
  hasExplicitUrl: boolean;
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
const DEFAULT_MAX_TOOL_STEPS = 4;
const BROWSER_WORKFLOW_MAX_TOOL_STEPS = 7;
const MAX_REPEATED_TOOL_CALLS = 2;
const TOOL_RESULT_MARKER = '[TOOL RESULT - NOT A USER MESSAGE]';
const TOOL_RESULT_CONTINUATION_HINT =
  'Continue from this runtime update. The user request has not changed.';
const SUPPORTED_TOOLS: SupportedTool[] = [
  'eastmoney_select_stock',
  'web_search',
  'web_fetch',
  'open_app',
  'take_screenshot',
  'apply_skill',
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
const BROWSER_TOOL_SET = new Set<SupportedTool>([
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
]);
const HOST_TOOL_SET = new Set<SupportedTool>(['open_app', 'take_screenshot', 'apply_skill']);
const INTERNET_TOOL_SET = new Set<SupportedTool>(['web_search', 'web_fetch']);
const EASTMONEY_MARKET_SIGNALS = ['a股', 'A股', '港股', '美股'];
const EASTMONEY_STRONG_SIGNALS = [
  '东方财富',
  '东财',
  '选股',
  '筛股',
  '股票推荐',
  '板块推荐',
  '行业股票',
  '成分股',
  '财务指标',
  '行情指标',
  '市盈率',
  '市净率',
  '净利润',
  'roe',
  'pe',
  'pb',
];
const EASTMONEY_WEAK_SIGNALS = [
  '股票',
  '板块',
  '行业',
  '指数',
  '涨幅',
  '跌幅',
  '推荐',
];
const ELEMENT_TARGETED_BROWSER_TOOLS = new Set<SupportedTool>([
  'browser_click',
  'browser_type',
  'browser_select',
  'browser_hover',
]);
const STALE_LIMITATION_PATTERN =
  /without Claude Code, external APIs, or remote tools|cannot access real[- ]?time network|do not have web search|cannot browse the web|as of 2024|repeat my final answer|repeat the final answer|previous answer to repeat|there's no previous conversation|there is no previous conversation|The user is asking me to repeat/i;
const DESKTOP_SCREENSHOT_SIGNALS = [
  'desktop screenshot',
  'screen shot',
  'screenshot the screen',
  'whole screen',
  'entire screen',
  'current screen',
  'capture screen',
  'desktop',
  '桌面',
  '屏幕',
  '整个屏幕',
  '当前屏幕',
  '桌面截图',
  '屏幕截图',
];
const BROWSER_SCREENSHOT_SIGNALS = [
  'browser screenshot',
  'page screenshot',
  'website screenshot',
  'webpage screenshot',
  'screenshot this page',
  'screenshot the page',
  'screenshot the website',
  'browser page',
  'web page',
  'website page',
  '网页截图',
  '页面截图',
  '截取网页',
  '截取页面',
  '浏览器截图',
  '网站截图',
  '网页',
  '网站',
  '浏览器',
  '页面',
];
const BROWSER_STRONG_SIGNALS = [
  'browser_',
  'open browser',
  'use browser',
  'in the browser',
  'navigate to',
  'go to',
  'visit',
  'open website',
  'open webpage',
  'web page',
  'website',
  'page',
  'tab',
  'url',
  'link',
  '打开浏览器',
  '用浏览器',
  '在浏览器',
  '打开网页',
  '打开网站',
  '访问网页',
  '访问网站',
  '链接',
  '网址',
  '网页',
  '网站',
  '页面',
  '浏览器',
];
const BROWSER_ACTION_SIGNALS = [
  'click',
  'type',
  'input',
  'scroll',
  'hover',
  'reload',
  'back',
  'forward',
  'select',
  'press',
  '点击',
  '输入',
  '滚动',
  '刷新',
  '回退',
  '前进',
  '选择',
];
const BROWSER_SEARCH_SIGNALS = [
  'search',
  'find',
  'look up',
  'lookup',
  'query',
  'google',
  'bing',
  'duckduckgo',
  '搜索',
  '查找',
  '查询',
  '查一下',
  '搜一下',
];
const INTERNET_STRONG_SIGNALS = [
  'latest',
  'today',
  'current',
  'news',
  'official',
  'website',
  'github',
  'docs',
  'documentation',
  'release',
  'version',
  'price',
  'prices',
  '最新',
  '新闻',
  '官网',
  '文档',
  '版本',
  '价格',
];
const INTERNET_WEAK_SIGNALS = [
  'search',
  'find',
  'look up',
  'lookup',
  'web',
  'internet',
  'online',
  '联网',
  '搜索',
  '查一下',
  '搜一下',
];
const SKILL_INSTALL_SIGNALS = [
  'install skill',
  'apply skill',
  'add skill',
  '??skill',
  '????',
  '??skill',
  '????',
  '????skill',
  '??????',
  '????',
];

const OPEN_APP_STRONG_SIGNALS = [
  'open app',
  'launch app',
  'start app',
  'open software',
  'run program',
  'notepad',
  'steam',
  'calculator',
  'powershell',
  'cmd',
  'terminal',
  'explorer',
  'paint',
  '打开',
  '启动',
  '运行',
  '记事本',
  '计算器',
  '终端',
  '命令提示符',
];
const COMMON_FILLER_PHRASES = [
  'please',
  'could you',
  'can you',
  'would you',
  'for me',
  'help me',
  'i want you to',
  '请',
  '帮我',
  '帮我把',
  '麻烦你',
  '谢谢',
  '我想让你',
];
const SEARCH_ACTION_PHRASES = [
  'search',
  'find',
  'look up',
  'lookup',
  'query',
  'open browser',
  'use browser',
  'in the browser',
  'browser',
  '打开浏览器',
  '在浏览器',
  '用浏览器',
  '搜索',
  '查询',
  '查找',
  '查一下',
  '搜一下',
];
const SCREENSHOT_CONTEXT_PHRASES = [
  'screenshot',
  'screen shot',
  'capture',
  'page screenshot',
  'browser screenshot',
  '截图',
  '截屏',
  '网页截图',
  '页面截图',
  '截取网页',
];
const OUTPUT_FORMAT_FILLERS = [
  'just reply with',
  'only reply with',
  'only return',
  '只回复',
  '只返回',
  '告诉我',
  '给我',
];

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
  const conversational = messages.filter((message) => message.role !== 'system');
  return conversational.slice(-24);
}

function saveHistory(sessionId: string, messages: ConversationMessage[]): void {
  fs.writeFileSync(
    getSessionPath(sessionId),
    JSON.stringify({ messages: trimHistory(messages) }, null, 2),
  );
}

function persistConversationTurn(
  sessionId: string,
  history: ConversationMessage[],
  prompt: string,
  reply: string,
): void {
  saveHistory(sessionId, [
    ...history,
    { role: 'user', content: prompt },
    { role: 'assistant', content: reply },
  ]);
}

function readOptionalFile(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    return '';
  }
}

function buildSystemPrompt(input: ContainerInput): string {
  const parts: string[] = [];
  const assistantName = input.assistantName || 'NanoClaw';

  parts.push(
    `You are ${assistantName}, a local NanoClaw assistant powered only by Ollama.`,
    'You are running without Claude Code or Anthropic services.',
    'You may use built-in tools when they help: eastmoney_select_stock, web_search, web_fetch, open_app, take_screenshot, apply_skill, browser_navigate, browser_snapshot, browser_click, browser_type, browser_scroll, browser_back, browser_forward, browser_reload, browser_read, browser_screenshot, browser_links, browser_press, browser_select, browser_hover, and browser_wait_for_text.',
    'eastmoney_select_stock runs a local Eastmoney stock screening CLI for fresh A股, 港股, and 美股 screening, sector lookup, constituent lookup, and recommendation workflows.',
    'web_search uses a real browser to search the web. web_fetch uses a real browser to open a page and extract readable content.',
    'The browser_* tools control a persistent browser page for multi-step workflows. Start with browser_navigate to open a URL, use browser_snapshot to inspect the current page and get element IDs, then use browser_click, browser_type, browser_select, browser_hover, browser_scroll, browser_press, browser_back, browser_forward, browser_reload, browser_read, browser_links, browser_screenshot, and browser_wait_for_text as needed.',
    'open_app asks the host OS to open a desktop application by name or path. take_screenshot asks the host OS to capture the current desktop and returns the saved file path. apply_skill asks the host to install a packaged local NanoClaw skill from .agents/skills using the skills engine.',
    'If you want to use a tool, reply with ONLY compact JSON and no markdown fences.',
    'Tool call examples: {"tool":"eastmoney_select_stock","input":{"keyword":"今日涨幅2%的股票","market":"A股"}}, {"tool":"web_search","input":{"query":"latest NanoClaw GitHub repo"}}, {"tool":"browser_navigate","input":{"url":"https://example.com"}}, {"tool":"browser_click","input":{"elementId":"el-2"}}, {"tool":"browser_type","input":{"elementId":"el-3","text":"hello","clear":true}}, {"tool":"open_app","input":{"app":"Notepad"}}, or {"tool":"apply_skill","input":{"skill":"add-telegram"}}.',
    'Only call one tool at a time. After you receive tool output, continue reasoning and either call another tool or provide the final answer normally.',
    'If you already have enough information, answer normally and do not emit JSON.',
    'If the user asks for fresh facts, search results, prices, release info, docs, websites, GitHub links, news, or anything likely to change, prefer using the internet tools instead of answering from stale memory.',
    "If the latest user prompt is in Chinese, answer in Chinese and try to match the user's script style (Simplified or Traditional) instead of forcing Simplified Chinese.",
    'When you answer using internet tool results, give a short direct answer first, then add a compact Sources section listing the source title and URL you relied on.',
    'If the user explicitly asks to only return a URL, name, version, or another minimal format, follow that output format and omit extra prose.',
    'Be honest about limitations. Do not claim to have executed commands or modified files unless the host explicitly did so outside this model.',
    'Reply in the same language as the user when practical, and keep answers useful and direct.',
    'If the prompt includes <client channel="web" ...>, markdown is allowed. When take_screenshot or browser_screenshot returns a screenshotUrl or SCREENSHOT_URL, you may include a markdown image using that URL if the user asked to see the screenshot.',
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

function normalizeIntentText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasAnySignal(text: string, phrases: string[]): boolean {
  return phrases.some((phrase) => text.includes(phrase));
}

function scoreSignals(text: string, strong: string[], medium: string[] = [], weak: string[] = []): number {
  let score = 0;
  for (const phrase of strong) {
    if (text.includes(phrase)) score += 3;
  }
  for (const phrase of medium) {
    if (text.includes(phrase)) score += 2;
  }
  for (const phrase of weak) {
    if (text.includes(phrase)) score += 1;
  }
  return score;
}

function hasExplicitUrl(text: string): boolean {
  return /https?:\/\/\S+/i.test(text);
}

function extractExplicitUrl(text: string): string | null {
  const match = text.match(/https?:\/\/\S+/i);
  if (!match) return null;
  return match[0].replace(/[),.;]+$/, '');
}

function detectScreenshotTarget(text: string): ScreenshotTarget {
  const normalized = normalizeIntentText(text);
  const mentionsScreenshot =
    normalized.includes('screenshot') ||
    normalized.includes('screen shot') ||
    normalized.includes('截图') ||
    normalized.includes('截屏');

  if (!mentionsScreenshot) {
    return 'unknown';
  }

  const browserScore = scoreSignals(normalized, BROWSER_SCREENSHOT_SIGNALS, BROWSER_STRONG_SIGNALS);
  const desktopScore = scoreSignals(normalized, DESKTOP_SCREENSHOT_SIGNALS);

  if (browserScore > desktopScore) return 'browser-page';
  if (desktopScore > browserScore) return 'desktop';
  if (hasAnySignal(normalized, BROWSER_STRONG_SIGNALS)) return 'browser-page';
  if (hasAnySignal(normalized, DESKTOP_SCREENSHOT_SIGNALS)) return 'desktop';
  return 'unknown';
}

function scoreBrowserWorkflowIntent(text: string): number {
  const normalized = normalizeIntentText(text);
  let score = scoreSignals(normalized, BROWSER_STRONG_SIGNALS, BROWSER_ACTION_SIGNALS, BROWSER_SEARCH_SIGNALS);
  if (hasExplicitUrl(normalized)) score += 3;
  if (detectScreenshotTarget(normalized) === 'browser-page') score += 3;
  return score;
}

function scoreBrowserSearchIntent(text: string): number {
  const normalized = normalizeIntentText(text);
  let score = scoreSignals(normalized, BROWSER_SEARCH_SIGNALS);
  if (normalized.includes('地址') || normalized.includes('address')) score += 2;
  if (normalized.includes('网址') || normalized.includes('url')) score += 2;
  if (normalized.includes('链接') || normalized.includes('link')) score += 2;
  return score;
}

function scoreInternetIntent(text: string): number {
  const normalized = normalizeIntentText(text);
  let score = scoreSignals(normalized, INTERNET_STRONG_SIGNALS, [], INTERNET_WEAK_SIGNALS);
  if (hasExplicitUrl(normalized)) score += 2;
  return score;
}

function scoreOpenAppIntent(text: string): number {
  const normalized = normalizeIntentText(text);
  let score = scoreSignals(normalized, OPEN_APP_STRONG_SIGNALS);
  if (normalized.includes('open ') || normalized.includes('launch ')) score += 1;
  return score;
}

function scoreEastmoneyIntent(text: string): number {
  const normalized = normalizeIntentText(text);
  let score = scoreSignals(
    normalized,
    EASTMONEY_STRONG_SIGNALS,
    EASTMONEY_MARKET_SIGNALS,
    EASTMONEY_WEAK_SIGNALS,
  );
  if (normalized.includes('今日') && normalized.includes('股票')) score += 2;
  if (normalized.includes('条件') && normalized.includes('股票')) score += 2;
  return score;
}

function buildIntentProfile(prompt: string): IntentProfile {
  const latestUserText = extractLatestUserText(prompt);
  return {
    latestUserText,
    eastmoneyScore: scoreEastmoneyIntent(latestUserText),
    screenshotTarget: detectScreenshotTarget(latestUserText),
    browserWorkflowScore: scoreBrowserWorkflowIntent(latestUserText),
    browserSearchScore: scoreBrowserSearchIntent(latestUserText),
    internetScore: scoreInternetIntent(latestUserText),
    openAppScore: scoreOpenAppIntent(latestUserText),
    hasExplicitUrl: hasExplicitUrl(latestUserText),
  };
}

function isLikelyBrowserWorkflowRequest(prompt: string): boolean {
  const profile = buildIntentProfile(prompt);
  return (
    profile.browserWorkflowScore >= 4 ||
    profile.screenshotTarget === 'browser-page' ||
    profile.hasExplicitUrl
  );
}

function isLikelyBrowserSearchRequest(prompt: string): boolean {
  const profile = buildIntentProfile(prompt);
  return isLikelyBrowserWorkflowRequest(prompt) && profile.browserSearchScore >= 2;
}

function cleanSearchQuery(text: string, extraPhrases: string[] = []): string {
  let cleaned = normalizeWhitespace(text);
  const phrases = [
    ...COMMON_FILLER_PHRASES,
    ...SEARCH_ACTION_PHRASES,
    ...SCREENSHOT_CONTEXT_PHRASES,
    ...OUTPUT_FORMAT_FILLERS,
    ...extraPhrases,
  ].sort((a, b) => b.length - a.length);

  for (const phrase of phrases) {
    cleaned = cleaned.replace(new RegExp(escapeRegExp(phrase), 'gi'), ' ');
  }

  cleaned = cleaned
    .replace(/[<>{}\[\]()`"'“”‘’]+/g, ' ')
    .replace(/[,:;!?，。！？、]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return cleaned;
}

function buildAutomaticSearchQuery(prompt: string): string {
  const latest = extractLatestUserText(prompt);
  const query = cleanSearchQuery(latest, ['browser screenshot', 'page screenshot', '网页截图', '页面截图']);
  return (query || latest).slice(0, 160);
}

function buildAutomaticBrowserSearchQuery(prompt: string): string {
  const latest = extractLatestUserText(prompt);
  const query = cleanSearchQuery(latest, ['browser', 'web page', 'website', 'page', 'tab', '网页', '网站', '页面', '浏览器']);
  return (query || latest).slice(0, 120);
}

function buildAutomaticBrowserSearchUrl(prompt: string): string {
  const query = buildAutomaticBrowserSearchQuery(prompt);
  return `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
}

function isLikelySkillInstallRequest(prompt: string): boolean {
  const latest = normalizeIntentText(extractLatestUserText(prompt));
  const hasInstallVerb =
    SKILL_INSTALL_SIGNALS.some((signal) => latest.includes(signal)) ||
    latest.includes('install') ||
    latest.includes('apply') ||
    latest.includes('add ') ||
    latest.includes('\u5b89\u88c5') ||
    latest.includes('\u5e94\u7528') ||
    latest.includes('\u6dfb\u52a0');
  const mentionsSkill = latest.includes('skill') || latest.includes('\u6280\u80fd');
  return hasInstallVerb && mentionsSkill;
}

function buildAutomaticSkillName(prompt: string): string {
  const latest = extractLatestUserText(prompt);
  const codeLikeMatch = latest.match(/[A-Za-z][A-Za-z0-9_-]{2,}/g) || [];
  const filtered = codeLikeMatch.filter((token) => {
    const lowered = token.toLowerCase();
    return !['install', 'apply', 'add', 'skill', 'skills', 'this'].includes(lowered);
  });
  if (filtered.length > 0) {
    return filtered[0] || latest.slice(0, 120);
  }
  if (codeLikeMatch.length > 0) {
    return codeLikeMatch[0] || latest.slice(0, 120);
  }
  return latest.slice(0, 120);
}

function buildAutomaticOpenAppName(prompt: string): string {
  const latest = extractLatestUserText(prompt);
  if (/steam|蒸汽平台/i.test(latest)) return 'Steam';
  if (/notepad|记事本/i.test(latest)) return 'notepad.exe';
  if (/browser|chrome|edge|浏览器/i.test(latest)) return 'msedge.exe';
  if (/calculator|calc|计算器/i.test(latest)) return 'calc.exe';
  if (/powershell/i.test(latest)) return 'powershell.exe';
  if (/cmd|command prompt|命令提示符/i.test(latest)) return 'cmd.exe';
  return latest.slice(0, 120);
}

function buildPreferredBrowserToolCall(prompt: string): ToolCall {
  const latest = extractLatestUserText(prompt);
  const explicitUrl = extractExplicitUrl(latest);
  if (explicitUrl) {
    return { tool: 'browser_navigate', input: { url: explicitUrl } };
  }
  if (isLikelyBrowserSearchRequest(prompt)) {
    return { tool: 'browser_navigate', input: { url: buildAutomaticBrowserSearchUrl(prompt) } };
  }
  if (detectScreenshotTarget(latest) === 'browser-page') {
    return { tool: 'browser_screenshot', input: {} };
  }
  return { tool: 'browser_snapshot', input: {} };
}

function buildPreferredInternetToolCall(prompt: string): ToolCall {
  const latest = extractLatestUserText(prompt);
  const explicitUrl = extractExplicitUrl(latest);
  if (explicitUrl) {
    return { tool: 'web_fetch', input: { url: explicitUrl } };
  }
  return { tool: 'web_search', input: { query: buildAutomaticSearchQuery(prompt) } };
}

function detectEastmoneyMarket(prompt: string): string {
  const latest = extractLatestUserText(prompt);
  if (latest.includes('港股')) return '港股';
  if (latest.includes('美股')) return '美股';
  if (latest.includes('A股') || latest.includes('a股')) return 'A股';
  return '';
}

function buildPreferredEastmoneyToolCall(prompt: string): ToolCall {
  return {
    tool: 'eastmoney_select_stock',
    input: {
      keyword: extractLatestUserText(prompt),
      market: detectEastmoneyMarket(prompt),
    },
  };
}

function isBrowserTool(tool: SupportedTool): boolean {
  return BROWSER_TOOL_SET.has(tool);
}

function isHostTool(tool: SupportedTool): boolean {
  return HOST_TOOL_SET.has(tool);
}

function isInternetTool(tool: SupportedTool): boolean {
  return INTERNET_TOOL_SET.has(tool);
}

function decideFirstAction(prompt: string, modelToolCall: ToolCall | null): FirstActionDecision {
  const profile = buildIntentProfile(prompt);
  const wantsBrowserWorkflow = profile.browserWorkflowScore >= 4 || profile.screenshotTarget === 'browser-page' || profile.hasExplicitUrl;
  const wantsBrowserSearch = wantsBrowserWorkflow && profile.browserSearchScore >= 2;
  const wantsDesktopScreenshot = profile.screenshotTarget === 'desktop' && !wantsBrowserWorkflow;
  const wantsInstallSkill = isLikelySkillInstallRequest(prompt);
  const wantsEastmoney = profile.eastmoneyScore >= 4 && !wantsInstallSkill;
  const wantsOpenApp = profile.openAppScore >= 4 && profile.browserWorkflowScore < profile.openAppScore;
  const wantsInternet = profile.internetScore >= 3 && !wantsBrowserWorkflow && !wantsInstallSkill && !wantsEastmoney;

  if (modelToolCall) {
    if (wantsEastmoney) {
      if (modelToolCall.tool === 'eastmoney_select_stock') {
        return { kind: 'tool', toolCall: modelToolCall, reason: 'eastmoney-model-choice', source: 'model' };
      }
      return { kind: 'tool', toolCall: buildPreferredEastmoneyToolCall(prompt), reason: 'forced-eastmoney-tool', source: 'override' };
    }
    if (wantsBrowserWorkflow) {
      if (isBrowserTool(modelToolCall.tool)) {
        return { kind: 'tool', toolCall: modelToolCall, reason: 'browser-workflow-model-choice', source: 'model' };
      }
      return { kind: 'tool', toolCall: buildPreferredBrowserToolCall(prompt), reason: 'forced-browser-workflow', source: 'override' };
    }
    if (wantsDesktopScreenshot) {
      if (modelToolCall.tool === 'take_screenshot') {
        return { kind: 'tool', toolCall: modelToolCall, reason: 'desktop-screenshot-model-choice', source: 'model' };
      }
      return { kind: 'tool', toolCall: { tool: 'take_screenshot', input: {} }, reason: 'forced-desktop-screenshot', source: 'override' };
    }
    if (wantsInstallSkill) {
      if (modelToolCall.tool === 'apply_skill') {
        return { kind: 'tool', toolCall: modelToolCall, reason: 'install-skill-model-choice', source: 'model' };
      }
      return { kind: 'tool', toolCall: { tool: 'apply_skill', input: { skill: buildAutomaticSkillName(prompt) } }, reason: 'forced-install-skill', source: 'override' };
    }
    if (wantsOpenApp) {
      if (modelToolCall.tool === 'open_app') {
        return { kind: 'tool', toolCall: modelToolCall, reason: 'open-app-model-choice', source: 'model' };
      }
      return { kind: 'tool', toolCall: { tool: 'open_app', input: { app: buildAutomaticOpenAppName(prompt) } }, reason: 'forced-open-app', source: 'override' };
    }
    if (wantsInternet) {
      if (isInternetTool(modelToolCall.tool) || isBrowserTool(modelToolCall.tool)) {
        return { kind: 'tool', toolCall: modelToolCall, reason: 'internet-model-choice', source: 'model' };
      }
      return { kind: 'tool', toolCall: buildPreferredInternetToolCall(prompt), reason: 'forced-internet-tool', source: 'override' };
    }
    return { kind: 'tool', toolCall: modelToolCall, reason: 'model-choice', source: 'model' };
  }

  if (wantsBrowserWorkflow) {
    return { kind: 'tool', toolCall: buildPreferredBrowserToolCall(prompt), reason: wantsBrowserSearch ? 'browser-workflow-fallback' : 'browser-workflow-fallback', source: 'fallback' };
  }
  if (wantsDesktopScreenshot) {
    return { kind: 'tool', toolCall: { tool: 'take_screenshot', input: {} }, reason: 'desktop-screenshot-fallback', source: 'fallback' };
  }
  if (wantsInstallSkill) {
    return { kind: 'tool', toolCall: { tool: 'apply_skill', input: { skill: buildAutomaticSkillName(prompt) } }, reason: 'install-skill-fallback', source: 'fallback' };
  }
  if (wantsEastmoney) {
    return { kind: 'tool', toolCall: buildPreferredEastmoneyToolCall(prompt), reason: 'eastmoney-fallback', source: 'fallback' };
  }
  if (wantsOpenApp) {
    return { kind: 'tool', toolCall: { tool: 'open_app', input: { app: buildAutomaticOpenAppName(prompt) } }, reason: 'open-app-fallback', source: 'fallback' };
  }
  if (wantsInternet) {
    return { kind: 'tool', toolCall: buildPreferredInternetToolCall(prompt), reason: 'internet-fallback', source: 'fallback' };
  }
  return { kind: 'direct-answer', reason: 'no-first-tool-needed' };
}

function buildRuntimeHintMessages(prompt: string): ConversationMessage[] {
  const profile = buildIntentProfile(prompt);
  if (isLikelySkillInstallRequest(prompt)) {
    return [{ role: 'system', content: 'The latest user request is about installing a NanoClaw skill. Use apply_skill with the local packaged skill name when possible. If the requested skill is not a packaged local skill, explain that manifest.yaml and SKILL.md are required.' }];
  }
  if (profile.eastmoneyScore >= 4) {
    return [{ role: 'system', content: 'The latest user request is about stock screening or stock recommendations. Prefer the eastmoney_select_stock tool because it uses fresh Eastmoney data. Pass the latest user request as the keyword. If the user mentions A股, 港股, or 美股, include that market. After the tool returns, summarize the results in Chinese and mention the exported CSV and description file paths.' }];
  }
  if (profile.browserWorkflowScore >= 4 || profile.screenshotTarget === 'browser-page' || profile.hasExplicitUrl) {
    return [{ role: 'system', content: 'The latest user request is a browser workflow. Prefer browser_navigate, browser_snapshot, browser_click, browser_type, browser_read, and browser_screenshot as needed. If the user asks to search in the browser and then provide a screenshot, start by navigating to a relevant page and use browser_screenshot after the page is ready. Only use take_screenshot for a desktop or full-screen capture.' }];
  }
  if (profile.internetScore >= 3) {
    return [{ role: 'system', content: 'The latest user request appears to need fresh web information. Prefer using web_search first, then web_fetch when a result page needs confirmation. Do not claim you lack internet access unless a tool call actually fails.' }];
  }
  return [];
}
function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
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
    const files = fs.readdirSync(IPC_INPUT_DIR).filter((file) => file.endsWith('.json')).sort();
    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { type?: string; text?: string };
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) messages.push(data.text);
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

function isToolCallShape(value: unknown): value is ToolCall {
  if (!value || typeof value !== 'object') return false;
  const parsed = value as ToolCall;
  if (typeof parsed.tool !== 'string' || !SUPPORTED_TOOLS.includes(parsed.tool as SupportedTool)) return false;
  return Boolean(parsed.input && typeof parsed.input === 'object');
}

function normalizeParsedToolCall(value: unknown): ToolCall | null {
  if (!value || typeof value !== 'object') return null;
  const parsed = value as { tool?: unknown; input?: unknown };
  if (isToolCallShape(parsed)) return parsed;
  if (typeof parsed.tool !== 'string' || !parsed.input || typeof parsed.input !== 'object') {
    return null;
  }

  const toolAliasMap: Partial<Record<string, SupportedTool>> = {
    web_browse: 'browser_navigate',
    browse_web: 'browser_navigate',
    open_webpage: 'browser_navigate',
    open_website: 'browser_navigate',
  };

  const mappedTool = toolAliasMap[parsed.tool.toLowerCase()];
  if (!mappedTool) return null;

  const normalized: ToolCall = {
    tool: mappedTool,
    input: parsed.input as ToolCall['input'],
  };
  return isToolCallShape(normalized) ? normalized : null;
}

function tryParseToolCallCandidate(candidate: string): ToolCall | null {
  try {
    const parsed = JSON.parse(candidate);
    return normalizeParsedToolCall(parsed);
  } catch {
    return null;
  }
}

function extractJsonObjectCandidates(text: string): string[] {
  const candidates: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '{') {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (char === '}') {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0 && start !== -1) {
        candidates.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return candidates;
}

function parseToolCall(text: string): ToolCall | null {
  const trimmed = text.trim();
  const direct = tryParseToolCallCandidate(trimmed);
  if (direct) return direct;

  const withoutFences = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const fenced = tryParseToolCallCandidate(withoutFences);
  if (fenced) return fenced;

  for (const candidate of extractJsonObjectCandidates(withoutFences)) {
    const parsed = tryParseToolCallCandidate(candidate);
    if (parsed) return parsed;
  }
  return null;
}

function sanitizeHistory(messages: ConversationMessage[]): ConversationMessage[] {
  return messages.filter((message) => {
    if (message.content.includes(TOOL_RESULT_MARKER)) return false;
    if (message.role === 'assistant') {
      if (STALE_LIMITATION_PATTERN.test(message.content)) return false;
      if (parseToolCall(message.content)) return false;
    }
    return true;
  });
}

function writeHostToolRequest(call: ToolCall): string {
  fs.mkdirSync(HOST_TOOL_REQUEST_DIR, { recursive: true });
  fs.mkdirSync(HOST_TOOL_RESULT_DIR, { recursive: true });
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(path.join(HOST_TOOL_REQUEST_DIR, `${id}.json`), JSON.stringify({ id, type: call.tool, app: call.input.app, skill: call.input.skill, skillPath: call.input.skillPath, timestamp: new Date().toISOString() }, null, 2));
  return id;
}

async function waitForHostToolResult(id: string): Promise<HostToolResult> {
  const resultPath = path.join(HOST_TOOL_RESULT_DIR, `${id}.json`);
  const timeoutAt = Date.now() + 30000;
  while (Date.now() < timeoutAt) {
    if (fs.existsSync(resultPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(resultPath, 'utf8')) as HostToolResult;
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
  if (!result.ok) throw new Error(result.message || ('Host tool failed: ' + call.tool));

  if (call.tool === 'take_screenshot') {
    return {
      raw: result,
      summary: ['HOST_SCREENSHOT_OK', 'MESSAGE: ' + result.message, result.screenshotPath ? 'SCREENSHOT_PATH: ' + result.screenshotPath : '', result.screenshotUrl ? 'SCREENSHOT_URL: ' + result.screenshotUrl : ''].filter(Boolean).join('\n'),
    };
  }

  return { raw: result, summary: 'HOST_ACTION_OK\nMESSAGE: ' + result.message };
}

function runCommand(
  file: string,
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { cwd, env: process.env }, (error, stdout, stderr) => {
      if (error) {
        reject(
          new Error(
            [error.message, stderr.trim(), stdout.trim()].filter(Boolean).join('\n'),
          ),
        );
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function sanitizeFilePrefix(value: string): string {
  return value
    .replace(/[^\w\u4e00-\u9fff-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

async function executeEastmoneyTool(call: ToolCall): Promise<string> {
  const keyword = (call.input.keyword || call.input.query || '').trim();
  if (!keyword) {
    throw new Error('eastmoney_select_stock requires a keyword');
  }

  const args = [
    keyword,
    '--output-dir',
    'eastmoney-output',
    '--prefix',
    sanitizeFilePrefix(keyword) || 'eastmoney',
  ];

  const market = (call.input.market || '').trim();
  if (market) {
    args.push('--market', market);
  }

  const { stdout } = await runCommand(
    'eastmoney-select-stock',
    args,
    '/workspace/group',
  );
  return stdout.trim();
}

function stringifyToolOutput(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function makeToolResultMessage(tool: SupportedTool, toolOutput: string): ConversationMessage {
  return {
    role: 'user',
    content: [TOOL_RESULT_MARKER, `Tool: ${tool}`, 'Source: runtime', '', 'Payload:', toolOutput, '', TOOL_RESULT_CONTINUATION_HINT].join('\n'),
  };
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
      return stringifyToolOutput(await browserType(call.input.elementId || '', call.input.text || '', { clear: Boolean(call.input.clear), submit: Boolean(call.input.submit) }));
    case 'browser_scroll':
      return stringifyToolOutput(await browserScroll(call.input.direction === 'up' ? 'up' : 'down', call.input.amount));
    case 'browser_back':
      return stringifyToolOutput(await browserBack());
    case 'browser_forward':
      return stringifyToolOutput(await browserForward());
    case 'browser_reload':
      return stringifyToolOutput(await browserReload());
    case 'browser_read':
      return stringifyToolOutput(await browserRead());
    case 'browser_screenshot':
      return stringifyToolOutput(await browserScreenshot({ fullPage: call.input.fullPage, path: call.input.path }));
    case 'browser_links':
      return stringifyToolOutput(await browserLinks());
    case 'browser_press':
      return stringifyToolOutput(await browserPress(call.input.key || ''));
    case 'browser_select':
      return stringifyToolOutput(await browserSelect(call.input.elementId || '', call.input.value || ''));
    case 'browser_hover':
      return stringifyToolOutput(await browserHover(call.input.elementId || ''));
    case 'browser_wait_for_text':
      return stringifyToolOutput(await browserWaitForText(call.input.text || '', call.input.timeoutMs));
    default:
      throw new Error('Unsupported browser tool: ' + call.tool);
  }
}

function hasChinese(text: string): boolean {
  return /[\u3400-\u9fff]/.test(text);
}

async function finalizeDirectHostAction(sessionId: string, history: ConversationMessage[], prompt: string, reply: string, onStream?: (chunk: StreamToken) => void | Promise<void>): Promise<string> {
  if (onStream) await onStream({ kind: 'content', value: reply });
  persistConversationTurn(sessionId, history, prompt, reply);
  return reply;
}

function buildDirectHostActionReply(call: ToolCall, result: ExecutedHostToolResult, prompt: string): string {
  const prefersChinese = hasChinese(prompt);
  const isWebClient = prompt.includes('<client channel="web"');
  if (call.tool === 'take_screenshot') {
    const intro = prefersChinese ? '好的，截图已成功捕获！' : 'Done. I captured the screenshot successfully.';
    const imageLine = isWebClient && result.raw.screenshotUrl ? `\n\n![Screenshot](${result.raw.screenshotUrl})` : '';
    return intro + imageLine;
  }
  const appName = call.input.app || (prefersChinese ? '目标应用' : 'the requested app');
  return prefersChinese ? `好的，已经尝试为你打开 ${appName}。` : `Done. I attempted to open ${appName}.`;
}

function buildDirectBrowserScreenshotReply(toolOutput: string, prompt: string): string | null {
  try {
    const parsed = JSON.parse(toolOutput) as { screenshotUrl?: string; path?: string; title?: string; url?: string };
    const prefersChinese = hasChinese(prompt);
    const isWebClient = prompt.includes('<client channel="web"');
    const intro = prefersChinese ? '\u597d\u7684\uff0c\u7f51\u9875\u622a\u56fe\u5df2\u5b8c\u6210\u3002' : 'Done. I captured the webpage screenshot.';
    const details = parsed.title ? (prefersChinese ? `\n\n\u9875\u9762\uff1a${parsed.title}` : `\n\nPage: ${parsed.title}`) : '';
    const imageLine = isWebClient && parsed.screenshotUrl ? `\n\n![Screenshot](${parsed.screenshotUrl})` : '';
    const pathLine = !imageLine && parsed.path ? (prefersChinese ? `\n\n\u622a\u56fe\u6587\u4ef6\uff1a${parsed.path}` : `\n\nScreenshot file: ${parsed.path}`) : '';
    return intro + details + imageLine + pathLine;
  } catch {
    return null;
  }
}

async function executeToolCall(call: ToolCall): Promise<string> {
  if (call.tool === 'eastmoney_select_stock') return executeEastmoneyTool(call);
  if (call.tool === 'web_search') return webSearch(call.input.query || '');
  if (call.tool === 'web_fetch') return webFetch(call.input.url || '');
  if (call.tool.startsWith('browser_')) return executeBrowserTool(call);
  const hostResult = await executeHostTool(call);
  return hostResult.summary;
}

function getToolCallSignature(call: ToolCall): string {
  return `${call.tool}:${JSON.stringify(call.input || {})}`;
}

function getMaxToolSteps(prompt: string): number {
  return isLikelyBrowserWorkflowRequest(prompt) ? BROWSER_WORKFLOW_MAX_TOOL_STEPS : DEFAULT_MAX_TOOL_STEPS;
}

function shouldShortCircuitHostAction(decision: FirstActionDecision): boolean {
  return decision.kind === 'tool' && decision.source !== 'model' && isHostTool(decision.toolCall.tool);
}

function isElementTargetedBrowserTool(tool: SupportedTool): boolean {
  return ELEMENT_TARGETED_BROWSER_TOOLS.has(tool);
}

function buildBrowserFollowUpFallback(prompt: string, hasBrowserSnapshot: boolean): ToolCall | null {
  const latest = extractLatestUserText(prompt);
  if (detectScreenshotTarget(latest) === 'browser-page') {
    return hasBrowserSnapshot
      ? { tool: 'browser_screenshot', input: {} }
      : { tool: 'browser_snapshot', input: {} };
  }

  if (isLikelyBrowserSearchRequest(prompt)) {
    return hasBrowserSnapshot
      ? { tool: 'browser_screenshot', input: {} }
      : { tool: 'browser_snapshot', input: {} };
  }

  return hasBrowserSnapshot ? null : { tool: 'browser_snapshot', input: {} };
}

function shouldPreferBrowserPageScreenshot(prompt: string): boolean {
  const latest = extractLatestUserText(prompt);
  const normalized = normalizeIntentText(latest);
  const target = detectScreenshotTarget(latest);
  const mentionsScreenshot =
    normalized.includes('screenshot') ||
    normalized.includes('screen shot') ||
    normalized.includes('\u622a\u56fe') ||
    normalized.includes('\u622a\u5c4f');
  return target === 'browser-page' || (mentionsScreenshot && isLikelyBrowserWorkflowRequest(prompt));
}

async function askModel(messages: ConversationMessage[]): Promise<{
  text: string;
  host: string;
  model: string;
  promptEvalCount: number;
  evalCount: number;
}> {
  const model = (process.env.OLLAMA_MODEL || '').trim();
  if (!model) throw new Error('OLLAMA_MODEL is not configured');

  const body: Record<string, unknown> = { model, messages, stream: false };
  const temperature = Number(process.env.OLLAMA_TEMPERATURE || '');
  if (!Number.isNaN(temperature)) body.options = { temperature };

  const { response, host } = await ollamaFetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Ollama error from ${host} (${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as { message?: { content?: string }; prompt_eval_count?: number; eval_count?: number };
  const text = data.message?.content?.trim();
  if (!text) throw new Error('Ollama returned an empty response');

  return {
    text,
    host,
    model,
    promptEvalCount: data.prompt_eval_count || 0,
    evalCount: data.eval_count || 0,
  };
}

async function streamModelAnswer(messages: ConversationMessage[], onToken: (token: StreamToken) => void | Promise<void>, options?: { includeThinking?: boolean }): Promise<{ text: string; host: string; model: string }> {
  const model = (process.env.OLLAMA_MODEL || '').trim();
  if (!model) throw new Error('OLLAMA_MODEL is not configured');

  const body: Record<string, unknown> = { model, messages, stream: true };
  const temperature = Number(process.env.OLLAMA_TEMPERATURE || '');
  if (!Number.isNaN(temperature)) body.options = { temperature };

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
      const data = JSON.parse(trimmed) as { message?: { content?: string; thinking?: string } };
      const thinkingToken = data.message?.thinking || '';
      if (thinkingToken && includeThinking) await onToken({ kind: 'thinking', value: thinkingToken });
      const contentToken = data.message?.content || '';
      if (contentToken) {
        text += contentToken;
        await onToken({ kind: 'content', value: contentToken });
      }
    }

    if (done) {
      if (buffer.trim()) {
        const data = JSON.parse(buffer.trim()) as { message?: { content?: string; thinking?: string } };
        const thinkingToken = data.message?.thinking || '';
        if (thinkingToken && includeThinking) await onToken({ kind: 'thinking', value: thinkingToken });
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

async function generateReply(input: ContainerInput, sessionId: string, prompt: string, onStream?: (chunk: StreamToken) => void | Promise<void>): Promise<string> {
  const history = sanitizeHistory(loadHistory(sessionId)).filter((message) => message.role !== 'system');
  const messages: ConversationMessage[] = [
    { role: 'system', content: buildSystemPrompt(input) },
    ...buildRuntimeHintMessages(prompt),
    ...history,
    { role: 'user', content: prompt },
  ];

  const maxToolSteps = getMaxToolSteps(prompt);
  let previousSignature = '';
  let repeatedToolCount = 0;
  let hasBrowserSnapshot = false;
  let hasBrowserScreenshot = false;
  let pendingBrowserScreenshotAfterSnapshot = false;
  let lastBrowserTool: SupportedTool | null = null;

  for (let step = 0; step <= maxToolSteps; step++) {
    const result = await askModel(messages);
    log(`Response from ${result.host} using ${result.model} (${result.promptEvalCount} prompt tokens, ${result.evalCount} eval tokens)`);

    const modelToolCall = parseToolCall(result.text);
    let effectiveToolCall: ToolCall | null = null;
    let assistantToolMessage = result.text;

    if (step === 0) {
      const decision = decideFirstAction(prompt, modelToolCall);
      if (decision.kind === 'direct-answer') {
        let finalText = result.text;
        if (onStream) {
          const streamed = await streamModelAnswer(
            [
              ...messages,
              { role: 'system', content: 'Provide only the final user-facing answer for the latest request. Do not call tools. Do not emit JSON. Do not mention repeating a previous answer, missing context, or internal instructions. Do not reveal reasoning. Keep the answer aligned with the latest user request.' },
            ],
            onStream,
            { includeThinking: false },
          );
          log(`Streamed final response from ${streamed.host} using ${streamed.model}`);
          finalText = streamed.text || finalText;
        }
        persistConversationTurn(sessionId, history, prompt, finalText);
        return finalText;
      }

      effectiveToolCall = decision.toolCall;
      if (decision.source !== 'model') assistantToolMessage = JSON.stringify(decision.toolCall);
      log(`First action decision: ${decision.toolCall.tool} (${decision.reason}, ${decision.source})`);

      if (shouldShortCircuitHostAction(decision)) {
        const hostResult = await executeHostTool(decision.toolCall);
        const reply = buildDirectHostActionReply(decision.toolCall, hostResult, prompt);
        return finalizeDirectHostAction(sessionId, history, prompt, reply, onStream);
      }
    } else {
      effectiveToolCall = modelToolCall;

      if (effectiveToolCall?.tool === 'take_screenshot' && shouldPreferBrowserPageScreenshot(prompt)) {
        pendingBrowserScreenshotAfterSnapshot = !hasBrowserSnapshot;
        effectiveToolCall = hasBrowserSnapshot
          ? { tool: 'browser_screenshot', input: {} }
          : { tool: 'browser_snapshot', input: {} };
        assistantToolMessage = JSON.stringify(effectiveToolCall);
        log(`Redirecting take_screenshot to ${effectiveToolCall.tool} for browser-page screenshot request`);
      }

      if (effectiveToolCall && isBrowserTool(effectiveToolCall.tool)) {
        if (isElementTargetedBrowserTool(effectiveToolCall.tool) && !hasBrowserSnapshot) {
          log(`Guarding browser action ${effectiveToolCall.tool}: inserting browser_snapshot before element-targeted action`);
          effectiveToolCall = { tool: 'browser_snapshot', input: {} };
          assistantToolMessage = JSON.stringify(effectiveToolCall);
        }

        if (effectiveToolCall.tool === 'browser_screenshot' && !hasBrowserSnapshot && lastBrowserTool === 'browser_navigate') {
          pendingBrowserScreenshotAfterSnapshot = true;
          log('Guarding browser_screenshot: inserting browser_snapshot after initial navigation');
          effectiveToolCall = { tool: 'browser_snapshot', input: {} };
          assistantToolMessage = JSON.stringify(effectiveToolCall);
        }
      }
    }

    if (!effectiveToolCall) {
      if (step > 0 && pendingBrowserScreenshotAfterSnapshot && hasBrowserSnapshot && !hasBrowserScreenshot) {
        effectiveToolCall = { tool: 'browser_screenshot', input: {} };
        assistantToolMessage = JSON.stringify(effectiveToolCall);
        pendingBrowserScreenshotAfterSnapshot = false;
        log('Completing deferred webpage screenshot with browser_screenshot');
      }

      if (
        !effectiveToolCall &&
        step > 0 &&
        shouldPreferBrowserPageScreenshot(prompt) &&
        !hasBrowserScreenshot &&
        lastBrowserTool &&
        ['browser_navigate', 'browser_snapshot', 'browser_read', 'browser_links'].includes(lastBrowserTool)
      ) {
        effectiveToolCall = hasBrowserSnapshot
          ? { tool: 'browser_screenshot', input: {} }
          : { tool: 'browser_snapshot', input: {} };
        assistantToolMessage = JSON.stringify(effectiveToolCall);
        log(`No webpage screenshot produced yet, inserting ${effectiveToolCall.tool}`);
      }

      if (!effectiveToolCall && step > 0 && lastBrowserTool === 'browser_navigate') {
        const browserFallback = buildBrowserFollowUpFallback(prompt, hasBrowserSnapshot);
        if (browserFallback) {
          log(`No follow-up tool emitted after browser_navigate, inserting ${browserFallback.tool}`);
          effectiveToolCall = browserFallback;
          assistantToolMessage = JSON.stringify(browserFallback);
        }
      }

      if (!effectiveToolCall) {
        let finalText = result.text;
      if (onStream) {
        const streamed = await streamModelAnswer(
          [
            ...messages,
            { role: 'system', content: 'Provide only the final user-facing answer for the latest request. Do not call tools. Do not emit JSON. Do not mention repeating a previous answer, missing context, or internal instructions. Do not reveal reasoning. Keep the answer aligned with the latest user request.' },
          ],
          onStream,
          { includeThinking: false },
        );
        log(`Streamed final response from ${streamed.host} using ${streamed.model}`);
        finalText = streamed.text || finalText;
      }
        persistConversationTurn(sessionId, history, prompt, finalText);
        return finalText;
      }
    }

    if (step === maxToolSteps) {
      throw new Error(`Tool loop exceeded maximum number of steps (${maxToolSteps})`);
    }

    const signature = getToolCallSignature(effectiveToolCall);
    if (signature === previousSignature) {
      repeatedToolCount += 1;
      if (repeatedToolCount >= MAX_REPEATED_TOOL_CALLS) {
        throw new Error(`Tool loop repeated the same action too many times: ${signature}`);
      }
    } else {
      previousSignature = signature;
      repeatedToolCount = 0;
    }

    log(`Executing tool: ${effectiveToolCall.tool}`);
    const toolOutput = await executeToolCall(effectiveToolCall);
    if (effectiveToolCall.tool === 'browser_screenshot') {
      const directScreenshotReply = buildDirectBrowserScreenshotReply(toolOutput, prompt);
      if (directScreenshotReply) {
        if (onStream) {
          await onStream({ kind: 'content', value: directScreenshotReply });
        }
        persistConversationTurn(sessionId, history, prompt, directScreenshotReply);
        return directScreenshotReply;
      }
    }
    if (effectiveToolCall.tool === 'browser_snapshot') {
      hasBrowserSnapshot = true;
    }
    if (effectiveToolCall.tool === 'browser_screenshot') {
      hasBrowserScreenshot = true;
      pendingBrowserScreenshotAfterSnapshot = false;
    }
    if (isBrowserTool(effectiveToolCall.tool)) {
      lastBrowserTool = effectiveToolCall.tool;
    }
    messages.push({ role: 'assistant', content: assistantToolMessage });
    messages.push(makeToolResultMessage(effectiveToolCall.tool, toolOutput));
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
    writeOutput({ status: 'error', result: null, error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}` });
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
  if (input.isScheduledTask) prompt = `[SCHEDULED TASK]\n\n${prompt}`;

  const pending = drainIpcInput();
  if (pending.length > 0) prompt += `\n${pending.join('\n')}`;

  try {
    while (true) {
      const reply = await generateReply(
        input,
        sessionId,
        prompt,
        input.streamToHost
          ? async (chunk) => {
              writeOutput({ status: 'success', result: chunk.value, newSessionId: sessionId, stream: true, streamKind: chunk.kind, done: false });
            }
          : undefined,
      );
      writeOutput({ status: 'success', result: reply, newSessionId: sessionId, done: true });

      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }
      prompt = nextMessage;
    }
  } catch (err) {
    writeOutput({ status: 'error', result: null, newSessionId: sessionId, error: err instanceof Error ? err.message : String(err), done: true });
    process.exit(1);
  }
}

main();

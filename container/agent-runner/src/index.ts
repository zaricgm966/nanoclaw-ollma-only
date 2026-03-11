/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, and answers via Ollama.
 */

import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

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
  done?: boolean;
}

interface ConversationMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ToolCall {
  tool: 'web_search' | 'web_fetch';
  input: {
    query?: string;
    url?: string;
  };
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';
const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;
const SESSION_DIR = '/workspace/group/.nanoclaw-ollama';
const DEFAULT_OLLAMA_HOSTS = [
  'http://host.docker.internal:11434',
  'http://gateway.docker.internal:11434',
  'http://172.17.0.1:11434',
  'http://localhost:11434',
];
const MAX_TOOL_STEPS = 4;
const CURL_ARGS = ['-L', '--max-time', '20', '--connect-timeout', '10', '-A', 'NanoClaw/1.0'];
const INTERNET_REQUEST_PATTERN =
  /\b(search|latest|today|current|news|official|website|site|web|internet|online|github)\b/i;
const STALE_LIMITATION_PATTERN =
  /without Claude Code, external APIs, or remote tools|cannot access real[- ]?time network|do not have web search|cannot browse the web|as of 2024/i;

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
    'You may use two built-in internet tools when fresh online information would help: web_search and web_fetch.',
    'If you want to use a tool, reply with ONLY compact JSON and no markdown fences.',
    'Tool call format: {"tool":"web_search","input":{"query":"..."}} or {"tool":"web_fetch","input":{"url":"https://..."}}.',
    'Only call one tool at a time. After you receive tool output, continue reasoning and either call another tool or provide the final answer normally.',
    'If you already have enough information, answer normally and do not emit JSON.',
    'Be honest about limitations. Do not claim to have executed commands or modified files unless the host explicitly did so outside this model.',
    'Reply in the same language as the user when practical, and keep answers useful and direct.',
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
  return INTERNET_REQUEST_PATTERN.test(prompt);
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

function runCurl(url: string): string {
  return execFileSync('curl', [...CURL_ARGS, url], {
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
    env: process.env,
  });
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x2F;/g, '/');
}

function stripHtml(html: string): string {
  return decodeHtml(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );
}

function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? stripHtml(match[1]) : '';
}

function resolveDuckDuckGoUrl(url: string): string {
  try {
    const parsed = new URL(url, 'https://duckduckgo.com');
    const uddg = parsed.searchParams.get('uddg');
    if (uddg) {
      return decodeURIComponent(uddg);
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

function webSearch(query: string): string {
  if (!query.trim()) {
    throw new Error('web_search requires a non-empty query');
  }

  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const html = runCurl(searchUrl);
  const matches = [...html.matchAll(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
  const fallback = matches.length === 0
    ? [...html.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)].slice(0, 8)
    : matches;

  const results = fallback
    .map((match) => {
      const url = resolveDuckDuckGoUrl(match[1]);
      const title = stripHtml(match[2]);
      if (!title || !/^https?:/i.test(url)) return null;
      return { title, url };
    })
    .filter((result): result is { title: string; url: string } => result !== null)
    .slice(0, 5);

  if (results.length === 0) {
    return `No search results found for: ${query}`;
  }

  return [
    `Search results for: ${query}`,
    ...results.map((result, index) => `${index + 1}. ${result.title}\n${result.url}`),
  ].join('\n\n');
}

function webFetch(url: string): string {
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('web_fetch only supports http and https URLs');
  }

  const html = runCurl(url);
  const title = extractTitle(html);
  const text = stripHtml(html).slice(0, 6000);
  const sections = [`Fetched: ${url}`];
  if (title) {
    sections.push(`Title: ${title}`);
  }
  sections.push(`Content:\n${text || '[no text content extracted]'}`);
  return sections.join('\n\n');
}

function parseToolCall(text: string): ToolCall | null {
  const trimmed = text.trim();
  const withoutFences = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');

  try {
    const parsed = JSON.parse(withoutFences) as ToolCall;
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.tool !== 'web_search' && parsed.tool !== 'web_fetch') return null;
    if (!parsed.input || typeof parsed.input !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

function executeToolCall(call: ToolCall): string {
  if (call.tool === 'web_search') {
    return webSearch(call.input.query || '');
  }
  return webFetch(call.input.url || '');
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
  onToken: (token: string) => void | Promise<void>,
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
        message?: { content?: string };
        done?: boolean;
      };
      const token = data.message?.content || '';
      if (token) {
        text += token;
        await onToken(token);
      }
    }

    if (done) {
      if (buffer.trim()) {
        const data = JSON.parse(buffer.trim()) as {
          message?: { content?: string };
        };
        const token = data.message?.content || '';
        if (token) {
          text += token;
          await onToken(token);
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
  onStream?: (chunk: string) => void | Promise<void>,
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

  if (isLikelyInternetRequest(prompt)) {
    messages.splice(1, 0, {
      role: 'system',
      content:
        'The latest user request appears to need fresh web information. Prefer using web_search first, then web_fetch when a result page needs confirmation. Do not answer that you lack internet access unless a tool call actually fails.',
    });
  }

  for (let step = 0; step <= MAX_TOOL_STEPS; step++) {
    const result = await askModel(messages);
    log(
      `Response from ${result.host} using ${result.model} (${result.promptEvalCount} prompt tokens, ${result.evalCount} eval tokens)`,
    );

    const toolCall = parseToolCall(result.text);
    if (!toolCall) {
      let finalText = result.text;
      if (onStream) {
        const streamMessages: ConversationMessage[] = [
          ...messages,
          {
            role: 'system',
            content:
              'Repeat the final answer for the user in normal prose. Do not call tools. Do not emit JSON. Keep the substance aligned with the previous answer.',
          },
        ];
        const streamed = await streamModelAnswer(streamMessages, onStream);
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

    log(`Executing tool: ${toolCall.tool}`);
    const toolOutput = executeToolCall(toolCall);
    messages.push({ role: 'assistant', content: result.text });
    messages.push({
      role: 'user',
      content: `Tool result for ${toolCall.tool}:\n${toolOutput}\n\nNow continue and answer the user, or request another tool if still necessary.`,
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
                result: chunk,
                newSessionId: sessionId,
                stream: true,
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

/**
 * Ollama MCP Server for NanoClaw
 * Exposes local Ollama models as tools for the container agent.
 */

import fs from 'fs';
import path from 'path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const DEFAULT_OLLAMA_HOSTS = [
  'http://host.docker.internal:11434',
  'http://gateway.docker.internal:11434',
  'http://172.17.0.1:11434',
  'http://localhost:11434',
];
const OLLAMA_STATUS_FILE = '/workspace/ipc/ollama_status.json';

function log(msg: string): void {
  console.error(`[OLLAMA] ${msg}`);
}

function writeStatus(status: string, detail?: string): void {
  try {
    const data = { status, detail, timestamp: new Date().toISOString() };
    const tmpPath = `${OLLAMA_STATUS_FILE}.tmp`;
    fs.mkdirSync(path.dirname(OLLAMA_STATUS_FILE), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(data));
    fs.renameSync(tmpPath, OLLAMA_STATUS_FILE);
  } catch {
    // Best-effort status reporting only.
  }
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

const server = new McpServer({
  name: 'ollama',
  version: '1.0.0',
});

server.tool(
  'ollama_list_models',
  'List all locally installed Ollama models. Use this to see which models are available before calling ollama_generate.',
  {},
  async () => {
    log('Listing models...');
    writeStatus('listing', 'Listing available models');
    try {
      const { response, host } = await ollamaFetch('/api/tags');
      if (!response.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Ollama API error from ${host}: ${response.status} ${response.statusText}`,
            },
          ],
          isError: true,
        };
      }

      const data = (await response.json()) as {
        models?: Array<{ name: string; size: number; modified_at: string }>;
      };
      const models = data.models || [];

      if (models.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `No models installed on ${host}. Run \`ollama pull <model>\` on the host to install one.`,
            },
          ],
        };
      }

      const list = models
        .map((model) => `- ${model.name} (${(model.size / 1e9).toFixed(1)}GB)`)
        .join('\n');

      log(`Found ${models.length} models via ${host}`);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Installed models (${host}):\n${list}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: err instanceof Error ? err.message : String(err),
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  'ollama_generate',
  'Send a prompt to a local Ollama model and get a response. Good for cheaper/faster tasks like summarization, translation, or general queries. Use ollama_list_models first to see available models.',
  {
    model: z.string().describe('The model name (e.g., "llama3.2", "mistral", "gemma2")'),
    prompt: z.string().describe('The prompt to send to the model'),
    system: z.string().optional().describe('Optional system prompt to set model behavior'),
  },
  async (args) => {
    log(`>>> Generating with ${args.model} (${args.prompt.length} chars)...`);
    writeStatus('generating', `Generating with ${args.model}`);
    try {
      const body: Record<string, unknown> = {
        model: args.model,
        prompt: args.prompt,
        stream: false,
      };
      if (args.system) {
        body.system = args.system;
      }

      const { response, host } = await ollamaFetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return {
          content: [
            {
              type: 'text' as const,
              text: `Ollama error from ${host} (${response.status}): ${errorText}`,
            },
          ],
          isError: true,
        };
      }

      const data = (await response.json()) as {
        response: string;
        total_duration?: number;
        eval_count?: number;
      };

      let meta = `\n\n[${args.model} via ${host}`;
      if (data.total_duration) {
        const secs = (data.total_duration / 1e9).toFixed(1);
        meta += ` | ${secs}s`;
        if (data.eval_count) {
          meta += ` | ${data.eval_count} tokens`;
        }
        log(
          `<<< Done: ${args.model} | ${secs}s | ${data.eval_count || '?'} tokens | ${data.response.length} chars | ${host}`,
        );
        writeStatus(
          'done',
          `${args.model} via ${host} | ${secs}s | ${data.eval_count || '?'} tokens`,
        );
      } else {
        log(`<<< Done: ${args.model} | ${data.response.length} chars | ${host}`);
        writeStatus('done', `${args.model} via ${host} | ${data.response.length} chars`);
      }
      meta += ']';

      return { content: [{ type: 'text' as const, text: data.response + meta }] };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: err instanceof Error ? err.message : String(err),
          },
        ],
        isError: true,
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
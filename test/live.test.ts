import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ModelEngine } from '../src/engine.js';
import { createMcpServer } from '../src/server.js';
import type { AppConfig, ProviderConfig } from '../src/types.js';

/**
 * Live tests are deliberately opt in. They make one small, fixed inference
 * request against a configured OpenAI-compatible endpoint and never print
 * credentials or model output to the test log.
 */
const enabled = process.env.MODEL_AS_TOOL_LIVE === '1';
const baseUrl = process.env.MODEL_AS_TOOL_LIVE_BASE_URL;
const modelName = process.env.MODEL_AS_TOOL_LIVE_MODEL;

function config(): AppConfig {
  if (!baseUrl || !modelName) throw new Error('Set MODEL_AS_TOOL_LIVE_BASE_URL and MODEL_AS_TOOL_LIVE_MODEL for the live test');
  const provider: ProviderConfig = {
    type: 'openai',
    baseUrl,
    // The name is safe to include in source. Its value stays in the process
    // environment and is consumed only by the provider adapter.
    ...(process.env.MODEL_AS_TOOL_LIVE_API_KEY ? { apiKeyEnv: 'MODEL_AS_TOOL_LIVE_API_KEY' } : {})
  };
  return {
    providers: { live: provider },
    models: {
      live: {
        provider: 'live',
        model: modelName,
        aliases: ['live-model'],
        capabilities: {
          roles: ['system', 'user', 'assistant'],
          input: ['text'],
          output: ['text'],
          streaming: true,
          json: true,
          jsonSchema: false,
          options: ['maxTokens', 'temperature', 'topP', 'stop', 'seed']
        }
      }
    },
    routes: {},
    presets: {},
    policy: {
      concurrency: 1,
      maxQueue: 1,
      timeoutMs: 30_000,
      requestsPerMinute: 0,
      retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
      circuit: { failures: 0, resetMs: 0 },
      cache: { enabled: false, ttlMs: 0, maxEntries: 0 },
      deduplicate: false,
      records: { enabled: false, includeContent: false, maxEntries: 0 },
      sessions: { enabled: false, ttlMs: 0, maxSessions: 0, maxMessages: 0 }
    },
    http: { host: '127.0.0.1', port: 0, path: '/mcp', allowedOrigins: [], tenants: {}, maxBodyBytes: 1_048_576 }
  };
}

describe.skipIf(!enabled)('live OpenAI-compatible MCP integration', () => {
  let client: Client | undefined;
  let server: ReturnType<typeof createMcpServer> | undefined;

  afterEach(async () => {
    await client?.close().catch(() => undefined);
    await server?.close().catch(() => undefined);
    client = undefined;
    server = undefined;
  });

  it('invokes ask_model through MCP and returns the provider text', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const appConfig = config();
    const engine = new ModelEngine(appConfig);
    server = createMcpServer({ config: appConfig, engine });
    client = new Client({ name: 'model-as-tool-live-test', version: '0.1.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const listed = await client.listTools();
    expect(listed.tools.some(tool => tool.name === 'ask_model')).toBe(true);

    const result = await client.callTool({
      name: 'ask_model',
      arguments: {
        model: 'live-model',
        messages: [{ role: 'user', content: 'Reply with exactly: live probe' }],
        options: { maxTokens: 8 }
      }
    });
    expect(result.isError).not.toBe(true);
    const text = result.content?.find(part => part.type === 'text');
    expect(text?.type).toBe('text');
    expect((text as { type: 'text'; text: string }).text.trim().toLowerCase()).toContain('live probe');
  }, 40_000);
});

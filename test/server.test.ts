import { describe, expect, it } from 'vitest';
import { request as httpRequest } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer, startHttp } from '../src/server.js';
import type { AppConfig, ModelResponse } from '../src/types.js';

const config = {
  providers: {}, models: { demo: { provider: 'p', model: 'demo', capabilities: { roles: ['user'], input: ['text'], output: ['text'], streaming: true, json: false, jsonSchema: false, options: [] } } }, routes: {}, presets: {},
  policy: { concurrency: 1, maxQueue: 4, timeoutMs: 1000, requestsPerMinute: 100, retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 }, circuit: { failures: 3, resetMs: 1000 }, cache: { enabled: false, ttlMs: 1, maxEntries: 1 }, deduplicate: false, records: { enabled: false, includeContent: false, maxEntries: 1 }, sessions: { enabled: true, ttlMs: 1000, maxSessions: 2, maxMessages: 8 } },
  http: { host: '127.0.0.1', port: 0, path: '/mcp', allowedOrigins: [], tenants: {}, maxBodyBytes: 1024 * 1024 }
} as unknown as AppConfig;

function fakeEngine() {
  const response: ModelResponse = { model: 'demo', provider: 'p', text: 'hello' };
  return {
    ask: async () => response,
    detectCapabilities: async (model: string, aspects: string[]) => ({ model, requested: aspects, results: aspects.map(aspect => ({ aspect, status: 'supported', rationaleCode: 'OBSERVED_SUCCESS', details: 'ok' })) }),
    listModels: () => [{ id: 'demo', ...config.models.demo }],
    batch: async () => [{ status: 'fulfilled' as const, value: response }], probe: async () => ({ available: true }),
    createSession: () => ({ id: 's', model: 'demo', messages: [], expiresAt: Date.now() + 1000 }),
    getSession: () => ({ id: 's', model: 'demo', messages: [], expiresAt: Date.now() + 1000 }), deleteSession: () => ({ deleted: true }),
    stats: () => ({ requests: 0, succeeded: 0, failed: 0, cacheHits: 0, deduplicated: 0, inputTokens: 0, outputTokens: 0, providerCalls: 0, providerLatencyMs: 0, costs: {} }), records: () => []
  };
}

describe('MCP server', () => {
  it('lists tools and dispatches ask_model over MCP', async () => {
    const server = createMcpServer({ config, engine: fakeEngine() as never });
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const tools = await client.listTools();
    expect(tools.tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['ask_model', 'list_models', 'batch_ask', 'probe_model', 'detect_capabilities', 'create_session', 'get_session', 'delete_session', 'stats', 'records']));
    const askTool = tools.tools.find(tool => tool.name === 'ask_model');
    const listModelsTool = tools.tools.find(tool => tool.name === 'list_models');
    expect(tools.tools.every(tool => tool.outputSchema)).toBe(true);
    expect(askTool?.outputSchema).toMatchObject({ type: 'object', required: expect.arrayContaining(['model', 'provider', 'text']) });
    expect(listModelsTool?.outputSchema).toMatchObject({ type: 'object', required: ['models'] });
    const result = await client.callTool({ name: 'ask_model', arguments: { model: 'demo', messages: [{ role: 'user', content: 'hi' }] } });
    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual(expect.arrayContaining([{ type: 'text', text: 'hello' }]));
    expect(result.structuredContent).toMatchObject({ model: 'demo', provider: 'p', text: 'hello' });
    await client.close(); await server.close();
  });

  it('normalizes rejected batch results without serializing Error objects', async () => {
    const engine = fakeEngine();
    engine.batch = async () => [{ status: 'rejected', reason: new Error('secret provider detail') }];
    const server = createMcpServer({ config, engine: engine as never });
    const client = new Client({ name: 'batch-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.callTool({ name: 'batch_ask', arguments: { requests: [{ model: 'demo', messages: [{ role: 'user', content: 'hi' }] }] } });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result.structuredContent)).toContain('internal_error');
    expect(JSON.stringify(result.structuredContent)).not.toContain('secret provider detail');
    await client.close(); await server.close();
  });

  it('validates structured output for every operational tool', async () => {
    const server = createMcpServer({ config, engine: fakeEngine() as never });
    const client = new Client({ name: 'schema-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const calls = [
      ['list_models', {}],
      ['batch_ask', { requests: [{ model: 'demo', messages: [{ role: 'user', content: 'hi' }] }] }],
      ['probe_model', { model: 'demo' }],
      ['detect_capabilities', { model: 'demo', aspects: ['json'] }],
      ['create_session', { model: 'demo' }],
      ['get_session', { id: 's' }],
      ['delete_session', { id: 's' }],
      ['stats', {}],
      ['records', {}]
    ] as const;
    for (const [name, args] of calls) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError, `${name} returned an MCP error`).not.toBe(true);
      expect(result.structuredContent, `${name} omitted structuredContent`).toBeDefined();
    }
    await client.close(); await server.close();
  });

  it('validates multimodal and batch response variants against output schemas', async () => {
    const engine = fakeEngine();
    engine.ask = async () => ({
      model: 'demo', provider: 'p', text: 'hello',
      content: [
        { type: 'text', text: 'hello' },
        { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
        { type: 'image', url: 'https://example.test/image.png', mimeType: 'image/png' },
        { type: 'audio', data: 'AQID', mimeType: 'audio/wav' }
      ]
    });
    engine.batch = async () => [
      { status: 'fulfilled', value: { model: 'demo', provider: 'p', text: 'hello', content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }] } },
      { status: 'rejected', reason: new Error('provider detail') }
    ];
    const server = createMcpServer({ config, engine: engine as never });
    const client = new Client({ name: 'multimodal-schema-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const ask = await client.callTool({ name: 'ask_model', arguments: { model: 'demo' } });
    expect(ask.isError).not.toBe(true);
    expect(ask.structuredContent).toMatchObject({ content: expect.arrayContaining([{ type: 'image', url: 'https://example.test/image.png', mimeType: 'image/png' }, { type: 'audio', data: 'AQID', mimeType: 'audio/wav' }]) });
    const batch = await client.callTool({ name: 'batch_ask', arguments: { requests: [{ model: 'demo' }, { model: 'demo' }] } });
    expect(batch.isError).not.toBe(true);
    expect(batch.structuredContent).toMatchObject({ responses: [{ status: 'fulfilled' }, { status: 'rejected', reason: { code: 'internal_error' } }] });
    await client.close(); await server.close();
  });

  it('requires both probe and ask scopes for capability detection', async () => {
    const engine = fakeEngine();
    const server = createMcpServer({ config, engine: engine as never, principal: { tenant: 't', models: ['demo'], scopes: ['models:probe'] } });
    const client = new Client({ name: 'capability-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const denied = await client.callTool({ name: 'detect_capabilities', arguments: { model: 'demo', aspects: ['json'] } });
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent).toBeUndefined();
    expect(denied.content).toEqual([{ type: 'text', text: expect.any(String) }]);
    await client.close(); await server.close();

    const allowedServer = createMcpServer({ config, engine: fakeEngine() as never, principal: { tenant: 't', models: ['demo'], scopes: ['models:probe', 'models:ask'] } });
    const allowedClient = new Client({ name: 'capability-client-ok', version: '1.0.0' });
    const [allowedClientTransport, allowedServerTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([allowedServer.connect(allowedServerTransport), allowedClient.connect(allowedClientTransport)]);
    const allowed = await allowedClient.callTool({ name: 'detect_capabilities', arguments: { model: 'demo', aspects: ['json'] } });
    expect(allowed.isError).not.toBe(true);
    expect(allowed.structuredContent).toMatchObject({ model: 'demo', requested: ['json'] });
    await allowedClient.close(); await allowedServer.close();
  });
});

describe('HTTP transport', () => {
  it('serves stateless Streamable HTTP on loopback', async () => {
    const running = await startHttp({ config, engine: fakeEngine() as never, host: '127.0.0.1', port: 0 });
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const client = new Client({ name: 'http-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${running.port}/mcp`));
    await client.connect(transport);
    const result = await client.callTool({ name: 'list_models', arguments: {} });
    expect(result.isError).not.toBe(true);
    await client.close(); await running.close();
  });

  it('requires configured tenant credentials on loopback and rejects duplicate tokens', async () => {
    const secured = structuredClone(config);
    secured.http.tenants = {
      one: { apiKeyEnv: 'MCP_TEST_TOKEN_ONE', models: ['demo'], scopes: ['models:read'] },
      two: { apiKeyEnv: 'MCP_TEST_TOKEN_TWO', models: ['demo'], scopes: ['models:read'] }
    };
    process.env.MCP_TEST_TOKEN_ONE = 'same-token'; process.env.MCP_TEST_TOKEN_TWO = 'same-token';
    await expect(startHttp({ config: secured, engine: fakeEngine() as never, host: '127.0.0.1', port: 0 })).rejects.toThrow(/duplicate/i);
    process.env.MCP_TEST_TOKEN_TWO = 'different-token';
    const running = await startHttp({ config: secured, engine: fakeEngine() as never, host: '127.0.0.1', port: 0 });
    const unauthenticated = await fetch(`http://127.0.0.1:${running.port}/mcp`, { method: 'POST', body: '{}' });
    expect(unauthenticated.status).toBe(401);
    await running.close();
    delete process.env.MCP_TEST_TOKEN_ONE; delete process.env.MCP_TEST_TOKEN_TWO;
  });

  it('accepts bracketed IPv6 loopback Host headers', async () => {
    const running = await startHttp({ config, engine: fakeEngine() as never, host: '::1', port: 0 });
    const response = await fetch(`http://[::1]:${running.port}/mcp`, { method: 'POST', body: '{}' });
    // The MCP endpoint may reject an incomplete JSON-RPC body, but Host validation must pass.
    expect(response.status).not.toBe(421);
    await running.close();
  });

  it('enforces configured Origin and Host boundaries', async () => {
    const restricted = structuredClone(config);
    restricted.http.allowedOrigins = ['https://allowed.example'];
    const running = await startHttp({ config: restricted, engine: fakeEngine() as never, host: '127.0.0.1', port: 0 });
    const endpoint = `http://127.0.0.1:${running.port}/mcp`;
    const deniedOrigin = await fetch(endpoint, { method: 'POST', headers: { origin: 'https://evil.example' }, body: '{}' });
    expect(deniedOrigin.status).toBe(403);
    const hostileHost = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(`http://127.0.0.1:${running.port}/mcp`, { method: 'POST', headers: { host: 'attacker.example', 'content-length': '2' } }, res => {
        res.resume(); res.once('end', () => resolve(res.statusCode ?? 0));
      });
      req.once('error', reject); req.end('{}');
    });
    expect(hostileHost).toBe(421);
    const noOrigin = await fetch(endpoint, { method: 'POST', body: '{}' });
    expect(noOrigin.status).not.toBe(403);
    const invalidAnonymousAuth = await fetch(endpoint, { method: 'POST', headers: { authorization: 'Bearer invalid' }, body: '{}' });
    expect(invalidAnonymousAuth.status).toBe(401);
    const allowedOrigin = await fetch(endpoint, { method: 'POST', headers: { origin: 'https://allowed.example' }, body: '{}' });
    expect(allowedOrigin.status).not.toBe(403);
    await running.close();
  });
});

import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ModelEngine } from '../src/engine.js';
import { parseConfig } from '../src/config.js';
import { createMcpServer, startHttp } from '../src/server.js';
import { request } from '../src/providers/common.js';
import { ModelError, type AppConfig, type ModelResponse } from '../src/types.js';

const capabilities = { roles: ['system','user','assistant'], input: ['text'], output: ['text'], streaming: true, json: true, jsonSchema: true, options: ['temperature','topP','maxTokens','stop','seed'] };
function config(extra: Record<string, unknown> = {}): AppConfig { return parseConfig({ providers: { p: { type: 'openai', baseUrl: 'http://127.0.0.1:1/v1' } }, models: { a: { provider: 'p', model: 'real-a', capabilities }, b: { provider: 'p', model: 'real-b', capabilities } }, ...extra }); }
const req = { model: 'a', messages: [{ role: 'user' as const, content: 'hello' }] };
const response = (): ModelResponse => ({ model: 'a', provider: 'p', text: 'answer' });
async function listen(server: Server): Promise<number> { await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (typeof address !== 'object' || !address) throw new Error('Missing address'); return address.port; }
async function close(server: Server) { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
afterEach(() => { vi.useRealTimers(); });

describe('independent Sol audit: transport boundaries', () => {
  it('requires configured tenant authentication even on loopback', async () => {
    process.env.MODEL_TOOL_AUDIT_TOKEN = 'audit-only-token';
    const c = config({ http: { port: 0, tenants: { one: { apiKeyEnv: 'MODEL_TOOL_AUDIT_TOKEN', models: ['a'], scopes: ['models:read'] } } } });
    const running = await startHttp({ config: c, engine: new ModelEngine(c, { openai: { generate: async () => response() } }) });
    try {
      for (const authorization of [undefined, 'Bearer wrong-token']) {
        const result = await fetch(`http://127.0.0.1:${running.port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(authorization ? { authorization } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'audit', version: '1' } } }) });
        expect(result.status).toBe(401); await result.body?.cancel();
      }
    } finally { await running.close(); delete process.env.MODEL_TOOL_AUDIT_TOKEN; }
  });

  it('renders normalized text once when content also contains text', async () => {
    const c = config(); const generate = vi.fn().mockResolvedValue({ ...response(), content: [{ type: 'text', text: 'answer' }] });
    const server = createMcpServer({ config: c, engine: new ModelEngine(c, { openai: { generate } }) });
    const client = new Client({ name: 'audit', version: '1' }); const [ct, st] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(st), client.connect(ct)]);
      const result = await client.callTool({ name: 'ask_model', arguments: req });
      expect(result.content).toEqual([{ type: 'text', text: 'answer' }]);
    } finally { await client.close(); await server.close(); }
  });

  it('exposes batch error messages and rejects unknown message properties', async () => {
    const c = config(); const generate = vi.fn().mockRejectedValue(new ModelError('RATE_LIMITED', 'not public', true));
    const server = createMcpServer({ config: c, engine: new ModelEngine(c, { openai: { generate } }) });
    const client = new Client({ name: 'audit', version: '1' }); const [ct, st] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(st), client.connect(ct)]);
      const batch = await client.callTool({ name: 'batch_ask', arguments: { requests: [req] } });
      const body = JSON.parse(JSON.stringify(batch.structuredContent)) as { responses: Array<{ status: string; reason: { code: string; message: string } }> };
      expect(body.responses[0]).toMatchObject({ status: 'rejected', reason: { code: 'RATE_LIMITED', message: expect.any(String) } });
      const invalid = await client.callTool({ name: 'ask_model', arguments: { ...req, messages: [{ ...req.messages[0], extra: true }] } });
      expect(invalid.isError).toBe(true);
      expect(generate).toHaveBeenCalledTimes(1);
    } finally { await client.close(); await server.close(); }
  });

  it.each(['x-api-key', 'x-goog-api-key'])('does not forward %s through a provider redirect', async header => {
    let destinationRequests = 0;
    const destination = createServer((_req, res) => { destinationRequests++; res.setHeader('content-type', 'application/json'); res.end('{}'); });
    const port = await listen(destination);
    const redirect = createServer((_req, res) => { res.writeHead(307, { location: `http://127.0.0.1:${port}/capture` }); res.end(); });
    const origin = await listen(redirect);
    try {
      const result = request(`http://127.0.0.1:${origin}/generate`, { method: 'POST', headers: { [header]: 'audit-secret' }, body: '{}' }, { signal: new AbortController().signal });
      await expect(result).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
      expect(destinationRequests).toBe(0);
    } finally { await close(redirect); await close(destination); }
  });
});

describe('independent Sol audit: engine semantics', () => {
  it('releases a half-open circuit trial when it is cancelled', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    let started!: () => void; const trialStarted = new Promise<void>(resolve => { started = resolve; });
    const generate = vi.fn()
      .mockRejectedValueOnce(new ModelError('NETWORK_ERROR', 'failure', true))
      .mockImplementationOnce(async (_p, _m, _messages, _options, context) => {
        started();
        await new Promise<void>((_resolve, reject) => context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true }));
        return response();
      })
      .mockResolvedValueOnce(response());
    const c = config({ policy: { circuit: { failures: 1, resetMs: 10 }, retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 } } });
    const engine = new ModelEngine(c, { openai: { generate } });
    await expect(engine.ask(req)).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    vi.advanceTimersByTime(10);
    const controller = new AbortController();
    const trial = engine.ask(req, { signal: controller.signal });
    await trialStarted; controller.abort();
    await expect(trial).rejects.toMatchObject({ code: 'CANCELLED' });
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
    await expect(engine.ask(req)).resolves.toMatchObject({ text: 'answer' });
    expect(generate).toHaveBeenCalledTimes(3);
  });

  it('balances simultaneous least-loaded reservations across models', async () => {
    let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
    const generate = vi.fn().mockImplementation(async () => { await pending; return response(); });
    const c = config({ routes: { balanced: { models: ['a','b'], strategy: 'least_loaded' } } });
    const engine = new ModelEngine(c, { openai: { generate } });
    const first = engine.ask({ route: 'balanced', messages: req.messages }); const second = engine.ask({ route: 'balanced', messages: req.messages });
    await Promise.resolve(); await Promise.resolve();
    const selected = generate.mock.calls.map(call => call[1].model);
    release(); await Promise.all([first, second]);
    expect(selected).toEqual(['real-a','real-b']);
  });

  it('rejects unsupported streaming without depending on an event callback', async () => {
    const c = config(); c.models.a!.capabilities.streaming = false;
    const generate = vi.fn().mockResolvedValue(response()); const engine = new ModelEngine(c, { openai: { generate } });
    await expect(engine.ask({ ...req, stream: true })).rejects.toMatchObject({ code: expect.stringMatching(/UNSUPPORTED/) });
    expect(generate).not.toHaveBeenCalled();
  });

  it('rejects inherited preset and route names as unknown', async () => {
    const generate = vi.fn().mockResolvedValue(response()); const engine = new ModelEngine(config(), { openai: { generate } });
    await expect(engine.ask({ ...req, preset: 'toString' })).rejects.toMatchObject({ code: 'UNKNOWN_PRESET' });
    await expect(engine.ask({ route: 'toString', messages: req.messages })).rejects.toMatchObject({ code: 'UNKNOWN_ROUTE' });
    expect(generate).not.toHaveBeenCalled();
  });

  it('does not retry or fall back after delivering partial output', async () => {
    const generate = vi.fn().mockImplementation(async (_p, _m, _messages, _options, context) => {
      await context.onEvent({ type: 'text', text: 'partial' });
      throw new ModelError('NETWORK_ERROR', 'failure', true);
    });
    const engine = new ModelEngine(config(), { openai: { generate } });
    const onEvent = vi.fn();
    await expect(engine.ask({ ...req, stream: true, fallback: ['b'], retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 } }, { onEvent })).rejects.toMatchObject({ code: 'STREAM_INTERRUPTED', retryable: false });
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('requires both scopes and model authorization for live capability probes', async () => {
    const generate = vi.fn().mockResolvedValue(response()); const engine = new ModelEngine(config(), { openai: { generate } });
    const principal = (models: string[], scopes: string[]) => ({ principal: { tenant: 'audit', models, scopes } });
    for (const context of [principal(['a'], ['models:probe']), principal(['a'], ['models:ask']), principal(['b'], ['models:probe', 'models:ask'])]) {
      await expect(engine.detectCapabilities('a', ['text'], context)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    expect(generate).not.toHaveBeenCalled();
    const result = await engine.detectCapabilities('a', ['text'], principal(['a'], ['models:probe', 'models:ask']));
    expect(result.results[0]?.status).toBe('supported');
    expect(generate).toHaveBeenCalledTimes(1);
    expect(engine.listModels(principal(['a'], ['models:read']))[0]?.capabilities).toEqual(config().models.a!.capabilities);
  });
});

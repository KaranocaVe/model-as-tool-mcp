import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseAsk, parseConfig, validateRequest } from '../src/config.js';
import { ModelEngine } from '../src/engine.js';
import { ModelError, type AppConfig, type ModelResponse } from '../src/types.js';

const capabilities = {
  roles: ['system', 'user', 'assistant'] as const,
  input: ['text'] as const,
  output: ['text'] as const,
  streaming: true,
  json: true,
  jsonSchema: true,
  options: ['temperature', 'topP', 'maxTokens', 'stop', 'seed'] as const
};

function rawConfig(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    providers: { p: { type: 'openai', baseUrl: 'https://provider.example/v1' } },
    models: { m: { provider: 'p', model: 'provider-m', capabilities } },
    ...extra
  };
}

function config(extra: Record<string, unknown> = {}): AppConfig {
  return parseConfig(rawConfig(extra));
}

const request = { model: 'm', messages: [{ role: 'user' as const, content: 'hello' }] };
const response = (text = 'answer'): ModelResponse => ({ model: 'upstream', provider: 'upstream', text });
afterEach(() => { vi.useRealTimers(); });

describe('configuration boundary audit', () => {
  it('fills bounded defaults and rejects unknown keys at every strict boundary', () => {
    const parsed = config();
    expect(parsed.policy).toMatchObject({ concurrency: 8, maxQueue: 100, timeoutMs: 60000, requestsPerMinute: 0 });
    expect(parsed.policy.sessions).toMatchObject({ enabled: false, maxSessions: 100, maxMessages: 1000 });
    expect(parsed.http).toMatchObject({ host: '127.0.0.1', port: 3000, path: '/mcp', maxBodyBytes: 10000000 });
    expect(parsed.models.m?.capabilities).toEqual({
      roles: ['system', 'user', 'assistant'], input: ['text'], output: ['text'],
      streaming: true, json: true, jsonSchema: true,
      options: ['temperature', 'topP', 'maxTokens', 'stop', 'seed']
    });

    expect(() => parseConfig({ ...rawConfig(), typo: true })).toThrow(/typo/);
    expect(() => parseConfig(rawConfig({ policy: { queu: 1 } }))).toThrow(/queu/);
    expect(() => parseConfig(rawConfig({ http: { maxBodyBytes: 1024, extra: true } }))).toThrow(/extra/);
    expect(() => parseConfig(rawConfig({ models: { m: { provider: 'p', model: 'x', capabilities: { ...capabilities, optionz: [] } } } }))).toThrow(/optionz/);
    expect(() => parseAsk({ ...request, options: { topP: 0.2, unknown: true } })).toThrow(/unknown/);
  });

  it('rejects prototype-pollution keys in all configured maps and nested JSON', () => {
    const reserved = ['__proto__', 'prototype', 'constructor'];
    for (const key of reserved) {
      for (const section of ['providers', 'models', 'routes', 'presets'] as const) {
        const value = section === 'providers'
          ? { type: 'openai', baseUrl: 'https://provider.example/v1' }
          : section === 'models'
            ? { provider: 'p', model: 'x' }
            : section === 'routes'
              ? { models: ['m'], strategy: 'round_robin' }
              : { model: 'm', messages: [{ role: 'user', content: 'x' }] };
        const input = rawConfig({ [section]: { ...(rawConfig()[section] as object), [key]: value } });
        expect(() => parseConfig(input), `${section}.${key}`).toThrow(/Reserved identifier|Invalid configuration/);
      }
      const tenantInput = rawConfig({ http: { tenants: { [key]: { apiKeyEnv: 'TENANT_KEY', models: ['m'] } } } });
      expect(() => parseConfig(tenantInput), `http.tenants.${key}`).toThrow(/Reserved identifier|Invalid configuration/);
    }

    for (const key of reserved) {
      const providerOptions = { [key]: { polluted: true } };
      expect(() => parseAsk({ ...request, options: { providerOptions } })).toThrow(/safe plain JSON|Invalid request/);
      const schema = { type: 'object', properties: { [key]: { type: 'string' } } };
      expect(() => parseAsk({ ...request, options: { responseFormat: { type: 'json_schema', schema } } })).toThrow(/safe plain JSON|Invalid request/);
    }
  });

  it('bounds URLs, headers, environment names, JSON depth, and non-finite values', () => {
    expect(() => parseConfig(rawConfig({ providers: { p: { type: 'openai', baseUrl: 'https://user:pass@provider.example/v1' } } }))).toThrow();
    expect(() => parseConfig(rawConfig({ providers: { p: { type: 'openai', baseUrl: 'https://provider.example/v1?token=secret' } } }))).toThrow();
    expect(() => parseConfig(rawConfig({ providers: { p: { type: 'openai', baseUrl: 'https://provider.example/v1', apiKeyEnv: 'BAD-NAME' } } }))).toThrow();
    expect(() => parseConfig(rawConfig({ providers: { p: { type: 'openai', baseUrl: 'https://provider.example/v1', headers: { Authorization: 'secret' } } } }))).toThrow(/Reserved provider header/);
    expect(() => parseConfig(rawConfig({ providers: { p: { type: 'openai', baseUrl: 'https://provider.example/v1', headers: { 'X-Test': 'line\nfeed' } } } }))).toThrow();

    let nested: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 41; i++) nested = { next: nested };
    expect(() => parseAsk({ ...request, options: { providerOptions: nested } })).toThrow(/max depth|Invalid request/);
    expect(() => parseAsk({ ...request, options: { providerOptions: { value: Number.NaN } } })).toThrow(/safe plain JSON|Invalid request/);
    expect(() => parseAsk({ ...request, options: { providerOptions: new Date() } })).toThrow(/safe plain JSON|Invalid request/);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => parseAsk({ ...request, options: { providerOptions: cyclic } })).toThrow(/Invalid request|safe plain JSON|max depth/);
  });

  it('rejects unresolved references and route collisions before startup', () => {
    expect(() => parseConfig(rawConfig({ models: { m: { provider: 'missing', model: 'x' } } }))).toThrow(/Unknown provider/);
    expect(() => parseConfig(rawConfig({ routes: { r: { models: ['missing'], strategy: 'round_robin' } } }))).toThrow(/Unknown route model/);
    expect(() => parseConfig(rawConfig({ routes: { r: { models: ['m', 'm'], strategy: 'round_robin' } } }))).toThrow(/Duplicate route member/);
    expect(() => parseConfig(rawConfig({ routes: { m: { models: ['m'], strategy: 'round_robin' } } }))).toThrow(/Route conflicts/);
    expect(() => parseConfig(rawConfig({ presets: { p: { model: 'missing', messages: [{ role: 'user', content: 'x' }] } } }))).toThrow(/Unknown preset model/);
    expect(() => parseConfig(rawConfig({ http: { tenants: { t: { apiKeyEnv: 'TENANT_KEY', models: ['missing'] } } } }))).toThrow(/Unknown tenant model/);
    expect(() => parseConfig(rawConfig({ models: {
      m: { provider: 'p', model: 'x', aliases: ['same'] },
      n: { provider: 'p', model: 'y', aliases: ['same'] }
    } }))).toThrow(/Duplicate model identifier/);
  });

  it('enforces declared generation options, modalities, roles, and content', () => {
    const model = config().models.m!;
    const narrow = { ...model, capabilities: { ...model.capabilities, roles: ['user'] as const, input: ['text'] as const, output: ['text'] as const, options: [] as const, json: false, jsonSchema: false } };
    expect(() => validateRequest(narrow, [{ role: 'assistant', content: 'x' }], {})).toThrow(/UNSUPPORTED_ROLE|role/);
    expect(() => validateRequest(narrow, [{ role: 'user', content: [{ type: 'audio', data: 'YWFhYQ==', mimeType: 'audio/wav' }] }], {})).toThrow(/UNSUPPORTED_CONTENT|audio/);
    expect(() => validateRequest(narrow, [{ role: 'user', content: 'x' }], { maxTokens: 1 })).toThrow(/UNSUPPORTED_OPTION|maxTokens/);
    expect(() => validateRequest(narrow, [{ role: 'user', content: 'x' }], { responseFormat: { type: 'json' } })).toThrow(/UNSUPPORTED_OPTION|JSON/);
    expect(() => validateRequest(narrow, [{ role: 'user', content: 'x' }], { modalities: ['image'] })).toThrow(/UNSUPPORTED_CONTENT|image/);
  });
});

describe('configuration-controlled engine semantics', () => {
  function makeEngine(policy: Record<string, unknown> = {}, adapter?: { generate: (provider: any, model: any, messages: any[], options: any, context: any) => Promise<ModelResponse> }): ModelEngine {
    return new ModelEngine(config({ policy }), { openai: adapter ?? { generate: async () => response() } });
  }

  it('propagates caller cancellation and policy/request timeouts to the adapter', async () => {
    let adapterSignal: AbortSignal | undefined;
    const generate = vi.fn(async (_provider, _model, _messages, _options, context) => {
      adapterSignal = context.signal;
      await new Promise<void>(resolve => context.signal.addEventListener('abort', () => resolve(), { once: true }));
      return response();
    });
    const engine = makeEngine({ timeoutMs: 20 }, { generate });
    await expect(engine.ask(request)).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(adapterSignal?.aborted).toBe(true);

    const controller = new AbortController();
    const second = engine.ask(request, { signal: controller.signal });
    controller.abort();
    await expect(second).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(adapterSignal?.aborted).toBe(true);
  });

  it('keeps admission bounded by concurrency and maxQueue and removes canceled waiters', async () => {
    let releaseFirst!: () => void;
    let calls = 0;
    const generate = vi.fn(async (_provider, _model, _messages, _options, context) => {
      calls++;
      if (calls === 1) await new Promise<void>(resolve => { releaseFirst = resolve; });
      context.signal.throwIfAborted();
      return response();
    });
    const engine = makeEngine({ concurrency: 1, maxQueue: 1 }, { generate });
    const first = engine.ask(request);
    const controller = new AbortController();
    const second = engine.ask(request, { signal: controller.signal });
    await expect(engine.ask(request)).rejects.toMatchObject({ code: 'QUEUE_FULL' });
    controller.abort();
    await expect(second).rejects.toMatchObject({ code: 'CANCELLED' });
    releaseFirst();
    await first;
    expect(engine.stats()).toMatchObject({ active: 0, queued: 0 });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('enforces the process rate budget and releases the next request after the window', async () => {
    vi.useFakeTimers();
    const generate = vi.fn(async () => response());
    const engine = makeEngine({ concurrency: 2, requestsPerMinute: 1, timeoutMs: 120_000 }, { generate });
    await engine.ask(request);
    const second = engine.ask(request);
    await Promise.resolve();
    expect(generate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(generate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(second).resolves.toMatchObject({ text: 'answer' });
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('opens a circuit after retryable failures and closes it after a successful half-open trial', async () => {
    vi.useFakeTimers();
    const generate = vi.fn()
      .mockRejectedValueOnce(new ModelError('PROVIDER_ERROR', 'transient', true))
      .mockResolvedValue(response());
    const engine = makeEngine({ circuit: { failures: 1, resetMs: 100 }, retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 } }, { generate });
    await expect(engine.ask(request)).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    await expect(engine.ask(request)).rejects.toMatchObject({ code: 'CIRCUIT_OPEN' });
    expect(generate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(99);
    await expect(engine.ask(request)).rejects.toMatchObject({ code: 'CIRCUIT_OPEN' });
    expect(generate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(engine.ask(request)).resolves.toMatchObject({ text: 'answer' });
    expect(generate).toHaveBeenCalledTimes(2);
    await expect(engine.ask(request)).resolves.toMatchObject({ text: 'answer' });
    expect(generate).toHaveBeenCalledTimes(3);
  });

  it('reopens a circuit after a failed half-open trial instead of leaving the trial stuck', async () => {
    vi.useFakeTimers();
    const transient = () => new ModelError('PROVIDER_ERROR', 'transient', true);
    const generate = vi.fn()
      .mockRejectedValueOnce(transient())
      .mockRejectedValueOnce(transient())
      .mockResolvedValue(response());
    const engine = makeEngine({ circuit: { failures: 1, resetMs: 100 }, retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 } }, { generate });
    await expect(engine.ask(request)).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    await vi.advanceTimersByTimeAsync(100);
    await expect(engine.ask(request)).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    await expect(engine.ask(request)).rejects.toMatchObject({ code: 'CIRCUIT_OPEN' });
    expect(generate).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(100);
    await expect(engine.ask(request)).resolves.toMatchObject({ text: 'answer' });
    expect(generate).toHaveBeenCalledTimes(3);
  });

  it('merges preset defaults explicitly and keeps session history bounded to the configured model', async () => {
    const seen: { messages: unknown[]; options: unknown }[] = [];
    const generate = vi.fn(async (_provider, _model, messages, options) => {
      seen.push({ messages, options });
      return response();
    });
    const engine = makeEngine({ sessions: { enabled: true, ttlMs: 60000, maxSessions: 2, maxMessages: 8 } }, { generate });
    const configured = config({ presets: { p: { model: 'm', messages: [{ role: 'system', content: 'preset' }], options: { temperature: 0.2 } } } });
    const presetEngine = new ModelEngine(configured, { openai: { generate } });
    await presetEngine.ask({ preset: 'p', options: { temperature: 0.8 } });
    expect(seen[0]).toMatchObject({ messages: [{ role: 'system', content: 'preset' }], options: { temperature: 0.8 } });

    const session = engine.createSession('m');
    await engine.ask({ sessionId: session.id, messages: [{ role: 'user', content: 'first' }] });
    await engine.ask({ sessionId: session.id, messages: [{ role: 'user', content: 'second' }] });
    expect(seen.at(-1)?.messages).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'second' }
    ]);
  });

  it('does not permit streaming when the selected model declaration disables it', async () => {
    const disabled = config({ models: { m: { provider: 'p', model: 'provider-m', capabilities: { ...capabilities, streaming: false } } } });
    const generate = vi.fn(async () => response());
    const engine = new ModelEngine(disabled, { openai: { generate } });
    await expect(engine.ask({ ...request, stream: true })).rejects.toMatchObject({ code: 'UNSUPPORTED_OPTION' });
    expect(generate).not.toHaveBeenCalled();
  });

  it('authorizes every route member before selecting or calling a provider', async () => {
    const routeConfig = config({
      models: {
        m: { provider: 'p', model: 'provider-m', capabilities },
        n: { provider: 'p', model: 'provider-n', capabilities }
      },
      routes: { r: { models: ['m', 'n'], strategy: 'round_robin' } }
    });
    const generate = vi.fn(async () => response());
    const engine = new ModelEngine(routeConfig, { openai: { generate } });
    await expect(engine.ask({ route: 'r', messages: request.messages }, {
      principal: { tenant: 'tenant-a', models: ['m'], scopes: ['models:ask'] }
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(generate).not.toHaveBeenCalled();
  });

  it('requires both probe and ask scopes and the tenant model ACL before capability probes', async () => {
    const generate = vi.fn(async () => response());
    const engine = makeEngine({}, { generate });
    const askOnly = { principal: { tenant: 'tenant-a', models: ['m'], scopes: ['models:ask'] } };
    await expect(engine.detectCapabilities('m', ['text'], askOnly)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const probeOnly = { principal: { tenant: 'tenant-a', models: ['m'], scopes: ['models:probe'] } };
    await expect(engine.detectCapabilities('m', ['text'], probeOnly)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const wrongModel = { principal: { tenant: 'tenant-a', models: ['other'], scopes: ['models:probe', 'models:ask'] } };
    await expect(engine.detectCapabilities('m', ['text'], wrongModel)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(generate).not.toHaveBeenCalled();
  });

  it('keeps declaration bypass scoped to probing and reports conflicts without mutating the registry', async () => {
    const configured = config({ models: { m: { provider: 'p', model: 'provider-m', capabilities: { ...capabilities, json: false, jsonSchema: false, streaming: false, input: ['text'], output: ['text'] } } } });
    let providerCapabilities: unknown;
    const generate = vi.fn(async (_provider, model) => { providerCapabilities = model.capabilities; return response('{"ok":true}'); });
    const engine = new ModelEngine(configured, { openai: { generate } });
    const principal = { principal: { tenant: 'tenant-a', models: ['m'], scopes: ['models:probe', 'models:ask'] } };
    const result = await engine.detectCapabilities('m', ['json'], principal);
    expect(result.results[0]).toMatchObject({ status: 'supported', declared: false, rationaleCode: 'OBSERVED_SUCCESS_DECLARATION_CONFLICT' });
    expect((providerCapabilities as { json: boolean }).json).toBe(true);
    expect(engine.listModels({ principal: { ...principal.principal, scopes: ['models:read'] } })[0]?.capabilities.json).toBe(false);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('compiles JSON Schema before provider work and rejects unresolved references', async () => {
    const generate = vi.fn(async () => response());
    const engine = makeEngine({}, { generate });
    await expect(engine.ask({
      ...request,
      options: { responseFormat: { type: 'json_schema', schema: { $ref: '#/$defs/missing' } } }
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(generate).not.toHaveBeenCalled();
  });
});

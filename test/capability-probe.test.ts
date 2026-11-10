import { describe, expect, it, vi } from 'vitest';
import { detectCapabilities } from '../src/capability-probe.js';
import { ModelError, type Capabilities, type ModelResponse } from '../src/types.js';

const declared: Capabilities = {
  roles: ['system', 'user', 'assistant'], input: ['text', 'image', 'audio'], output: ['text'],
  streaming: true, json: true, jsonSchema: true, options: ['temperature', 'topP', 'maxTokens', 'stop', 'seed']
};
const answer = (text = 'OK'): ModelResponse => ({ model: 'm', provider: 'p', text, usage: { inputTokens: 3, outputTokens: 1 }, meta: { latencyMs: 2, attempts: 1 } });

describe('explicit capability probes', () => {
  it('uses one real ask per requested capability and exposes probe consumption', async () => {
    const calls: Array<{ request: any; context: any }> = [];
    const engine = { ask: vi.fn(async (request: any, context: any) => {
      calls.push({ request, context });
      if (request.stream) await context.onEvent?.({ type: 'text', text: 'chunk' });
      if (request.options?.responseFormat?.type === 'json_schema') return answer('{"ok":true}');
      if (request.options?.responseFormat?.type === 'json') return answer('{"ok":true}');
      return answer();
    }) };
    const result = await detectCapabilities(engine, 'm', ['text', 'json', 'json_schema', 'streaming', 'image_input', 'audio_input', 'role:system', 'option:temperature'], { declared });
    expect(engine.ask).toHaveBeenCalledTimes(8);
    expect(result.results.every(item => item.status === 'supported' && item.observed === true)).toBe(true);
    expect(result.results.find(item => item.aspect === 'streaming')?.events).toEqual([{ type: 'text', text: 'chunk' }]);
    expect(result.results.find(item => item.aspect === 'json')?.usage).toEqual({ inputTokens: 3, outputTokens: 1 });
    expect(calls.every(call => call.request.model === 'm' && call.request.cache === false && call.request.deduplicate === false && call.request.retry.maxAttempts === 1 && !call.request.sessionId && !call.request.fallback)).toBe(true);
    expect(calls.find(call => call.request.stream)?.context.onEvent).toBeTypeOf('function');
    expect(calls.find(call => call.request.options?.responseFormat?.type === 'json_schema')?.request.options.responseFormat.schema).toMatchObject({ required: ['ok'] });
  });

  it('does not infer unsupported from authentication, rate, network, or invalid request errors', async () => {
    const codes = ['AUTHENTICATION_FAILED', 'RATE_LIMITED', 'NETWORK_ERROR', 'INVALID_REQUEST'];
    for (const code of codes) {
      const engine = { ask: vi.fn().mockRejectedValue(new ModelError(code, 'failure')) };
      const result = await detectCapabilities(engine, 'm', ['json']);
      expect(result.results[0]).toMatchObject({ status: 'inconclusive', rationaleCode: 'INCONCLUSIVE_ERROR', error: { code } });
    }
  });

  it('accepts only explicit unsupported errors and leaves unknown aspects uncalled', async () => {
    const engine = { ask: vi.fn().mockRejectedValue(new ModelError('UNSUPPORTED_OPTION', 'unsupported')) };
    const result = await detectCapabilities(engine, 'm', ['option:seed', 'future_capability', 'toString'], { declared });
    expect(engine.ask).toHaveBeenCalledTimes(1);
    expect(result.results[0]).toMatchObject({ status: 'unsupported', rationaleCode: 'UNSUPPORTED_OPTION', declared: true });
    expect(result.results[1]).toMatchObject({ status: 'inconclusive', rationaleCode: 'UNKNOWN_ASPECT' });
    expect(result.results[2]).toMatchObject({ status: 'inconclusive', rationaleCode: 'UNKNOWN_ASPECT' });
  });

  it('requires a non-empty, bounded, explicit unique list', async () => {
    const engine = { ask: vi.fn() };
    await expect(detectCapabilities(engine, 'm', [])).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(detectCapabilities(engine, 'm', ['text', 'text'])).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(detectCapabilities(engine, 'm', Array.from({ length: 33 }, () => 'text'))).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(engine.ask).not.toHaveBeenCalled();
  });

  it('stops before issuing another probe after cancellation', async () => {
    const controller = new AbortController();
    const engine = { ask: vi.fn(async () => { controller.abort(); return answer(); }) };
    await expect(detectCapabilities(engine, 'm', ['text', 'json'], { signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(engine.ask).toHaveBeenCalledTimes(1);
  });
});

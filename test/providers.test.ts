import { afterEach, describe, expect, it, vi } from 'vitest';
import { providerAdapters } from '../src/providers/index.js';
import type { ProviderKind, ModelConfig, ProviderConfig } from '../src/types.js';
const capabilities = { roles: ['system', 'user', 'assistant'], input: ['text', 'image', 'audio'], output: ['text', 'image', 'audio'], streaming: true, json: true, jsonSchema: true, options: ['temperature', 'topP', 'maxTokens', 'stop', 'seed'] } as ModelConfig['capabilities'];
const model: ModelConfig = { provider: 'test', model: 'model-id', capabilities };
const config = (type: ProviderKind): ProviderConfig => ({ type, baseUrl: 'https://provider.example/v1', apiKeyEnv: 'PROVIDER_TEST_KEY' });
const context = () => ({ signal: new AbortController().signal });
const messages = [{ role: 'user' as const, content: 'hello' }];
const sse = (...items: unknown[]) => new Response(items.map(item => 'data: ' + (typeof item === 'string' ? item : JSON.stringify(item)) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } });
process.env.PROVIDER_TEST_KEY = 'secret';
afterEach(() => vi.unstubAllGlobals());
describe('provider transports', () => {
 it('maps OpenAI parameters and normalizes usage without fabricating response identity', async () => {
  const fetch = vi.fn(async () => Response.json({ choices: [{ message: { content: 'answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 4 } })); vi.stubGlobal('fetch', fetch);
  const answer = await providerAdapters.openai.generate(config('openai'), model, messages, { maxTokens: 12, responseFormat: { type: 'json_schema', schema: { type: 'object' }, name: 'thing' } }, context());
  const request = fetch.mock.calls[0] as unknown as [string, RequestInit]; const body = JSON.parse(request[1].body as string);
  expect(body.max_completion_tokens).toBe(12); expect(body.response_format.json_schema.name).toBe('thing'); expect(body.tools).toBeUndefined(); expect(request[1].redirect).toBe('error');
  expect(answer).toMatchObject({ text: 'answer', usage: { inputTokens: 3, outputTokens: 4 } }); expect(answer.providerModel).toBeUndefined(); expect(answer.requestId).toBeUndefined();
  await providerAdapters.openai.generate(config('openai'), model, messages, { maxTokens: 7, providerOptions: { max_tokens_parameter: 'max_tokens' } }, context());
  const second = JSON.parse((fetch.mock.calls[1] as unknown as [string, RequestInit])[1].body as string); expect(second.max_tokens).toBe(7); expect(second.max_tokens_parameter).toBeUndefined();
 });
 it('streams OpenAI deltas and usage-only chunks', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => sse({ choices: [{ index: 0, delta: { content: 'a' }, finish_reason: null }] }, { choices: [{ index: 0, delta: { content: 'b' }, finish_reason: 'stop' }] }, { choices: [], usage: { prompt_tokens: 2, completion_tokens: 2 } }, '[DONE]')));
  const chunks: string[] = []; const answer = await providerAdapters.openai.generate(config('openai'), model, messages, {}, { ...context(), onEvent: event => { if (event.text) chunks.push(event.text); } });
  expect(chunks).toEqual(['a', 'b']); expect(answer.text).toBe('ab'); expect(answer.usage?.outputTokens).toBe(2);
 });
 it('streams Anthropic native events and requires terminal message_stop', async () => {
  const events = [{ type: 'message_start', message: { id: 'id', model: 'm', usage: { input_tokens: 2 } } }, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } }, { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }, { type: 'message_stop' }];
  vi.stubGlobal('fetch', vi.fn(async () => sse(...events))); const chunks: string[] = [];
  const answer = await providerAdapters.anthropic.generate(config('anthropic'), model, messages, { maxTokens: 30 }, { ...context(), onEvent: event => { if (event.text) chunks.push(event.text); } });
  expect(chunks).toEqual(['hello']); expect(answer.usage).toEqual({ inputTokens: 2, outputTokens: 1 });
  vi.stubGlobal('fetch', vi.fn(async () => sse(...events.slice(0, -1))));
  await expect(providerAdapters.anthropic.generate(config('anthropic'), model, messages, { maxTokens: 30 }, { ...context(), onEvent: () => {} })).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' });
 });
 it('streams Gemini native events and preserves interleaved output parts', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => sse({ candidates: [{ content: { parts: [{ text: 'a' }, { inlineData: { mimeType: 'image/png', data: 'abc' } }] } }] }, { candidates: [{ content: { parts: [{ text: 'b' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2 } })));
  const events: unknown[] = []; const result = await providerAdapters.gemini.generate(config('gemini'), model, messages, { modalities: ['text', 'image'] }, { ...context(), onEvent: e => { events.push(e); } });
  expect(result.text).toBe('ab'); expect(result.content?.map(p => p.type)).toEqual(['text', 'image', 'text']); expect(events).toHaveLength(3);
 });
 it('rejects untrusted provider options and unsupported native modalities before fetch', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  await expect(providerAdapters.openai.generate(config('openai'), model, messages, { providerOptions: { tools: [] } }, context())).rejects.toMatchObject({ code: 'UNSUPPORTED_ARGUMENT' });
  await expect(providerAdapters.anthropic.generate(config('anthropic'), model, messages, { maxTokens: 3, responseFormat: { type: 'json' } }, context())).rejects.toMatchObject({ code: 'UNSUPPORTED_ARGUMENT' });
  await expect(providerAdapters.gemini.generate(config('gemini'), model, [{ role: 'user', content: [{ type: 'image', mimeType: 'image/png', url: 'https://example.com/x' }] }], {}, context())).rejects.toMatchObject({ code: 'UNSUPPORTED_ARGUMENT' });
  expect(fetch).not.toHaveBeenCalled();
 });
 it('does not expose provider errors, detects refusal, and propagates cancellation', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('private secret', { status: 429, headers: { 'retry-after': '3' } })));
  await expect(providerAdapters.openai.generate(config('openai'), model, messages, {}, context())).rejects.toMatchObject({ code: 'RATE_LIMITED', retryable: true, retryAfterMs: 3000, message: 'Provider request failed (HTTP 429).' });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ choices: [{ message: { refusal: 'secret' }, finish_reason: 'stop' }] })));
  await expect(providerAdapters.openai.generate(config('openai'), model, messages, {}, context())).rejects.toMatchObject({ code: 'REFUSED' });
  const controller = new AbortController(); controller.abort();
  await expect(providerAdapters.openai.generate(config('openai'), model, messages, {}, { signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
 });
});

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { openaiAdapter, openaiCapabilities } from '../src/providers/openai.js';
import { anthropicAdapter, anthropicCapabilities } from '../src/providers/anthropic.js';
import { geminiAdapter, geminiCapabilities } from '../src/providers/gemini.js';
import { request } from '../src/providers/common.js';
import { ModelError, type AdapterContext, type ModelConfig, type ProviderConfig } from '../src/types.js';

type RequestRecord = { method: string; url: string; headers: Record<string, string | undefined>; body: unknown };
const servers: Server[] = [];

async function listen(handler: (record: RequestRecord, response: import('node:http').ServerResponse) => void | Promise<void>): Promise<{ url: string; requests: RequestRecord[]; close: () => Promise<void> }> {
  const requests: RequestRecord[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    let body: unknown;
    try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined; } catch { body = Buffer.concat(chunks).toString('utf8'); }
    const record: RequestRecord = { method: req.method ?? '', url: req.url ?? '', headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : v])), body };
    requests.push(record);
    await handler(record, res);
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', () => resolve()).on('error', reject));
  const address = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${address.port}`, requests, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

afterEach(async () => { while (servers.length) { const server = servers.pop(); server?.closeAllConnections(); await new Promise<void>(resolve => server?.close(() => resolve())); } delete process.env.AUDIT_OPENAI_KEY; delete process.env.AUDIT_ANTHROPIC_KEY; delete process.env.AUDIT_GEMINI_KEY; });

const context = (signal = new AbortController().signal, onEvent?: AdapterContext['onEvent']): AdapterContext => ({ signal, ...(onEvent ? { onEvent } : {}) });
const model = (capabilities: typeof openaiCapabilities | typeof anthropicCapabilities): ModelConfig => ({ provider: 'p', model: 'wire-model', capabilities });
const provider = (type: 'openai' | 'anthropic', baseUrl: string, apiKeyEnv?: string): ProviderConfig => ({ type, baseUrl, ...(apiKeyEnv ? { apiKeyEnv } : {}) });
const jsonResponse = (value: unknown, status = 200) => (res: import('node:http').ServerResponse) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
const sse = (chunks: unknown[], delayAfter = 0) => async (res: import('node:http').ServerResponse) => {
  res.statusCode = 200; res.setHeader('content-type', 'text/event-stream'); res.setHeader('cache-control', 'no-cache');
  for (const chunk of chunks) { res.write(typeof chunk === 'string' ? `data: ${chunk}\n\n` : `data: ${JSON.stringify(chunk)}\n\n`); }
  if (delayAfter) await new Promise(resolve => setTimeout(resolve, delayAfter)); else res.end();
};

describe('OpenAI chat-completions wire contract', () => {
  it('maps messages, native JSON schema, and provider options without an override escape hatch', async () => {
    process.env.AUDIT_OPENAI_KEY = 'secret-openai';
    const upstream = await listen((_request, response) => jsonResponse({ id: 'req-1', model: 'gpt-wire', choices: [{ message: { role: 'assistant', content: '{"ok":true}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })(response));
    const result = await openaiAdapter.generate(provider('openai', `${upstream.url}/v1`, 'AUDIT_OPENAI_KEY'), model(openaiCapabilities), [
      { role: 'system', content: 'system' }, { role: 'user', content: 'hello' }
    ], { maxTokens: 20, responseFormat: { type: 'json_schema', name: 'answer', schema: { type: 'object', properties: { ok: { type: 'boolean' } } } }, providerOptions: { frequency_penalty: 0.2 } }, context());
    const request = upstream.requests[0]!;
    expect(request.url).toBe('/v1/chat/completions');
    expect(request.body).toMatchObject({ model: 'wire-model', messages: [{ role: 'system' }, { role: 'user' }], max_completion_tokens: 20, response_format: { type: 'json_schema', json_schema: { name: 'answer', strict: true } }, frequency_penalty: 0.2 });
    expect(request.body).not.toHaveProperty('tools');
    expect(result).toMatchObject({ text: '{"ok":true}', providerModel: 'gpt-wire', requestId: 'req-1', usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } });
    delete process.env.AUDIT_OPENAI_KEY;
  });

  it.each(['model', 'messages', 'tools', 'authorization'])('rejects providerOptions.%s instead of allowing request or auth override', async key => {
    const value = key === 'messages' ? [] : 'attacker';
    await expect(openaiAdapter.generate({ type: 'openai', baseUrl: 'http://127.0.0.1:1' }, model(openaiCapabilities), [{ role: 'user', content: 'hi' }], { providerOptions: { [key]: value } }, context())).rejects.toMatchObject({ code: 'UNSUPPORTED_ARGUMENT' });
  });

  it('accepts the legitimate usage-only streaming chunk and never fabricates usage', async () => {
    const upstream = await listen((_request, response) => sse([
      { id: 'req-s', model: 'gpt-wire', choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }] },
      { id: 'req-s', model: 'gpt-wire', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { id: 'req-s', model: 'gpt-wire', choices: [], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } }, '[DONE]'
    ])(response));
    const events: string[] = [];
    const result = await openaiAdapter.generate(provider('openai', upstream.url), model(openaiCapabilities), [{ role: 'user', content: 'hi' }], {}, context(new AbortController().signal, event => { if (event.type === 'text') events.push(event.text ?? ''); }));
    expect(result.text).toBe('hi'); expect(events).toEqual(['hi']); expect(result.usage).toEqual({ inputTokens: 2, outputTokens: 1, totalTokens: 3 });
  });

  it('rejects truncated SSE, refusal, and tool calls', async () => {
    const truncated = await listen((_request, response) => sse([{ choices: [{ delta: { content: 'partial' }, finish_reason: null }] }])(response));
    await expect(openaiAdapter.generate(provider('openai', truncated.url), model(openaiCapabilities), [{ role: 'user', content: 'hi' }], {}, context(new AbortController().signal, () => undefined))).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' });
    const refusal = await listen((_request, response) => jsonResponse({ choices: [{ message: { refusal: 'no' }, finish_reason: 'stop' }] })(response));
    await expect(openaiAdapter.generate(provider('openai', refusal.url), model(openaiCapabilities), [{ role: 'user', content: 'hi' }], {}, context())).rejects.toMatchObject({ code: 'REFUSED' });
    const tools = await listen((_request, response) => jsonResponse({ choices: [{ message: { tool_calls: [{ id: 'x', type: 'function' }] }, finish_reason: 'tool_calls' }] })(response));
    await expect(openaiAdapter.generate(provider('openai', tools.url), model(openaiCapabilities), [{ role: 'user', content: 'hi' }], {}, context())).rejects.toMatchObject({ code: 'UNEXPECTED_TOOL_CALL' });
    const malformedChoice = await listen((_request, response) => sse([
      { choices: [null] },
      { choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }, '[DONE]'
    ])(response));
    await expect(openaiAdapter.generate(provider('openai', malformedChoice.url), model(openaiCapabilities), [{ role: 'user', content: 'hi' }], {}, context(new AbortController().signal, () => undefined))).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' });
    const emptyChoice = await listen((_request, response) => sse([
      { choices: [] },
      { choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }, '[DONE]'
    ])(response));
    await expect(openaiAdapter.generate(provider('openai', emptyChoice.url), model(openaiCapabilities), [{ role: 'user', content: 'hi' }], {}, context(new AbortController().signal, () => undefined))).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' });
  });

  it('maps image and audio input and audio output with the native shape', async () => {
    const upstream = await listen((_request, response) => jsonResponse({ id: 'audio-1', model: 'gpt-audio', choices: [{ message: { content: 'heard', audio: { data: 'AQID' } }, finish_reason: 'stop' }] })(response));
    const result = await openaiAdapter.generate(provider('openai', upstream.url), model(openaiCapabilities), [{ role: 'user', content: [
      { type: 'text', text: 'describe' }, { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }, { type: 'audio', data: 'AQID', mimeType: 'audio/wav' }
    ] }], { modalities: ['text', 'audio'], providerOptions: { audio: { voice: 'alloy', format: 'wav' } } }, context());
    expect(upstream.requests[0]!.body).toMatchObject({ messages: [{ content: [{ type: 'text' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }, { type: 'input_audio', input_audio: { data: 'AQID', format: 'wav' } }] }], modalities: ['text', 'audio'], audio: { voice: 'alloy', format: 'wav' } });
    expect(result.content).toEqual([{ type: 'text', text: 'heard' }, { type: 'audio', data: 'AQID', mimeType: 'audio/wav' }]);
  });

  it('cancels an in-flight stream and does not turn cancellation into success', async () => {
    const upstream = await listen(async (_request, response) => { response.statusCode = 200; response.setHeader('content-type', 'text/event-stream'); response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'first' }, finish_reason: null }] })}\n\n`); await new Promise(resolve => setTimeout(resolve, 500)); response.end(); });
    const controller = new AbortController();
    const pending = openaiAdapter.generate(provider('openai', upstream.url), model(openaiCapabilities), [{ role: 'user', content: 'hi' }], {}, context(controller.signal, () => undefined));
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});
describe('Anthropic messages wire contract', () => {
  it('maps system blocks, images, JSON schema, and usage metadata', async () => {
    process.env.AUDIT_ANTHROPIC_KEY = 'secret-anthropic';
    const upstream = await listen((_request, response) => jsonResponse({ id: 'msg-1', model: 'claude-wire', content: [{ type: 'text', text: '{"ok":true}' }], stop_reason: 'end_turn', usage: { input_tokens: 4, output_tokens: 2 } })(response));
    const result = await anthropicAdapter.generate(provider('anthropic', upstream.url, 'AUDIT_ANTHROPIC_KEY'), model(anthropicCapabilities), [
      { role: 'system', content: 'rules' }, { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }] }
    ], { maxTokens: 20, responseFormat: { type: 'json_schema', schema: { type: 'object', properties: { ok: { type: 'boolean' } } } } }, context());
    const request = upstream.requests[0]!;
    expect(request.url).toBe('/messages');
    expect(request.body).toMatchObject({ model: 'wire-model', max_tokens: 20, system: [{ type: 'text', text: 'rules' }], messages: [{ role: 'user', content: [{ type: 'text' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } }] }], output_config: { format: { type: 'json_schema' } } });
    expect(result).toMatchObject({ text: '{"ok":true}', providerModel: 'claude-wire', requestId: 'msg-1', usage: { inputTokens: 4, outputTokens: 2 } });
    delete process.env.AUDIT_ANTHROPIC_KEY;
  });

  it('rejects missing maxTokens, tool use, refusal, and truncated streams', async () => {
    const base = await listen((_request, response) => jsonResponse({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' })(response));
    await expect(anthropicAdapter.generate(provider('anthropic', base.url), model(anthropicCapabilities), [{ role: 'user', content: 'hi' }], {}, context())).rejects.toMatchObject({ code: 'UNSUPPORTED_ARGUMENT' });
    const tool = await listen((_request, response) => jsonResponse({ content: [{ type: 'tool_use', id: 'x', name: 'danger', input: {} }], stop_reason: 'tool_use' })(response));
    await expect(anthropicAdapter.generate(provider('anthropic', tool.url), model(anthropicCapabilities), [{ role: 'user', content: 'hi' }], { maxTokens: 10 }, context())).rejects.toMatchObject({ code: 'UNEXPECTED_TOOL_CALL' });
    const refusal = await listen((_request, response) => jsonResponse({ content: [{ type: 'refusal', text: 'no' }], stop_reason: 'end_turn' })(response));
    await expect(anthropicAdapter.generate(provider('anthropic', refusal.url), model(anthropicCapabilities), [{ role: 'user', content: 'hi' }], { maxTokens: 10 }, context())).rejects.toMatchObject({ code: 'REFUSED' });
    const stream = await listen((_request, response) => sse([{ type: 'message_start', message: { id: 'x', model: 'claude-wire', usage: { input_tokens: 1 } } }, { type: 'message_stop' }])(response));
    await expect(anthropicAdapter.generate(provider('anthropic', stream.url), model(anthropicCapabilities), [{ role: 'user', content: 'hi' }], { maxTokens: 10 }, context(new AbortController().signal, () => undefined))).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' });
  });

  it('rejects providerOptions that try to supply model, messages, tools, or auth', async () => {
    for (const key of ['model', 'messages', 'tools', 'authorization']) {
      await expect(anthropicAdapter.generate({ type: 'anthropic', baseUrl: 'http://127.0.0.1:1' }, model(anthropicCapabilities), [{ role: 'user', content: 'hi' }], { maxTokens: 10, providerOptions: { [key]: 'attacker' } }, context())).rejects.toMatchObject({ code: 'UNSUPPORTED_ARGUMENT' });
    }
  });

  it('does not publish invalid negative cache token metadata', async () => {
    const upstream = await listen((_request, response) => jsonResponse({ id: 'cache-1', model: 'claude-wire', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 2, output_tokens: 1, cache_read_input_tokens: -4 } })(response));
    const result = await anthropicAdapter.generate(provider('anthropic', upstream.url), model(anthropicCapabilities), [{ role: 'user', content: 'hi' }], { maxTokens: 10 }, context());
    expect(result.usage).toEqual({ inputTokens: 2, outputTokens: 1 });
  });

  it('cancels an in-flight event stream', async () => {
    const upstream = await listen(async (_request, response) => { response.statusCode = 200; response.setHeader('content-type', 'text/event-stream'); response.write(`data: ${JSON.stringify({ type: 'message_start', message: { id: 'cancel-a', model: 'claude-wire', usage: { input_tokens: 1 } } })}\n\n`); await new Promise(resolve => setTimeout(resolve, 500)); response.end(); });
    const controller = new AbortController();
    const pending = anthropicAdapter.generate(provider('anthropic', upstream.url), model(anthropicCapabilities), [{ role: 'user', content: 'hi' }], { maxTokens: 10 }, context(controller.signal, () => undefined));
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});

describe('provider authentication boundary', () => {
  it('uses configured credentials for auth and does not expose them in request bodies or errors', async () => {
    process.env.AUDIT_OPENAI_KEY = 'secret-key';
    const upstream = await listen((_request, response) => jsonResponse({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] })(response));
    const result = await openaiAdapter.generate(provider('openai', upstream.url, 'AUDIT_OPENAI_KEY'), model(openaiCapabilities), [{ role: 'user', content: 'hi' }], {}, context());
    expect(result.text).toBe('ok'); expect(upstream.requests[0]!.headers.authorization).toBe('Bearer secret-key');
    expect(JSON.stringify(upstream.requests[0]!.body)).not.toContain('secret-key');
    delete process.env.AUDIT_OPENAI_KEY;
  });

  it('rejects redirects before credentials can reach a different origin', async () => {
    let destinationRequests = 0;
    const destination = await listen((_request, response) => { destinationRequests++; jsonResponse({ ok: true })(response); });
    const redirect = await listen((_request, response) => { response.statusCode = 307; response.setHeader('location', `${destination.url}/capture`); response.end(); });
    await expect(request(`${redirect.url}/generate`, { method: 'POST', headers: { authorization: 'Bearer audit-secret' }, body: '{}' }, context())).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(destinationRequests).toBe(0);
  });
});

describe('Gemini generateContent wire contract', () => {
  it('maps model roles, system instruction, generation settings, JSON schema, and inline media', async () => {
    process.env.AUDIT_GEMINI_KEY = 'secret-gemini';
    const upstream = await listen((_request, response) => jsonResponse({ responseId: 'gem-1', modelVersion: 'gemini-wire', candidates: [{ content: { parts: [{ text: '{"ok":true}' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 } })(response));
    const result = await geminiAdapter.generate({ type: 'gemini', baseUrl: upstream.url, apiKeyEnv: 'AUDIT_GEMINI_KEY' }, { provider: 'p', model: 'gemini-wire', capabilities: geminiCapabilities }, [
      { role: 'system', content: 'rules' }, { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }, { type: 'audio', data: 'AQID', mimeType: 'audio/wav' }] }, { role: 'assistant', content: 'previous' }
    ], { temperature: 0.2, topP: 0.8, maxTokens: 30, stop: ['END'], responseFormat: { type: 'json_schema', schema: { type: 'object', properties: { ok: { type: 'boolean' } } } }, providerOptions: { topK: 4 } }, context());
    const request = upstream.requests[0]!;
    expect(request.url).toBe('/models/gemini-wire:generateContent');
    expect(request.headers['x-goog-api-key']).toBe('secret-gemini');
    expect(request.body).toMatchObject({ systemInstruction: { parts: [{ text: 'rules' }] }, contents: [{ role: 'user', parts: [{ text: 'look' }, { inlineData: { mimeType: 'image/png', data: 'aGVsbG8=' } }, { inlineData: { mimeType: 'audio/wav', data: 'AQID' } }] }, { role: 'model', parts: [{ text: 'previous' }] }], generationConfig: { temperature: 0.2, topP: 0.8, maxOutputTokens: 30, stopSequences: ['END'], responseMimeType: 'application/json', responseJsonSchema: { type: 'object' }, topK: 4 } });
    expect(result).toMatchObject({ text: '{"ok":true}', providerModel: 'gemini-wire', requestId: 'gem-1', usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } });
    delete process.env.AUDIT_GEMINI_KEY;
  });

  it('normalizes streamed text and multimodal inline output, while rejecting tool calls and incomplete streams', async () => {
    const upstream = await listen((_request, response) => sse([
      { responseId: 'gem-s', modelVersion: 'gemini-wire', candidates: [{ content: { parts: [{ text: 'hello ' }] }, finishReason: undefined }] },
      { responseId: 'gem-s', modelVersion: 'gemini-wire', candidates: [{ content: { parts: [{ text: 'world' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 } }, '[DONE]'
    ])(response));
    const seen: string[] = [];
    const result = await geminiAdapter.generate({ type: 'gemini', baseUrl: upstream.url }, { provider: 'p', model: 'gemini-wire', capabilities: geminiCapabilities }, [{ role: 'user', content: 'hi' }], {}, context(new AbortController().signal, event => { if (event.type === 'text') seen.push(event.text ?? ''); }));
    expect(result.text).toBe('hello world'); expect(seen).toEqual(['hello ', 'world']); expect(result.usage).toEqual({ inputTokens: 1, outputTokens: 2, totalTokens: 3 });

    const media = await listen((_request, response) => jsonResponse({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/pcm', data: 'AQID' } }] }, finishReason: 'STOP' }] })(response));
    const mediaResult = await geminiAdapter.generate({ type: 'gemini', baseUrl: media.url }, { provider: 'p', model: 'gemini-wire', capabilities: geminiCapabilities }, [{ role: 'user', content: 'speak' }], { modalities: ['audio'] }, context());
    expect(mediaResult.content).toEqual([{ type: 'audio', data: 'AQID', mimeType: 'audio/pcm' }]);

    const tool = await listen((_request, response) => jsonResponse({ candidates: [{ content: { parts: [{ functionCall: { name: 'bad' } }] }, finishReason: 'STOP' }] })(response));
    await expect(geminiAdapter.generate({ type: 'gemini', baseUrl: tool.url }, { provider: 'p', model: 'gemini-wire', capabilities: geminiCapabilities }, [{ role: 'user', content: 'hi' }], {}, context())).rejects.toMatchObject({ code: 'UNEXPECTED_TOOL_CALL' });
    const truncated = await listen((_request, response) => sse([{ candidates: [{ content: { parts: [{ text: 'partial' }] } }] }])(response));
    await expect(geminiAdapter.generate({ type: 'gemini', baseUrl: truncated.url }, { provider: 'p', model: 'gemini-wire', capabilities: geminiCapabilities }, [{ role: 'user', content: 'hi' }], {}, context(new AbortController().signal, () => undefined))).rejects.toMatchObject({ code: expect.stringMatching(/INVALID_PROVIDER_RESPONSE|UNSUPPORTED_FINISH_REASON/) });
  });

  it.each(['model', 'messages', 'tools', 'authorization'])('rejects providerOptions.%s and cannot override native request fields', async key => {
    await expect(geminiAdapter.generate({ type: 'gemini', baseUrl: 'http://127.0.0.1:1' }, { provider: 'p', model: 'gemini-wire', capabilities: geminiCapabilities }, [{ role: 'user', content: 'hi' }], { providerOptions: { [key]: 'attacker' } }, context())).rejects.toMatchObject({ code: 'UNSUPPORTED_ARGUMENT' });
  });

  it('cancels an in-flight SSE stream', async () => {
    const upstream = await listen(async (_request, response) => { response.statusCode = 200; response.setHeader('content-type', 'text/event-stream'); response.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'partial' }] } }] })}\n\n`); await new Promise(resolve => setTimeout(resolve, 500)); response.end(); });
    const controller = new AbortController();
    const pending = geminiAdapter.generate({ type: 'gemini', baseUrl: upstream.url }, { provider: 'p', model: 'gemini-wire', capabilities: geminiCapabilities }, [{ role: 'user', content: 'hi' }], {}, context(controller.signal, () => undefined));
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});

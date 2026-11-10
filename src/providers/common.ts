import { ModelError, type AdapterContext, type Capabilities, type ContentPart, type GenerationOptions, type Message, type ModelConfig, type ModelResponse, type ProviderConfig, type Usage } from '../types.js';
export type Obj = Record<string, any>;
export const object = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
export function fail(message: string): never { throw new ModelError('UNSUPPORTED_ARGUMENT', message); }
export function malformed(): never { throw new ModelError('INVALID_PROVIDER_RESPONSE', 'Provider returned an invalid or incomplete response.'); }
export function parts(message: Message): ContentPart[] { return typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content; }
export function validate(model: ModelConfig, messages: Message[], options: GenerationOptions, context: AdapterContext, native: Capabilities): void {
 const cap = model.capabilities;
 for (const message of messages) {
  if (!cap.roles.includes(message.role) || !native.roles.includes(message.role)) fail(`Unsupported role: ${message.role}`);
  for (const part of parts(message)) {
   if (!cap.input.includes(part.type) || !native.input.includes(part.type)) fail(`Unsupported input modality: ${part.type}`);
   if (message.role === 'system' && part.type !== 'text') fail('System messages only support text.');
  }
 }
 for (const key of ['temperature', 'topP', 'maxTokens', 'stop', 'seed'] as const) if (options[key] !== undefined && (!cap.options.includes(key) || !native.options.includes(key))) fail(`Unsupported option: ${key}`);
 for (const modality of options.modalities ?? ['text']) if (!cap.output.includes(modality) || !native.output.includes(modality)) fail(`Unsupported output modality: ${modality}`);
 if (context.onEvent && (!cap.streaming || !native.streaming)) fail('Streaming is unsupported by this model.');
 const format = options.responseFormat?.type;
 if (format === 'json' && (!cap.json || !native.json)) fail('JSON output is unsupported by this model.');
 if (format === 'json_schema' && (!cap.jsonSchema || !native.jsonSchema)) fail('JSON schema output is unsupported by this model.');
 if (format === 'json_schema' && !object(options.responseFormat?.schema)) fail('JSON schema output requires a schema.');
}
export function providerOptions(options: GenerationOptions, allowed: Record<string, (value: unknown) => boolean>): Obj {
 const result: Obj = {};
 for (const [key, value] of Object.entries(options.providerOptions ?? {})) {
  if (!Object.hasOwn(allowed, key) || !allowed[key]!(value)) fail(`Unsupported or invalid provider option: ${key}`);
  result[key] = value;
 }
 return result;
}
export const number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
export const integer = (v: unknown): v is number => number(v) && Number.isInteger(v);
export function exactObject(v: unknown, validators: Record<string, (v: unknown) => boolean>, required: string[] = []): boolean {
 return object(v) && required.every(k => Object.hasOwn(v, k)) && Object.entries(v).every(([k, value]) => Object.hasOwn(validators, k) && validators[k]!(value));
}
export function credentials(provider: ProviderConfig): string | undefined {
 if (!provider.apiKeyEnv) return undefined;
 const value = process.env[provider.apiKeyEnv];
 if (!value) throw new ModelError('MISSING_CREDENTIAL', 'The configured provider credential is unavailable.');
 return value;
}
export function endpoint(provider: ProviderConfig, path: string): string { return `${provider.baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`; }
export function headers(provider: ProviderConfig, type: 'openai' | 'anthropic' | 'gemini'): Record<string, string> {
 const result: Record<string, string> = { ...provider.headers, 'content-type': 'application/json' };
 const key = credentials(provider);
 if (key) {
  const auth = type === 'openai' ? 'authorization' : type === 'anthropic' ? 'x-api-key' : 'x-goog-api-key';
  for (const name of Object.keys(result)) if (name.toLowerCase() === auth) delete result[name];
  result[auth] = type === 'openai' ? `Bearer ${key}` : key;
 }
 if (type === 'anthropic') result['anthropic-version'] = '2023-06-01';
 return result;
}
function retryAfter(response: Response): number | undefined {
 const value = response.headers.get('retry-after'); if (!value) return undefined;
 const seconds = Number(value); const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
 return Number.isFinite(ms) ? Math.max(0, ms) : undefined;
}
export async function request(url: string, init: RequestInit, context: AdapterContext): Promise<Response> {
 try {
  context.signal.throwIfAborted();
  const response = await fetch(url, { ...init, signal: context.signal, redirect: 'error' });
  if (!response.ok) {
   await response.body?.cancel(); const status = response.status;
   throw new ModelError(status === 429 ? 'RATE_LIMITED' : status === 401 || status === 403 ? 'AUTHENTICATION_FAILED' : status === 404 ? 'MODEL_NOT_FOUND' : 'PROVIDER_ERROR', `Provider request failed (HTTP ${status}).`, status === 429 || status >= 500, status, retryAfter(response));
  }
  return response;
 } catch (error) {
  if (context.signal.aborted) throw new ModelError('CANCELLED', 'Provider request was cancelled.');
  if (error instanceof ModelError) throw error;
  throw new ModelError('NETWORK_ERROR', 'Provider network request failed.', true);
 }
}
export async function json(response: Response, context: AdapterContext): Promise<Obj> {
 try {
  if (!response.body) malformed();
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
   for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > 16 * 1024 * 1024) malformed(); chunks.push(chunk.value); }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes)); if (!object(value)) malformed(); return value;
 }
 catch (error) { if (context.signal.aborted) throw new ModelError('CANCELLED', 'Provider request was cancelled.'); if (error instanceof ModelError) throw error; malformed(); }
}
export async function* events(response: Response, context: AdapterContext): AsyncGenerator<Obj | '[DONE]'> {
 if (!response.body) malformed();
 const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let data: string[] = []; let eventBytes = 0; let totalBytes = 0;
 const parse = (line: string): Obj | '[DONE]' | undefined => {
  if (line === '') {
   if (!data.length) return; const raw = data.join('\n'); data = []; eventBytes = 0; if (raw === '[DONE]') return '[DONE]';
   try { const value: unknown = JSON.parse(raw); if (!object(value)) malformed(); return value; } catch { malformed(); }
  }
  if (line.startsWith('data:')) { eventBytes += line.length; if (eventBytes > 16 * 1024 * 1024) malformed(); data.push(line.slice(5).replace(/^ /, '')); } return;
 };
 try {
  while (true) {
   context.signal.throwIfAborted(); const chunk = await reader.read(); totalBytes += chunk.value?.byteLength ?? 0; if (totalBytes > 16 * 1024 * 1024) malformed(); buffer += decoder.decode(chunk.value, { stream: !chunk.done }); let newline: number;
   while ((newline = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, newline).replace(/\r$/, ''); buffer = buffer.slice(newline + 1); const value = parse(line); if (value) yield value; }
   if (buffer.length > 16 * 1024 * 1024) malformed();
   if (chunk.done) { if (buffer) { const value = parse(buffer.replace(/\r$/, '')); if (value) yield value; } const last = parse(''); if (last) yield last; break; }
  }
 } catch (error) {
  if (context.signal.aborted) throw new ModelError('CANCELLED', 'Provider request was cancelled.'); if (error instanceof ModelError) throw error;
  throw new ModelError('NETWORK_ERROR', 'Provider response stream failed.', true);
 } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
export function nativeError(value: Obj): void { if (value.error || value.type === 'error') throw new ModelError('PROVIDER_ERROR', 'Provider returned an inference error.'); }
export function finish(reason: unknown, allowed: string[]): string {
 if (typeof reason !== 'string') malformed();
 if (['tool_calls', 'function_call', 'tool_use'].includes(reason)) throw new ModelError('UNEXPECTED_TOOL_CALL', 'Provider attempted a tool call; tools are disabled.');
 if (['content_filter', 'refusal', 'safety', 'SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII'].includes(reason)) throw new ModelError('REFUSED', 'Provider refused or filtered the response.');
 if (['length', 'max_tokens', 'MAX_TOKENS'].includes(reason)) throw new ModelError('OUTPUT_TRUNCATED', 'Provider output reached its token limit.');
 if (!allowed.includes(reason)) throw new ModelError('UNSUPPORTED_FINISH_REASON', 'Provider returned an unsupported finish reason.');
 return reason;
}
export function usage(value: Obj, keys: [string, string, string?]): Usage | undefined {
 const input = value[keys[0]], output = value[keys[1]], total = keys[2] ? value[keys[2]] : undefined; const result: Usage = {};
 if (integer(input) && input >= 0) result.inputTokens = input; if (integer(output) && output >= 0) result.outputTokens = output; if (integer(total) && total >= 0) result.totalTokens = total;
 return Object.keys(result).length ? result : undefined;
}
export function result(model: ModelConfig, text: string, content: ContentPart[], reason: string, providerModel?: unknown, requestId?: unknown, tokens?: Usage): ModelResponse {
 return { model: model.model, provider: model.provider, text, ...(content.length ? { content } : {}), finishReason: reason, ...(typeof providerModel === 'string' ? { providerModel } : {}), ...(typeof requestId === 'string' ? { requestId } : {}), ...(tokens ? { usage: tokens } : {}) };
}
export async function probe(provider: ProviderConfig, model: ModelConfig, context: AdapterContext): Promise<{ available: boolean; details?: string }> {
 try { const response = await request(endpoint(provider, `models/${encodeURIComponent(model.model)}`), { method: 'GET', headers: headers(provider, provider.type) }, context); await response.body?.cancel(); return { available: true, details: 'Model metadata endpoint is available; generation capabilities were not probed.' }; }
 catch (error) { if (error instanceof ModelError && error.code !== 'CANCELLED') return { available: false, details: error.message }; throw error; }
}

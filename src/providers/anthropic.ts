import { ModelError, type Capabilities, type ContentPart, type ProviderAdapter } from '../types.js';
import { endpoint, events, fail, finish, headers, integer, json, malformed, nativeError, object, parts, probe, providerOptions, request, result, usage, validate, type Obj } from './common.js';
export const anthropicCapabilities: Capabilities = { roles: ['system', 'user', 'assistant'], input: ['text', 'image'], output: ['text'], streaming: true, json: false, jsonSchema: true, options: ['temperature', 'topP', 'maxTokens', 'stop'] };
export const anthropicAdapter: ProviderAdapter = {
 probe,
 async generate(provider, model, messages, options, context) {
  validate(model, messages, options, context, anthropicCapabilities);
  const extra = providerOptions(options, { service_tier: v => ['auto', 'standard_only'].includes(v as string) });
  if (options.maxTokens === undefined) fail('Anthropic requires an explicit maxTokens option.');
  const system: Obj[] = []; const conversation: Obj[] = []; let seenConversation = false;
  for (const message of messages) {
   const content = parts(message).map(part => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    if (part.type !== 'image') fail('Anthropic does not support audio.');
    if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(part.mimeType)) fail('Unsupported Anthropic image MIME type.');
    if (message.role !== 'user') fail('Anthropic image input requires a user message.');
    return { type: 'image', source: part.url ? { type: 'url', url: part.url } : { type: 'base64', media_type: part.mimeType, data: part.data } };
   });
   if (message.role === 'system') { if (seenConversation) fail('Anthropic system messages must precede conversation messages.'); system.push(...content); }
   else { seenConversation = true; conversation.push({ role: message.role, content }); }
  }
  const body: Obj = { ...extra, model: model.model, messages: conversation, max_tokens: options.maxTokens };
  if (system.length) body.system = system;
  if (options.temperature !== undefined) body.temperature = options.temperature;
  if (options.topP !== undefined) body.top_p = options.topP;
  if (options.stop !== undefined) body.stop_sequences = options.stop;
  if (options.responseFormat?.type === 'json_schema') body.output_config = { format: { type: 'json_schema', schema: options.responseFormat.schema } };
  if (context.onEvent) body.stream = true;
  const response = await request(endpoint(provider, 'messages'), { method: 'POST', headers: headers(provider, 'anthropic'), body: JSON.stringify(body) }, context);
  let text = ''; let reason: unknown; let nativeModel: unknown; let id: unknown; let tokenValues: Obj = {}; let done = false; const blocks = new Set<number>();
  const accept = async (block: Obj, stream: boolean) => {
   if (block.type === 'tool_use' || block.type === 'server_tool_use') throw new ModelError('UNEXPECTED_TOOL_CALL', 'Provider attempted a tool call; tools are disabled.');
   if (block.type === 'refusal') throw new ModelError('REFUSED', 'Provider refused the response.');
   if (block.type !== 'text' || typeof block.text !== 'string') malformed();
   text += block.text; if (stream && block.text) await context.onEvent?.({ type: 'text', text: block.text });
  };
  if (context.onEvent) {
   let started = false;
   for await (const event of events(response, context)) {
    if (event === '[DONE]') malformed(); nativeError(event);
    if (event.type === 'ping') continue;
    if (event.type === 'message_start') {
     if (started || !object(event.message)) malformed(); started = true; nativeModel = event.message.model; id = event.message.id;
     if (object(event.message.usage)) tokenValues = { ...event.message.usage };
    } else if (event.type === 'content_block_start') {
     if (!started || !Number.isInteger(event.index) || blocks.has(event.index) || !object(event.content_block)) malformed();
     blocks.add(event.index); await accept(event.content_block, true);
    } else if (event.type === 'content_block_delta') {
     if (!blocks.has(event.index) || !object(event.delta) || event.delta.type !== 'text_delta') malformed();
     await accept({ type: 'text', text: event.delta.text }, true);
    } else if (event.type === 'content_block_stop') { if (!blocks.delete(event.index)) malformed(); }
    else if (event.type === 'message_delta') { if (!started || !object(event.delta)) malformed(); reason = event.delta.stop_reason; if (object(event.usage)) tokenValues = { ...tokenValues, ...event.usage }; }
    else if (event.type === 'message_stop') { if (!started || blocks.size) malformed(); done = true; break; }
    else malformed();
   }
   if (!done) malformed();
  } else {
   const value = await json(response, context); nativeError(value); if (!Array.isArray(value.content)) malformed();
   for (const block of value.content) { if (!object(block)) malformed(); await accept(block, false); }
   reason = value.stop_reason; nativeModel = value.model; id = value.id; if (object(value.usage)) tokenValues = value.usage;
  }
  const stopped = finish(reason, ['end_turn', 'stop_sequence']); const content: ContentPart[] = text ? [{ type: 'text', text }] : [];
  if (!text) malformed();
  const tokens = usage(tokenValues, ['input_tokens', 'output_tokens']);
  if (tokens && integer(tokenValues.cache_read_input_tokens) && tokenValues.cache_read_input_tokens >= 0) tokens.cachedInputTokens = tokenValues.cache_read_input_tokens;
  return result(model, text, content, stopped, nativeModel, id, tokens);
 }
};

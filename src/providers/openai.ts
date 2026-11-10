import { ModelError, type Capabilities, type ContentPart, type ProviderAdapter } from '../types.js';
import { endpoint, events, exactObject, fail, finish, headers, json, malformed, nativeError, number, object, parts, probe, providerOptions, request, result, usage, validate, type Obj } from './common.js';
export const openaiCapabilities: Capabilities = { roles: ['system', 'user', 'assistant'], input: ['text', 'image', 'audio'], output: ['text', 'audio'], streaming: true, json: true, jsonSchema: true, options: ['temperature', 'topP', 'maxTokens', 'stop', 'seed'] };
const formats: Record<string, string> = { 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3' };
const outputMime: Record<string, string> = { wav: 'audio/wav', mp3: 'audio/mpeg', flac: 'audio/flac', opus: 'audio/opus', pcm16: 'audio/pcm' };
export const openaiAdapter: ProviderAdapter = {
 probe,
 async generate(provider, model, messages, options, context) {
  validate(model, messages, options, context, openaiCapabilities);
  const extra = providerOptions(options, {
   frequency_penalty: v => number(v) && v >= -2 && v <= 2, presence_penalty: v => number(v) && v >= -2 && v <= 2,
   reasoning_effort: v => ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(v as string),
   service_tier: v => ['auto', 'default', 'flex', 'priority'].includes(v as string),
   max_tokens_parameter: v => v === 'max_tokens' || v === 'max_completion_tokens',
   audio: v => exactObject(v, { voice: x => typeof x === 'string' && x.length > 0, format: x => typeof x === 'string' && Object.hasOwn(outputMime, x) }, ['voice', 'format'])
  });
  const audioRequested = options.modalities?.includes('audio');
  const maxTokensParameter = extra.max_tokens_parameter ?? 'max_completion_tokens'; delete extra.max_tokens_parameter;
  if (options.maxTokens === undefined && options.providerOptions?.max_tokens_parameter !== undefined) fail('max_tokens_parameter requires maxTokens.');
  if (audioRequested && !extra.audio) fail('Audio output requires providerOptions.audio with voice and format.');
  if (extra.audio && !audioRequested) fail('providerOptions.audio requires the audio output modality.');
  const body: Obj = { ...extra, model: model.model, messages: messages.map(message => ({ role: message.role, content: parts(message).map(part => {
   if (part.type === 'text') return { type: 'text', text: part.text };
   if (message.role !== 'user') fail('OpenAI image/audio input is supported only in user messages.');
   if (part.type === 'image') return { type: 'image_url', image_url: { url: part.url ?? ('data:' + part.mimeType + ';base64,' + part.data) } };
   const format = formats[part.mimeType]; if (!format) fail('OpenAI audio input supports WAV and MP3.');
   return { type: 'input_audio', input_audio: { data: part.data, format } };
  }) })) };
  if (options.temperature !== undefined) body.temperature = options.temperature;
  if (options.topP !== undefined) body.top_p = options.topP;
  if (options.maxTokens !== undefined) body[maxTokensParameter] = options.maxTokens;
  if (options.stop !== undefined) body.stop = options.stop;
  if (options.seed !== undefined) body.seed = options.seed;
  if (options.modalities) body.modalities = options.modalities;
  if (options.responseFormat?.type === 'json') body.response_format = { type: 'json_object' };
  if (options.responseFormat?.type === 'json_schema') body.response_format = { type: 'json_schema', json_schema: { name: options.responseFormat.name ?? 'response', schema: options.responseFormat.schema, strict: true } };
  if (context.onEvent) { body.stream = true; body.stream_options = { include_usage: true }; }
  const response = await request(endpoint(provider, 'chat/completions'), { method: 'POST', headers: headers(provider, 'openai'), body: JSON.stringify(body) }, context);
  let text = ''; let reason: unknown; let nativeModel: unknown; let id: unknown; let tokens; let audio = ''; let done = false;
  const accept = async (message: Obj, streamed: boolean) => {
   if (message.refusal) throw new ModelError('REFUSED', 'Provider refused the response.');
   if (message.tool_calls || message.function_call) throw new ModelError('UNEXPECTED_TOOL_CALL', 'Provider attempted a tool call; tools are disabled.');
   if (message.content !== null && message.content !== undefined) {
    if (typeof message.content !== 'string') malformed();
    text += message.content; if (streamed && message.content) await context.onEvent?.({ type: 'text', text: message.content });
   }
   if (message.audio) {
    if (!audioRequested || !object(message.audio)) malformed();
    if (message.audio.data !== undefined) { if (typeof message.audio.data !== 'string') malformed(); audio += message.audio.data; }
   }
  };
  if (context.onEvent) {
   for await (const chunk of events(response, context)) {
    if (chunk === '[DONE]') { done = true; break; } nativeError(chunk);
    if (chunk.model !== undefined) nativeModel = chunk.model; if (chunk.id !== undefined) id = chunk.id;
    if (object(chunk.usage)) tokens = usage(chunk.usage, ['prompt_tokens', 'completion_tokens', 'total_tokens']);
    if (!Array.isArray(chunk.choices) || chunk.choices.length > 1) malformed();
    if (chunk.choices.length === 0) { if (!object(chunk.usage)) malformed(); continue; }
    const choice = chunk.choices[0]; if (!object(choice)) malformed();
    if (choice.index !== undefined && choice.index !== 0) malformed();
    if (object(choice.delta)) await accept(choice.delta, true); else malformed();
    if (choice.finish_reason !== null && choice.finish_reason !== undefined) reason = choice.finish_reason;
   }
   if (!done) malformed();
  } else {
   const value = await json(response, context); nativeError(value); if (!Array.isArray(value.choices) || value.choices.length !== 1 || !object(value.choices[0]?.message)) malformed();
   await accept(value.choices[0].message, false); reason = value.choices[0].finish_reason; nativeModel = value.model; id = value.id;
   if (object(value.usage)) tokens = usage(value.usage, ['prompt_tokens', 'completion_tokens', 'total_tokens']);
  }
  const stopped = finish(reason, ['stop']); const content: ContentPart[] = [];
  if (text) content.push({ type: 'text', text });
  if (audio) { const part: ContentPart = { type: 'audio', data: audio, mimeType: outputMime[extra.audio.format]! }; content.push(part); await context.onEvent?.({ type: 'content', content: part }); }
  if (audioRequested && !audio) malformed();
  if (!text && !audio) malformed();
  return result(model, text, content, stopped, nativeModel, id, tokens);
 }
};

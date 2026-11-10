import { ModelError, type Capabilities, type ContentPart, type ProviderAdapter } from '../types.js';
import { endpoint, events, fail, finish, headers, integer, json, malformed, nativeError, object, parts, probe, providerOptions, request, result, usage, validate, type Obj } from './common.js';
export const geminiCapabilities: Capabilities = { roles: ['system', 'user', 'assistant'], input: ['text', 'image', 'audio'], output: ['text', 'image', 'audio'], streaming: true, json: true, jsonSchema: true, options: ['temperature', 'topP', 'maxTokens', 'stop', 'seed'] };
export const geminiAdapter: ProviderAdapter = {
 probe,
 async generate(provider, model, messages, options, context) {
  validate(model, messages, options, context, geminiCapabilities);
  const extra = providerOptions(options, { topK: v => integer(v) && v > 0 });
  const system: Obj[] = []; const contents: Obj[] = []; let seenConversation = false;
  for (const message of messages) {
   const converted = parts(message).map(part => {
    if (part.type === 'text') return { text: part.text };
    if (message.role !== 'user') fail('Gemini media input requires a user message.');
    if (part.type === 'image' && part.url) fail('Gemini requires inline image data, not URLs.');
    return { inlineData: { mimeType: part.mimeType, data: part.data } };
   });
   if (message.role === 'system') { if (seenConversation) fail('Gemini system messages must precede conversation messages.'); system.push(...converted); }
   else { seenConversation = true; contents.push({ role: message.role === 'assistant' ? 'model' : 'user', parts: converted }); }
  }
  const generationConfig: Obj = { ...extra };
  if (options.temperature !== undefined) generationConfig.temperature = options.temperature;
  if (options.topP !== undefined) generationConfig.topP = options.topP;
  if (options.maxTokens !== undefined) generationConfig.maxOutputTokens = options.maxTokens;
  if (options.stop !== undefined) generationConfig.stopSequences = options.stop;
  if (options.seed !== undefined) generationConfig.seed = options.seed;
  if (options.modalities) generationConfig.responseModalities = options.modalities.map(x => x.toUpperCase());
  if (options.responseFormat && options.responseFormat.type !== 'text') generationConfig.responseMimeType = 'application/json';
  if (options.responseFormat?.type === 'json_schema') generationConfig.responseJsonSchema = options.responseFormat.schema;
  const body: Obj = { contents, generationConfig }; if (system.length) body.systemInstruction = { parts: system };
  const action = context.onEvent ? 'streamGenerateContent?alt=sse' : 'generateContent';
  const response = await request(endpoint(provider, 'models/' + encodeURIComponent(model.model) + ':' + action), { method: 'POST', headers: headers(provider, 'gemini'), body: JSON.stringify(body) }, context);
  let text = ''; let reason: unknown; let nativeModel: unknown; let id: unknown; let tokens; const content: ContentPart[] = []; let sawCandidate = false;
  const accept = async (value: Obj, streamed: boolean) => {
   nativeError(value);
   if (value.promptFeedback?.blockReason) throw new ModelError('REFUSED', 'Provider refused or filtered the request.');
   if (value.modelVersion !== undefined) nativeModel = value.modelVersion; if (value.responseId !== undefined) id = value.responseId;
   if (object(value.usageMetadata)) tokens = usage(value.usageMetadata, ['promptTokenCount', 'candidatesTokenCount', 'totalTokenCount']);
   if (value.candidates === undefined) return;
   if (!Array.isArray(value.candidates) || value.candidates.length !== 1 || !object(value.candidates[0])) malformed();
   const candidate = value.candidates[0]; sawCandidate = true;
   if (candidate.finishReason !== undefined) reason = candidate.finishReason;
   if (candidate.content !== undefined) {
    if (!object(candidate.content) || !Array.isArray(candidate.content.parts)) malformed();
    for (const part of candidate.content.parts) {
     if (!object(part)) malformed();
     if (part.functionCall || part.functionResponse || part.executableCode || part.codeExecutionResult) throw new ModelError('UNEXPECTED_TOOL_CALL', 'Provider attempted a tool call; tools are disabled.');
     if (part.thought) continue;
     if (typeof part.text === 'string') { text += part.text; if (part.text) { const previous = content.at(-1); if (previous?.type === 'text') previous.text += part.text; else content.push({ type: 'text', text: part.text }); } if (streamed && part.text) await context.onEvent?.({ type: 'text', text: part.text }); }
     else if (object(part.inlineData) && typeof part.inlineData.data === 'string' && typeof part.inlineData.mimeType === 'string') {
      const mimeType = part.inlineData.mimeType; const type = mimeType.startsWith('image/') ? 'image' : mimeType.startsWith('audio/') ? 'audio' : undefined;
      if (!type || !(options.modalities ?? ['text']).includes(type)) malformed();
      const normalized: ContentPart = { type, data: part.inlineData.data, mimeType }; content.push(normalized); if (streamed) await context.onEvent?.({ type: 'content', content: normalized });
     } else malformed();
    }
   }
  };
  if (context.onEvent) { for await (const chunk of events(response, context)) { if (chunk === '[DONE]') break; await accept(chunk, true); } }
  else await accept(await json(response, context), false);
  if (!sawCandidate) malformed();
  const stopped = finish(reason, ['STOP']);
  if (!content.length) malformed();
  return result(model, text, content, stopped, nativeModel, id, tokens);
 }
};

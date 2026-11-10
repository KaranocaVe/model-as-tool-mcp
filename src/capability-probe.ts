import { ModelError, type AskRequest, type CallContext, type Capabilities, type ContentPart, type GenerationOptions, type Message, type ModelResponse, type Role, type StreamEvent, type Usage } from './types.js';

/** The explicit probe names accepted by {@link detectCapabilities}. */
export type CapabilityAspect =
  | 'text'
  | 'json'
  | 'json_schema'
  | 'streaming'
  | 'image'
  | 'audio'
  | 'image_input'
  | 'audio_input'
  | 'role:system'
  | 'role:user'
  | 'role:assistant'
  | 'role_system'
  | 'role_user'
  | 'role_assistant'
  | 'option:temperature'
  | 'option:topP'
  | 'option:maxTokens'
  | 'option:stop'
  | 'option:seed'
  | 'option_temperature'
  | 'option_topP'
  | 'option_maxTokens'
  | 'option_stop'
  | 'option_seed';

export type CapabilityStatus = 'supported' | 'unsupported' | 'inconclusive';

export type CapabilityRationaleCode =
  | 'OBSERVED_SUCCESS'
  | 'OBSERVED_SUCCESS_DECLARATION_CONFLICT'
  | 'UNSUPPORTED_OPTION'
  | 'UNSUPPORTED_CONTENT'
  | 'UNSUPPORTED_ROLE'
  | 'UNSUPPORTED_ARGUMENT'
  | 'UNKNOWN_ASPECT'
  | 'NO_STREAM_EVENT'
  | 'INVALID_PROBE_RESPONSE'
  | 'INCONCLUSIVE_ERROR';

export interface CapabilityProbeContext extends CallContext {
  /** Optional registry declaration to report alongside the live observation. */
  declared?: Capabilities;
}

export interface CapabilityProbeResult {
  aspect: string;
  status: CapabilityStatus;
  rationaleCode: CapabilityRationaleCode;
  details: string;
  /** The configured declaration, when the caller supplied one. */
  declared?: boolean;
  /** Live observation: omitted when the request was inconclusive. */
  observed?: boolean;
  /** Usage and request metadata are kept visible so probes do not hide consumption. */
  usage?: Usage;
  meta?: ModelResponse['meta'];
  /** Streaming probes include the actual events observed from the request. */
  events?: StreamEvent[];
  error?: { code: string; message: string; status?: number; retryable?: boolean };
}

export interface CapabilityDetectionResult {
  model: string;
  requested: string[];
  results: CapabilityProbeResult[];
}

export interface CapabilityProbeEngine {
  ask(request: AskRequest, context?: CapabilityProbeContext): Promise<ModelResponse>;
}

export const MAX_CAPABILITY_PROBES = 32;

// Tiny local fixtures. They intentionally contain no remote references.
const ONE_PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
// RIFF/WAVE, mono, 8 kHz, 16-bit PCM, one silent sample.
const ONE_SAMPLE_WAV = 'UklGRi4AAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQIAAAAAAAAA';

const roleAliases: Record<string, Role | undefined> = {
  'role:system': 'system', role_system: 'system',
  'role:user': 'user', role_user: 'user',
  'role:assistant': 'assistant', role_assistant: 'assistant'
};
const optionAliases: Record<string, keyof Pick<GenerationOptions, 'temperature' | 'topP' | 'maxTokens' | 'stop' | 'seed'> | undefined> = {
  'option:temperature': 'temperature', option_temperature: 'temperature',
  'option:topP': 'topP', option_topP: 'topP',
  'option:maxTokens': 'maxTokens', option_maxTokens: 'maxTokens',
  'option:stop': 'stop', option_stop: 'stop',
  'option:seed': 'seed', option_seed: 'seed'
};

type ProbePlan = { request: AskRequest; validate: (response: ModelResponse, events: StreamEvent[]) => { ok: boolean; code: CapabilityRationaleCode; details: string } };

function textMessage(role: Role = 'user'): Message {
  return { role, content: 'Reply with exactly OK.' };
}

function roleMessages(role: Role): Message[] {
  if (role === 'system') return [{ role: 'system', content: 'You are a capability probe.' }, textMessage('user')];
  if (role === 'assistant') return [textMessage('user'), { role: 'assistant', content: 'Acknowledged.' }, textMessage('user')];
  return [textMessage('user')];
}

function responseText(response: ModelResponse): boolean { return typeof response.text === 'string' && response.text.length > 0; }
function validJson(response: ModelResponse): boolean {
  if (!responseText(response)) return false;
  try { JSON.parse(response.text); return true; } catch { return false; }
}
function validJsonSchema(response: ModelResponse): boolean {
  if (!validJson(response)) return false;
  try { const value: unknown = JSON.parse(response.text); return !!value && typeof value === 'object' && !Array.isArray(value) && (value as { ok?: unknown }).ok === true; } catch { return false; }
}

function planFor(aspect: string, streamEvents: StreamEvent[]): ProbePlan | undefined {
  const base = (request: AskRequest, validate: ProbePlan['validate'] = (response) => responseText(response) ? { ok: true, code: 'OBSERVED_SUCCESS', details: 'The model returned text for the requested capability.' } : { ok: false, code: 'INVALID_PROBE_RESPONSE', details: 'The model request succeeded without a non-empty text result.' }): ProbePlan => ({ request: { ...request, options: { maxTokens: 64, ...(request.options ?? {}) }, retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 }, cache: false, deduplicate: false }, validate });
  if (aspect === 'text') return base({ messages: [textMessage()] });
  if (aspect === 'json') return base({ messages: [{ role: 'user', content: 'Return a JSON object with the key "ok" set to true.' }], options: { responseFormat: { type: 'json' } } }, response => validJson(response) ? { ok: true, code: 'OBSERVED_SUCCESS', details: 'The model returned valid JSON using responseFormat=json.' } : { ok: false, code: 'INVALID_PROBE_RESPONSE', details: 'The request completed but the response was not valid JSON.' });
  if (aspect === 'json_schema') {
    const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
    return base({ messages: [{ role: 'user', content: 'Return exactly the JSON object {"ok":true}.' }], options: { responseFormat: { type: 'json_schema', name: 'CapabilityProbe', schema } } }, response => validJsonSchema(response) ? { ok: true, code: 'OBSERVED_SUCCESS', details: 'The model returned a response matching the requested JSON schema.' } : { ok: false, code: 'INVALID_PROBE_RESPONSE', details: 'The request completed but the response did not match the probe schema.' });
  }
  if (aspect === 'streaming') return base({ messages: [textMessage()], stream: true }, response => {
    const observed = streamEvents.some(event => (event.type === 'text' && typeof event.text === 'string' && event.text.length > 0) || (event.type === 'content' && event.content !== undefined));
    return observed ? { ok: true, code: 'OBSERVED_SUCCESS', details: `Observed ${streamEvents.length} streaming event${streamEvents.length === 1 ? '' : 's'}.` } : { ok: false, code: 'NO_STREAM_EVENT', details: 'The request completed without an observable non-empty stream event.' };
  });
  if (aspect === 'image' || aspect === 'image_input') {
    const content: ContentPart[] = [{ type: 'text', text: 'Describe this image with exactly one word.' }, { type: 'image', data: ONE_PIXEL_PNG, mimeType: 'image/png' }];
    return base({ messages: [{ role: 'user', content }] });
  }
  if (aspect === 'audio' || aspect === 'audio_input') {
    const content: ContentPart[] = [{ type: 'text', text: 'Listen to this audio and reply with exactly OK.' }, { type: 'audio', data: ONE_SAMPLE_WAV, mimeType: 'audio/wav' }];
    return base({ messages: [{ role: 'user', content }] });
  }
  const role = Object.hasOwn(roleAliases, aspect) ? roleAliases[aspect] : undefined;
  if (role) return base({ messages: roleMessages(role) });
  const option = Object.hasOwn(optionAliases, aspect) ? optionAliases[aspect] : undefined;
  if (option) {
    const values: Record<typeof option, number | string[] > = { temperature: 0, topP: 1, maxTokens: 64, stop: ['<capability-probe-stop>'], seed: 1 };
    return base({ messages: [textMessage()], options: { [option]: values[option] } });
  }
  return undefined;
}
function errorInfo(error: unknown): { code: string; message: string; status?: number; retryable?: boolean } {
  if (error instanceof ModelError) return { code: error.code, message: error.message, ...(error.status === undefined ? {} : { status: error.status }), ...(error.retryable ? { retryable: true } : {}) };
  return { code: 'PROVIDER_ERROR', message: 'Provider request failed' };
}

function unsupportedCode(code: string): CapabilityRationaleCode | undefined {
  if (code === 'UNSUPPORTED_OPTION') return 'UNSUPPORTED_OPTION';
  if (code === 'UNSUPPORTED_CONTENT') return 'UNSUPPORTED_CONTENT';
  if (code === 'UNSUPPORTED_ROLE') return 'UNSUPPORTED_ROLE';
  return undefined;
}

/**
 * Run only the explicitly requested live capability probes. Each recognized
 * aspect gets one direct `ModelEngine.ask` call, serially, with no cache,
 * deduplication, fallback, or session history. The model registry is never
 * modified by this function.
 */
export async function detectCapabilities(engine: CapabilityProbeEngine, model: string, probes: readonly string[], context?: CapabilityProbeContext): Promise<CapabilityDetectionResult> {
  if (!model || typeof model !== 'string') throw new ModelError('INVALID_ARGUMENT', 'A model is required.');
  if (!Array.isArray(probes) || probes.length < 1 || probes.length > MAX_CAPABILITY_PROBES) throw new ModelError('INVALID_ARGUMENT', `Provide between 1 and ${MAX_CAPABILITY_PROBES} explicit capability probes.`);
  const requested = [...probes];
  if (requested.some(probe => typeof probe !== 'string' || probe.length === 0)) throw new ModelError('INVALID_ARGUMENT', 'Capability probe names must be non-empty strings.');
  if (new Set(requested).size !== requested.length) throw new ModelError('INVALID_ARGUMENT', 'Capability probes must be unique.');
  const results: CapabilityProbeResult[] = [];
  for (const aspect of requested) {
    if (context?.signal?.aborted) throw new ModelError('CANCELLED', 'Capability detection was cancelled.');
    const plan = planFor(aspect, []);
    if (!plan) { results.push({ aspect, status: 'inconclusive', rationaleCode: 'UNKNOWN_ASPECT', details: 'The requested capability is unknown; no inference request was issued.' }); continue; }
    const events: StreamEvent[] = [];
    const probeContext: CapabilityProbeContext = {
      ...(context ?? {}),
      onEvent: async event => { events.push(event); await context?.onEvent?.(event); }
    };
    // ModelEngine uses this explicit marker to run candidate validation against
    // a permissive temporary model view. It never changes the registry.
    (probeContext as CapabilityProbeContext & { capabilityProbe: boolean }).capabilityProbe = true;
    // The stream validator closes over the events from this one request only.
    const streamPlan = aspect === 'streaming' ? planFor(aspect, events)! : plan;
    try {
      const response = await engine.ask({ model, ...streamPlan.request }, probeContext);
      const observed = streamPlan.validate(response, events);
      const declared = context?.declared ? declarationFor(context.declared, aspect) : undefined;
      const conflict = observed.ok && declared === false;
      results.push({ aspect, status: observed.ok ? 'supported' : 'inconclusive', rationaleCode: conflict ? 'OBSERVED_SUCCESS_DECLARATION_CONFLICT' : observed.code, details: conflict ? `${observed.details} The live result conflicts with the supplied registry declaration.` : observed.details, ...(declared === undefined ? {} : { declared }), ...(observed.ok ? { observed: true } : {}), ...(response.usage ? { usage: response.usage } : {}), ...(response.meta ? { meta: response.meta } : {}), ...(aspect === 'streaming' || events.length ? { events: [...events] } : {}) });
    } catch (error) {
      const info = errorInfo(error); const unsupported = unsupportedCode(info.code); const declared = context?.declared ? declarationFor(context.declared, aspect) : undefined;
      results.push({ aspect, status: unsupported ? 'unsupported' : 'inconclusive', rationaleCode: unsupported ?? 'INCONCLUSIVE_ERROR', details: unsupported ? `The model explicitly rejected this capability: ${info.message}` : `The live probe failed without a capability-specific rejection: ${info.message}`, ...(declared === undefined ? {} : { declared }), ...(unsupported ? { observed: false } : {}), ...(aspect === 'streaming' ? { events: [...events] } : {}), error: info });
    }
  }
  return { model, requested, results };
}

function declarationFor(capabilities: Capabilities, aspect: string): boolean | undefined {
  if (aspect === 'text') return capabilities.input.includes('text');
  if (aspect === 'json') return capabilities.json;
  if (aspect === 'json_schema') return capabilities.jsonSchema;
  if (aspect === 'streaming') return capabilities.streaming;
  if (aspect === 'image' || aspect === 'image_input') return capabilities.input.includes('image');
  if (aspect === 'audio' || aspect === 'audio_input') return capabilities.input.includes('audio');
  const role = Object.hasOwn(roleAliases, aspect) ? roleAliases[aspect] : undefined; if (role) return capabilities.roles.includes(role);
  const option = Object.hasOwn(optionAliases, aspect) ? optionAliases[aspect] : undefined; if (option) return capabilities.options.includes(option);
  return undefined;
}

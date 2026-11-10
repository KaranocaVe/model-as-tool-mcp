import { createHash, randomUUID } from 'node:crypto';
import { Ajv, type ValidateFunction } from 'ajv';
import { parseAsk, validateRequest } from './config.js';
import { adapters as defaultAdapters } from './providers/index.js';
import { abortable, abortError, Scheduler } from './scheduler.js';
import { detectCapabilities as runCapabilityProbes, type CapabilityDetectionResult } from './capability-probe.js';
import { ModelError, type AppConfig, type AskRequest, type CallContext, type GenerationOptions, type Message, type ModelResponse, type ProviderAdapter, type RequestRecord } from './types.js';

interface Session { id: string; model: string; messages: Message[]; expiresAt: number; tenant: string; busy: boolean }
interface Shared { promise: Promise<ModelResponse>; controller: AbortController; users: number }
interface Counters { requests: number; succeeded: number; failed: number; cacheHits: number; deduplicated: number; inputTokens: number; outputTokens: number; providerCalls: number; providerLatencyMs: number; costs: Record<string, number> }
const copy = <T>(value: T): T => structuredClone(value);
function stable(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable((value as Record<string, unknown>)[key])).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
function sanitized(error: unknown): ModelError {
  if (error instanceof ModelError) return new ModelError(error.code, ({ CANCELLED: 'Request cancelled', TIMEOUT: 'Request timed out', QUEUE_FULL: 'Request queue is full', CIRCUIT_OPEN: 'Model circuit is open', INVALID_RESPONSE: 'Provider output failed validation', STREAM_INTERRUPTED: 'Streaming response was interrupted after output began', UNSUPPORTED_PROVIDER: 'Unsupported provider', UNSUPPORTED_OPTION: 'Requested option is unsupported', UNSUPPORTED_CONTENT: 'Requested content is unsupported', UNSUPPORTED_ROLE: 'Requested role is unsupported' } as Record<string,string>)[error.code] ?? 'Model request failed', error.retryable, error.status, error.retryAfterMs);
  return new ModelError('PROVIDER_ERROR', 'Provider request failed');
}

/** Every call is caller initiated. There are no background probes or implicit model requests. */
export class ModelEngine {
  private config: AppConfig;
  private scheduler: Scheduler;
  private aliases = new Map<string, string>();
  private rr = new Map<string, number>();
  private loads = new Map<string, number>();
  private routeLoads = new Map<string, number>();
  private circuits = new Map<string, { failures: number; until: number; trial: boolean }>();
  private cache = new Map<string, { expires: number; response: ModelResponse }>();
  private inflight = new Map<string, Shared>();
  private sessions = new Map<string, Session>();
  private log: RequestRecord[] = [];
  private counters = new Map<string, Counters>();
  private schema = new Ajv({ strict: false, allErrors: false });
  constructor(config: AppConfig, private adapters: Record<string, ProviderAdapter> = defaultAdapters) {
    this.config = copy(config);
    this.scheduler = new Scheduler(config.policy.concurrency, config.policy.maxQueue, config.policy.requestsPerMinute);
    for (const [id, model] of Object.entries(config.models)) { this.aliases.set(id, id); for (const alias of model.aliases ?? []) this.aliases.set(alias, id); }
  }
  private tenant(context?: CallContext): string { return context?.principal?.tenant ?? 'stdio'; }
  private scope(scope: string, context?: CallContext): void {
    if (context?.principal && !context.principal.scopes.includes('*') && !context.principal.scopes.includes(scope)) throw new ModelError('FORBIDDEN', 'Access denied');
  }
  private resolve(id: string): string { const result = this.aliases.get(id); if (!result) throw new ModelError('UNKNOWN_MODEL', 'Unknown model'); return result; }
  private allowed(id: string, context?: CallContext): boolean {
    return !context?.principal || context.principal.models.some(item => item === '*' || this.aliases.get(item) === id);
  }
  private authorize(id: string, context?: CallContext): void { if (!this.allowed(id, context)) throw new ModelError('FORBIDDEN', 'Access denied'); }
  listModels(context?: CallContext) {
    this.scope('models:read', context);
    return Object.entries(this.config.models).filter(([id]) => this.allowed(id, context)).map(([id, model]) => ({ id, ...copy(model) }));
  }
  private counter(tenant: string, model: string) {
    const key = JSON.stringify([tenant, model]); let value = this.counters.get(key);
    if (!value) { value = { requests: 0, succeeded: 0, failed: 0, cacheHits: 0, deduplicated: 0, inputTokens: 0, outputTokens: 0, providerCalls: 0, providerLatencyMs: 0, costs: {} }; this.counters.set(key, value); }
    return value;
  }
  stats(context?: CallContext) {
    this.scope('stats:read', context);
    const total: Counters = { requests: 0, succeeded: 0, failed: 0, cacheHits: 0, deduplicated: 0, inputTokens: 0, outputTokens: 0, providerCalls: 0, providerLatencyMs: 0, costs: {} };
    for (const [key, counter] of this.counters) { const [tenant, model] = JSON.parse(key) as [string,string]; if (tenant !== this.tenant(context) || !this.allowed(model, context)) continue; for (const field of ['requests','succeeded','failed','cacheHits','deduplicated','inputTokens','outputTokens','providerCalls','providerLatencyMs'] as const) total[field] += counter[field]; for (const [currency, amount] of Object.entries(counter.costs)) total.costs[currency] = (total.costs[currency] ?? 0) + amount; }
    return copy({ ...total, ...(context?.principal ? {} : { active: this.scheduler.active, queued: this.scheduler.queued }) });
  }
  records(context?: CallContext): RequestRecord[] {
    this.scope('records:read', context);
    return copy(this.log.filter(record => record.tenant === this.tenant(context) && this.allowed(record.model, context)));
  }
  private pruneSessions(): void { for (const [id, session] of this.sessions) if (!session.busy && session.expiresAt <= Date.now()) this.sessions.delete(id); }
  createSession(model: string, context?: CallContext) {
    this.scope('sessions:manage', context);
    if (!this.config.policy.sessions.enabled) throw new ModelError('DISABLED', 'Sessions are disabled');
    const id = this.resolve(model); this.authorize(id, context); this.pruneSessions();
    if (this.sessions.size >= this.config.policy.sessions.maxSessions) throw new ModelError('SESSION_LIMIT', 'Session limit reached');
    const session: Session = { id: randomUUID(), model: id, messages: [], expiresAt: Date.now() + this.config.policy.sessions.ttlMs, tenant: this.tenant(context), busy: false };
    this.sessions.set(session.id, session);
    return this.sessionView(session);
  }
  private sessionView(session: Session) { return { id: session.id, model: session.model, messages: copy(session.messages), expiresAt: session.expiresAt }; }
  private session(id: string, context?: CallContext): Session {
    if (!this.config.policy.sessions.enabled) throw new ModelError('DISABLED', 'Sessions are disabled');
    this.pruneSessions();
    const session = this.sessions.get(id);
    if (!session || session.tenant !== this.tenant(context) || session.expiresAt <= Date.now()) throw new ModelError('UNKNOWN_SESSION', 'Unknown session');
    this.authorize(session.model, context);
    return session;
  }
  getSession(id: string, context?: CallContext) { this.scope('sessions:manage', context); return this.sessionView(this.session(id, context)); }
  deleteSession(id: string, context?: CallContext) {
    this.scope('sessions:manage', context); const session = this.session(id, context);
    if (session.busy) throw new ModelError('SESSION_BUSY', 'Session is busy');
    this.sessions.delete(id); return { deleted: true };
  }
  private deadline(timeout: number, signal?: AbortSignal) {
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason instanceof ModelError ? signal.reason : new ModelError('CANCELLED', 'Request cancelled'));
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new ModelError('TIMEOUT', 'Request timed out')), timeout);
    return { signal: controller.signal, dispose: () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); } };
  }
  async ask(input: AskRequest, context?: CallContext): Promise<ModelResponse> { return this.runAsk(input, context, false); }
  async detectCapabilities(model: string, aspects: string[], context?: CallContext): Promise<CapabilityDetectionResult> {
    this.scope('models:probe', context); this.scope('models:ask', context);
    const id = this.resolve(model); this.authorize(id, context);
    return runCapabilityProbes({ ask: (request, probeContext) => this.runAsk(request, probeContext, true) }, id, aspects, { ...context, declared: copy(this.config.models[id]!.capabilities) });
  }
  private async runAsk(input: AskRequest, context?: CallContext, probe = false): Promise<ModelResponse> {
    this.scope('models:ask', context);
    const request = parseAsk(input);
    const preset = request.preset && Object.hasOwn(this.config.presets, request.preset) ? this.config.presets[request.preset] : undefined;
    if (request.preset && !preset) throw new ModelError('UNKNOWN_PRESET', 'Unknown preset');
    let session: Session | undefined;
    if (request.sessionId) { this.scope('sessions:manage', context); session = this.session(request.sessionId, context); }
    const chosen = request.model ?? (request.route ? undefined : preset?.model) ?? session?.model;
    if (request.route && session) throw new ModelError('INVALID_REQUEST', 'Session cannot use a route');
    const route = request.route && Object.hasOwn(this.config.routes, request.route) ? this.config.routes[request.route] : undefined;
    if (request.route && !route) throw new ModelError('UNKNOWN_ROUTE', 'Unknown route');
    if (!chosen && !route) throw new ModelError('INVALID_REQUEST', 'A model or route is required');
    const ids = (route ? route.models : [chosen!]).map(id => this.resolve(id));
    const fallbacks = (request.fallback ?? []).map(id => this.resolve(id));
    const options: GenerationOptions = { ...copy(preset?.options ?? {}), ...copy(request.options ?? {}) };
    const newMessages = copy(request.messages ?? preset?.messages ?? []);
    const messages = [...copy(session?.messages ?? []), ...newMessages];
    if (!messages.length) throw new ModelError('INVALID_REQUEST', 'Messages are required');
    if (session && ids[0] !== session.model) throw new ModelError('INVALID_REQUEST', 'Session model cannot change');
    // Validate every potential destination before issuing even the first request.
    for (const id of new Set([...ids, ...fallbacks])) { this.authorize(id, context); const model = this.effectiveModel(id, probe); validateRequest(model, messages, options); if (request.stream && !model.capabilities.streaming) throw new ModelError('UNSUPPORTED_OPTION', 'Model does not support streaming'); }
    if (session && (messages.length + 1 > this.config.policy.sessions.maxMessages)) throw new ModelError('SESSION_LIMIT', 'Session message limit reached');
    let validateOutput: ValidateFunction | undefined;
    if (options.responseFormat?.type === 'json_schema') {
      try { if (!options.responseFormat.schema) throw new Error(); validateOutput = this.schema.compile(options.responseFormat.schema); } catch { throw new ModelError('INVALID_REQUEST', 'Invalid output JSON schema'); }
    }
    if (session?.busy) throw new ModelError('SESSION_BUSY', 'Session is busy');
    if (session) session.busy = true;
    const deadline = this.deadline(request.timeoutMs ?? this.config.policy.timeoutMs, context?.signal);
    const start = Date.now(); const tenant = this.tenant(context);
    let selected = ids[0]!;
    if (route?.strategy === 'round_robin') { const next = this.rr.get(request.route!) ?? 0; selected = ids[next % ids.length]!; this.rr.set(request.route!, (next + 1) % ids.length); }
    if (route?.strategy === 'least_loaded') selected = ids.reduce((best, id) => (this.routeLoads.get(id) ?? 0) < (this.routeLoads.get(best) ?? 0) ? id : best, ids[0]!);
    this.routeLoads.set(selected, (this.routeLoads.get(selected) ?? 0) + 1);
    const counter = this.counter(tenant, selected); counter.requests++;
    const candidates = [...new Set([selected, ...(route?.fallback ? ids.filter(id => id !== selected) : []), ...fallbacks])];
    let result: ModelResponse | undefined;
    try {
      if (deadline.signal.aborted) throw abortError(deadline.signal);
      const key = createHash('sha256').update(stable({ tenant, models: candidates, messages, options, stream: request.stream ?? false, retry: request.retry ?? this.config.policy.retry })).digest('hex');
      const useCache = (request.cache ?? this.config.policy.cache.enabled) && !request.stream;
      const dedup = (request.deduplicate ?? this.config.policy.deduplicate) && !request.stream;
      for (const [cacheKey, entry] of this.cache) if (entry.expires <= Date.now()) this.cache.delete(cacheKey);
      const cached = useCache ? this.cache.get(key) : undefined;
      if (cached) { result = copy(cached.response); result.meta = { ...result.meta!, cacheHit: true, latencyMs: Date.now() - start, attempts: 0 }; counter.cacheHits++; }
      else {
        const existing = dedup ? this.inflight.get(key) : undefined;
        let shared = existing;
        if (!shared) {
          const controller = new AbortController();
          shared = { controller, users: 0, promise: this.execute(candidates, messages, options, request, controller.signal, tenant, probe, request.stream ? context?.onEvent ?? (() => {}) : undefined) };
          if (dedup) { this.inflight.set(key, shared); const current = shared; void shared.promise.then(() => { if (this.inflight.get(key) === current) this.inflight.delete(key); }, () => { if (this.inflight.get(key) === current) this.inflight.delete(key); }); }
        }
        shared.users++;
        try {
          result = copy(await abortable(shared.promise, deadline.signal));
          if (existing) { result.meta = { ...result.meta!, deduplicated: true }; counter.deduplicated++; }
        } finally { if (--shared.users === 0) { if (this.inflight.get(key) === shared) this.inflight.delete(key); shared.controller.abort(new ModelError('CANCELLED', 'Request cancelled')); } }
        if (deadline.signal.aborted) throw abortError(deadline.signal);
        if (options.responseFormat?.type === 'json' || validateOutput) {
          let parsed: unknown; try { parsed = JSON.parse(result.text); } catch { throw new ModelError('INVALID_RESPONSE', 'Provider output failed validation'); }
          if (validateOutput && !validateOutput(parsed)) throw new ModelError('INVALID_RESPONSE', 'Provider output failed validation');
        }
        if (useCache && this.config.policy.cache.maxEntries > 0) {
          this.cache.delete(key); this.cache.set(key, { expires: Date.now() + this.config.policy.cache.ttlMs, response: copy(result) });
          while (this.cache.size > this.config.policy.cache.maxEntries) this.cache.delete(this.cache.keys().next().value!);
        }
      }
      result.meta = { ...result.meta!, latencyMs: Date.now() - start, ...(request.route ? { route: request.route } : {}), ...(session ? { sessionId: session.id } : {}) };
      if (session) { session.messages = [...messages, { role: 'assistant', content: result.content?.length ? copy(result.content) : result.text }]; session.expiresAt = Date.now() + this.config.policy.sessions.ttlMs; }
      counter.succeeded++;
      this.record(tenant, start, result.model, true, messages, result);
      return copy(result);
    } catch (error) { counter.failed++; const safe = sanitized(error); this.record(tenant, start, selected, false, messages, undefined, safe.code); throw safe; }
    finally { deadline.dispose(); this.routeLoads.set(selected, (this.routeLoads.get(selected) ?? 1) - 1); if (session) session.busy = false; }
  }
  private record(tenant: string, start: number, model: string, success: boolean, messages: Message[], response?: ModelResponse, errorCode?: string): void {
    const policy = this.config.policy.records; if (!policy.enabled || !policy.maxEntries) return;
    this.log.push({ id: randomUUID(), tenant, model, startedAt: new Date(start).toISOString(), latencyMs: Date.now() - start, success, ...(errorCode ? { errorCode } : {}), ...(response?.usage ? { usage: copy(response.usage) } : {}), ...(policy.includeContent ? { messages: copy(messages), ...(response ? { response: copy(response) } : {}) } : {}) });
    while (this.log.length > policy.maxEntries) this.log.shift();
  }
  private effectiveModel(id: string, probe: boolean) {
    const model = copy(this.config.models[id]!);
    if (probe) model.capabilities = { roles: ['system','user','assistant'], input: ['text','image','audio'], output: ['text','image','audio'], streaming: true, json: true, jsonSchema: true, options: ['temperature','topP','maxTokens','stop','seed'] };
    return model;
  }
  private async execute(ids: string[], messages: Message[], options: GenerationOptions, request: AskRequest, signal: AbortSignal, tenant: string, probe: boolean, onEvent?: CallContext['onEvent']): Promise<ModelResponse> {
    const start = Date.now(); let attempts = 0; let last: unknown; let emitted = false;
    const retry = { ...this.config.policy.retry, ...request.retry };
    for (const id of ids) {
      for (let attempt = 0; attempt < retry.maxAttempts; attempt++) {
        if (signal.aborted) throw abortError(signal);
        const release = await this.scheduler.acquire(signal);
        let circuit: { failures: number; until: number; trial: boolean } | undefined; let enteredCircuit = false;
        try {
          const circuitPolicy = this.config.policy.circuit;
          if (circuitPolicy.failures > 0) {
            circuit = this.circuits.get(id) ?? { failures: 0, until: 0, trial: false }; this.circuits.set(id, circuit);
            if (circuit.until > Date.now() || (circuit.until > 0 && circuit.trial)) throw new ModelError('CIRCUIT_OPEN', 'Model circuit is open');
            if (circuit.until) circuit.trial = true;
            enteredCircuit = true;
          }
          const model = this.effectiveModel(id, probe); const provider = this.config.providers[model.provider]!; const adapter = this.adapters[provider.type];
          if (!adapter) throw new ModelError('UNSUPPORTED_PROVIDER', 'Unsupported provider');
          attempts++; this.loads.set(id, (this.loads.get(id) ?? 0) + 1);
          const physicalStart = Date.now(); const counter = this.counter(tenant, id); counter.providerCalls++;
          let response: ModelResponse;
          try { response = await adapter.generate(copy(provider), copy(model), copy(messages), copy(options), { signal, ...(onEvent ? { onEvent: async event => { if (signal.aborted) throw abortError(signal); emitted = true; await onEvent(event); } } : {}) }); if (signal.aborted) throw abortError(signal); }
          finally { this.loads.set(id, (this.loads.get(id) ?? 1) - 1); counter.providerLatencyMs += Date.now() - physicalStart; }
          if (typeof response.text !== 'string') throw new ModelError('INVALID_RESPONSE', 'Provider output failed validation');
          if (circuit) { circuit.failures = 0; circuit.until = 0; circuit.trial = false; }
          const usage = response.usage;
          const cost = model.pricing && usage?.inputTokens !== undefined && usage.outputTokens !== undefined ? { amount: (usage.inputTokens * model.pricing.inputPerMillion + usage.outputTokens * model.pricing.outputPerMillion) / 1_000_000, currency: model.pricing.currency } : undefined;
          counter.inputTokens += usage?.inputTokens ?? 0; counter.outputTokens += usage?.outputTokens ?? 0;
          if (cost) counter.costs[cost.currency] = (counter.costs[cost.currency] ?? 0) + cost.amount;
          return { ...response, model: id, provider: model.provider, meta: { latencyMs: Date.now() - start, attempts, ...(cost ? { cost } : {}) } };
        } catch (error) {
          last = error;
          if (circuit && enteredCircuit) circuit.trial = false;
          if (signal.aborted) throw abortError(signal);
          if (circuit && enteredCircuit && error instanceof ModelError && error.retryable) { circuit.failures++; if (circuit.failures >= this.config.policy.circuit.failures) circuit.until = Date.now() + this.config.policy.circuit.resetMs; }
          if (emitted) throw new ModelError('STREAM_INTERRUPTED', 'Streaming response was interrupted after output began');
          if (!(error instanceof ModelError) || !error.retryable || attempt + 1 >= retry.maxAttempts) break;
        } finally { release(); }
        const delay = Math.min(retry.maxDelayMs, Math.max(last instanceof ModelError ? last.retryAfterMs ?? 0 : 0, retry.baseDelayMs * 2 ** attempt));
        if (delay > 0) await new Promise<void>((resolve, reject) => {
          const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(abortError(signal)); };
          const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, delay);
          signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
        });
      }
    }
    throw last ?? new ModelError('PROVIDER_ERROR', 'Provider request failed');
  }
  async batch(requests: AskRequest[], context?: CallContext, concurrency = this.config.policy.concurrency): Promise<PromiseSettledResult<ModelResponse>[]> {
    if (!Array.isArray(requests) || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 1024) throw new ModelError('INVALID_REQUEST', 'Invalid batch concurrency');
    const results: PromiseSettledResult<ModelResponse>[] = new Array(requests.length); let index = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, requests.length) }, async () => {
      while (index < requests.length) { const current = index++; try { results[current] = { status: 'fulfilled', value: await this.ask(requests[current]!, context) }; } catch (reason) { results[current] = { status: 'rejected', reason }; } }
    }));
    return results;
  }
  async probe(model: string, context?: CallContext) {
    this.scope('models:probe', context); const id = this.resolve(model); this.authorize(id, context);
    const configured = this.config.models[id]!; const provider = this.config.providers[configured.provider]!; const adapter = this.adapters[provider.type];
    if (!adapter?.probe) throw new ModelError('UNSUPPORTED', 'Provider does not support availability probes');
    const deadline = this.deadline(this.config.policy.timeoutMs, context?.signal);
    try { const release = await this.scheduler.acquire(deadline.signal); const physical = Promise.resolve().then(() => adapter.probe!(copy(provider), copy(configured), { signal: deadline.signal })).finally(release); return await abortable(physical, deadline.signal); }
    catch (error) { throw sanitized(error); } finally { deadline.dispose(); }
  }
}

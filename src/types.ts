export type ProviderKind = 'openai' | 'anthropic' | 'gemini';
export type Role = 'system' | 'user' | 'assistant';
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; data?: string; url?: string; mimeType: string }
  | { type: 'audio'; data: string; mimeType: string };
export interface Message { role: Role; content: string | ContentPart[] }
export interface GenerationOptions {
  temperature?: number; topP?: number; maxTokens?: number; stop?: string[]; seed?: number;
  responseFormat?: { type: 'text' | 'json' | 'json_schema'; schema?: Record<string, unknown>; name?: string };
  modalities?: ('text' | 'audio' | 'image')[];
  providerOptions?: Record<string, unknown>;
}
export interface Capabilities {
  roles: Role[]; input: ('text' | 'image' | 'audio')[]; output: ('text' | 'image' | 'audio')[];
  streaming: boolean; json: boolean; jsonSchema: boolean;
  options: ('temperature' | 'topP' | 'maxTokens' | 'stop' | 'seed')[];
}
export interface ProviderConfig {
  type: ProviderKind; baseUrl: string; apiKeyEnv?: string; headers?: Record<string, string>;
}
export interface ModelConfig {
  provider: string; model: string; aliases?: string[]; capabilities: Capabilities;
  pricing?: { inputPerMillion: number; outputPerMillion: number; currency: string };
}
export interface RetryPolicy { maxAttempts: number; baseDelayMs: number; maxDelayMs: number }
export interface RouteConfig { models: string[]; strategy: 'round_robin' | 'least_loaded'; fallback: boolean }
export interface Preset { model?: string; messages?: Message[]; options?: GenerationOptions }
export interface TenantConfig { apiKeyEnv: string; models: string[]; scopes?: string[] }
export interface AppConfig {
  providers: Record<string, ProviderConfig>; models: Record<string, ModelConfig>;
  routes: Record<string, RouteConfig>; presets: Record<string, Preset>;
  policy: { concurrency: number; maxQueue: number; timeoutMs: number; requestsPerMinute: number;
    retry: RetryPolicy; circuit: { failures: number; resetMs: number };
    cache: { enabled: boolean; ttlMs: number; maxEntries: number }; deduplicate: boolean;
    records: { enabled: boolean; includeContent: boolean; maxEntries: number };
    sessions: { enabled: boolean; ttlMs: number; maxSessions: number; maxMessages: number };
  };
  http: { host: string; port: number; path: string; allowedOrigins: string[]; tenants: Record<string, TenantConfig>; maxBodyBytes: number };
}
export interface AskRequest {
  model?: string; messages?: Message[]; options?: GenerationOptions; preset?: string;
  sessionId?: string; timeoutMs?: number; stream?: boolean; cache?: boolean; deduplicate?: boolean;
  retry?: Partial<RetryPolicy>; fallback?: string[]; route?: string;
}
export interface Usage { inputTokens?: number; outputTokens?: number; totalTokens?: number; cachedInputTokens?: number }
export interface ModelResponse {
  model: string; provider: string; providerModel?: string; text: string; content?: ContentPart[];
  usage?: Usage; finishReason?: string; requestId?: string;
  meta?: { latencyMs: number; attempts: number; cacheHit?: boolean; deduplicated?: boolean;
    cost?: { amount: number; currency: string }; route?: string; sessionId?: string };
}
export interface StreamEvent { type: 'text' | 'content'; text?: string; content?: ContentPart }
export interface AdapterContext { signal: AbortSignal; onEvent?: (event: StreamEvent) => void | Promise<void> }
export interface ProviderAdapter {
  generate(provider: ProviderConfig, model: ModelConfig, messages: Message[], options: GenerationOptions, context: AdapterContext): Promise<ModelResponse>;
  probe?(provider: ProviderConfig, model: ModelConfig, context: AdapterContext): Promise<{ available: boolean; details?: string }>;
}
export interface Principal { tenant: string; models: string[]; scopes: string[] }
export interface CallContext { principal?: Principal; signal?: AbortSignal; onEvent?: (event: StreamEvent) => void | Promise<void> }
export interface RequestRecord { id: string; tenant: string; model: string; startedAt: string; latencyMs: number; success: boolean; errorCode?: string; usage?: Usage; messages?: Message[]; response?: ModelResponse }
export class ModelError extends Error {
  constructor(public code: string, message: string, public retryable = false, public status?: number, public retryAfterMs?: number) { super(message); this.name = 'ModelError'; }
}

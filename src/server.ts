import { createServer as nodeCreateServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { AppConfig, AskRequest, CallContext, ContentPart, ModelResponse, Principal } from './types.js';
import { ModelError } from './types.js';
import { ModelEngine } from './engine.js';

export interface ServerOptions {
  config: AppConfig;
  engine: ModelEngine;
  principal?: Principal;
}

export interface RunningServer {
  close(): Promise<void>;
  address?: () => ReturnType<import('node:http').Server['address']>;
}

const anyObject = z.record(z.string(), z.unknown());
const messageSchema = z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.union([z.string(), z.array(z.unknown())]) }).strict();
const askSchema = {
  model: z.string().optional(),
  messages: z.array(messageSchema).optional(),
  options: anyObject.optional(),
  preset: z.string().optional(),
  sessionId: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
  stream: z.boolean().optional(),
  cache: z.boolean().optional(),
  deduplicate: z.boolean().optional(),
  retry: anyObject.optional(),
  fallback: z.array(z.string()).optional(),
  route: z.string().optional()
};

// PTC clients use outputSchema as the structured result contract. PTC itself
// controls whether results stay in its runtime; content remains for clients
// that still read content blocks.
const usageOutputSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
  cachedInputTokens: z.number().int().nonnegative().optional()
});
const contentOutputSchema = z.union([
  z.object({ type: z.literal('text'), text: z.string() }).strict(),
  z.object({ type: z.literal('image'), data: z.string(), mimeType: z.string() }).strict(),
  z.object({ type: z.literal('image'), url: z.string(), mimeType: z.string() }).strict(),
  z.object({ type: z.literal('audio'), data: z.string(), mimeType: z.string() }).strict()
]);
const modelResponseOutputSchema = z.object({
  model: z.string(),
  provider: z.string(),
  providerModel: z.string().optional(),
  text: z.string(),
  content: z.array(contentOutputSchema).optional(),
  usage: usageOutputSchema.optional(),
  finishReason: z.string().optional(),
  requestId: z.string().optional(),
  meta: z.object({
    latencyMs: z.number().nonnegative(),
    attempts: z.number().int().nonnegative(),
    cacheHit: z.boolean().optional(),
    deduplicated: z.boolean().optional(),
    cost: z.object({ amount: z.number(), currency: z.string() }).optional(),
    route: z.string().optional(),
    sessionId: z.string().optional()
  }).optional()
});
const capabilitiesOutputSchema = z.object({
  roles: z.array(z.enum(['system', 'user', 'assistant'])),
  input: z.array(z.enum(['text', 'image', 'audio'])),
  output: z.array(z.enum(['text', 'image', 'audio'])),
  streaming: z.boolean(),
  json: z.boolean(),
  jsonSchema: z.boolean(),
  options: z.array(z.enum(['temperature', 'topP', 'maxTokens', 'stop', 'seed']))
});
const modelOutputSchema = z.object({
  id: z.string(),
  provider: z.string(),
  model: z.string(),
  aliases: z.array(z.string()).optional(),
  capabilities: capabilitiesOutputSchema,
  pricing: z.object({ inputPerMillion: z.number(), outputPerMillion: z.number(), currency: z.string() }).optional()
});
const listModelsOutputSchema = z.object({ models: z.array(modelOutputSchema) });
const batchResponseOutputSchema = z.union([
  z.object({ status: z.literal('fulfilled'), value: modelResponseOutputSchema }),
  z.object({ status: z.literal('rejected'), reason: z.object({ code: z.string(), message: z.string(), retryable: z.boolean(), status: z.number().optional(), retryAfterMs: z.number().optional() }) })
]);
const batchOutputSchema = z.object({ responses: z.array(batchResponseOutputSchema) });
const probeOutputSchema = z.object({ available: z.boolean(), details: z.string().optional() });
const capabilityDetectionOutputSchema = z.object({
  model: z.string(),
  requested: z.array(z.string()),
  results: z.array(z.record(z.string(), z.unknown()))
});
const sessionOutputSchema = z.object({ id: z.string(), model: z.string(), messages: z.array(messageSchema), expiresAt: z.number() });
const deletedSessionOutputSchema = z.object({ deleted: z.boolean() });
const statsOutputSchema = z.object({
  requests: z.number().int().nonnegative(),
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  cacheHits: z.number().int().nonnegative(),
  deduplicated: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  providerCalls: z.number().int().nonnegative(),
  providerLatencyMs: z.number().nonnegative(),
  costs: z.record(z.string(), z.number()),
  active: z.number().int().nonnegative().optional(),
  queued: z.number().int().nonnegative().optional()
});
const recordsOutputSchema = z.object({ records: z.array(z.record(z.string(), z.unknown())) });

function allPrincipal(config: AppConfig): Principal {
  return { tenant: 'stdio', models: Object.keys(config.models), scopes: ['models:read', 'models:ask', 'models:probe', 'sessions:manage', 'stats:read', 'records:read'] };
}

function hasScope(principal: Principal, scope: string): boolean {
  return principal.scopes.includes('*') || principal.scopes.includes(scope);
}

function modelAllowed(config: AppConfig, principal: Principal, model: string | undefined): boolean {
  if (!model || principal.models.includes('*') || principal.models.includes(model)) return true;
  const canonical = Object.entries(config.models).find(([id, value]) => id === model || value.aliases?.includes(model))?.[0];
  if (!canonical) return false;
  return principal.models.some(item => item === canonical || config.models[canonical]?.aliases?.includes(item));
}

function ensureAccess(config: AppConfig, principal: Principal, scope: string, model?: string): void {
  if (!hasScope(principal, scope)) throw new ModelError('forbidden', 'The caller is not authorized for this operation.', false, 403);
  if (!modelAllowed(config, principal, model)) throw new ModelError('forbidden', 'The caller is not authorized for this model.', false, 403);
}

function responseResult(response: ModelResponse): CallToolResult {
  const content: CallToolResult['content'] = [];
  const textParts = (response.content ?? []).filter((part): part is Extract<ContentPart, { type: 'text' }> => part.type === 'text');
  const containsResponseText = textParts.some(part => part.text === response.text) || (textParts.length > 1 && textParts.map(part => part.text).join('') === response.text);
  if (response.text && !containsResponseText) content.push({ type: 'text', text: response.text });
  for (const part of response.content ?? []) {
    if (part.type === 'text') content.push({ type: 'text', text: part.text });
    else if (part.data) content.push({ type: part.type, data: part.data, mimeType: part.mimeType });
    else content.push({ type: 'text', text: `[${part.type} content unavailable]` });
  }
  if (content.length === 0) content.push({ type: 'text', text: '' });
  return { content, structuredContent: response as unknown as Record<string, unknown> };
}

function errorResult(error: unknown): CallToolResult {
  const e = error instanceof ModelError ? error : new ModelError('internal_error', 'The request failed.');
  return {
    isError: true,
    content: [{ type: 'text', text: e.message }]
  };
}
function errorPayload(error: unknown): Record<string, unknown> {
  const e = error instanceof ModelError ? error : new ModelError('internal_error', 'The request failed.');
  return { code: e.code, message: e.message, retryable: e.retryable, ...(e.status !== undefined ? { status: e.status } : {}), ...(e.retryAfterMs !== undefined ? { retryAfterMs: e.retryAfterMs } : {}) };
}

function toolContext(extra: { signal: AbortSignal; _meta?: Record<string, unknown>; sendNotification: (notification: any) => Promise<void> }, principal: Principal): CallContext {
  let progress = 0;
  const token = extra._meta?.progressToken;
  const onEvent = token === undefined ? undefined : async (event: { type: string; text?: string; content?: ContentPart }) => {
    progress += 1;
    await extra.sendNotification({ method: 'notifications/progress', params: {
      progressToken: token as string | number,
      progress,
      message: event.text ?? (event.content ? `[${event.content.type}]` : event.type)
    } });
  };
  return { principal, signal: extra.signal, onEvent };
}

function registerTools(server: McpServer, engine: ModelEngine, config: AppConfig, defaultPrincipal?: Principal): void {
  const principalFor = (extra: { authInfo?: { extra?: Record<string, unknown> }; signal: AbortSignal; _meta?: Record<string, unknown>; sendNotification: (notification: any) => Promise<void> }): Principal => {
    // HTTP authentication is resolved before the server is created. Keep authInfo as a narrow fallback.
    return defaultPrincipal ?? allPrincipal(config);
  };
  const handler = async (fn: () => Promise<CallToolResult> | CallToolResult): Promise<CallToolResult> => {
    try { return await fn(); } catch (error) { return errorResult(error); }
  };

  const askToolSchema = z.object(askSchema).strict();
  server.registerTool('ask_model', { description: 'Run one model inference request. Use PTC for bounded workflows where code will predictably transform or write substantial model output; use a direct call for short, advisory, interactive, or host-judgment responses.', inputSchema: askToolSchema, outputSchema: modelResponseOutputSchema }, async (args, extra) => handler(async () => {
    const principal = principalFor(extra);
    ensureAccess(config, principal, 'models:ask', args.model);
    const context = toolContext(extra, principal);
    const response = await engine.ask(args as AskRequest, context);
    return responseResult(response);
  }));

  server.registerTool('list_models', { description: 'List configured models and their capabilities.', inputSchema: {}, outputSchema: listModelsOutputSchema }, async (_args, extra) => handler(async () => {
    const principal = principalFor(extra);
    ensureAccess(config, principal, 'models:read');
    const models = engine.listModels({ principal });
    return { content: [{ type: 'text', text: JSON.stringify(models) }], structuredContent: { models } };
  }));

  server.registerTool('batch_ask', { description: 'Run multiple inference requests.', inputSchema: { requests: z.array(askToolSchema), concurrency: z.number().int().positive().optional() }, outputSchema: batchOutputSchema }, async (args, extra) => handler(async () => {
    const principal = principalFor(extra);
    ensureAccess(config, principal, 'models:ask');
    for (const req of args.requests) ensureAccess(config, principal, 'models:ask', req.model);
    const settled = await engine.batch(args.requests as AskRequest[], toolContext(extra, principal), args.concurrency);
    const responses = settled.map(result => result.status === 'rejected' ? { status: 'rejected' as const, reason: errorPayload(result.reason) } : result);
    return { content: [{ type: 'text', text: JSON.stringify(responses) }], structuredContent: { responses } };
  }));

  server.registerTool('probe_model', { description: 'Check model/provider availability.', inputSchema: { model: z.string() }, outputSchema: probeOutputSchema }, async (args, extra) => handler(async () => {
    const principal = principalFor(extra);
    ensureAccess(config, principal, 'models:probe', args.model);
    const result = await engine.probe(args.model, toolContext(extra, principal));
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result as Record<string, unknown> };
  }));

  const detectCapabilitiesSchema = z.object({ model: z.string().min(1), aspects: z.array(z.string().min(1).max(128)).min(1).max(32) }).strict();
  server.registerTool('detect_capabilities', {
    description: 'Run explicitly requested live capability probes for a model.',
    inputSchema: detectCapabilitiesSchema,
    outputSchema: capabilityDetectionOutputSchema
  }, async (args, extra) => handler(async () => {
    const principal = principalFor(extra);
    ensureAccess(config, principal, 'models:probe', args.model);
    ensureAccess(config, principal, 'models:ask', args.model);
    const result = await engine.detectCapabilities(args.model, args.aspects, toolContext(extra, principal));
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result as unknown as Record<string, unknown> };
  }));

  server.registerTool('create_session', { description: 'Create a model conversation session.', inputSchema: { model: z.string() }, outputSchema: sessionOutputSchema }, async (args, extra) => handler(async () => {
    const principal = principalFor(extra);
    ensureAccess(config, principal, 'sessions:manage', args.model);
    const session = await engine.createSession(args.model, { principal, signal: extra.signal });
    return { content: [{ type: 'text', text: JSON.stringify(session) }], structuredContent: session as unknown as Record<string, unknown> };
  }));
  server.registerTool('get_session', { description: 'Get a session snapshot.', inputSchema: { id: z.string() }, outputSchema: sessionOutputSchema }, async (args, extra) => handler(async () => {
    const principal = principalFor(extra);
    ensureAccess(config, principal, 'sessions:manage');
    const session = await engine.getSession(args.id, { principal, signal: extra.signal });
    return { content: [{ type: 'text', text: JSON.stringify(session) }], structuredContent: session as unknown as Record<string, unknown> };
  }));
  server.registerTool('delete_session', { description: 'Delete a model conversation session.', inputSchema: { id: z.string() }, outputSchema: deletedSessionOutputSchema }, async (args, extra) => handler(async () => {
    const principal = principalFor(extra);
    ensureAccess(config, principal, 'sessions:manage');
    const result = await engine.deleteSession(args.id, { principal, signal: extra.signal });
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result as Record<string, unknown> };
  }));

  server.registerTool('stats', { description: 'Read engine statistics.', inputSchema: {}, outputSchema: statsOutputSchema }, async (_args, extra) => handler(async () => {
    const principal = principalFor(extra);
    ensureAccess(config, principal, 'stats:read');
    const result = engine.stats({ principal });
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result as Record<string, unknown> };
  }));
  server.registerTool('records', { description: 'Read request records according to configured retention policy.', inputSchema: {}, outputSchema: recordsOutputSchema }, async (_args, extra) => handler(async () => {
    const principal = principalFor(extra);
    ensureAccess(config, principal, 'records:read');
    const result = engine.records({ principal });
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: { records: result } };
  }));
}

export function createMcpServer(options: ServerOptions): McpServer {
  const server = new McpServer({ name: 'model-as-tool-mcp', version: '0.1.0' }, {
    capabilities: { tools: { listChanged: false } },
    instructions: 'Provider-neutral model inference. Models never receive tools. Use direct calls for short, advisory, interactive, or host-judgment responses. Use programmatic tool calling only for bounded workflows where predictable code will transform or write substantial model output, and consume the structuredContent result there.'
  });
  registerTools(server, options.engine, options.config, options.principal);
  return server;
}

export async function startStdio(options: ServerOptions): Promise<RunningServer> {
  const transport = new StdioServerTransport();
  const server = createMcpServer({ ...options, principal: options.principal ?? allPrincipal(options.config) });
  await server.connect(transport);
  return { close: () => server.close() };
}

function isLoopback(host: string): boolean { return host === '127.0.0.1' || host === '::1' || host === 'localhost'; }
function originAllowed(origin: string | undefined, allowed: string[]): boolean { return !origin || allowed.includes('*') || allowed.includes(origin); }
function hostAllowed(hostHeader: string | undefined, configured: string, allowedOrigins: string[]): boolean {
  if (!hostHeader) return false;
  const host = (hostHeader.startsWith('[') ? hostHeader.slice(1, hostHeader.indexOf(']')) : hostHeader.split(':')[0])?.toLowerCase();
  if (!host) return false;
  if (host === configured.toLowerCase() || (isLoopback(configured) && isLoopback(host))) return true;
  if (configured === '0.0.0.0' || configured === '::') {
    return isLoopback(host) || allowedOrigins.some(origin => { try { return new URL(origin).hostname.toLowerCase() === host; } catch { return false; } });
  }
  return false;
}
function authenticate(req: IncomingMessage, config: AppConfig): Principal | undefined {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return undefined;
  const token = Buffer.from(header.slice(7));
  for (const [tenant, tenantConfig] of Object.entries(config.http.tenants)) {
    const expectedValue = process.env[tenantConfig.apiKeyEnv];
    if (!expectedValue) continue;
    const expected = Buffer.from(expectedValue);
    if (token.length === expected.length && timingSafeEqual(token, expected)) {
      return { tenant, models: tenantConfig.models, scopes: tenantConfig.scopes ?? [] };
    }
  }
  return undefined;
}
function hasAuthorization(req: IncomingMessage): boolean { return typeof req.headers.authorization === 'string'; }
function rejectDuplicateTenantTokens(config: AppConfig): void {
  const seen = new Set<string>();
  for (const tenantConfig of Object.values(config.http.tenants)) {
    const value = process.env[tenantConfig.apiKeyEnv];
    if (!value) continue;
    if (seen.has(value)) throw new Error('Duplicate tenant credentials are not allowed.');
    seen.add(value);
  }
}
async function readBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = []; let total = 0;
  for await (const chunk of req) { const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); total += b.length; if (total > maxBytes) throw new ModelError('body_too_large', 'Request body exceeds the configured limit.', false, 413); chunks.push(b); }
  if (!Buffer.concat(chunks).length) return undefined;
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ModelError('invalid_json', 'Request body must be valid JSON.', false, 400); }
}
function sendError(res: ServerResponse, status: number, message: string): void { if (!res.headersSent) { res.statusCode = status; res.setHeader('content-type', 'application/json'); } res.end(JSON.stringify({ error: message })); }

export async function startHttp(options: ServerOptions & { host?: string; port?: number }): Promise<RunningServer & { port: number }> {
  const { config } = options;
  const host = options.host ?? config.http.host;
  const port = options.port ?? config.http.port;
  if (!isLoopback(host) && Object.keys(config.http.tenants).length === 0) throw new Error('Refusing unauthenticated non-loopback HTTP listener.');
  rejectDuplicateTenantTokens(config);
  const httpServer = nodeCreateServer(async (req, res) => {
    try {
      if (req.url?.split('?')[0] !== config.http.path) return sendError(res, 404, 'Not found.');
      if (!hostAllowed(req.headers.host, host, config.http.allowedOrigins)) return sendError(res, 421, 'Invalid host.');
      if (!originAllowed(req.headers.origin, config.http.allowedOrigins)) return sendError(res, 403, 'Origin not allowed.');
      const principal = authenticate(req, config);
      const tenantAuthConfigured = Object.keys(config.http.tenants).length > 0;
      if ((tenantAuthConfigured || hasAuthorization(req)) && !principal) return sendError(res, 401, 'Authorization required.');
      const declaredLength = req.headers['content-length'];
      if (declaredLength !== undefined && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > config.http.maxBodyBytes)) return sendError(res, 413, 'Request body exceeds the configured limit.');
      const body = req.method === 'POST' ? await readBody(req, config.http.maxBodyBytes) : undefined;
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const server = createMcpServer({ ...options, principal: principal ?? allPrincipal(config) });
      await server.connect(transport);
      res.once('close', () => { void server.close().catch(() => undefined); });
      await transport.handleRequest(req, res, body);
    } catch (error) {
      const e = error instanceof ModelError ? error : new ModelError('internal_error', 'Request failed.');
      sendError(res, e.status ?? 500, e.message);
    }
  });
  await new Promise<void>((resolve, reject) => { httpServer.once('error', reject); httpServer.listen(port, host, () => resolve()); });
  const address = httpServer.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  return { port: actualPort, address: () => httpServer.address(), close: () => new Promise<void>((resolve, reject) => httpServer.close(err => err ? reject(err) : resolve())) };
}

export async function startServer(options: ServerOptions & { transport?: 'stdio' | 'http'; host?: string; port?: number }): Promise<RunningServer & { port?: number }> {
  return options.transport === 'http' ? startHttp(options) : startStdio(options);
}

/** Backwards-compatible concise alias for library consumers. */
export const createServer = createMcpServer;

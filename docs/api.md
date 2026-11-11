# MCP API

The server exposes model invocation and operational tools through MCP. Tool names use snake case. All inputs are JSON objects; all outputs are JSON values or structured MCP errors.

## `ask_model`

The primary call performs one explicit model request:

```json
{
  "model": "openai/gpt-4o-mini",
  "messages": [
    { "role": "system", "content": "You edit technical prose." },
    { "role": "user", "content": "Make this paragraph shorter." }
  ],
  "options": {
    "temperature": 0.2,
    "maxTokens": 300
  }
}
```

`model` may be a configured ID or alias. `messages` is an ordered list of `system`, `user`, and `assistant` messages. A message's `content` is a string or an array of text, image, and audio parts. `options` supports the provider-neutral generation controls in [types.ts](../src/types.ts): `temperature`, `topP`, `maxTokens`, `stop`, `seed`, `responseFormat`, `modalities`, and `providerOptions`.

Optional request controls are:

| Field | Effect |
| --- | --- |
| `preset` | Selects configured message, model, and option defaults. |
| `sessionId` | Uses bounded server-side session history when sessions are enabled. |
| `timeoutMs` | Overrides the policy deadline within configured limits. |
| `stream` | Emits `text` or `content` events when the model declares streaming. |
| `cache` | Enables a cache lookup/store for this request when policy cache is enabled. |
| `deduplicate` | Joins an equivalent in-flight request when deduplication is enabled. |
| `retry` | Overrides bounded retry fields for this request. |
| `fallback` | Supplies an explicit ordered fallback model list. |
| `route` | Selects a configured route. |

### Structured and multimodal requests

Use `responseFormat: { "type": "json" }` for providers with a native JSON mode or `responseFormat: { "type": "json_schema", "name": "Result", "schema": { ... } }` for schema validation. Anthropic structured output is schema-based, so use `json_schema` there. The selected model must declare the requested mode; the runtime parses JSON and rejects invalid or schema-mismatched output. `text` is the default response format.

Image input uses one content part with either a URL or base64 `data` and a required `mimeType`; audio input uses base64 `data` and a required `mimeType`. `modalities` requests output modalities declared by the model. Provider-specific values belong in `providerOptions` and remain subject to adapter validation.

A successful response has the normalized shape:

```json
{
  "model": "openai/gpt-4o-mini",
  "provider": "openai-main",
  "providerModel": "gpt-4o-mini",
  "text": "A shorter paragraph.",
  "usage": { "inputTokens": 34, "outputTokens": 8, "totalTokens": 42 },
  "finishReason": "stop",
  "requestId": "provider-request-id",
  "meta": {
    "latencyMs": 421,
    "attempts": 1,
    "cacheHit": false,
    "deduplicated": false,
    "route": "writers",
    "sessionId": "session-1"
  }
}
```

Fields are omitted when a provider does not supply the corresponding value. The service does not estimate token counts, cost, or finish reasons. A stream delivers events through the MCP transport and finishes with the same normalized metadata when supported by the transport.

For MCP clients, the normalized value is available as `structuredContent` under the declared `outputSchema`. A compatibility `content` rendering is also returned for clients that still read content blocks. A direct host call can therefore see the same text in both representations; a PTC program should read `structuredContent`, pass or write the needed fields, and return a compact result instead of forwarding the full response.

### Programmatic tool calling

Use PTC only when the workflow is bounded and code can handle a substantial intermediate response predictably, such as extracting selected fields, aggregating several outputs, or passing generated text to a file or another tool. Keep the complete response inside that program and return only the data needed by the host, such as a path, status, or short summary. This avoids sending the full intermediate text back for the host to repeat.

Use a direct `ask_model` call for ordinary questions, short copy, concise adviser responses, interactive discussion, or whenever the host must read and evaluate the complete answer. `outputSchema` exposes the response shape to compatible clients; it does not suppress fields from the host transcript. PTC changes where the result is processed, not what the MCP server stores or conceals.

## `list_models`

Returns configured public model IDs, aliases, provider information, and declared capabilities. It does not enumerate a provider's entire catalog. Use it before selecting a model when the host does not already know the configuration.

## `batch_ask`

Submits multiple independent `ask_model` requests through one MCP call. Each item keeps its own model, messages, options, and optional controls. The runtime applies the same concurrency, timeout, retry, fallback, and authorization policy as individual calls. Results retain input order and identify per-item errors; one failed item does not turn another item into a hidden retry or a second agent.

Batch support is a throughput convenience. It does not imply provider-side batching, shared context, or voting across models.

## `probe_model`

Probes a configured provider/model pair when its adapter implements availability probing. A probe reports availability and optional provider details; it does not generate model output. Probing can consume provider quota and should be used deliberately.

## Explicit capability detection (library API)

The library export `detectCapabilities(engine, model, probes, context?)` runs only the named, bounded live checks and returns `supported`, `unsupported`, or `inconclusive` results with a rationale code. Recognized probes include text, JSON, JSON Schema, streaming, image/audio input, roles, and common generation options. It disables cache and deduplication and uses one attempt per probe. Authentication, rate-limit, network, and malformed-request failures are inconclusive; only an explicit unsupported error marks a capability unsupported.

This API never mutates `ModelConfig.capabilities` and does not run automatically. The MCP `detect_capabilities` tool exposes the same operation with `{ model, aspects }`; it requires both `models:probe` and `models:ask`, performs one inference per named aspect, and accepts at most 32 unique aspects. Probes may consume provider quota or incur charges and show protocol behavior, not semantic quality or factual reliability. `probe_model` remains the lightweight MCP availability check that performs provider metadata probing when the adapter supports it.

## Sessions

`create_session`, `get_session`, and `delete_session` manage explicitly named server-side sessions when `policy.sessions.enabled` is true:

- `create_session` creates a bounded session and returns its ID, model, empty message list, and expiry time.
- `get_session` returns session metadata and stored messages according to the configured retention policy.
- `delete_session` removes a session and its stored messages.

A session is never created implicitly by `ask_model`. The host must pass `sessionId`, and the session's tenant and model scopes still apply.

## Operations

- `stats` returns process counters such as in-flight work, queue depth, request counts, and cache/deduplication counters. It does not include prompt or response bodies.
- `records` returns bounded request records when recording is enabled. Content fields appear only when `policy.records.includeContent` is true and the caller is authorized. Records are for diagnostics, not an audit log with indefinite retention.

## Errors

Errors are structured MCP errors with a stable `ModelError.code` where possible. Typical classes include invalid request, unknown model or preset, capability mismatch, authentication failure, rate limit, timeout, provider failure, queue full, circuit open, and unauthorized tenant/model access. Retry only when the error is marked retryable or the provider returned a retryable status.

The service never converts a provider error into a successful natural-language answer. It also never includes API key values in errors.

## Authorization

Stdio runs with the local process principal and all service scopes. HTTP tenants are authenticated with a bearer token whose value comes from the tenant's configured environment variable. A tenant with omitted `scopes` has no permissions; grant only the scopes it needs:

| Scope | Tools |
| --- | --- |
| `models:read` | `list_models` |
| `models:ask` | `ask_model`, `batch_ask` |
| `models:probe` | `probe_model` |
| `models:probe` + `models:ask` | `detect_capabilities` |
| `sessions:manage` | `create_session`, `get_session`, `delete_session` |
| `stats:read` | `stats` |
| `records:read` | `records` |

Model IDs are checked against the tenant's `models` allowlist, including aliases resolved to their canonical model. HTTP requests also enforce the configured path, host, origin allowlist, body limit, and loopback or authentication rule.

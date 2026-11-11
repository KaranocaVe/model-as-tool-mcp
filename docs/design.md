# Design and implementation matrix

This document turns the product design into reviewable repository requirements. The feature list is deliberately explicit: an implementation may add capability behind configuration or request flags, but it must not change the default one-call model-as-tool behavior.

## Invariants

1. The host MCP client is the only orchestrator. A provider adapter performs an inference HTTP request and never receives MCP tools, shell access, files, or browser access.
2. A request forwards only its explicit `messages` and options. The service does not append hidden prompts, host conversation, or workspace content.
3. A model is selected by its configured ID, alias, preset, or explicitly configured route. There is no implicit model choice.
4. Provider differences are represented by declared capabilities and stable errors. Unsupported roles, content parts, options, or output modes fail clearly.
5. API keys come from environment variables named in configuration. Prompt and response bodies are excluded from records by default.
6. The default request is stateless and maps to one provider inference call. Session, retry, fallback, caching, deduplication, routing, records, and HTTP authentication are opt-in policy features.

## Feature matrix

The evidence column points to the current implementation and tests. Entries marked as not covered identify gaps that should be closed before a release.

| Capability | Contract surface | Default | Evidence |
| --- | --- | --- | --- |
| Explicit single-model inference | `ask_model({ model, messages, options? })` | Enabled | `src/engine.ts`; `test/engine.test.ts` |
| Model discovery | `list_models` | Enabled | `src/engine.ts`; `src/server.ts`; `test/server.test.ts` |
| Availability probe | `probe_model({ model })` | Explicit opt-in call | `src/engine.ts`; `src/server.ts`; `src/providers/common.ts`; `test/providers.test.ts` |
| OpenAI-compatible provider | `ProviderConfig.type = openai` | Enabled when configured | `src/providers/`; `test/providers.test.ts`; `test/audit-providers.test.ts` |
| Anthropic provider | `ProviderConfig.type = anthropic` | Enabled when configured | `src/providers/`; `test/providers.test.ts`; `test/audit-providers.test.ts` |
| Gemini provider | `ProviderConfig.type = gemini` | Enabled when configured | `src/providers/`; `test/providers.test.ts`; `test/audit-providers.test.ts` |
| Local OpenAI-compatible gateway | `type: openai`, local `baseUrl` | Opt-in provider entry | `examples/local-gateway.json`; `docs/live-testing.md`; `test/live.test.ts` (opt-in) |
| Explicit text messages and roles | `Message`, `Role` | Enabled | `src/config.ts`; `test/audit-config.test.ts` |
| Streaming and cancellation | `AskRequest.stream`, `AdapterContext.signal/onEvent` | Disabled unless requested and declared | `src/scheduler.ts`; `test/engine.test.ts`; `test/audit-sol.test.ts` |
| Structured JSON output | `GenerationOptions.responseFormat` | Disabled unless requested and declared | `src/engine.ts`; `test/engine.test.ts` |
| JSON Schema output | `responseFormat.type = json_schema` | Disabled unless requested and declared | `src/engine.ts`; `test/engine.test.ts`; `test/audit-config.test.ts` |
| Multimodal input | `ContentPart` image/audio | Disabled unless model declares input | `src/providers/`; `test/audit-providers.test.ts` |
| Multimodal output | `ContentPart`, `GenerationOptions.modalities` | Disabled unless model declares output | `src/providers/`; `test/providers.test.ts`; `test/audit-providers.test.ts` |
| Provider-specific options | `GenerationOptions.providerOptions` | Empty | `src/providers/openai.ts`; `src/providers/anthropic.ts`; `src/providers/gemini.ts`; `test/providers.test.ts` |
| Capability declaration | `ModelConfig.capabilities` | Required per model | `src/config.ts`; `test/audit-config.test.ts` |
| Capability probing | `probe_model`, `ProviderAdapter.probe` | Explicit availability check | `src/providers/common.ts`; `test/providers.test.ts`; `test/capability-probe.test.ts` |
| Explicit capability detection | `detect_capabilities({ model, aspects })`, `detectCapabilities(engine, model, probes)` | Opt-in; max 32 named probes; never automatic | `src/capability-probe.ts`; `src/server.ts`; `test/capability-probe.test.ts` |
| Sessions | `create_session`, `get_session`, `delete_session`, `sessionId`, `policy.sessions` | Disabled | `src/engine.ts`; `test/engine.test.ts` |
| Concurrency and queueing | `policy.concurrency`, `maxQueue` | Parser default applies; bounded | `src/scheduler.ts`; `test/engine.test.ts`; `test/audit-config.test.ts` |
| Per-request timeout | `AskRequest.timeoutMs`, `policy.timeoutMs` | Policy timeout | `src/engine.ts`; `test/engine.test.ts`; `test/audit-config.test.ts` |
| Batch requests | `batch_ask({ requests, concurrency? })` | Explicit opt-in call | `src/engine.ts`; `src/server.ts`; `test/server.test.ts` |
| Retry | `AskRequest.retry`, `policy.retry` | Policy default; bounded | `src/engine.ts`; `test/engine.test.ts` |
| Rate limiting | `policy.requestsPerMinute` | Policy default | `src/scheduler.ts`; `test/audit-config.test.ts` |
| Circuit breaker | `policy.circuit` | Policy default | `src/engine.ts`; `test/audit-config.test.ts` |
| Explicit fallback | `AskRequest.fallback`, `RouteConfig.fallback` | Off | `src/engine.ts`; `test/engine.test.ts`; `test/audit-sol.test.ts` |
| Round-robin route | `RouteConfig.strategy = round_robin` | Off | `src/engine.ts`; `test/audit-sol.test.ts` |
| Least-loaded route | `RouteConfig.strategy = least_loaded` | Off | `src/engine.ts`; `test/audit-sol.test.ts` |
| Token, latency, and cost metadata | `Usage`, `ModelResponse.meta`, `stats` | Returned when provider supplies data; counters are in-memory | `src/engine.ts`; `test/engine.test.ts`; `test/server.test.ts` |
| Response cache | `AskRequest.cache`, `policy.cache` | Disabled | `src/engine.ts`; `test/engine.test.ts` |
| In-flight deduplication | `AskRequest.deduplicate`, `policy.deduplicate` | Disabled | `src/engine.ts`; `test/engine.test.ts` |
| Request records | `records`, `policy.records`, and `RequestRecord` | Disabled; content always excluded unless opted in | `src/engine.ts`; `test/engine.test.ts` |
| HTTP transport | `--transport http`, `http` config | Stdio by default | `src/server.ts`; `test/server.test.ts`; `test/audit-sol.test.ts` |
| HTTP origin restriction | `http.allowedOrigins` | Configuration-controlled | `src/server.ts`; `test/server.test.ts` |
| Tenant authentication and model scopes | `http.tenants`, `Principal` | Disabled unless tenants configured | `src/server.ts`; `test/server.test.ts`; `test/audit-sol.test.ts` |
| Configurable prompt presets | `presets`, `AskRequest.preset` | Off | `src/engine.ts`; `test/engine.test.ts`; `test/audit-config.test.ts` |

## Acceptance scenarios

Before release, verify these cases with a real MCP client and a deterministic test adapter:

- A host calls `ask_model` once with an explicit model and message list and receives text plus normalized metadata.
- `list_models` exposes only configured IDs and declared capabilities; aliases resolve to the same stable model.
- A message or option unsupported by the selected model produces a structured error and does not silently downgrade.
- No provider call receives MCP tools, shell commands, hidden host context, or an API key from the request body.
- A provider timeout aborts the request and returns a structured timeout error; retry and fallback apply only to errors explicitly classified as retryable.
- Optional features remain inactive on a default configuration.
- A provider probe, when supported, is an explicit metadata availability check. The library capability detector runs only named live checks and returns evidence without rewriting the model declaration.
- HTTP requests enforce body size, origin, tenant model scopes, and configured path.

## Decision rule

When adding a feature, preserve the smallest explicit call path. A feature belongs in the core only when it improves model invocation without adding agent planning, hidden context, or tool execution.

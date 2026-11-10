# Configuration

The CLI reads one JSON configuration object. The root keys are `providers`, `models`, `routes`, `presets`, `policy`, and `http`. Parsing is strict: unknown keys, invalid enum values, malformed URLs, missing references, negative limits, and duplicate public model IDs are configuration errors. The parser fills documented defaults for omitted optional values and returns a complete internal `AppConfig` before the server starts.

Keep secrets out of this file. `apiKeyEnv` and tenant `apiKeyEnv` name environment variables; the values are read at startup or request authentication time and are never part of MCP arguments.

## Defaults

`providers` and `models` are required and must each contain at least one entry. The parser supplies these defaults for omitted sections and fields:

| Field | Default |
| --- | --- |
| Model capabilities `roles` | `system`, `user`, `assistant` |
| Model capabilities `input` / `output` | `text` / `text` |
| Model capabilities `streaming`, `json`, `jsonSchema` | `false`, `false`, `false` |
| Model capabilities `options` | `temperature`, `topP`, `maxTokens`, `stop` |
| `routes`, `presets` | `{}` |
| `policy.concurrency` / `maxQueue` | `8` / `100` |
| `policy.timeoutMs` | `60000` |
| `policy.requestsPerMinute` | `0` (unlimited) |
| `policy.retry` | `maxAttempts: 1`, `baseDelayMs: 250`, `maxDelayMs: 10000` |
| `policy.circuit` | `failures: 0` (disabled), `resetMs: 30000` |
| `policy.cache` | `enabled: false`, `ttlMs: 60000`, `maxEntries: 100` |
| `policy.deduplicate` | `false` |
| `policy.records` | `enabled: false`, `includeContent: false`, `maxEntries: 100` |
| `policy.sessions` | `enabled: false`, `ttlMs: 3600000`, `maxSessions: 100`, `maxMessages: 1000` |
| `http.host` / `port` / `path` | `127.0.0.1` / `3000` / `/mcp` |
| `http.allowedOrigins` / `tenants` | `[]` / `{}` |
| `http.maxBodyBytes` | `10000000` |

`routes[].fallback` defaults to `false`. Values are strict: the schema rejects unknown keys, malformed IDs, duplicate aliases, provider references that do not exist, and route or tenant model references that do not resolve.

## Providers

```json
{
  "providers": {
    "magpie-local": {
      "type": "openai",
      "baseUrl": "http://127.0.0.1:8000/v1",
      "apiKeyEnv": "MAGPIE_API_KEY",
      "headers": { "X-Client": "model-as-tool-mcp" }
    }
  }
}
```

- `type` is `openai`, `anthropic`, or `gemini`.
- `baseUrl` is the provider endpoint root. OpenAI-compatible services, including local Magpie, Ollama, and vLLM gateways, use `openai` when they expose the compatible request shape.
- `apiKeyEnv` is optional for local or unauthenticated endpoints. If set, the named environment variable must be available when a request needs credentials.
- `headers` adds fixed non-secret headers. Do not put an API key directly in a header value committed to source control.

## Models

Each model has a stable public ID and points to one provider entry:

```json
{
  "models": {
    "magpie/local": {
      "provider": "magpie-local",
      "model": "magpie-model",
      "aliases": ["local-writer"],
      "capabilities": {
        "roles": ["system", "user", "assistant"],
        "input": ["text"],
        "output": ["text"],
        "streaming": true,
        "json": true,
        "jsonSchema": false,
        "options": ["temperature", "topP", "maxTokens", "stop"]
      }
    }
  }
}
```

`provider` is a key in `providers`; `model` is the provider's model name. `aliases` are optional and must not collide with another model ID or alias. `capabilities` describes what this configured model accepts. The service uses this declaration to reject unsupported request features rather than silently changing the request. `pricing` is optional and is used only when calculating cost metadata:

```json
"pricing": { "inputPerMillion": 1.0, "outputPerMillion": 3.0, "currency": "USD" }
```

A declaration is not a benchmark and does not prove that the provider is reachable. Use a provider probe, if exposed by the implementation, for availability checks.

## Routes and presets

Routes group public model IDs:

```json
{
  "routes": {
    "writers": {
      "models": ["magpie/local", "openai/gpt-4o-mini"],
      "strategy": "round_robin",
      "fallback": true
    }
  }
}
```

`round_robin` rotates among models. `least_loaded` chooses the model with the least active work when the runtime exposes load information. `fallback` permits the runtime to try another model after a failure classified as eligible by policy. Routes are explicit; the service never invents a route.

Presets hold reusable defaults:

```json
{
  "presets": {
    "plain-rewrite": {
      "model": "magpie/local",
      "messages": [
        { "role": "system", "content": "Rewrite concisely and preserve meaning." }
      ],
      "options": { "temperature": 0.2, "maxTokens": 500 }
    }
  }
}
```

A request may select `preset` and override its model, messages, or options according to the merge rules in [api.md](api.md). Presets do not make context implicit: their contents are visible configuration and are included only when selected.

## Policy

`policy` bounds work performed by the service:

```json
{
  "policy": {
    "concurrency": 4,
    "maxQueue": 64,
    "timeoutMs": 60000,
    "requestsPerMinute": 120,
    "retry": { "maxAttempts": 2, "baseDelayMs": 250, "maxDelayMs": 4000 },
    "circuit": { "failures": 5, "resetMs": 30000 },
    "cache": { "enabled": false, "ttlMs": 30000, "maxEntries": 1000 },
    "deduplicate": false,
    "records": { "enabled": false, "includeContent": false, "maxEntries": 1000 },
    "sessions": { "enabled": false, "ttlMs": 3600000, "maxSessions": 1000, "maxMessages": 100 }
  }
}
```

- `concurrency` limits provider calls in flight; `maxQueue` bounds waiting calls.
- `timeoutMs` is the default per-request deadline. A request may provide a smaller or larger timeout only within implementation limits.
- `requestsPerMinute` applies a process-level request budget.
- `retry` controls bounded retries. Retry only errors classified as retryable; do not retry malformed requests.
- `circuit` opens after `failures` and permits probes after `resetMs`.
- `cache` and `deduplicate` are off by default because they change freshness and request execution semantics. Enable them only with a deliberate key and retention policy.
- `records` is off by default. If enabled, `includeContent` must be explicitly enabled to retain messages or responses.
- `sessions` is off by default. When enabled, `sessionId` can refer to bounded server-side history; set all retention limits.

The defaults above are bounded except for `requestsPerMinute: 0`, which disables the process-level rate limit. The example configurations choose stricter limits where useful for local development.

## HTTP

```json
{
  "http": {
    "host": "127.0.0.1",
    "port": 8787,
    "path": "/mcp",
    "allowedOrigins": ["http://localhost:3000"],
    "tenants": {
      "team-a": {
        "apiKeyEnv": "MODEL_TOOL_TEAM_A_KEY",
        "models": ["magpie/local"],
        "scopes": ["models:read", "models:ask"]
      }
    },
    "maxBodyBytes": 1048576
  }
}
```

The HTTP transport is opt-in through `--transport http`. `path` selects the MCP endpoint. `allowedOrigins` is an allowlist; an empty or omitted allowlist must follow the runtime's documented same-origin policy. Tenants scope which model IDs a credential can invoke. `maxBodyBytes` rejects oversized requests before parsing.

For a local-only listener, bind to `127.0.0.1`. For a network listener, put TLS and an authenticated reverse proxy in front of the process and keep origins and tenant scopes narrow.

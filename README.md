# Model-as-Tool MCP

Model-as-Tool MCP exposes configured language models as ordinary MCP tools. A host agent chooses a model, sends an explicit message list, and receives a normalized response. The service does not create another agent, run tools on the model's behalf, or inject the host's hidden context.

The project is provider-neutral. It supports OpenAI-compatible HTTP APIs and native Anthropic and Gemini adapters through one configuration schema. Ollama, vLLM, and local gateways can use the OpenAI-compatible adapter when their endpoint implements the expected API.

## Status

The primary interface is intentionally small:

- `ask_model` performs one explicit inference request.
- `list_models` describes configured models and their declared capabilities.
- Optional operational tools cover `batch_ask`, `probe_model`, explicit capability detection, session lifecycle, `stats`, and `records`; they are documented in [docs/api.md](docs/api.md).

The optional controls in the request and policy schema are opt-in. See [docs/design.md](docs/design.md) for the implementation evidence matrix and [docs/api.md](docs/api.md) for the request and response contract.

## Requirements

- Node.js 22.12.0 or newer
- An API endpoint for each configured model
- API keys supplied through environment variables when a provider requires them

## Install and build locally

```sh
npm ci
npm run check
npm test
npm run build
npm pack
```

The package exposes `dist/cli.js` as `model-as-tool-mcp` and `dist/index.js` as its library entry point. During development, use the local CLI after building:

```sh
node dist/cli.js --config ./config.json --transport stdio

# Invoke the local built CLI through npx (no network install)
npx --no-install -- node dist/cli.js --config ./config.json --transport stdio
```

`--config` defaults to `config.json`. The default transport is `stdio`; pass `--transport http` to start the HTTP MCP transport. The HTTP listener uses the `http` section of the configuration (`host`, `port`, `path`, origins, tenants, and body limit).

## MCP client configuration

For an MCP client that launches local processes, point the command at the built CLI and pass a configuration file. This example uses a repository-local path so that the client does not need a global install:

```json
{
  "mcpServers": {
    "model-as-tool": {
      "command": "node",
      "args": [
        "/path/to/model-as-tool-mcp/dist/cli.js",
        "--config",
        "/path/to/model-as-tool-mcp/config.json",
        "--transport",
        "stdio"
      ],
      "env": {
        "MAGPIE_API_KEY": "replace-me"
      }
    }
  }
}
```

Use an environment manager or secret store for credentials in real deployments. Do not put a key in a committed JSON file or in an MCP tool argument.

For a remote deployment, run `node dist/cli.js --transport http` and configure the client for the resulting MCP HTTP endpoint. Restrict `http.allowedOrigins` and configure tenants before exposing the listener outside a trusted network. See [docs/configuration.md](docs/configuration.md).

## Configuration at a glance

The root configuration has six objects:

| Section | Purpose |
| --- | --- |
| `providers` | Provider kind, base URL, optional key environment variable, and fixed headers. |
| `models` | Stable public model IDs, provider mapping, provider model names, aliases, capabilities, and optional pricing. |
| `routes` | Explicit model groups with round-robin or least-loaded selection and optional fallback. |
| `presets` | Reusable model, message, and generation-option defaults. |
| `policy` | Concurrency, queueing, timeout, rate limit, retry, circuit breaker, cache, deduplication, records, and sessions. |
| `http` | HTTP listener, allowed origins, tenant credentials/scopes, and request body limit. |

The parser applies documented defaults and rejects unknown or malformed values. Use [examples/config.json](examples/config.json) as a complete, provider-neutral starting point; [docs/configuration.md](docs/configuration.md) describes each field.

## Provider examples

The examples include all three adapter kinds. `examples/config.json` includes a local Magpie OpenAI-compatible endpoint alongside OpenAI, Anthropic, and Gemini entries. The local endpoint uses the same OpenAI-compatible wire contract as other compatible gateways:

```json
{
  "providers": {
    "magpie-local": {
      "type": "openai",
      "baseUrl": "http://127.0.0.1:8000/v1",
      "apiKeyEnv": "MAGPIE_API_KEY"
    }
  },
  "models": {
    "magpie/local": {
      "provider": "magpie-local",
      "model": "magpie-model",
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

The example uses port `8000` as a generic local gateway. The opt-in desktop Magpie integration in [docs/live-testing.md](docs/live-testing.md) uses its observed loopback port and can be overridden with `MODEL_AS_TOOL_LIVE_BASE_URL`.

The adapter kind determines the wire protocol; the model declaration determines which features this service will accept for that model. A provider's public feature set does not imply that every configured model supports every option. See [docs/providers.md](docs/providers.md) for the differences and capability declaration rules.

## Calling the tools

A minimal call is explicit and stateless:

```json
{
  "model": "magpie/local",
  "messages": [
    { "role": "user", "content": "Rewrite this sentence in plain English." }
  ]
}
```

`ask_model` also accepts an alias, preset, route, explicit fallback list, timeout, retry override, cache and deduplication flags, an optional session ID, and streaming. Structured output, multimodal content, provider-specific options, and the other optional features are described in [docs/api.md](docs/api.md). `list_models` returns the configured public IDs, provider kind, aliases, and declared capabilities so a host can choose deliberately.

The service forwards only the supplied messages. It does not add a system prompt, host conversation, files, tools, or credentials. Models are called without tool execution.

## Design boundaries

Model-as-Tool MCP is a model invocation adapter, not an agent runtime. The host remains the only orchestrator. A request can select one model or an explicitly configured route; it does not create sub-agents or perform hidden planning. Errors are returned as structured MCP errors with stable codes where the provider or policy layer can identify one.

By default, request records exclude message and response content. Enable content recording only when the deployment has a clear retention and access policy. API keys are read from environment variables named by provider or tenant configuration and are never logged by the service.

## Development

```sh
npm ci
npm run check
npm test
npm run build
```

Please read [CONTRIBUTING.md](CONTRIBUTING.md) before changing adapters, transport behavior, or the configuration contract. Security reports belong in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © 2026 Model-as-Tool MCP contributors.

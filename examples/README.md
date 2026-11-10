# Examples

`config.json` is a complete configuration with four provider entries:

- `magpie-local` uses the OpenAI-compatible adapter against `http://127.0.0.1:8000/v1` and is the local development example. In the complete `config.json`, its `apiKeyEnv` is `MAGPIE_API_KEY`; set that variable before invoking it, or use `magpie-local.json` for an unauthenticated endpoint.
- `openai-main` uses the OpenAI-compatible adapter against OpenAI's API.
- `anthropic-main` uses the native Anthropic adapter.
- `gemini-main` uses the native Gemini adapter.

`magpie-local.json` is a minimal local-only configuration for an unauthenticated endpoint. If the endpoint requires authentication, add `"apiKeyEnv": "MAGPIE_API_KEY"` to its provider entry and set that environment variable; the provider adapter then requires the variable to be present.

Start stdio after building:

```sh
node dist/cli.js --config examples/config.json --transport stdio
```

Start the loopback HTTP endpoint:

```sh
node dist/cli.js --config examples/config.json --transport http
```

The complete example enables a round-robin route and a prompt preset, while cache, deduplication, records, sessions, and tenant authentication remain disabled. The local-only example uses tighter concurrency and queue limits and leaves all behavior-changing features disabled. The provider capability declarations intentionally differ: OpenAI-compatible models advertise image input and JSON Schema where configured, Anthropic advertises image input and text output, and Gemini advertises image/audio input.

`http-tenant.json` demonstrates the least-privilege HTTP default: a tenant with only `models:read` and `models:ask` can list and invoke its allowlisted model, but cannot probe, inspect records, read stats, or manage sessions. Omitted policy and HTTP fields use the parser defaults in [docs/configuration.md](../docs/configuration.md).

`ask-model.json` is the smallest explicit request body. It contains no provider credential, hidden context, or tool definition.

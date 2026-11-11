# Live integration test

The opt-in live test exercises `listTools` and `ask_model` through a real MCP
client and a configured OpenAI-compatible Chat Completions endpoint. It is
skipped during ordinary `npm test` runs.

Set the endpoint root and an available model explicitly:

```sh
MODEL_AS_TOOL_LIVE=1 \
MODEL_AS_TOOL_LIVE_BASE_URL=https://your-provider.example/v1 \
MODEL_AS_TOOL_LIVE_MODEL=your-model-name \
npm test -- --run test/live.test.ts
```

The adapter appends `/chat/completions` to the configured base URL. Use the
API root expected by your provider. For a provider that requires a key, set
`MODEL_AS_TOOL_LIVE_API_KEY` in the environment before running the test.

For example, the local Magpie instance used in development accepted Chat
Completions at `http://127.0.0.1:3425/chat/completions`; that installation's
base URL was therefore `http://127.0.0.1:3425`. Configure the actual endpoint
and a model available in your installation.

The fixed probe asks for `live probe` and caps output at eight tokens. The test
does not log credentials or response bodies. It requires network access to the
configured provider and may incur usage charges.

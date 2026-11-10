# Live Magpie test

The live suite is opt in and is skipped by default. It exercises the real MCP
boundary (`listTools` and `ask_model`) with one bounded request to a local
OpenAI compatible endpoint. The provider is called directly by the adapter;
the test does not start Codex, Claude Code, or another agent harness.

## Magpie defaults

The desktop Magpie tray normally listens at:

```text
http://127.0.0.1:3425
```

Its OpenAI compatible Responses endpoint is `/v1/responses`. The live test
uses `group/gpt-6-luna` unless `MODEL_AS_TOOL_LIVE_MODEL` is set. Magpie's
loopback endpoint usually does not need an API key. If a deployment does, set
the key in the environment; do not put it in a config file or command line.

## Run

From this package directory:

```sh
MODEL_AS_TOOL_LIVE=1 npm test -- --run test/live.test.ts
```

Optional environment variables:

```sh
MODEL_AS_TOOL_LIVE_BASE_URL=http://127.0.0.1:3425
MODEL_AS_TOOL_LIVE_MODEL=group/gpt-6-luna
MODEL_AS_TOOL_LIVE_API_KEY=…           # only for endpoints that require one
```

For example, to provide a key without writing it to disk:

```sh
read -r 'MODEL_AS_TOOL_LIVE_API_KEY?API key: '
export MODEL_AS_TOOL_LIVE_API_KEY
MODEL_AS_TOOL_LIVE=1 npm test -- --run test/live.test.ts
unset MODEL_AS_TOOL_LIVE_API_KEY
```

The fixed probe asks the model to reply with `live probe` and caps output at
eight tokens. Test output contains only assertions; credentials and response
body are never logged. A missing or stopped Magpie service causes the opt-in
test to fail, while ordinary `npm test` runs remain offline and deterministic.

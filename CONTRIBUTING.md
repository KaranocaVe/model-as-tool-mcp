# Contributing

Thanks for improving Model-as-Tool MCP. Keep changes small, explicit, and compatible with the model-as-tool boundary.

## Before changing code

1. Read `AGENTS.md` and the relevant design sections in [docs/design.md](docs/design.md).
2. Keep provider adapters independent of MCP transport code.
3. Update the shared types and validation rules before adding a new public field.
4. Do not add implicit prompts, hidden context, tool execution, agent planning, or credential parameters to MCP calls.

## Local checks

Use Node.js 22 or newer:

```sh
npm ci
npm run check
npm test
npm run build
npm pack
```

Add a regression test for every behavior change. Tests must use deterministic fakes or credentials supplied through environment variables; never commit API keys, provider responses containing secrets, or private endpoints.

## Provider changes

A provider adapter should:

- implement the shared `ProviderAdapter` contract;
- consume only the configured provider and model values;
- honor `AbortSignal` and streaming callbacks when supported;
- return normalized response metadata without inventing usage or cost values;
- classify provider failures as structured errors without logging prompt or response bodies.

Declare model capabilities explicitly. Unsupported content and options must fail clearly rather than being silently dropped.

## Documentation and pull requests

Update README or the relevant document when a CLI flag, configuration field, MCP tool, default, error code, or provider capability changes. Include the feature-matrix evidence in `docs/design.md`.

Pull requests should explain the user-visible behavior, tests run, and any provider-specific limitations. Keep generated `dist` files and credentials out of commits unless a release workflow explicitly requires them.

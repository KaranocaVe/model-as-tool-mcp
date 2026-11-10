# Configuration and engine boundary audit

The regression suite in [`test/audit-config.test.ts`](../test/audit-config.test.ts) treats configuration as an untrusted boundary. It covers:

- strict root and nested objects, documented defaults, and bounded limits;
- reserved property names (`__proto__`, `prototype`, and `constructor`) in every configuration map and in provider options / JSON Schema values;
- provider URL, header, and environment variable validation without accepting credentials in URLs or reserved transport headers;
- plain JSON checks, finite numbers, and maximum nesting depth;
- provider, model, route, preset, tenant, and alias reference integrity;
- capability checks for roles, media, output modes, and generation options;
- cancellation and deadlines reaching the adapter, bounded queue admission, process rate limiting, circuit open/half-open/reset behavior, explicit preset merge behavior, session history, and streaming capability declarations;
- live capability probes with declaration conflicts, tenant/scope authorization, JSON response validation, and no hidden calls for unknown aspects.

## Baseline and ownership

Run the focused audit with:

```sh
npx vitest run test/audit-config.test.ts
```

The initial run was blocked by the provider worker's missing `src/providers/index.ts`; that registry is now present and the focused audit passes all 16 tests. At the latest run, `npm test` passed 84 tests with one explicitly skipped live test and `npm run check` passed. Failures in the first `configuration boundary audit` block belong to the config owner (`src/config.ts`). Failures in `configuration-controlled engine semantics` belong to the engine owner (`src/engine.ts` / `src/scheduler.ts`). A failure that only appears through MCP transport belongs to the transport owner.

## Findings protocol

Every failing assertion should be reduced to a small input and recorded here with the observed error, the expected contract, and the owning source line. Do not “fix” an audit by weakening an assertion or by adding private endpoints, credentials, or response bodies to fixtures. The fixtures use `provider.example`, synthetic model IDs, and in-memory adapters only.

## Current review notes

- Tenant examples use the schema scopes `models:read` and `models:ask`; copying them into a config is accepted by `configSchema`.
- The parser rejects reserved identifiers at map keys and recursively checks provider options and JSON Schema objects for safe plain JSON. Keep this check in place when adding new free-form configuration fields.
- Capability declarations are configuration, not proof of provider behavior. The adapter must still enforce native provider capabilities and reject unsupported provider-specific options.
- Timeout tests assert that the adapter signal is actually aborted. Returning a timeout error while leaving provider work running would leak work beyond the configured policy.
- Session tests assert explicit model selection and bounded retained history. Presets replace message defaults when a request supplies its own messages and merge options field by field.

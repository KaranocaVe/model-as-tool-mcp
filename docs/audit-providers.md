# Provider protocol audit

`test/audit-providers.test.ts` is an offline wire-contract audit for the native provider adapters. It uses loopback HTTP fixtures, so it never contacts a real model service and never requires a credential.

## Covered contracts

- OpenAI Chat Completions request mapping, JSON and JSON Schema response formats, image and audio input, audio output, provider options, usage-only stream chunks, refusal and tool-call rejection, truncated SSE, and cancellation.
- Anthropic Messages request mapping, system blocks, image input, native JSON Schema output configuration, usage metadata, refusal and tool-use rejection, truncated event streams, and cancellation.
- Gemini `generateContent` and `streamGenerateContent?alt=sse` mapping, `systemInstruction`, `user`/`model` roles, generation settings, JSON Schema, inline image/audio data, multimodal output, usage metadata, refusal/tool-call rejection, and provider-option isolation.
- Provider options cannot inject `model`, `messages`, `tools`, or authentication fields. Credentials are read from the configured environment variable and are absent from the JSON body.
- Provider streams must terminate according to their native protocol; malformed JSON, incomplete OpenAI `[DONE]` streams, malformed Anthropic event sequences, and incomplete Gemini candidates are rejected as provider-response errors.

## Metadata rule

The adapters expose token metadata only when the provider sends valid non-negative integer fields. They do not estimate usage from text length or token limits. The audit includes a negative Anthropic cache-token fixture because cache token counts must follow the same validation rule as ordinary input/output counts.

## Running the audit

```sh
npm test -- --run test/audit-providers.test.ts
```

The fixtures bind to an ephemeral loopback port and are closed after each test. Environment variables used by the tests contain only dummy values and are removed after the credential cases.

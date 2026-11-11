# Providers

Adapters translate the normalized request into a provider protocol and normalize the provider response. The MCP layer does not depend on provider-specific SDK objects.

## OpenAI-compatible

Use `type: "openai"` for OpenAI and compatible HTTP APIs. The adapter is suitable for gateways such as Ollama and vLLM when their endpoint implements the expected chat-completions style contract. Set `baseUrl` to the API root and `apiKeyEnv` only when the endpoint requires a key.

```json
{
  "type": "openai",
  "baseUrl": "http://127.0.0.1:8000/v1",
  "apiKeyEnv": "GATEWAY_API_KEY"
}
```

Provider-specific request controls may be passed through `options.providerOptions` only when the selected model declares and the adapter supports them. The OpenAI-compatible adapter accepts `max_tokens_parameter` (`max_completion_tokens` by default, or `max_tokens` for older compatible gateways), plus validated `frequency_penalty`, `presence_penalty`, `reasoning_effort`, `service_tier`, and audio voice/format settings. Keep the stable fields in the common `options` object whenever possible.

## Anthropic

Use `type: "anthropic"` for Anthropic's native messages API. The adapter translates system content, user/assistant turns, generation limits, stop sequences, and supported structured or multimodal content according to the configured model capabilities. Anthropic authentication is read from the configured environment variable.

The same normalized `Message` and `ModelResponse` types are used, but provider behavior differs for system messages, token limits, structured output, and multimodal parts. Anthropic structured output is schema-based; callers should use `responseFormat.type = "json_schema"` with an explicit schema. Declare only the features that the selected model and adapter can actually honor.

## Gemini

Use `type: "gemini"` for Gemini's native API. The adapter maps messages, generation settings, safety/provider controls, and supported modalities to Gemini's request format. Authentication is read from the configured environment variable.

Gemini model names and output metadata differ from OpenAI-compatible and Anthropic responses. The normalized response preserves the configured public ID and includes provider model and usage fields only when returned by the API.

## Capability declarations

The native adapters currently normalize these provider shapes:

| Adapter | Input | Output | Structured output |
| --- | --- | --- | --- |
| OpenAI-compatible | text, image, audio where the endpoint supports it | text and audio; image output is rejected | JSON and JSON Schema only when the model capability declaration and endpoint support it |
| Anthropic | text and image | text | JSON Schema through the native output format; use `json_schema` for portable behavior |
| Gemini | text, image, and audio inline data | provider-supported normalized content | JSON and JSON Schema only when declared and supported |

Capabilities are per configured model, not global per provider:

- `roles` lists accepted message roles.
- `input` and `output` list text, image, and audio content.
- `streaming`, `json`, and `jsonSchema` gate optional request modes.
- `options` lists the common generation options accepted by the model.

A capability mismatch is a request error. The service does not silently drop an option or coerce unsupported content. Provider-specific differences should be represented in `providerOptions` and documented with the model entry.

## Credentials and endpoints

Use environment variables for keys, for example:

```sh
export OPENAI_API_KEY='…'
export ANTHROPIC_API_KEY='…'
export GEMINI_API_KEY='…'
export GATEWAY_API_KEY='…'
```

These names are examples only; configuration chooses the actual variable name. Keep local endpoints bound to loopback unless a protected network service is intended. Never commit credentials or include them in an MCP request.

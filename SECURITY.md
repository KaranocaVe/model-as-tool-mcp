# Security policy

## Supported versions

Security fixes target the latest released version and the default branch. Upgrade before reporting a problem against an old build.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Contact the repository maintainers through the private security reporting channel configured for the hosting service. Include:

- affected version or commit;
- deployment mode (`stdio` or `http`);
- a minimal reproduction that contains no API keys or private prompts;
- impact and conditions required to reproduce it.

If the repository hosting service offers a private security advisory, use that workflow. If no private channel is configured yet, open a minimal issue asking maintainers to provide one without including exploit details.

## Deployment guidance

- Keep API keys in environment variables or a secret manager. They are never accepted as tool arguments.
- Bind local HTTP deployments to loopback. For network use, place TLS and authentication at a trusted reverse proxy and restrict `http.allowedOrigins`.
- Configure tenant model scopes and request body limits before exposing HTTP transport.
- Keep request records disabled or content-free unless retention and access controls are intentional.
- Do not enable content recording for sensitive prompts without a documented retention policy.
- Review provider and proxy logs separately; this service does not log prompt or response bodies by default.

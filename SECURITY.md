# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately, not as a public issue, so a fix can ship before the
details are public.

Use GitHub's private reporting on this repository: **Security** tab, then **Report a
vulnerability**. That opens a draft advisory visible only to you and the maintainers.

Useful in a report: what an attacker gains, the smallest reproduction you have (a curl call
against a local engine is ideal), the version or commit, and whether `AGENTX_AUTH` was enabled.
Expect an acknowledgement within a few working days. This is a small project, so please treat that
as a best effort rather than a contractual SLA.

Please do not run automated scanners against any hosted AgentX instance. Everything here is
self-hostable, so test against your own.

## Supported versions

Fixes land on `main` and go out in the next release. There are no long-lived maintenance branches,
so "upgrade to the latest release" is the supported path.

## What the default deployment assumes

Worth stating, because several reports would otherwise describe the documented design:

- **No dashboard login by default.** The engine trusts anything that can reach its port, which
  assumes one machine and one operator. `AGENTX_AUTH=enabled` turns on sign-in for shared
  deployments. See README's "Dashboard authentication".
- **Project API keys are stored in plaintext** in the engine's own database, and the dashboard
  shows them. That is deliberate: the key is the project selector, an operator has to be able to
  copy it into an SDK, and it is stored in the same database as the telemetry it protects. So
  database read access is already total compromise, and hashing the key would not change that.
  Keys carry 192 bits of entropy from `crypto.randomBytes`, and both credential and data-plane
  request rates are capped by default (`engine/src/auth/rateLimit.ts`).
- **LLM provider keys are write-only over the API.** They are stored so the engine can call
  OpenAI and Anthropic on your behalf, and read back only in masked form.
- **Code scorers execute code you supply**, in a subprocess, by design. They are an operator
  feature, not a sandbox. Treat the ability to write a scorer as equivalent to shell access on the
  engine host.
- **Exposing the engine to the internet is your call to make deliberately.** Put it behind TLS and
  `AGENTX_AUTH=enabled`, and set `AGENTX_TRUSTED_ORIGINS`.

Reports that show a way *around* one of these boundaries are very much in scope. A bypass of
project scoping is the one to look hardest at: every project-scoped query derives its tenancy from
the resolved API key (`engine/src/auth/apiKey.ts`), and anything that reads one project's rows
with another project's key is a serious bug.

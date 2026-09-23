---
system: credential-broker
sources:
  - apps/orchestrator/src/tools/credentials.ts
  - packages/security/src/credential-cipher.ts
  - packages/security/src/env-guard.ts
  - packages/security/src/redact.ts
verified_at: 151b09c
---

# Credential broker

[credentials.ts](../../apps/orchestrator/src/tools/credentials.ts). Secrets are
used by tools without ever reaching a model, a log, a report or SQLite in
plain text.

## Storage

- `credential_references`: name, kind, environment variable, description,
  repository scope, AES-256-GCM `ciphertext`/`iv`/`tag` (the row id is bound
  as additional data, so a ciphertext cannot be moved to another row), an
  8-character SHA-256 fingerprint, timestamps.
- The 32-byte key: on Windows `<data>/credential-key.dpapi`, protected with
  DPAPI for the current user (only this Windows account can unwrap it; done
  with Windows PowerShell's `ProtectedData`); elsewhere `<data>/credential-key`
  with mode 600. It is loaded lazily — the first time a credential is stored
  or used.

## Flow

1. `POST /api/credentials {name, kind, envVar?, description, repositoryIds?, value}`
   — the value is write-only; no endpoint returns it (`PATCH` replaces it).
2. A tool call that declares credential kinds (Cloudflare → `cloudflare`)
   gets `envFor(kinds)`: the first in-scope credential of each kind injected
   as its variable (`CREDENTIAL_KIND_ENV`: `CLOUDFLARE_API_TOKEN`, `GH_TOKEN`,
   `DATABASE_URL`, `MYSQL_PWD`, `NPM_TOKEN`), plus `CLOUDFLARE_ACCOUNT_ID`
   when one is stored with that variable. `http.request {auth: {credential}}`
   uses one by name as a header.
3. Every value handed out is first registered with the shared redactor
   (`registerSecretValues`), and all stored values are registered at startup,
   so an echo of it in any output becomes `[REDACTED]`.
4. The variables the broker manages are stripped from every inherited
   environment (`setBrokerManagedEnvVars` in [env-guard.ts](../../packages/security/src/env-guard.ts)):
   agents and repository commands never receive them from the orchestrator's
   own environment.

Kinds: `cloudflare`, `github`, `postgres`, `mysql`, `http`, `npm`, `other`.

## Verified

Integration test: a stored value is absent from API responses and from the
raw SQLite file (after a WAL checkpoint); an HTTP call received exactly
`Bearer <value>`; the server's echo came back redacted.

Last verified: 2026-09-23

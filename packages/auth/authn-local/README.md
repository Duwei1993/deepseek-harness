# @deepseek-ai/dsh-authn-local

English | [中文](README.zh.md)

The local provider for the [authentication seam](../auth/README.md) (`ctx.authn`). Accounts live in a `node:sqlite` database at `auth.db` under the resolved harness home (`$DSH_HOME` > `~/.dsh`), the schema versioned by a monotonic `PRAGMA user_version` migration ladder (`SCHEMA_VERSION`, currently 1): `users` (unique username, role check, `must_change_password`/`disabled` flags), `external_identities` (`UNIQUE(provider, subject)` links, reserved for the M3b OIDC provider), and `auth_tokens` (keyed by token digest). Unloading the plugin closes the database through its fiber's disposer.

## Behavior

Passwords are scrypt-hashed with a random 32-byte salt and stored as `saltHex:hashHex`, verified in constant time. A login against an unknown username verifies against a standing dummy hash so failure timing matches a wrong password, and both fail with the shared `AUTH_INVALID_CREDENTIALS` wording. Bearer tokens are 32 random bytes base64url-encoded; only their SHA-256 digest is stored. Tokens live `tokenTtlMs` (default 7 days) from issue, and every successful `resolveToken` slides the expiry forward by the same span; an expired token is deleted when observed. Consecutive login failures lock the username for an exponentially growing in-memory lockout (`rateLimitBaseDelayMs` doubling up to `rateLimitMaxDelayMs`, 1 second to 5 minutes by default); a successful credential check clears the streak.

A first boot against an empty store seeds `superadmin` with `mustChangePassword: true` and logs a loud warning. Without `seedSuperadminPassword` the seed password is the well-known default `123456` and the warning names it — rotate it immediately. Seeding keys off an empty `users` table, so later boots and remounts change nothing.

## Configuration

All fields are optional: `path` (database file, or `:memory:`; defaults to the harness home), `seedSuperadminPassword` (test hook consulted only while the store is empty), `tokenTtlMs`, `rateLimitBaseDelayMs`, and `rateLimitMaxDelayMs`. Tests can also steer time through the service's `internals.now` hook.

## Model Experience

None, as the provider serves same-process callers over `ctx.authn`; nothing it stores or returns reaches a model request.

#### KV Cache effect

None; nothing here reaches a model request.

## Known Limitations and Deferred Work

- **The seam does not bind sessions to owners** — the HTTP gate consumes `ctx.authn` for authentication, but session lists stay shared across accounts; TODO: the next milestone.
- **`external_identities` is storage-only** — no service method links or resolves external identities until the M3b OIDC provider arrives; only the store layer exercises it.
- **Rate limiting is process-local** — the failure streak lives in memory and resets on restart; multi-instance deployments need a shared throttle.
- **Token cleanup is lazy** — expired tokens are deleted only when resolved; there is no sweep.
- **`node:sqlite` emits Node 22's ExperimentalWarning once per process** — the provider imports it lazily at mount; the warning-filter treatment from `dsh-session-persistence-sqlite` is not replicated here yet.

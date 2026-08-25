# @deepseek-ai/dsh-auth

English | [中文](README.zh.md)

The authentication Service Definition for DeepSeek Harness, mounted as `ctx.authn`. The seam authenticates accounts by username and password, resolves bearer tokens to accounts, and exposes the account-management surface (`listUsers`/`createUser`/`resetPassword`/`setDisabled`). It declares the contract only: a provider such as [`@deepseek-ai/dsh-authn-local`](../authn-local/README.md) supplies storage and hashing, and the enforcement consumers are [`@deepseek-ai/dsh-auth-gate`](../auth-gate/README.md) (login UI and page gate) and `dsh-client-connection` (the `/api` 401 fence).

## Vocabulary

`AuthUser` is the credential-free account record: a branded `UserId`, the unique `username`, a `displayName`, the `role` (`'superadmin' | 'user'`), an optional `tenant`, and two flags — `disabled` (blocks login and voids the account's tokens at resolve time) and `mustChangePassword` (carried, not enforced, by this seam). `AuthLogin` pairs the account with the freshly minted bearer token; providers store only a digest of it. Failures carry `AuthError` with a stable `AuthErrorCode`; `AUTH_INVALID_CREDENTIALS` deliberately shares one message for an unknown username and a wrong password so the failure channel never reveals whether an account exists.

## Composition

Mounting a provider registers `ctx.authn` for the whole context tree. Consumers resolve identities through `resolveToken(token)` (unknown, expired, or disabled-owned tokens all return `null`; a successful resolve slides the token's expiry forward) and authenticate through `login(username, password)`. A `mustChangePassword` account still receives a token from `login`; turning that flag into an HTTP or UI gate belongs to the consumer that later mounts one.

## Model Experience

None, as the seam declares an abstract service contract and registers no prompt, tool schema, or model-visible content.

#### KV Cache effect

None; nothing here reaches a model request.

## Known Limitations and Deferred Work

- **No session-owner binding** — the HTTP gate ([`dsh-auth-gate`](../auth-gate/README.md)) and the `/api` 401 fence enforce authentication, but nothing binds sessions to accounts or filters session lists per owner; TODO: the next milestone.
- **No OIDC provider** — the seam is credential-only; the M3b provider will consume the `external_identities` plumbing the local provider already stores. TODO: M3b.
- **Password rotation does not revoke tokens** — `changePassword`/`resetPassword` leave previously issued tokens live until they expire; TODO: revoke-on-rotate when a revocation policy is designed.
- **No logout or token enumeration** — tokens expire or die with their account's disabled flag; explicit revocation is undeclared.

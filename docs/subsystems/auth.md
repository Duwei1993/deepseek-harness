# Authentication

English | [中文](auth.zh.md)

The authentication seam of [dsh-auth](../../packages/auth/auth) gives deployments accounts: a branded user identity, credential login, bearer-token resolution, and the account-management surface. The local provider [dsh-authn-local](../../packages/auth/authn-local) implements it over SQLite; the opt-in [dsh-auth bundle](../../packages/bundle/auth-bundle) mounts that provider together with [dsh-auth-gate](../../packages/auth/auth-gate), which serves the login and administration pages under `/auth/*` and redirects unauthenticated page navigations, while `dsh-client-connection` answers unauthenticated `/api` requests and WebSocket upgrades with 401. Nothing in this seam is mounted by default. Session-owner binding is the remaining milestone — see the package READMEs' limitations.

Source: [`packages/auth/auth/src/index.ts`](../../packages/auth/auth/src/index.ts)

## Accounts

Every account is an `AuthUser`: credential-free, so no consumer can leak a hash it never sees. `UserId` is branded so account ids never mix with session, agent, or tool-call ids.

```ts type-equiv
/**
 * Opaque cross-boundary user identity. Providers mint it; consumers never
 * parse it or assume a storage format.
 */
type UserId = Branded<'UserId'>
```

```ts type-equiv
/** The account roles this seam recognizes. */
type AuthRole = 'superadmin' | 'user'
```

```ts type-equiv
/**
 * One account as the seam exposes it. It never carries credential material:
 * password hashes and token values stay inside the provider.
 */
interface AuthUser {
  /** Opaque provider-minted identity. */
  id: UserId
  /** Unique login name. */
  username: string
  /** Human-facing display name. */
  displayName: string
  /** Account role; `'superadmin'` holds the management prerogatives. */
  role: AuthRole
  /** Deployment tenant the account belongs to, when the provider scopes accounts. */
  tenant?: string
  /**
   * Whether the account is administratively disabled. A disabled account
   * cannot log in, and its existing tokens resolve to `null`.
   */
  disabled: boolean
  /**
   * Whether the account must replace its password before ordinary use. The
   * seam only carries the flag; enforcement is the gate consumer's
   * (`dsh-auth-gate` redirects a flagged account's page navigations to the
   * change form).
   */
  mustChangePassword: boolean
}
```

## Login and tokens

`login(username, password)` verifies credentials and mints a bearer token. Unknown usernames and wrong passwords fail with the same `AUTH_INVALID_CREDENTIALS` wording, so the failure channel never reveals whether an account exists; a `mustChangePassword` account still receives its token, because enforcement belongs to the gate consumer. `resolveToken(token)` maps a live token back to its account — unknown, expired, or disabled-owned tokens all return `null` — and slides the token's expiry forward on every success.

```ts type-equiv
/** Result of a successful credential login. */
interface AuthLogin {
  /** The authenticated account. */
  user: AuthUser
  /**
   * The freshly minted bearer token, presented verbatim to
   * {@link AuthnService.resolveToken}. Providers store only a digest of it.
   */
  token: string
}
```

## Account management

The management surface — `listUsers`, `createUser`, `resetPassword`, `setDisabled` — administers accounts through the same seam. A created account always starts with `mustChangePassword: true`; `resetPassword` re-arms that flag, while `changePassword` (which requires the current password) clears it. Failures carry an `AuthError` with a stable `AuthErrorCode`: `AUTH_INVALID_CREDENTIALS`, `AUTH_USER_DISABLED`, `AUTH_RATE_LIMITED` (with `retryAfterMs`), `AUTH_USER_NOT_FOUND`, `AUTH_USERNAME_TAKEN`, and `AUTH_INVALID_INPUT`.

```ts type-equiv
/** Account-creation request for {@link AuthnService.createUser}. */
interface CreateUserInput {
  /** Unique login name; a duplicate fails with `AUTH_USERNAME_TAKEN`. */
  username: string
  /** Human-facing display name; defaults to the username. */
  displayName?: string
  /** Initial password. A created account always starts with `mustChangePassword: true`. */
  password: string
  /** Account role; defaults to `'user'`. */
  role?: AuthRole
  /** Deployment tenant scope. */
  tenant?: string
}
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxauthn--authnservice-abstract-seam"></a>

### `ctx.authn` — `AuthnService` (abstract seam)

Abstract authentication provider mounted as `ctx.authn`. Implementations own the account store, password hashing, and token issuance; every method here is the whole contract consumers may rely on.

```ts cordis-catalog
/**
 * Resolve a bearer token to its account. The provider slides the token's
 * expiry forward on a successful resolve.
 * @param token - the bearer token as minted by {@link login}.
 * @returns the account, or `null` when the token is unknown, expired, or
 *   belongs to a disabled account.
 */
abstract resolveToken(token: string): Promise<AuthUser | null>

/**
 * Authenticate by username and password and mint a bearer token. A
 * `mustChangePassword` account still receives a token; enforcement of the
 * change is the gate consumer's job, not this seam's.
 * @param username - the account's login name.
 * @param password - the plaintext password, verified against the stored hash.
 * @returns the account and the fresh token.
 * @throws {AuthError} `AUTH_INVALID_CREDENTIALS` for an unknown username or wrong password (one shared wording).
 * @throws {AuthError} `AUTH_USER_DISABLED` when the account is disabled.
 * @throws {AuthError} `AUTH_RATE_LIMITED` while a failure-streak lockout is running.
 */
abstract login(username: string, password: string): Promise<AuthLogin>

/**
 * Replace an account's password after verifying the current one; clears
 * `mustChangePassword`. Existing tokens survive the change in this skeleton
 * (see the package README's deferred work).
 * @param userId - the account to update.
 * @param oldPassword - the current password, verified before any change.
 * @param newPassword - the replacement password.
 * @returns the updated account.
 * @throws {AuthError} `AUTH_USER_NOT_FOUND` for an unknown id.
 * @throws {AuthError} `AUTH_INVALID_CREDENTIALS` when the current password does not match.
 * @throws {AuthError} `AUTH_INVALID_INPUT` when the new password is empty.
 */
abstract changePassword(userId: UserId, oldPassword: string, newPassword: string): Promise<AuthUser>

/**
 * List every account in stable username order.
 * @returns all accounts, without credential material.
 */
abstract listUsers(): Promise<AuthUser[]>

/**
 * Create an account. The new account starts enabled with
 * `mustChangePassword: true`.
 * @param input - the account to create.
 * @returns the created account.
 * @throws {AuthError} `AUTH_USERNAME_TAKEN` when the username exists.
 * @throws {AuthError} `AUTH_INVALID_INPUT` for an empty username or password.
 */
abstract createUser(input: CreateUserInput): Promise<AuthUser>

/**
 * Administratively replace an account's password without the current one;
 * sets `mustChangePassword: true` so the next login must rotate it.
 * @param userId - the account to reset.
 * @param newPassword - the replacement password.
 * @returns the updated account.
 * @throws {AuthError} `AUTH_USER_NOT_FOUND` for an unknown id.
 * @throws {AuthError} `AUTH_INVALID_INPUT` for an empty password.
 */
abstract resetPassword(userId: UserId, newPassword: string): Promise<AuthUser>

/**
 * Enable or disable an account. Disabling blocks future logins and voids
 * existing tokens at resolve time.
 * @param userId - the account to update.
 * @param disabled - the new disabled state.
 * @returns the updated account.
 * @throws {AuthError} `AUTH_USER_NOT_FOUND` for an unknown id.
 */
abstract setDisabled(userId: UserId, disabled: boolean): Promise<AuthUser>
```

Source: [`packages/auth/auth/src/index.ts`](../../packages/auth/auth/src/index.ts)
<!-- END GENERATED cordis-surface -->

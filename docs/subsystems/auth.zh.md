# 认证

[English](auth.md) | 中文

[dsh-auth](../../packages/auth/auth) 的认证 seam 为部署提供账户体系：带品牌标记的用户身份、口令登录、bearer token 解析与账户管理面。本地提供方 [dsh-authn-local](../../packages/auth/authn-local) 以 SQLite 实现它；可选启用的 [dsh-auth bundle](../../packages/bundle/auth-bundle) 同时挂载该提供方与 [dsh-auth-gate](../../packages/auth/auth-gate)——后者提供 `/auth/*` 下的登录与管理页并重定向未认证的页面导航，而 `dsh-client-connection` 对未认证的 `/api` 请求与 WebSocket 升级回答 401。此 seam 默认不挂载任何内容。剩余的里程碑是会话属主绑定——见各包 README 的已知限制。

来源：[`packages/auth/auth/src/index.ts`](../../packages/auth/auth/src/index.ts)

## 账户

每个账户都是一条 `AuthUser`：不含凭据材料，因此消费方不可能泄露它从未见过的哈希。`UserId` 带品牌标记，账户 id 不会与会话、agent 或工具调用 id 混用。

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

## 登录与 token

`login(username, password)` 校验凭据并签发 bearer token。用户名不存在与口令错误以同一 `AUTH_INVALID_CREDENTIALS` 措辞失败，失败通道永不泄露账户是否存在；带 `mustChangePassword` 的账户照常获得 token，因为执行该标志属于闸门消费方。`resolveToken(token)` 把存活 token 映射回账户——未知、过期或属于已禁用账户的 token 一律返回 `null`——并在每次成功时顺延该 token 的过期时间。

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

## 账户管理

管理面——`listUsers`、`createUser`、`resetPassword`、`setDisabled`——经由同一 seam 管理账户。新建账户总是带 `mustChangePassword: true`;`resetPassword` 会重新竖起该标志，而 `changePassword`（要求当前口令）会清除它。失败抛出带稳定 `AuthErrorCode` 的 `AuthError`:`AUTH_INVALID_CREDENTIALS`、`AUTH_USER_DISABLED`、`AUTH_RATE_LIMITED`（带 `retryAfterMs`)、`AUTH_USER_NOT_FOUND`、`AUTH_USERNAME_TAKEN` 与 `AUTH_INVALID_INPUT`。

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

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

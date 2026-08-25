/**
 * Authentication Service Definition (`ctx.authn`) for DeepSeek Harness. The
 * seam resolves bearer tokens to accounts, runs credential login, and exposes
 * the account-management surface; providers own storage and hashing, and
 * consumers (an HTTP gate, a login UI) own enforcement. This package declares
 * the contract only — it mounts nothing by itself.
 * @module @deepseek-ai/dsh-auth
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { AuthLogin, AuthUser, CreateUserInput, UserId } from './types.ts'

export { UserId } from './types.ts'
export type { AuthLogin, AuthRole, AuthUser, CreateUserInput } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    authn: AuthnService
  }
}

/**
 * Stable, machine-routable codes for authentication failures. Consumers branch
 * on these rather than parsing messages.
 */
export type AuthErrorCode =
  | 'AUTH_INVALID_CREDENTIALS'
  | 'AUTH_USER_DISABLED'
  | 'AUTH_RATE_LIMITED'
  | 'AUTH_USER_NOT_FOUND'
  | 'AUTH_USERNAME_TAKEN'
  | 'AUTH_INVALID_INPUT'

/**
 * Typed authentication error. `AUTH_INVALID_CREDENTIALS` deliberately covers
 * both an unknown username and a wrong password with one wording, so the
 * failure channel never reveals whether an account exists.
 */
export class AuthError extends Error {
  /** The stable machine-routable failure code. */
  readonly code: AuthErrorCode
  /** Milliseconds until a rate-limited caller may retry; set only on `AUTH_RATE_LIMITED`. */
  readonly retryAfterMs?: number

  constructor(message: string, code: AuthErrorCode, options?: ErrorOptions & { retryAfterMs?: number }) {
    super(message, options)
    this.name = 'AuthError'
    this.code = code
    if (options?.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs
  }
}

/**
 * Abstract authentication provider mounted as `ctx.authn`. Implementations own
 * the account store, password hashing, and token issuance; every method here
 * is the whole contract consumers may rely on.
 */
export abstract class AuthnService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'authn')
  }

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
}

export default AuthnService

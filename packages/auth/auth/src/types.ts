/**
 * Vocabulary for the authentication Service Definition (`ctx.authn`): the
 * branded user id, the account record, and the login and account-creation
 * shapes providers and consumers exchange.
 * @module @deepseek-ai/dsh-auth/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/**
 * Opaque cross-boundary user identity. Providers mint it; consumers never
 * parse it or assume a storage format.
 */
export type UserId = Branded<'UserId'>

/**
 * Brand a string as a {@link UserId}. For provider use only — a consumer never
 * manufactures an id, it receives one from the service.
 * @param id - the provider's raw id string.
 * @returns the same string, branded; no validation is performed.
 */
export function UserId(id: string): UserId {
  return id as UserId
}

/** The account roles this seam recognizes. */
export type AuthRole = 'superadmin' | 'user'

/**
 * One account as the seam exposes it. It never carries credential material:
 * password hashes and token values stay inside the provider.
 */
export interface AuthUser {
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

/** Result of a successful credential login. */
export interface AuthLogin {
  /** The authenticated account. */
  user: AuthUser
  /**
   * The freshly minted bearer token, presented verbatim to
   * {@link AuthnService.resolveToken}. Providers store only a digest of it.
   */
  token: string
}

/** Account-creation request for {@link AuthnService.createUser}. */
export interface CreateUserInput {
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

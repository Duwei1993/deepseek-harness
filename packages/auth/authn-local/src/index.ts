/**
 * Local SQLite provider for the authentication seam (`ctx.authn`). Accounts
 * live in `auth.db` under the harness home; passwords are scrypt-hashed with
 * per-password salts; bearer tokens are random 32-byte values stored as SHA-256
 * digests with a sliding expiry; and a first boot with an empty store seeds the
 * `superadmin` account with a loud warning.
 * @module @deepseek-ai/dsh-authn-local
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { AuthError, AuthnService, UserId } from '@deepseek-ai/dsh-auth'
import type { AuthLogin, AuthUser, CreateUserInput } from '@deepseek-ai/dsh-auth'
import { hashPassword, verifyPassword } from './passwords.ts'
import { LoginRateLimiter } from './ratelimit.ts'
import { AuthStore } from './store.ts'
import type { StoredUser } from './store.ts'

export { SCHEMA_VERSION } from './store.ts'
export { hashPassword, verifyPassword } from './passwords.ts'

/** Username of the seeded first account. */
export const SUPERADMIN_USERNAME = 'superadmin'
/** Password the seeded account gets when no seed override is configured. Never a safe deployment value. */
export const DEFAULT_SEED_SUPERADMIN_PASSWORD = '123456'
/** Default bearer-token lifetime; every successful resolve slides it forward by this much again. */
export const DEFAULT_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** Lockout the first consecutive credential failure applies. */
export const DEFAULT_RATE_LIMIT_BASE_DELAY_MS = 1_000
/** Longest lockout one failure streak can reach. */
export const DEFAULT_RATE_LIMIT_MAX_DELAY_MS = 300_000

/** Bytes of entropy in a minted bearer token (base64url-encoded on the wire). */
const TOKEN_BYTES = 32

/** Plugin configuration. */
export interface Config {
  /**
   * Database file path, or `:memory:` for an in-process store. Defaults to
   * `auth.db` under the resolved harness home (`$DSH_HOME` > `~/.dsh`).
   */
  path?: string
  /**
   * Password for the seeded superadmin account. A TEST HOOK: without it the
   * seed is the well-known default `123456` and the seed warning names it.
   * Consulted only while the store is empty; later boots ignore it.
   */
  seedSuperadminPassword?: string
  /** Bearer-token lifetime in milliseconds; each resolve slides it forward. Defaults to 7 days. */
  tokenTtlMs?: number
  /** Lockout the first consecutive credential failure applies. Defaults to 1 second. */
  rateLimitBaseDelayMs?: number
  /** Longest lockout one failure streak can reach. Defaults to 5 minutes. */
  rateLimitMaxDelayMs?: number
}

type ResolvedConfig = Required<Omit<Config, 'path' | 'seedSuperadminPassword'>> & Pick<Config, 'path' | 'seedSuperadminPassword'>

/** Test hooks for time-dependent behavior. */
export interface AuthnLocalInternals {
  /** Clock override; defaults to `Date.now`. */
  now?: () => number
}

/** SHA-256 hex digest of a bearer token — the only persisted form. */
function tokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Project a stored row to the seam's account shape, dropping credential material. */
function toAuthUser(row: Omit<StoredUser, 'passwordHash'>): AuthUser {
  return {
    id: UserId(row.id),
    username: row.username,
    displayName: row.displayName,
    role: row.role,
    ...(row.tenant !== null ? { tenant: row.tenant } : {}),
    disabled: row.disabled,
    mustChangePassword: row.mustChangePassword,
  }
}

/**
 * The local authentication provider. The database opens at mount and closes
 * with the owning fiber.
 */
export class LocalAuthnService extends AuthnService {
  static Config: z<Config> = z.object({
    path: z.string(),
    seedSuperadminPassword: z.string(),
    tokenTtlMs: z.number().step(1).min(1_000).default(DEFAULT_TOKEN_TTL_MS),
    rateLimitBaseDelayMs: z.number().step(1).min(1).default(DEFAULT_RATE_LIMIT_BASE_DELAY_MS),
    rateLimitMaxDelayMs: z.number().step(1).min(1).default(DEFAULT_RATE_LIMIT_MAX_DELAY_MS),
  })

  /** Validated config (schemastery applied the defaults before construction). */
  readonly config: ResolvedConfig
  /** Test hook for token-expiry and rate-limit timelines. */
  internals: AuthnLocalInternals = {}

  private store!: AuthStore
  private limiter!: LoginRateLimiter
  /** Standing hash verified for unknown usernames, so absence costs the same scrypt as existence. */
  private unknownUserHash?: string

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.config = config as ResolvedConfig
  }

  /** Open and migrate the database, then seed the superadmin when the store is empty. */
  protected async [Service.init](): Promise<void> {
    const path = this.config.path ?? dshHomePath('auth.db')
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.store = await AuthStore.open({ path })
    const store = this.store
    this.ctx.effect(() => () => {
      store.close()
    })
    this.limiter = new LoginRateLimiter({
      baseDelayMs: this.config.rateLimitBaseDelayMs,
      maxDelayMs: this.config.rateLimitMaxDelayMs,
      now: () => this.now(),
    })
    await this.seedSuperadmin()
  }

  private now(): number {
    return this.internals.now?.() ?? Date.now()
  }

  private async seedSuperadmin(): Promise<void> {
    if (this.store.countUsers() > 0) return
    const configured = this.config.seedSuperadminPassword
    const password = configured ?? DEFAULT_SEED_SUPERADMIN_PASSWORD
    this.store.createUser({
      id: randomUUID(),
      username: SUPERADMIN_USERNAME,
      displayName: 'Superadmin',
      passwordHash: await hashPassword(password),
      role: 'superadmin',
      tenant: null,
      mustChangePassword: true,
      disabled: false,
      createdAt: this.now(),
    })
    const logger = this.ctx.logger
    if (configured === undefined) {
      logger.warn(
        '============================================================\n'
        + ' authn-local seeded the initial superadmin account.\n'
        + `   username: ${SUPERADMIN_USERNAME}\n`
        + `   password: ${DEFAULT_SEED_SUPERADMIN_PASSWORD} (DEFAULT — change it immediately)\n`
        + ' The account is flagged mustChangePassword; sign in and\n'
        + ' rotate it before ordinary use (the auth gate enforces this\n'
        + ' for web page navigations when mounted).\n'
        + '============================================================',
      )
      return
    }
    logger.warn(
      `authn-local seeded the initial superadmin account "${SUPERADMIN_USERNAME}" from the`
      + ' configured seed password; the account is flagged mustChangePassword.',
    )
  }

  resolveToken(token: string): Promise<AuthUser | null> {
    const row = this.store.findToken(tokenDigest(token))
    if (row === undefined) return Promise.resolve(null)
    if (row.expiresAt <= this.now()) {
      this.store.deleteToken(row.tokenHash)
      return Promise.resolve(null)
    }
    const user = this.store.findUserById(row.userId)
    if (user === undefined || user.disabled) return Promise.resolve(null)
    this.store.touchToken(row.tokenHash, this.now() + this.config.tokenTtlMs)
    return Promise.resolve(toAuthUser(user))
  }

  async login(username: string, password: string): Promise<AuthLogin> {
    this.limiter.check(username)
    const user = this.store.findUserByUsername(username)
    // Unknown usernames verify against a standing hash so the failure timing
    // matches a wrong password and never reveals whether the account exists.
    const hash = user?.passwordHash ?? (this.unknownUserHash ??= await hashPassword(randomBytes(16).toString('hex')))
    if (!(await verifyPassword(password, hash)) || user === undefined) {
      this.limiter.recordFailure(username)
      throw new AuthError('invalid username or password', 'AUTH_INVALID_CREDENTIALS')
    }
    this.limiter.recordSuccess(username)
    if (user.disabled) {
      throw new AuthError('this account is disabled', 'AUTH_USER_DISABLED')
    }
    if (user.mustChangePassword) {
      this.ctx.logger.warn(
        `user "${user.username}" logged in with a password that must be changed (mustChangePassword)`,
      )
    }
    const token = randomBytes(TOKEN_BYTES).toString('base64url')
    const issued = this.now()
    this.store.insertToken({
      tokenHash: tokenDigest(token),
      userId: user.id,
      expiresAt: issued + this.config.tokenTtlMs,
      createdAt: issued,
    })
    return { user: toAuthUser(user), token }
  }

  async changePassword(userId: UserId, oldPassword: string, newPassword: string): Promise<AuthUser> {
    const user = this.requireUser(userId)
    if (!(await verifyPassword(oldPassword, user.passwordHash))) {
      throw new AuthError('invalid username or password', 'AUTH_INVALID_CREDENTIALS')
    }
    this.requirePassword(newPassword)
    this.store.updatePassword(user.id, await hashPassword(newPassword), false)
    return toAuthUser({ ...user, mustChangePassword: false })
  }

  listUsers(): Promise<AuthUser[]> {
    return Promise.resolve(this.store.listUsers().map(toAuthUser))
  }

  async createUser(input: CreateUserInput): Promise<AuthUser> {
    if (input.username.trim().length === 0) {
      throw new AuthError('username must not be empty', 'AUTH_INVALID_INPUT')
    }
    this.requirePassword(input.password)
    if (this.store.findUserByUsername(input.username) !== undefined) {
      throw new AuthError(`username ${JSON.stringify(input.username)} is already taken`, 'AUTH_USERNAME_TAKEN')
    }
    const row: StoredUser = {
      id: randomUUID(),
      username: input.username,
      displayName: input.displayName ?? input.username,
      passwordHash: await hashPassword(input.password),
      role: input.role ?? 'user',
      tenant: input.tenant ?? null,
      mustChangePassword: true,
      disabled: false,
      createdAt: this.now(),
    }
    this.store.createUser(row)
    return toAuthUser(row)
  }

  async resetPassword(userId: UserId, newPassword: string): Promise<AuthUser> {
    const user = this.requireUser(userId)
    this.requirePassword(newPassword)
    this.store.updatePassword(user.id, await hashPassword(newPassword), true)
    return toAuthUser({ ...user, mustChangePassword: true })
  }

  setDisabled(userId: UserId, disabled: boolean): Promise<AuthUser> {
    const user = this.store.findUserById(userId)
    if (user === undefined) return Promise.reject(new AuthError('no such user', 'AUTH_USER_NOT_FOUND'))
    this.store.setDisabled(user.id, disabled)
    return Promise.resolve(toAuthUser({ ...user, disabled }))
  }

  private requireUser(userId: UserId): StoredUser {
    const user = this.store.findUserById(userId)
    if (user === undefined) throw new AuthError('no such user', 'AUTH_USER_NOT_FOUND')
    return user
  }

  private requirePassword(password: string): void {
    if (password.length === 0) {
      throw new AuthError('password must not be empty', 'AUTH_INVALID_INPUT')
    }
  }
}

export default LocalAuthnService

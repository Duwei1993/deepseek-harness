/**
 * SQLite account store for the local authentication provider. Owns the schema
 * (a monotonic `PRAGMA user_version` migration ladder), durable-row decoding,
 * and every statement the service runs. The store is synchronous because
 * `node:sqlite` is; the service layer exposes the seam's async contract.
 * @module @deepseek-ai/dsh-authn-local/store
 */

import type { DatabaseSync } from 'node:sqlite'
import { AuthError, type AuthRole } from '@deepseek-ai/dsh-auth'

const MIGRATIONS: readonly (readonly string[])[] = [
  // 0 -> 1: accounts, M3b-reserved external identity links, and bearer tokens.
  [
    `CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('superadmin', 'user')),
      tenant TEXT,
      must_change_password INTEGER NOT NULL,
      disabled INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE external_identities (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users (id),
      provider TEXT NOT NULL,
      subject TEXT NOT NULL,
      linked_at INTEGER NOT NULL,
      UNIQUE (provider, subject)
    )`,
    `CREATE TABLE auth_tokens (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users (id),
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    'CREATE INDEX idx_auth_tokens_user ON auth_tokens (user_id)',
    'CREATE INDEX idx_external_identities_user ON external_identities (user_id)',
  ],
]

/**
 * Current auth database schema version, derived from the migration ladder so
 * it can never disagree with it. Migrations are append-only: version N is
 * `MIGRATIONS[N]` applied over version N-1, and a database newer than this
 * build fails loud instead of being read past.
 */
export const SCHEMA_VERSION = MIGRATIONS.length

/** One decoded durable user row; the storage form of `AuthUser` plus its hash. */
export interface StoredUser {
  readonly id: string
  readonly username: string
  readonly displayName: string
  readonly passwordHash: string
  readonly role: AuthRole
  readonly tenant: string | null
  readonly mustChangePassword: boolean
  readonly disabled: boolean
  readonly createdAt: number
}

/** One decoded durable bearer-token row; the token itself is never stored. */
export interface StoredToken {
  readonly tokenHash: string
  readonly userId: string
  readonly expiresAt: number
  readonly createdAt: number
}

/** Fields {@link AuthStore.createUser} persists; the service computes them all. */
export interface NewUser {
  readonly id: string
  readonly username: string
  readonly displayName: string
  readonly passwordHash: string
  readonly role: AuthRole
  readonly tenant: string | null
  readonly mustChangePassword: boolean
  readonly disabled: boolean
  readonly createdAt: number
}

/** Fields {@link AuthStore.insertToken} persists. */
export interface NewToken {
  readonly tokenHash: string
  readonly userId: string
  readonly expiresAt: number
  readonly createdAt: number
}

/** Fields {@link AuthStore.linkExternalIdentity} persists (M3b OIDC plumbing). */
export interface NewExternalIdentity {
  readonly id: string
  readonly userId: string
  readonly provider: string
  readonly subject: string
  readonly linkedAt: number
}

function recordOf(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function stringField(row: Record<string, unknown>, key: string): string {
  const field = row[key]
  if (typeof field !== 'string') throw new Error(`stored ${key} must be a string`)
  return field
}

function nullableStringField(row: Record<string, unknown>, key: string): string | null {
  const field = row[key]
  if (field === null) return null
  if (typeof field !== 'string') throw new Error(`stored ${key} must be a string or null`)
  return field
}

function flagField(row: Record<string, unknown>, key: string): boolean {
  const field = row[key]
  if (field !== 0 && field !== 1) throw new Error(`stored ${key} must be 0 or 1`)
  return field === 1
}

function integerField(row: Record<string, unknown>, key: string): number {
  const field = row[key]
  if (typeof field !== 'number' || !Number.isSafeInteger(field)) {
    throw new Error(`stored ${key} must be a safe integer`)
  }
  return field
}

/**
 * Decode and validate one durable user row. Durable storage is a trust
 * boundary: a row this build cannot interpret fails loud on read.
 * @param value - the raw row SQLite returned.
 * @returns the validated row.
 */
export function decodeStoredUser(value: unknown): StoredUser {
  const row = recordOf(value, 'stored user')
  const role = stringField(row, 'role')
  if (role !== 'superadmin' && role !== 'user') {
    throw new Error(`stored user role must be superadmin or user, got ${JSON.stringify(role)}`)
  }
  return {
    id: stringField(row, 'id'),
    username: stringField(row, 'username'),
    displayName: stringField(row, 'display_name'),
    passwordHash: stringField(row, 'password_hash'),
    role,
    tenant: nullableStringField(row, 'tenant'),
    mustChangePassword: flagField(row, 'must_change_password'),
    disabled: flagField(row, 'disabled'),
    createdAt: integerField(row, 'created_at'),
  }
}

/**
 * Decode and validate one durable token row.
 * @param value - the raw row SQLite returned.
 * @returns the validated row.
 */
export function decodeStoredToken(value: unknown): StoredToken {
  const row = recordOf(value, 'stored token')
  return {
    tokenHash: stringField(row, 'token_hash'),
    userId: stringField(row, 'user_id'),
    expiresAt: integerField(row, 'expires_at'),
    createdAt: integerField(row, 'created_at'),
  }
}

function userVersion(db: DatabaseSync): number {
  const row = recordOf(db.prepare('PRAGMA user_version').get(), 'user_version pragma')
  return integerField(row, 'user_version')
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'errcode') === 2067
}

function migrate(db: DatabaseSync, path: string): void {
  const current = userVersion(db)
  if (current > SCHEMA_VERSION) {
    throw new Error(
      `auth database at "${path}" has schema version ${current}, newer than this build supports (${SCHEMA_VERSION})`,
    )
  }
  if (current === SCHEMA_VERSION) return
  db.exec('BEGIN')
  try {
    for (const statements of MIGRATIONS.slice(current)) {
      for (const statement of statements) db.exec(statement)
    }
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/** Options for {@link AuthStore.open}. */
export interface AuthStoreOptions {
  /** Database file path, or `:memory:` for an in-process store. */
  path: string
}

/**
 * The local account store. One instance owns one open database; the owning
 * service closes it on dispose.
 */
export class AuthStore {
  private constructor(private readonly db: DatabaseSync) {}

  /**
   * Open the database and migrate it to {@link SCHEMA_VERSION}.
   * @param options - the database location.
   * @returns the open store.
   * @throws when the on-disk schema is newer than this build or migration fails.
   */
  static async open(options: AuthStoreOptions): Promise<AuthStore> {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(options.path)
    try {
      db.exec('PRAGMA foreign_keys = ON')
      migrate(db, options.path)
    } catch (error: unknown) {
      db.close()
      throw error
    }
    return new AuthStore(db)
  }

  /** Close the database; every later statement throws. */
  close(): void {
    this.db.close()
  }

  /**
   * Count all accounts.
   * @returns the number of rows in `users`; the seed check keys off zero.
   */
  countUsers(): number {
    const row = recordOf(this.db.prepare('SELECT COUNT(*) AS count FROM users').get(), 'user count')
    return integerField(row, 'count')
  }

  /**
   * Persist one account.
   * @param user - the complete row to insert.
   * @throws {AuthError} `AUTH_USERNAME_TAKEN` on a username collision.
   */
  createUser(user: NewUser): void {
    try {
      this.db.prepare(
        `INSERT INTO users (id, username, display_name, password_hash, role, tenant, must_change_password, disabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        user.id,
        user.username,
        user.displayName,
        user.passwordHash,
        user.role,
        user.tenant,
        user.mustChangePassword ? 1 : 0,
        user.disabled ? 1 : 0,
        user.createdAt,
      )
    } catch (error: unknown) {
      if (isUniqueViolation(error)) {
        throw new AuthError(`username ${JSON.stringify(user.username)} is already taken`, 'AUTH_USERNAME_TAKEN', { cause: error })
      }
      throw error
    }
  }

  /**
   * Look an account up by exact username.
   * @param username - the login name.
   * @returns the row, or `undefined` when absent.
   */
  findUserByUsername(username: string): StoredUser | undefined {
    const row = this.db.prepare('SELECT * FROM users WHERE username = ?').get(username)
    return row === undefined ? undefined : decodeStoredUser(row)
  }

  /**
   * Look an account up by id.
   * @param id - the account id.
   * @returns the row, or `undefined` when absent.
   */
  findUserById(id: string): StoredUser | undefined {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id)
    return row === undefined ? undefined : decodeStoredUser(row)
  }

  /**
   * List every account in stable username order.
   * @returns all account rows.
   */
  listUsers(): StoredUser[] {
    return this.db.prepare('SELECT * FROM users ORDER BY username').all().map(decodeStoredUser)
  }

  /**
   * Replace an account's password hash and reset its change flag.
   * @param id - the account id.
   * @param passwordHash - the new `saltHex:hashHex` record.
   * @param mustChangePassword - the new flag value.
   */
  updatePassword(id: string, passwordHash: string, mustChangePassword: boolean): void {
    this.db.prepare('UPDATE users SET password_hash = ?, must_change_password = ? WHERE id = ?')
      .run(passwordHash, mustChangePassword ? 1 : 0, id)
  }

  /**
   * Set an account's disabled flag.
   * @param id - the account id.
   * @param disabled - the new flag value.
   */
  setDisabled(id: string, disabled: boolean): void {
    this.db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(disabled ? 1 : 0, id)
  }

  /**
   * Persist one bearer token by its digest.
   * @param token - the token row to insert.
   */
  insertToken(token: NewToken): void {
    this.db.prepare(
      'INSERT INTO auth_tokens (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
    ).run(token.tokenHash, token.userId, token.expiresAt, token.createdAt)
  }

  /**
   * Look a token up by its digest.
   * @param tokenHash - the token's SHA-256 hex digest.
   * @returns the row, or `undefined` when absent.
   */
  findToken(tokenHash: string): StoredToken | undefined {
    const row = this.db.prepare('SELECT * FROM auth_tokens WHERE token_hash = ?').get(tokenHash)
    return row === undefined ? undefined : decodeStoredToken(row)
  }

  /**
   * Slide a token's expiry forward.
   * @param tokenHash - the token's digest.
   * @param expiresAt - the new expiry, milliseconds since the epoch.
   */
  touchToken(tokenHash: string, expiresAt: number): void {
    this.db.prepare('UPDATE auth_tokens SET expires_at = ? WHERE token_hash = ?').run(expiresAt, tokenHash)
  }

  /**
   * Delete a token (used when an expired one is observed).
   * @param tokenHash - the token's digest.
   */
  deleteToken(tokenHash: string): void {
    this.db.prepare('DELETE FROM auth_tokens WHERE token_hash = ?').run(tokenHash)
  }

  /**
   * Link an external identity (M3b OIDC plumbing; not reachable through the
   * service surface yet).
   * @param identity - the link row to insert.
   * @throws on a duplicate `(provider, subject)` pair.
   */
  linkExternalIdentity(identity: NewExternalIdentity): void {
    try {
      this.db.prepare(
        `INSERT INTO external_identities (id, user_id, provider, subject, linked_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(identity.id, identity.userId, identity.provider, identity.subject, identity.linkedAt)
    } catch (error: unknown) {
      if (isUniqueViolation(error)) {
        throw new Error(
          `external identity ${identity.provider}:${identity.subject} is already linked`,
          { cause: error },
        )
      }
      throw error
    }
  }

  /**
   * Resolve an external identity to its account.
   * @param provider - the external provider name.
   * @param subject - the provider-side subject id.
   * @returns the linked account row, or `undefined` when unlinked.
   */
  findUserByExternalIdentity(provider: string, subject: string): StoredUser | undefined {
    const row = this.db.prepare(
      `SELECT users.* FROM external_identities
       JOIN users ON users.id = external_identities.user_id
       WHERE external_identities.provider = ? AND external_identities.subject = ?`,
    ).get(provider, subject)
    return row === undefined ? undefined : decodeStoredUser(row)
  }
}

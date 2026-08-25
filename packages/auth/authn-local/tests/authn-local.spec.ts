import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AuthError, UserId } from '@deepseek-ai/dsh-auth'
import { DEFAULT_SEED_SUPERADMIN_PASSWORD, LocalAuthnService, SUPERADMIN_USERNAME } from '../src/index.ts'

const DAY_MS = 24 * 60 * 60 * 1000

let dir: string
let ctx: Context
let fiber: Awaited<ReturnType<Context['plugin']>>
let service: LocalAuthnService
let now: number
let warn: MockInstance

async function mount(config: Record<string, unknown> = {}): Promise<void> {
  fiber = await ctx.plugin(LocalAuthnService, { path: join(dir, 'auth.db'), ...config })
  service = ctx.authn as LocalAuthnService
  now = 1_800_000_000_000
  service.internals.now = () => now
}

function warnings(): string[] {
  return warn.mock.calls.map(call => String(call[0]))
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-authn-'))
  ctx = new Context()
  warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
})

afterEach(async () => {
  await fiber.dispose()
  rmSync(dir, { recursive: true, force: true })
})

describe('seeding', () => {
  it('seeds superadmin/123456 with mustChangePassword on an empty store, and warns loudly', async () => {
    await mount()
    const login = await ctx.authn.login(SUPERADMIN_USERNAME, DEFAULT_SEED_SUPERADMIN_PASSWORD)
    expect(login.user).toMatchObject({
      username: SUPERADMIN_USERNAME,
      role: 'superadmin',
      disabled: false,
      mustChangePassword: true,
    })
    const seeded = warnings().find(text => text.includes('seeded the initial superadmin account'))
    expect(seeded).toBeDefined()
    expect(seeded).toContain(DEFAULT_SEED_SUPERADMIN_PASSWORD)
  })

  it('honors the configured seed password and never names it in the warning', async () => {
    await mount({ seedSuperadminPassword: 'configured-pw' })
    await expect(ctx.authn.login(SUPERADMIN_USERNAME, 'configured-pw')).resolves.toBeDefined()
    await expect(ctx.authn.login(SUPERADMIN_USERNAME, DEFAULT_SEED_SUPERADMIN_PASSWORD)).rejects.toThrow(AuthError)
    const seeded = warnings().find(text => text.includes('seeded the initial superadmin account'))
    expect(seeded).toBeDefined()
    expect(seeded).not.toContain('configured-pw')
  })

  it('is idempotent: a second boot over the same store seeds nothing and keeps rotated passwords', async () => {
    await mount()
    const login = await ctx.authn.login(SUPERADMIN_USERNAME, DEFAULT_SEED_SUPERADMIN_PASSWORD)
    await ctx.authn.changePassword(login.user.id, DEFAULT_SEED_SUPERADMIN_PASSWORD, 'rotated')
    await fiber.dispose()
    fiber = await ctx.plugin(LocalAuthnService, { path: join(dir, 'auth.db') })
    service = ctx.authn as LocalAuthnService
    service.internals.now = () => now
    await expect(ctx.authn.login(SUPERADMIN_USERNAME, 'rotated')).resolves.toBeDefined()
    await expect(ctx.authn.login(SUPERADMIN_USERNAME, DEFAULT_SEED_SUPERADMIN_PASSWORD)).rejects.toThrow(AuthError)
    expect(warnings().filter(text => text.includes('seeded the initial superadmin account'))).toHaveLength(1)
  })

  it('defaults the database path to auth.db under the harness home', async () => {
    const home = join(dir, 'home')
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      fiber = await ctx.plugin(LocalAuthnService, {})
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
    service = ctx.authn as LocalAuthnService
    expect(existsSync(join(home, 'auth.db'))).toBe(true)
    await expect(ctx.authn.login(SUPERADMIN_USERNAME, DEFAULT_SEED_SUPERADMIN_PASSWORD)).resolves.toBeDefined()
  })
})

describe('login', () => {
  it('rejects an unknown username and a wrong password with one shared wording', async () => {
    await mount()
    const wrongPassword = await ctx.authn.login(SUPERADMIN_USERNAME, 'nope').catch((error: unknown) => error)
    now += 60_000
    const unknownUser = await ctx.authn.login('nobody', 'nope').catch((error: unknown) => error)
    // A second unknown-user login reuses the standing timing hash.
    now += 300_000
    const unknownUserAgain = await ctx.authn.login('nobody', 'nope').catch((error: unknown) => error)
    for (const error of [wrongPassword, unknownUser, unknownUserAgain]) {
      expect(error).toBeInstanceOf(AuthError)
      expect((error as AuthError).code).toBe('AUTH_INVALID_CREDENTIALS')
      expect((error as AuthError).message).toBe('invalid username or password')
    }
  })

  it('warns on every login while mustChangePassword is set, without withholding the token', async () => {
    await mount()
    await ctx.authn.login(SUPERADMIN_USERNAME, DEFAULT_SEED_SUPERADMIN_PASSWORD)
    await ctx.authn.login(SUPERADMIN_USERNAME, DEFAULT_SEED_SUPERADMIN_PASSWORD)
    const notices = warnings().filter(text => text.includes('must be changed'))
    expect(notices).toHaveLength(2)
  })

  it('rejects a disabled account after verifying its credentials', async () => {
    await mount()
    const login = await ctx.authn.login(SUPERADMIN_USERNAME, DEFAULT_SEED_SUPERADMIN_PASSWORD)
    await ctx.authn.setDisabled(login.user.id, true)
    const error = await ctx.authn.login(SUPERADMIN_USERNAME, DEFAULT_SEED_SUPERADMIN_PASSWORD).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(AuthError)
    expect((error as AuthError).code).toBe('AUTH_USER_DISABLED')
    // Wrong credentials on a disabled account still report the shared wording.
    const wrong = await ctx.authn.login(SUPERADMIN_USERNAME, 'nope').catch((caught: unknown) => caught)
    expect((wrong as AuthError).code).toBe('AUTH_INVALID_CREDENTIALS')
  })

  it('rate-limits a failure streak and rejects even correct credentials during the lockout', async () => {
    await mount()
    await expect(ctx.authn.login(SUPERADMIN_USERNAME, 'nope')).rejects.toThrow(AuthError)
    const limited = await ctx.authn.login(SUPERADMIN_USERNAME, DEFAULT_SEED_SUPERADMIN_PASSWORD).catch((error: unknown) => error)
    expect(limited).toBeInstanceOf(AuthError)
    expect((limited as AuthError).code).toBe('AUTH_RATE_LIMITED')
    expect((limited as AuthError).retryAfterMs).toBeGreaterThan(0)
    now += 1_000
    await expect(ctx.authn.login(SUPERADMIN_USERNAME, DEFAULT_SEED_SUPERADMIN_PASSWORD)).resolves.toBeDefined()
  })
})

describe('resolveToken', () => {
  it('resolves a live token and slides its expiry forward on every resolve', async () => {
    await mount({ tokenTtlMs: 7 * DAY_MS })
    const { token, user } = await ctx.authn.login(SUPERADMIN_USERNAME, DEFAULT_SEED_SUPERADMIN_PASSWORD)
    expect(await ctx.authn.resolveToken(token)).toEqual(user)
    now += 6 * DAY_MS
    expect(await ctx.authn.resolveToken(token)).not.toBeNull()
    // The resolve above re-armed expiry to now + 7d, so 7d - 1s later it still resolves.
    now += 7 * DAY_MS - 1_000
    expect(await ctx.authn.resolveToken(token)).not.toBeNull()
    // Without a resolve the slide stops and the token dies.
    now += 8 * DAY_MS
    expect(await ctx.authn.resolveToken(token)).toBeNull()
  })

  it('deletes an expired token when observed', async () => {
    await mount()
    const { token } = await ctx.authn.login(SUPERADMIN_USERNAME, DEFAULT_SEED_SUPERADMIN_PASSWORD)
    now += 8 * DAY_MS
    expect(await ctx.authn.resolveToken(token)).toBeNull()
    const raw = new DatabaseSync(join(dir, 'auth.db'))
    try {
      expect(raw.prepare('SELECT COUNT(*) AS count FROM auth_tokens').get()).toEqual({ count: 0 })
    } finally {
      raw.close()
    }
  })

  it('returns null for unknown and tampered tokens', async () => {
    await mount()
    expect(await ctx.authn.resolveToken('not-a-token')).toBeNull()
    const { token } = await ctx.authn.login(SUPERADMIN_USERNAME, DEFAULT_SEED_SUPERADMIN_PASSWORD)
    expect(await ctx.authn.resolveToken(`${token}x`)).toBeNull()
  })

  it('returns null for a disabled account\'s token without deleting it', async () => {
    await mount()
    const { token, user } = await ctx.authn.login(SUPERADMIN_USERNAME, DEFAULT_SEED_SUPERADMIN_PASSWORD)
    await ctx.authn.setDisabled(user.id, true)
    expect(await ctx.authn.resolveToken(token)).toBeNull()
    await ctx.authn.setDisabled(user.id, false)
    expect(await ctx.authn.resolveToken(token)).toMatchObject({ username: SUPERADMIN_USERNAME })
  })

  it('returns null for a token whose account row is gone', async () => {
    await mount()
    const { createHash } = await import('node:crypto')
    const token = 'orphaned-token'
    const raw = new DatabaseSync(join(dir, 'auth.db'))
    try {
      raw.exec('PRAGMA foreign_keys = OFF')
      raw.prepare('INSERT INTO auth_tokens (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
        .run(createHash('sha256').update(token).digest('hex'), 'u-gone', now + 60_000, now)
    } finally {
      raw.close()
    }
    expect(await ctx.authn.resolveToken(token)).toBeNull()
  })
})

describe('account management', () => {
  it('changePassword verifies the old password and clears mustChangePassword', async () => {
    await mount()
    const { user } = await ctx.authn.login(SUPERADMIN_USERNAME, DEFAULT_SEED_SUPERADMIN_PASSWORD)
    const wrong = await ctx.authn.changePassword(user.id, 'nope', 'new-pw').catch((error: unknown) => error)
    expect((wrong as AuthError).code).toBe('AUTH_INVALID_CREDENTIALS')
    const updated = await ctx.authn.changePassword(user.id, DEFAULT_SEED_SUPERADMIN_PASSWORD, 'new-pw')
    expect(updated.mustChangePassword).toBe(false)
    await expect(ctx.authn.login(SUPERADMIN_USERNAME, DEFAULT_SEED_SUPERADMIN_PASSWORD)).rejects.toThrow(AuthError)
    // The failed attempt above locks the username briefly; wait it out.
    now += 60_000
    await expect(ctx.authn.login(SUPERADMIN_USERNAME, 'new-pw')).resolves.toBeDefined()
    expect(warnings().filter(text => text.includes('must be changed'))).toHaveLength(1)
  })

  it('changePassword rejects an unknown user and an empty new password', async () => {
    await mount()
    const { user } = await ctx.authn.login(SUPERADMIN_USERNAME, DEFAULT_SEED_SUPERADMIN_PASSWORD)
    const missing = await ctx.authn.changePassword(UserId('u-gone'), 'a', 'b').catch((error: unknown) => error)
    expect((missing as AuthError).code).toBe('AUTH_USER_NOT_FOUND')
    const empty = await ctx.authn.changePassword(user.id, DEFAULT_SEED_SUPERADMIN_PASSWORD, '').catch((error: unknown) => error)
    expect((empty as AuthError).code).toBe('AUTH_INVALID_INPUT')
  })

  it('createUser applies the documented defaults and round-trips through listUsers', async () => {
    await mount()
    const created = await ctx.authn.createUser({ username: 'alice', password: 'alice-pw', tenant: 'acme' })
    expect(created).toMatchObject({
      username: 'alice', displayName: 'alice', role: 'user', tenant: 'acme', disabled: false, mustChangePassword: true,
    })
    const withRole = await ctx.authn.createUser({ username: 'bob', password: 'bob-pw', role: 'superadmin', displayName: 'Bob' })
    expect(withRole).toMatchObject({ role: 'superadmin', displayName: 'Bob' })
    expect(withRole.tenant).toBeUndefined()
    const users = await ctx.authn.listUsers()
    expect(users.map(user => user.username)).toEqual(['alice', 'bob', SUPERADMIN_USERNAME])
    await expect(ctx.authn.login('alice', 'alice-pw')).resolves.toBeDefined()
  })

  it('createUser rejects duplicates and empty input', async () => {
    await mount()
    const duplicate = await ctx.authn.createUser({ username: SUPERADMIN_USERNAME, password: 'x' }).catch((error: unknown) => error)
    expect((duplicate as AuthError).code).toBe('AUTH_USERNAME_TAKEN')
    const emptyName = await ctx.authn.createUser({ username: '   ', password: 'x' }).catch((error: unknown) => error)
    expect((emptyName as AuthError).code).toBe('AUTH_INVALID_INPUT')
    const emptyPassword = await ctx.authn.createUser({ username: 'alice', password: '' }).catch((error: unknown) => error)
    expect((emptyPassword as AuthError).code).toBe('AUTH_INVALID_INPUT')
  })

  it('resetPassword rotates without the old password and sets mustChangePassword', async () => {
    await mount()
    const { user } = await ctx.authn.login(SUPERADMIN_USERNAME, DEFAULT_SEED_SUPERADMIN_PASSWORD)
    const updated = await ctx.authn.resetPassword(user.id, 'reset-pw')
    expect(updated.mustChangePassword).toBe(true)
    await expect(ctx.authn.login(SUPERADMIN_USERNAME, DEFAULT_SEED_SUPERADMIN_PASSWORD)).rejects.toThrow(AuthError)
    now += 60_000
    await expect(ctx.authn.login(SUPERADMIN_USERNAME, 'reset-pw')).resolves.toBeDefined()
    const missing = await ctx.authn.resetPassword(UserId('u-gone'), 'x').catch((error: unknown) => error)
    expect((missing as AuthError).code).toBe('AUTH_USER_NOT_FOUND')
    const empty = await ctx.authn.resetPassword(user.id, '').catch((error: unknown) => error)
    expect((empty as AuthError).code).toBe('AUTH_INVALID_INPUT')
  })

  it('setDisabled round-trips and rejects an unknown user', async () => {
    await mount()
    const { user } = await ctx.authn.login(SUPERADMIN_USERNAME, DEFAULT_SEED_SUPERADMIN_PASSWORD)
    expect((await ctx.authn.setDisabled(user.id, true)).disabled).toBe(true)
    expect((await ctx.authn.setDisabled(user.id, false)).disabled).toBe(false)
    const missing = await ctx.authn.setDisabled(UserId('u-gone'), true).catch((error: unknown) => error)
    expect((missing as AuthError).code).toBe('AUTH_USER_NOT_FOUND')
  })
})

describe('lifecycle', () => {
  it('closes the database with the owning fiber', async () => {
    await mount()
    await fiber.dispose()
    // Disposal closed the store; a remount over the same file reopens cleanly.
    fiber = await ctx.plugin(LocalAuthnService, { path: join(dir, 'auth.db') })
    service = ctx.authn as LocalAuthnService
    await expect(ctx.authn.listUsers()).resolves.toHaveLength(1)
  })

  it('serves the service over an in-memory database', async () => {
    fiber = await ctx.plugin(LocalAuthnService, { path: ':memory:' })
    service = ctx.authn as LocalAuthnService
    await expect(ctx.authn.login(SUPERADMIN_USERNAME, DEFAULT_SEED_SUPERADMIN_PASSWORD)).resolves.toBeDefined()
  })
})

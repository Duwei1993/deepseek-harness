import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { AuthError } from '@deepseek-ai/dsh-auth'
import { AuthStore, SCHEMA_VERSION, decodeStoredToken, decodeStoredUser } from '../src/store.ts'
import type { NewUser } from '../src/store.ts'

const dirs: string[] = []
const stores: AuthStore[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-authn-store-'))
  dirs.push(dir)
  return dir
}

async function openStore(path = join(tempDir(), 'auth.db')): Promise<AuthStore> {
  const store = await AuthStore.open({ path })
  stores.push(store)
  return store
}

function newUser(overrides: Partial<NewUser> = {}): NewUser {
  return {
    id: 'u-1',
    username: 'alice',
    displayName: 'Alice',
    passwordHash: 'salt:hash',
    role: 'user',
    tenant: null,
    mustChangePassword: false,
    disabled: false,
    createdAt: 1_000,
    ...overrides,
  }
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('AuthStore.open', () => {
  it('creates the schema at the current version on a fresh database', async () => {
    const path = join(tempDir(), 'auth.db')
    await openStore(path)
    const raw = new DatabaseSync(path)
    try {
      expect(raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: SCHEMA_VERSION })
      const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
        .map(row => (row as { name: string }).name)
      expect(tables).toEqual(['auth_tokens', 'external_identities', 'users'])
    } finally {
      raw.close()
    }
  })

  it('reopens an existing database without re-running migrations', async () => {
    const path = join(tempDir(), 'auth.db')
    const first = await openStore(path)
    first.createUser(newUser())
    first.close()
    stores.splice(stores.indexOf(first), 1)
    const second = await openStore(path)
    expect(second.findUserByUsername('alice')).toMatchObject({ id: 'u-1', role: 'user' })
  })

  it('rejects a database newer than this build', async () => {
    const path = join(tempDir(), 'auth.db')
    const raw = new DatabaseSync(path)
    raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`)
    raw.close()
    await expect(AuthStore.open({ path })).rejects.toThrow(/newer than this build/)
  })

  it('rolls a failed migration back, leaving the database unversioned', async () => {
    const path = join(tempDir(), 'auth.db')
    const raw = new DatabaseSync(path)
    raw.exec('CREATE TABLE users (collision TEXT)')
    raw.close()
    await expect(AuthStore.open({ path })).rejects.toThrow()
    const check = new DatabaseSync(path)
    try {
      expect(check.prepare('PRAGMA user_version').get()).toEqual({ user_version: 0 })
    } finally {
      check.close()
    }
  })

  it('supports an in-memory database', async () => {
    const store = await openStore(':memory:')
    expect(store.countUsers()).toBe(0)
  })
})

describe('user rows', () => {
  it('creates and finds users by username and id, and lists them in username order', async () => {
    const store = await openStore()
    store.createUser(newUser({ id: 'u-2', username: 'bob', tenant: 'acme' }))
    store.createUser(newUser({ id: 'u-1', username: 'alice' }))
    expect(store.findUserByUsername('alice')).toMatchObject({ id: 'u-1', tenant: null })
    expect(store.findUserById('u-2')).toMatchObject({ username: 'bob', tenant: 'acme' })
    expect(store.listUsers().map(user => user.username)).toEqual(['alice', 'bob'])
  })

  it('returns undefined for absent lookups', async () => {
    const store = await openStore()
    expect(store.findUserByUsername('nobody')).toBeUndefined()
    expect(store.findUserById('nobody')).toBeUndefined()
  })

  it('persists set flags as 1', async () => {
    const store = await openStore()
    store.createUser(newUser({ mustChangePassword: true, disabled: true }))
    expect(store.findUserById('u-1')).toMatchObject({ mustChangePassword: true, disabled: true })
  })

  it('rejects a duplicate username with AUTH_USERNAME_TAKEN', async () => {
    const store = await openStore()
    store.createUser(newUser())
    expect(() => {
      store.createUser(newUser({ id: 'u-2' }))
    }).toThrow(AuthError)
    try {
      store.createUser(newUser({ id: 'u-2' }))
    } catch (error) {
      expect((error as AuthError).code).toBe('AUTH_USERNAME_TAKEN')
    }
  })

  it('rethrows non-constraint write failures', async () => {
    const store = await openStore()
    store.close()
    stores.splice(stores.indexOf(store), 1)
    expect(() => {
      store.createUser(newUser())
    }).toThrow(/not open|closed/)
    expect(() => {
      store.linkExternalIdentity({ id: 'e-1', userId: 'u-1', provider: 'oidc', subject: 's-1', linkedAt: 0 })
    }).toThrow(/not open|closed/)
  })

  it('updates the password hash and the change flag', async () => {
    const store = await openStore()
    store.createUser(newUser())
    store.updatePassword('u-1', 'salt2:hash2', true)
    expect(store.findUserById('u-1')).toMatchObject({ passwordHash: 'salt2:hash2', mustChangePassword: true })
    store.updatePassword('u-1', 'salt3:hash3', false)
    expect(store.findUserById('u-1')).toMatchObject({ passwordHash: 'salt3:hash3', mustChangePassword: false })
  })

  it('flips the disabled flag', async () => {
    const store = await openStore()
    store.createUser(newUser())
    store.setDisabled('u-1', true)
    expect(store.findUserById('u-1')?.disabled).toBe(true)
    store.setDisabled('u-1', false)
    expect(store.findUserById('u-1')?.disabled).toBe(false)
  })
})

describe('token rows', () => {
  it('inserts, finds, touches, and deletes tokens by digest', async () => {
    const store = await openStore()
    store.createUser(newUser())
    store.insertToken({ tokenHash: 'h-1', userId: 'u-1', expiresAt: 10_000, createdAt: 1_000 })
    expect(store.findToken('h-1')).toEqual({ tokenHash: 'h-1', userId: 'u-1', expiresAt: 10_000, createdAt: 1_000 })
    store.touchToken('h-1', 20_000)
    expect(store.findToken('h-1')?.expiresAt).toBe(20_000)
    store.deleteToken('h-1')
    expect(store.findToken('h-1')).toBeUndefined()
  })

  it('returns undefined for an unknown digest', async () => {
    const store = await openStore()
    expect(store.findToken('nope')).toBeUndefined()
  })
})

describe('external identity rows', () => {
  it('links an identity and resolves it back to the account', async () => {
    const store = await openStore()
    store.createUser(newUser())
    store.linkExternalIdentity({ id: 'e-1', userId: 'u-1', provider: 'oidc', subject: 'subject-1', linkedAt: 2_000 })
    expect(store.findUserByExternalIdentity('oidc', 'subject-1')).toMatchObject({ id: 'u-1', username: 'alice' })
    expect(store.findUserByExternalIdentity('oidc', 'other')).toBeUndefined()
  })

  it('rejects a duplicate (provider, subject) pair', async () => {
    const store = await openStore()
    store.createUser(newUser())
    store.createUser(newUser({ id: 'u-2', username: 'bob' }))
    store.linkExternalIdentity({ id: 'e-1', userId: 'u-1', provider: 'oidc', subject: 's-1', linkedAt: 0 })
    expect(() => {
      store.linkExternalIdentity({ id: 'e-2', userId: 'u-2', provider: 'oidc', subject: 's-1', linkedAt: 0 })
    }).toThrow(/already linked/)
  })
})

describe('durable row decoding', () => {
  const validUser = {
    id: 'u-1',
    username: 'alice',
    display_name: 'Alice',
    password_hash: 'salt:hash',
    role: 'superadmin',
    tenant: 'acme',
    must_change_password: 1,
    disabled: 0,
    created_at: 1_000,
  }

  it('decodes a valid user row', () => {
    expect(decodeStoredUser(validUser)).toEqual({
      id: 'u-1',
      username: 'alice',
      displayName: 'Alice',
      passwordHash: 'salt:hash',
      role: 'superadmin',
      tenant: 'acme',
      mustChangePassword: true,
      disabled: false,
      createdAt: 1_000,
    })
  })

  it.each([
    ['non-object', null],
    ['bad id', { ...validUser, id: 1 }],
    ['bad username', { ...validUser, username: 1 }],
    ['bad display name', { ...validUser, display_name: 1 }],
    ['bad password hash', { ...validUser, password_hash: 1 }],
    ['bad role', { ...validUser, role: 'admin' }],
    ['bad tenant', { ...validUser, tenant: 1 }],
    ['bad must_change_password', { ...validUser, must_change_password: 2 }],
    ['bad disabled', { ...validUser, disabled: 'no' }],
    ['bad created_at', { ...validUser, created_at: 'now' }],
  ])('rejects a user row with %s', (_label, row) => {
    expect(() => decodeStoredUser(row)).toThrow(/stored/)
  })

  const validToken = { token_hash: 'h-1', user_id: 'u-1', expires_at: 10_000, created_at: 1_000 }

  it('decodes a valid token row', () => {
    expect(decodeStoredToken(validToken)).toEqual({
      tokenHash: 'h-1', userId: 'u-1', expiresAt: 10_000, createdAt: 1_000,
    })
  })

  it.each([
    ['non-object', 'nope'],
    ['bad token hash', { ...validToken, token_hash: 1 }],
    ['bad user id', { ...validToken, user_id: 1 }],
    ['bad expiry', { ...validToken, expires_at: 'soon' }],
    ['bad created_at', { ...validToken, created_at: 1.5 }],
  ])('rejects a token row with %s', (_label, row) => {
    expect(() => decodeStoredToken(row)).toThrow(/stored/)
  })
})

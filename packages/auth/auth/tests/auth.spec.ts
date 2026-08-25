import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AuthError, AuthnService, UserId } from '../src/index.ts'
import DefaultExport from '../src/index.ts'
import type { AuthLogin, AuthUser, CreateUserInput } from '../src/index.ts'

class StubAuthn extends AuthnService {
  resolveToken(): Promise<AuthUser | null> {
    return Promise.resolve(null)
  }

  login(): Promise<AuthLogin> {
    throw new AuthError('invalid username or password', 'AUTH_INVALID_CREDENTIALS')
  }

  changePassword(): Promise<AuthUser> {
    throw new AuthError('no such user', 'AUTH_USER_NOT_FOUND')
  }

  listUsers(): Promise<AuthUser[]> {
    return Promise.resolve([])
  }

  createUser(_input: CreateUserInput): Promise<AuthUser> {
    throw new AuthError('username is already taken', 'AUTH_USERNAME_TAKEN')
  }

  resetPassword(): Promise<AuthUser> {
    throw new AuthError('no such user', 'AUTH_USER_NOT_FOUND')
  }

  setDisabled(): Promise<AuthUser> {
    throw new AuthError('no such user', 'AUTH_USER_NOT_FOUND')
  }
}

describe('AuthnService', () => {
  it('default-exports the abstract service and registers it as ctx.authn', async () => {
    expect(DefaultExport).toBe(AuthnService)
    const ctx = new Context()
    await ctx.plugin(StubAuthn)
    expect(ctx.authn).toBeInstanceOf(StubAuthn)
    expect(ctx.authn.name).toBe('authn')
  })
})

describe('AuthError', () => {
  it('carries the stable code and message', () => {
    const error = new AuthError('invalid username or password', 'AUTH_INVALID_CREDENTIALS')
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('AuthError')
    expect(error.code).toBe('AUTH_INVALID_CREDENTIALS')
    expect(error.message).toBe('invalid username or password')
    expect(error.retryAfterMs).toBeUndefined()
  })

  it('carries retryAfterMs only when supplied, and chains a cause', () => {
    const cause = new Error('store offline')
    const error = new AuthError('too many attempts', 'AUTH_RATE_LIMITED', { cause, retryAfterMs: 4000 })
    expect(error.retryAfterMs).toBe(4000)
    expect(error.cause).toBe(cause)
  })
})

describe('UserId', () => {
  it('brands a string without validation', () => {
    expect(UserId('u-1')).toBe('u-1')
  })
})

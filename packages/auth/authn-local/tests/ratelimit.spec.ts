import { describe, expect, it } from 'vitest'
import { AuthError } from '@deepseek-ai/dsh-auth'
import { LoginRateLimiter } from '../src/ratelimit.ts'

describe('LoginRateLimiter', () => {
  it('admits an unknown username', () => {
    const limiter = new LoginRateLimiter({ baseDelayMs: 1_000, maxDelayMs: 300_000, now: () => 0 })
    expect(limiter.retryAfterMs('alice')).toBe(0)
    expect(() => { limiter.check('alice') }).not.toThrow()
  })

  it('locks the username for baseDelayMs after the first failure', () => {
    let now = 1_000_000
    const limiter = new LoginRateLimiter({ baseDelayMs: 1_000, maxDelayMs: 300_000, now: () => now })
    expect(limiter.recordFailure('alice')).toBe(1_000)
    expect(limiter.retryAfterMs('alice')).toBe(1_000)
    expect(() => { limiter.check('alice') }).toThrow(AuthError)
    try {
      limiter.check('alice')
    } catch (error) {
      expect((error as AuthError).code).toBe('AUTH_RATE_LIMITED')
      expect((error as AuthError).retryAfterMs).toBe(1_000)
    }
    now += 999
    expect(limiter.retryAfterMs('alice')).toBe(1)
    now += 1
    expect(limiter.retryAfterMs('alice')).toBe(0)
    expect(() => { limiter.check('alice') }).not.toThrow()
  })

  it('backs off exponentially over a streak and caps at maxDelayMs', () => {
    const limiter = new LoginRateLimiter({ baseDelayMs: 1_000, maxDelayMs: 300_000, now: () => 0 })
    const delays = Array.from({ length: 12 }, () => limiter.recordFailure('alice'))
    expect(delays.slice(0, 5)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000])
    expect(delays[11]).toBe(300_000)
  })

  it('keeps the streak across an expired lockout', () => {
    let now = 0
    const limiter = new LoginRateLimiter({ baseDelayMs: 1_000, maxDelayMs: 300_000, now: () => now })
    limiter.recordFailure('alice')
    now += 60_000
    expect(limiter.retryAfterMs('alice')).toBe(0)
    expect(limiter.recordFailure('alice')).toBe(2_000)
  })

  it('clears the streak on success', () => {
    const limiter = new LoginRateLimiter({ baseDelayMs: 1_000, maxDelayMs: 300_000, now: () => 0 })
    limiter.recordFailure('alice')
    limiter.recordSuccess('alice')
    expect(limiter.retryAfterMs('alice')).toBe(0)
    expect(limiter.recordFailure('alice')).toBe(1_000)
  })

  it('defaults its clock to Date.now', () => {
    const limiter = new LoginRateLimiter({ baseDelayMs: 1_000, maxDelayMs: 300_000 })
    limiter.recordFailure('alice')
    const remaining = limiter.retryAfterMs('alice')
    expect(remaining).toBeGreaterThan(0)
    expect(remaining).toBeLessThanOrEqual(1_000)
    expect(() => { limiter.check('alice') }).toThrow(AuthError)
  })
})

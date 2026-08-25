/**
 * In-memory per-username login throttling. Consecutive credential failures lock
 * the username for an exponentially growing delay capped at a configured
 * maximum; a success clears the streak. State is deliberately process-local:
 * the lockout exists to blunt online guessing against this process, not to
 * coordinate across replicas.
 * @module @deepseek-ai/dsh-authn-local/ratelimit
 */

import { AuthError } from '@deepseek-ai/dsh-auth'

/** Tunables for {@link LoginRateLimiter}. */
export interface RateLimiterOptions {
  /** Lockout applied by the first consecutive failure, in milliseconds. */
  baseDelayMs: number
  /** Longest lockout one failure streak can reach, in milliseconds. */
  maxDelayMs: number
  /** Clock source; defaults to `Date.now`. */
  now?: () => number
}

interface RateLimitEntry {
  failures: number
  lockedUntil: number
}

/**
 * Per-username exponential-backoff lockout. A username stays in the map until a
 * successful login clears it, so an attacker spreading attempts over longer
 * than the lockout still accumulates the streak.
 */
export class LoginRateLimiter {
  private readonly now: () => number
  private readonly entries = new Map<string, RateLimitEntry>()

  constructor(private readonly options: RateLimiterOptions) {
    this.now = options.now ?? Date.now
  }

  /**
   * Milliseconds until the username may attempt a login again.
   * @param username - the login name being attempted.
   * @returns the remaining lockout, or 0 when the attempt may proceed.
   */
  retryAfterMs(username: string): number {
    const entry = this.entries.get(username)
    if (entry === undefined) return 0
    return Math.max(0, entry.lockedUntil - this.now())
  }

  /**
   * Admit or reject a login attempt.
   * @param username - the login name being attempted.
   * @throws {AuthError} `AUTH_RATE_LIMITED` while the streak's lockout is still running.
   */
  check(username: string): void {
    const wait = this.retryAfterMs(username)
    if (wait > 0) {
      throw new AuthError(
        'too many failed login attempts; try again later',
        'AUTH_RATE_LIMITED',
        { retryAfterMs: wait },
      )
    }
  }

  /**
   * Record one credential failure and apply the streak's new lockout.
   * @param username - the login name that failed.
   * @returns the lockout just applied, in milliseconds.
   */
  recordFailure(username: string): number {
    const entry = this.entries.get(username) ?? { failures: 0, lockedUntil: 0 }
    entry.failures += 1
    const delay = Math.min(this.options.baseDelayMs * 2 ** (entry.failures - 1), this.options.maxDelayMs)
    entry.lockedUntil = this.now() + delay
    this.entries.set(username, entry)
    return delay
  }

  /**
   * Clear a username's streak after a successful credential check.
   * @param username - the login name that succeeded.
   */
  recordSuccess(username: string): void {
    this.entries.delete(username)
  }
}

/**
 * Password hashing for the local authentication provider: scrypt with a random
 * per-password salt, stored as a `saltHex:hashHex` record and verified in
 * constant time. Plaintext passwords never persist.
 * @module @deepseek-ai/dsh-authn-local/passwords
 */

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scryptAsync: (password: string, salt: Buffer, keylen: number) => Promise<Buffer> = promisify(scryptCallback)

/** Byte length of the random salt prepended to every stored record. */
export const PASSWORD_SALT_BYTES = 32
/** Byte length of the derived key stored after the salt. */
export const PASSWORD_KEY_BYTES = 64

const HEX = /^[0-9a-f]+$/

/**
 * Hash a password for durable storage.
 * @param password - the plaintext password; this function is its last stop.
 * @returns the `saltHex:hashHex` record.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(PASSWORD_SALT_BYTES)
  const key = await scryptAsync(password, salt, PASSWORD_KEY_BYTES)
  return `${salt.toString('hex')}:${key.toString('hex')}`
}

/**
 * Verify a candidate password against a stored record in constant time. A
 * malformed record is a mismatch, never an exception.
 * @param password - the candidate plaintext password.
 * @param stored - a record produced by {@link hashPassword}.
 * @returns true only when the candidate reproduces the stored key.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex, extra] = stored.split(':')
  if (saltHex === undefined || hashHex === undefined || extra !== undefined
    || saltHex.length !== PASSWORD_SALT_BYTES * 2 || hashHex.length !== PASSWORD_KEY_BYTES * 2
    || !HEX.test(saltHex) || !HEX.test(hashHex)) {
    return false
  }
  const expected = Buffer.from(hashHex, 'hex')
  const actual = await scryptAsync(password, Buffer.from(saltHex, 'hex'), PASSWORD_KEY_BYTES)
  return timingSafeEqual(actual, expected)
}

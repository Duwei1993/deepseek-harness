import { describe, expect, it } from 'vitest'
import { PASSWORD_KEY_BYTES, PASSWORD_SALT_BYTES, hashPassword, verifyPassword } from '../src/passwords.ts'

describe('hashPassword', () => {
  it('returns a saltHex:hashHex record', async () => {
    const stored = await hashPassword('hunter2')
    const [salt, hash] = stored.split(':')
    expect(salt).toMatch(/^[0-9a-f]+$/)
    expect(hash).toMatch(/^[0-9a-f]+$/)
    expect(salt).toHaveLength(PASSWORD_SALT_BYTES * 2)
    expect(hash).toHaveLength(PASSWORD_KEY_BYTES * 2)
  })

  it('randomizes the salt: one password never hashes to the same record twice', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'))
  })
})

describe('verifyPassword', () => {
  it('accepts the password that produced the record', async () => {
    const stored = await hashPassword('correct horse battery staple')
    await expect(verifyPassword('correct horse battery staple', stored)).resolves.toBe(true)
  })

  it('rejects a wrong password', async () => {
    const stored = await hashPassword('right')
    await expect(verifyPassword('wrong', stored)).resolves.toBe(false)
  })

  it.each([
    ['no separator', 'garbage'],
    ['trailing separator', 'aa:'.repeat(1) + 'bb'],
    ['extra segment', 'aa:bb:cc'],
    ['non-hex salt', `${'zz'.repeat(PASSWORD_SALT_BYTES)}:${'ab'.repeat(PASSWORD_KEY_BYTES)}`],
    ['non-hex hash', `${'ab'.repeat(PASSWORD_SALT_BYTES)}:${'zz'.repeat(PASSWORD_KEY_BYTES)}`],
    ['short salt', `ab:${'ab'.repeat(PASSWORD_KEY_BYTES)}`],
    ['short hash', `${'ab'.repeat(PASSWORD_SALT_BYTES)}:ab`],
  ])('rejects a malformed record (%s) without throwing', async (_label, stored) => {
    await expect(verifyPassword('anything', stored)).resolves.toBe(false)
  })
})

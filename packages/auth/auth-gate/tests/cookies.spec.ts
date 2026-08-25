/** Unit coverage for the gate's cookie helpers. */

import { describe, expect, it } from 'vitest'
import { clearedCookie, readCookie, sessionCookie } from '../src/cookies.ts'

describe('readCookie', () => {
  it('finds the named cookie among its peers', () => {
    expect(readCookie('a=1; dsh_auth=tok123; b=2', 'dsh_auth')).toBe('tok123')
    expect(readCookie('dsh_auth=tok123', 'dsh_auth')).toBe('tok123')
    expect(readCookie('dsh_auth=tok123; ', 'dsh_auth')).toBe('tok123')
  })

  it('returns undefined when the header or the cookie is absent, empty, or malformed', () => {
    expect(readCookie(undefined, 'dsh_auth')).toBeUndefined()
    expect(readCookie('a=1; b=2', 'dsh_auth')).toBeUndefined()
    expect(readCookie('dsh_auth=', 'dsh_auth')).toBeUndefined()
    expect(readCookie('dsh_auth', 'dsh_auth')).toBeUndefined()
    expect(readCookie('dsh_authx=tok', 'dsh_auth')).toBeUndefined()
  })

  it('keeps values containing = intact and matches names case-sensitively', () => {
    expect(readCookie('dsh_auth=ab=c=', 'dsh_auth')).toBe('ab=c=')
    expect(readCookie('DSH_AUTH=tok', 'dsh_auth')).toBeUndefined()
  })
})

describe('Set-Cookie builders', () => {
  it('establishes and expires the session cookie with the shared attributes', () => {
    expect(sessionCookie('dsh_auth', 'tok'))
      .toBe('dsh_auth=tok; HttpOnly; SameSite=Lax; Path=/')
    expect(clearedCookie('dsh_auth'))
      .toBe('dsh_auth=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0')
  })
})

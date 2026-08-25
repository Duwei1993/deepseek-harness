/**
 * Optional session-cookie fence for the /api transport. With an `authn`
 * service mounted (the opt-in auth bundle), every /api request and WebSocket
 * upgrade must carry the session cookie the auth gate minted at login; without
 * one the behavior is exactly the pre-authentication fence's. The cookie name
 * is shared configuration between this plugin and the gate.
 */

import type { IncomingHttpHeaders } from 'node:http'
import type { AuthnService, AuthUser } from '@deepseek-ai/dsh-auth'

/**
 * Default session-cookie name — the same default `dsh-auth-gate`'s
 * `cookieName` config carries; a deployment renaming one must rename both.
 */
export const DEFAULT_AUTH_COOKIE_NAME = 'dsh_auth'

/** Read the Cookie header from either HTTP representation (node:http or Fetch). */
function cookieHeader(headers: IncomingHttpHeaders | Headers): string | undefined {
  if (headers instanceof Headers) return headers.get('cookie') ?? undefined
  const value = headers.cookie
  return typeof value === 'string' ? value : undefined
}

/**
 * Resolve the session cookie on one request to its account.
 * @param authn - the mounted authentication service.
 * @param headers - node:http or Fetch headers carrying the Cookie header.
 * @param cookieName - the configured session-cookie name.
 * @returns the account, or null when the cookie is absent, empty, or resolves
 *   to no account (unknown, expired, or disabled-owned token).
 */
export async function resolveAuthnUser(
  authn: AuthnService,
  headers: IncomingHttpHeaders | Headers,
  cookieName: string,
): Promise<AuthUser | null> {
  const cookie = cookieHeader(headers)
  if (cookie === undefined) return null
  for (const pair of cookie.split(';')) {
    const [rawName, ...rest] = pair.split('=')
    if (rawName?.trim() !== cookieName || rest.length === 0) continue
    const token = rest.join('=').trim()
    return token === '' ? null : authn.resolveToken(token)
  }
  return null
}

/**
 * Cookie helpers for the auth gate: read one value out of a `Cookie` request
 * header and build the `Set-Cookie` pair that establishes and expires the
 * session cookie. The cookie carries the bearer token verbatim (base64url
 * needs no encoding); `HttpOnly` keeps it out of page script, `SameSite=Lax`
 * lets the top-level navigation back from the login page carry it, and no
 * `Secure` attribute keeps the loopback default deployment working — a
 * non-loopback deployment must put the server behind an HTTPS reverse proxy
 * (see the package README).
 * @module @deepseek-ai/dsh-auth-gate/cookies
 */

/**
 * Read one cookie value from a raw `Cookie` header.
 * @param header - the header value, or undefined when the request carries none.
 * @param name - the cookie name to find; compared exactly, case-sensitive per RFC 6265.
 * @returns the cookie value, or undefined when the header has no such cookie.
 */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=')
    if (eq === -1) continue
    if (pair.slice(0, eq).trim() !== name) continue
    const value = pair.slice(eq + 1).trim()
    return value === '' ? undefined : value
  }
  return undefined
}

/**
 * Build the `Set-Cookie` value establishing the session cookie.
 * @param name - the configured cookie name.
 * @param token - the bearer token minted by the authentication provider.
 * @returns the Set-Cookie header value.
 */
export function sessionCookie(name: string, token: string): string {
  return `${name}=${token}; HttpOnly; SameSite=Lax; Path=/`
}

/**
 * Build the `Set-Cookie` value expiring the session cookie immediately.
 * @param name - the configured cookie name.
 * @returns the Set-Cookie header value.
 */
export function clearedCookie(name: string): string {
  return `${name}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`
}

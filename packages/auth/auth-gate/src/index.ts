/**
 * @deepseek-ai/dsh-auth-gate — the HTTP enforcement consumer of the
 * authentication seam (`ctx.authn`). It mounts the self-contained login and
 * account-administration pages under `/auth/*` together with their JSON
 * endpoints, answers the session cookie contract (login mints it, logout
 * expires it, every gate read resolves it through `resolveToken`), and gates
 * the SPA entry navigation. The `/api` transport gate lives in
 * `dsh-client-connection`, which owns that prefix; this package owns
 * everything under `/auth` plus the page-navigation redirect.
 * @module @deepseek-ai/dsh-auth-gate
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { AuthError } from '@deepseek-ai/dsh-auth'
import type { AuthErrorCode, AuthUser, AuthnService } from '@deepseek-ai/dsh-auth'
import { clearedCookie, readCookie, sessionCookie } from './cookies.ts'
import { readJsonBody, redirect, sendJson } from './http.ts'
import { renderAdminPage, renderLoginPage } from './pages.ts'

export { MAX_AUTH_BODY_BYTES } from './http.ts'

/** Stable Cordis plugin name. */
export const name = 'auth-gate'

/** Services required before the gate can mount: the seam it enforces and the route registry it serves through. */
export const inject = ['authn', 'webServer']

/**
 * Default session-cookie name. The `/api` fence in `dsh-client-connection`
 * shares this default; a deployment renaming the cookie sets both.
 */
export const DEFAULT_COOKIE_NAME = 'dsh_auth'

/** Default path the page gate proxies allowed navigations from: the frontend fallback's own index address. */
export const DEFAULT_INDEX_PATH = '/index.html'

/** Username of the seeded bootstrap account the login page warns about while it still awaits its first password change. */
export const BOOTSTRAP_USERNAME = 'superadmin'

/** RFC 7230 token characters: the only safe cookie names (a config value outside it would corrupt Set-Cookie). */
const COOKIE_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/

/** The proxied index must be a non-root absolute path; `/` would route back into the page gate itself. */
const INDEX_PATH_PATTERN = /^\/\S+$/

/** Plugin config. */
export interface AuthGateConfig {
  /**
   * Session-cookie name. Rename only together with the connection plugin's
   * `authCookieName`; the `/api` fence resolves the same cookie.
   */
  cookieName?: string
  /**
   * The path the page gate internally fetches to serve an allowed navigation:
   * the composition's ungated index address (the frontend fallback answers it).
   * The gate owns `/` itself, so this must name a different path.
   */
  indexPath?: string
}

export const Config: z<AuthGateConfig> = z.object({
  cookieName: z.string().pattern(COOKIE_NAME_PATTERN).default(DEFAULT_COOKIE_NAME),
  indexPath: z.string().pattern(INDEX_PATH_PATTERN).default(DEFAULT_INDEX_PATH),
})

/** HTTP status per failure code: one lookup so every endpoint answers the same way. */
const AUTH_ERROR_STATUS: Record<AuthErrorCode, number> = {
  AUTH_INVALID_CREDENTIALS: 401,
  AUTH_USER_DISABLED: 403,
  AUTH_RATE_LIMITED: 429,
  AUTH_USER_NOT_FOUND: 404,
  AUTH_USERNAME_TAKEN: 409,
  AUTH_INVALID_INPUT: 400,
}

/** The account fields the gate's pages and status endpoint may expose (never the opaque id). */
interface PublicUser {
  username: string
  displayName: string
  role: AuthUser['role']
  disabled: boolean
  mustChangePassword: boolean
}

/** Project an account to its wire shape. */
function publicUser(user: AuthUser): PublicUser {
  return {
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    disabled: user.disabled,
    mustChangePassword: user.mustChangePassword,
  }
}

/**
 * Mount the gate: the `/auth/*` routes and the page-navigation gate.
 * @param ctx - plugin context carrying the authn and webServer services.
 * @param config - validated {@link AuthGateConfig} (schema defaults applied by the Loader).
 */
export function apply(ctx: Context, config?: AuthGateConfig): void {
  // The Loader resolves schema defaults; hand-built test contexts may pass none.
  const cookieName = config?.cookieName ?? DEFAULT_COOKIE_NAME
  const indexPath = config?.indexPath ?? DEFAULT_INDEX_PATH
  const authn: AuthnService = ctx.authn

  /** Resolve the request's session cookie to its account. */
  async function resolveUser(req: IncomingMessage): Promise<AuthUser | null> {
    const token = readCookie(req.headers.cookie, cookieName)
    if (token === undefined) return null
    return authn.resolveToken(token)
  }

  /** Whether the seeded bootstrap account still awaits its first password change (the login page's warning banner). */
  async function isBootstrapPending(): Promise<boolean> {
    const users = await authn.listUsers()
    return users.some(user => user.username === BOOTSTRAP_USERNAME && user.mustChangePassword)
  }

  /** Write an AuthError reply; anything else is a provider failure and propagates to the webserver's per-request containment. */
  function sendAuthError(res: ServerResponse, error: unknown): void {
    if (!(error instanceof AuthError)) throw error
    sendJson(res, AUTH_ERROR_STATUS[error.code], {
      error: error.message,
      ...error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {},
    })
  }

  /** Read a required string field from a parsed JSON body. */
  function stringField(body: Record<string, unknown>, field: string): string | undefined {
    const value = body[field]
    return typeof value === 'string' && value !== '' ? value : undefined
  }

  /**
   * Read the JSON body, then run the action with uniform AuthError mapping —
   * either failure has already written the reply when this returns early.
   */
  async function withJsonBody(
    req: IncomingMessage,
    res: ServerResponse,
    action: (body: Record<string, unknown>) => Promise<void>,
  ): Promise<void> {
    const body = await readJsonBody(req, res)
    if (body === undefined) return
    try {
      await action(body)
    } catch (error) {
      sendAuthError(res, error)
    }
  }

  /** The login route: GET renders the page, POST authenticates and mints the cookie. */
  async function handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'GET') {
      const user = await resolveUser(req)
      /* v8 ignore next -- node:http always sets url on server requests. */
      const forceChange = new URL(req.url ?? '/', 'http://x').searchParams.get('force-change') === '1'
      if (user !== null && !user.mustChangePassword && !forceChange) {
        redirect(res, '/')
        return
      }
      const bootstrapWarning = await isBootstrapPending()
      const html = user !== null && (user.mustChangePassword || forceChange)
        ? renderLoginPage({ mode: 'change', bootstrapWarning, username: user.username })
        : renderLoginPage({ mode: 'login', bootstrapWarning })
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(html)
      return
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }
    await withJsonBody(req, res, async (body) => {
      const username = stringField(body, 'username')
      const password = stringField(body, 'password')
      if (username === undefined || password === undefined) {
        sendJson(res, 400, { error: 'username and password are required' })
        return
      }
      const login = await authn.login(username, password)
      sendJson(res, 200, { user: publicUser(login.user) }, { 'set-cookie': sessionCookie(cookieName, login.token) })
    })
  }

  /** The logout route: expire the cookie. */
  function handleLogout(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }
    // TODO: the seam has no token revocation yet — the cookie dies here but
    // the bearer token stays valid until expiry. Add provider revocation when
    // the seam grows it.
    sendJson(res, 200, { ok: true }, { 'set-cookie': clearedCookie(cookieName) })
  }

  /** The change-password route: authenticated callers rotate their own password. */
  async function handleChangePassword(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }
    const user = await resolveUser(req)
    if (user === null) {
      sendJson(res, 401, { error: 'authentication required' })
      return
    }
    await withJsonBody(req, res, async (body) => {
      const oldPassword = stringField(body, 'oldPassword')
      const newPassword = stringField(body, 'newPassword')
      if (oldPassword === undefined || newPassword === undefined) {
        sendJson(res, 400, { error: 'oldPassword and newPassword are required' })
        return
      }
      await authn.changePassword(user.id, oldPassword, newPassword)
      sendJson(res, 200, { ok: true })
    })
  }

  /** The status probe the login page and the SPA read. */
  async function handleStatus(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const user = await resolveUser(req)
    sendJson(res, 200, {
      authenticated: user !== null,
      ...user !== null ? { user: publicUser(user) } : {},
      mustChangePasswordBootstrap: await isBootstrapPending(),
    })
  }

  /** The administration page: superadmin-only, navigations bounce to the login page. */
  async function handleAdminPage(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const user = await resolveUser(req)
    if (user === null) {
      redirect(res, '/auth/login')
      return
    }
    if (user.role !== 'superadmin') {
      sendJson(res, 403, { error: 'superadmin only' })
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(renderAdminPage())
  }

  /** Resolve the administration caller: superadmin or an error reply. */
  async function requireSuperadmin(req: IncomingMessage, res: ServerResponse): Promise<AuthUser | undefined> {
    const user = await resolveUser(req)
    if (user === null) {
      sendJson(res, 401, { error: 'authentication required' })
      return undefined
    }
    if (user.role !== 'superadmin') {
      sendJson(res, 403, { error: 'superadmin only' })
      return undefined
    }
    return user
  }

  /** The account-management endpoints behind the administration page. */
  async function handleAdminUsers(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const admin = await requireSuperadmin(req, res)
    if (admin === undefined) return
    /* v8 ignore next -- node:http always sets url on server requests. */
    const pathname = new URL(req.url ?? '/', 'http://x').pathname
    if (pathname === '/auth/admin/users') {
      if (req.method === 'GET') {
        sendJson(res, 200, { users: (await authn.listUsers()).map(publicUser) })
        return
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }
      await withJsonBody(req, res, async (body) => {
        const username = stringField(body, 'username')
        const password = stringField(body, 'password')
        const displayName = body.displayName === undefined ? undefined : stringField(body, 'displayName')
        const role = body.role === undefined ? undefined : body.role
        if (username === undefined || password === undefined
          || (body.displayName !== undefined && displayName === undefined)
          || (role !== undefined && role !== 'user' && role !== 'superadmin')) {
          sendJson(res, 400, { error: 'username and password are required; role must be user or superadmin' })
          return
        }
        const user = await authn.createUser({
          username,
          password,
          ...displayName !== undefined ? { displayName } : {},
          ...role !== undefined ? { role } : {},
        })
        sendJson(res, 201, { user: publicUser(user) })
      })
      return
    }
    const segments = pathname.slice('/auth/admin/users/'.length).split('/')
    if (segments.length !== 2 || segments[0] === '' || segments[1] === '') {
      sendJson(res, 404, { error: 'not found' })
      return
    }
    const [rawName, action] = segments as [string, string]
    if (action !== 'reset-password' && action !== 'set-disabled') {
      sendJson(res, 404, { error: 'not found' })
      return
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }
    const username = decodeURIComponent(rawName)
    const target = (await authn.listUsers()).find(user => user.username === username)
    if (target === undefined) {
      sendJson(res, 404, { error: 'no such user' })
      return
    }
    await withJsonBody(req, res, async (body) => {
      if (action === 'reset-password') {
        const password = stringField(body, 'password')
        if (password === undefined) {
          sendJson(res, 400, { error: 'password is required' })
          return
        }
        await authn.resetPassword(target.id, password)
      } else {
        if (typeof body.disabled !== 'boolean') {
          sendJson(res, 400, { error: 'disabled must be a boolean' })
          return
        }
        await authn.setDisabled(target.id, body.disabled)
      }
      sendJson(res, 200, { ok: true })
    })
  }

  /**
   * The page-navigation gate. The webserver's prefix semantics match `/` only
   * against the exact path (a prefix p matches p or p/<anything>, and `/` has
   * no subpath form), so this registration intercepts exactly the SPA entry:
   * every other path keeps its own route or falls through to the frontend
   * fallback untouched. An allowed navigation is served by fetching the
   * composition's index path back from this same server.
   */
  async function handlePageGate(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const user = await resolveUser(req)
    const navigation = req.method === 'GET' && (req.headers.accept ?? '').includes('text/html')
    if (navigation && user === null) {
      redirect(res, '/auth/login')
      return
    }
    if (navigation && user !== null && user.mustChangePassword) {
      redirect(res, '/auth/login?force-change=1')
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }
    try {
      const upstream = await fetch(`http://127.0.0.1:${String(ctx.webServer.port)}${indexPath}`, { method: req.method })
      res.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') ?? 'text/html; charset=utf-8',
      })
      if (req.method === 'HEAD' || upstream.body === null) {
        res.end()
        return
      }
      for await (const chunk of upstream.body) {
        res.write(chunk)
      }
      res.end()
    } catch {
      res.writeHead(502)
      res.end('bad gateway')
    }
  }

  const routes: WebRoute[] = [
    { kind: 'exact', path: '/auth/login', handler: handleLogin },
    { kind: 'exact', path: '/auth/logout', handler: handleLogout },
    { kind: 'exact', path: '/auth/change-password', handler: handleChangePassword },
    { kind: 'exact', path: '/auth/status', handler: handleStatus },
    { kind: 'exact', path: '/auth/admin', handler: handleAdminPage },
    { kind: 'prefix', path: '/auth/admin/users', handler: handleAdminUsers },
    { kind: 'prefix', path: '/', handler: handlePageGate },
  ]
  for (const route of routes) {
    ctx.effect(() => ctx.webServer.register(route), `auth-gate: ${route.kind} ${route.path}`)
  }
}

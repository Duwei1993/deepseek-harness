/**
 * Hand-built coverage for the gate's edge branches: config plumbing, provider
 * failure propagation, and the page-gate proxy's non-happy paths (a dead or
 * bodyless upstream) that a real composition cannot produce. The behavior
 * matrix against the real provider and server lives in real-composition.spec.ts.
 */

import { createServer } from 'node:http'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AuthError, UserId } from '@deepseek-ai/dsh-auth'
import type { AuthLogin, AuthnService, AuthUser } from '@deepseek-ai/dsh-auth'
import type { WebRoute, WebServer } from '@deepseek-ai/dsh-host-webserver'
import { apply, inject } from '../src/index.ts'

/** One account record for the authn stubs. */
function stubUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: UserId('u-1'),
    username: 'alice',
    displayName: 'Alice',
    role: 'user',
    disabled: false,
    mustChangePassword: false,
    ...overrides,
  }
}

/** Minimal AuthnService stub; every method rejects unless overridden. */
function stubAuthn(overrides: Partial<Record<keyof AuthnService, unknown>> = {}): AuthnService {
  const missing = (): Promise<never> => Promise.reject(new Error('stub: unexpected call'))
  return {
    resolveToken: missing,
    login: missing,
    changePassword: missing,
    listUsers: () => Promise.resolve([]),
    createUser: missing,
    resetPassword: missing,
    setDisabled: missing,
    ...overrides,
  } as unknown as AuthnService
}

/** Response stub state: status, headers, and the streamed body. */
interface FakeState { status?: number; headers?: Record<string, string> | undefined; body?: string | undefined }

/** Response stub recording status, headers, and the streamed body. */
function fakeResponse(): { response: ServerResponse; state: FakeState } {
  const state: FakeState = {}
  const chunks: Buffer[] = []
  const response = Object.assign(new EventEmitter(), {
    writeHead(status: number, headers?: Record<string, string>) {
      state.status = status
      state.headers = headers
      return this
    },
    write(chunk: string | Uint8Array) {
      chunks.push(Buffer.from(chunk))
      return true
    },
    end(value?: string) {
      if (value !== undefined) chunks.push(Buffer.from(value))
      if (chunks.length > 0) state.body = Buffer.concat(chunks).toString()
      return this
    },
  }) as unknown as ServerResponse
  return { response, state }
}

/** Request stub with the given method, url, headers, and body chunks. */
function fakeRequest(method: string, url: string, headers: Record<string, string> = {}, chunks: Buffer[] = []): IncomingMessage {
  const request = Readable.from(chunks) as unknown as IncomingMessage
  Object.assign(request, { url, method, headers })
  return request
}

/** Fake webServer capturing registered routes and reporting the given port. */
function fakeWebServer(port = 0): { server: WebServer; routes: WebRoute[] } {
  const routes: WebRoute[] = []
  const server = {
    register(route: WebRoute) {
      routes.push(route)
      return () => { routes.splice(routes.indexOf(route), 1) }
    },
    port,
  } as unknown as WebServer
  return { server, routes }
}

/** Mount the gate by hand over the given authn stub and fake webServer. */
async function mounted(
  authn: AuthnService,
  options: { config?: { cookieName?: string }; port?: number } = {},
): Promise<{ routes: WebRoute[]; dispose: () => Promise<void> }> {
  const ctx = new Context()
  const { server, routes } = fakeWebServer(options.port ?? 0)
  ctx.provide('authn', authn)
  ctx.provide('webServer', server)
  const fiber = ctx.plugin({ inject: [...inject], apply }, options.config)
  await fiber.await()
  return { routes, dispose: () => fiber.dispose() }
}

/** Find a registered route and invoke it with the fake request/response. */
function route(routes: WebRoute[], path: string): WebRoute {
  const found = routes.find(candidate => candidate.path === path)
  if (found === undefined) throw new Error(`route ${path} not registered`)
  return found
}

/** Serve the given handler on one ephemeral raw server for the proxy to fetch. */
async function rawServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer(handler)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    port,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined || error === null) resolve()
        else reject(error)
      })
    }),
  }
}

const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(closers.splice(0).map(close => close()))
})

describe('auth-gate hand-built edges', () => {
  it('registers every /auth route plus the page gate and removes them with the fiber', async () => {
    const { routes, dispose } = await mounted(stubAuthn())
    expect(routes.map(candidate => `${candidate.kind} ${candidate.path}`)).toEqual([
      'exact /auth/login',
      'exact /auth/logout',
      'exact /auth/change-password',
      'exact /auth/status',
      'exact /auth/admin',
      'prefix /auth/admin/users',
      'prefix /',
    ])
    await dispose()
    expect(routes).toHaveLength(0)
  })

  it('mints and reads the configured cookie name', async () => {
    const user = stubUser()
    const authn = stubAuthn({
      login: (): Promise<AuthLogin> => Promise.resolve({ user, token: 'tok-1' }),
      resolveToken: (token: string) => Promise.resolve(token === 'tok-1' ? user : null),
    })
    const { routes, dispose } = await mounted(authn, { config: { cookieName: 'mine' } })
    const login = fakeResponse()
    await route(routes, '/auth/login').handler(
      fakeRequest('POST', '/auth/login', { 'content-type': 'application/json' }, [Buffer.from('{"username":"alice","password":"pw"}')]),
      login.response,
    )
    expect(login.state.status).toBe(200)
    expect(login.state.headers?.['set-cookie']).toContain('mine=tok-1')
    const status = fakeResponse()
    await route(routes, '/auth/status').handler(
      fakeRequest('GET', '/auth/status', { cookie: 'mine=tok-1' }),
      status.response,
    )
    expect(JSON.parse(status.state.body ?? '')).toMatchObject({ authenticated: true, user: { username: 'alice' } })
    // The default cookie name is inert under the renamed configuration.
    const wrong = fakeResponse()
    await route(routes, '/auth/status').handler(
      fakeRequest('GET', '/auth/status', { cookie: 'dsh_auth=tok-1' }),
      wrong.response,
    )
    expect(JSON.parse(wrong.state.body ?? '')).toMatchObject({ authenticated: false })
    await dispose()
  })

  it('lets a provider crash escape the route handler instead of answering an auth error', async () => {
    const authn = stubAuthn({
      login: () => Promise.reject(new Error('store gone')),
    })
    const { routes, dispose } = await mounted(authn)
    await expect(route(routes, '/auth/login').handler(
      fakeRequest('POST', '/auth/login', { 'content-type': 'application/json' }, [Buffer.from('{"username":"a","password":"b"}')]),
      fakeResponse().response,
    )).rejects.toThrow('store gone')
    await dispose()
  })

  it('maps provider AuthErrors from the admin sub-actions', async () => {
    const admin = stubUser({ role: 'superadmin', username: 'root' })
    const authn = stubAuthn({
      resolveToken: () => Promise.resolve(admin),
      listUsers: () => Promise.resolve([admin]),
      resetPassword: () => Promise.reject(new AuthError('locked', 'AUTH_RATE_LIMITED', { retryAfterMs: 500 })),
    })
    const { routes, dispose } = await mounted(authn)
    const result = fakeResponse()
    await route(routes, '/auth/admin/users').handler(
      fakeRequest('POST', '/auth/admin/users/root/reset-password', {
        'content-type': 'application/json',
        cookie: 'dsh_auth=tok',
      }, [Buffer.from('{"password":"x"}')]),
      result.response,
    )
    expect(result.state.status).toBe(429)
    expect(JSON.parse(result.state.body ?? '')).toEqual({ error: 'locked', retryAfterMs: 500 })
    await dispose()
  })

  it('rejects non-POST methods on the action routes', async () => {
    const { routes, dispose } = await mounted(stubAuthn())
    for (const [path, method] of [['/auth/logout', 'GET'], ['/auth/change-password', 'GET'], ['/auth/login', 'PUT']] as const) {
      const result = fakeResponse()
      await route(routes, path).handler(fakeRequest(method, path), result.response)
      expect(result.state.status).toBe(405)
    }
    await dispose()
  })

  it('proxies an allowed page request and answers 502 when the upstream is unreachable', async () => {
    const upstream = await rawServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('INDEX')
    })
    closers.push(upstream.close)
    const { routes, dispose } = await mounted(stubAuthn(), { port: upstream.port })
    const navigated = fakeResponse()
    await route(routes, '/').handler(
      fakeRequest('GET', '/', { accept: 'text/html' }),
      navigated.response,
    )
    // Unauthenticated navigation redirects; the proxy only serves allowed traffic.
    expect(navigated.state).toMatchObject({ status: 302, headers: { location: '/auth/login' } })
    const proxied = fakeResponse()
    await route(routes, '/').handler(fakeRequest('GET', '/', { accept: '*/*' }), proxied.response)
    expect(proxied.state).toMatchObject({ status: 200, body: 'INDEX' })
    // A request without an Accept header is not a navigation and passes the same way.
    const noAccept = fakeResponse()
    await route(routes, '/').handler(fakeRequest('GET', '/'), noAccept.response)
    expect(noAccept.state).toMatchObject({ status: 200, body: 'INDEX' })
    await dispose()

    const dead = await rawServer(() => {})
    const deadPort = dead.port
    await dead.close()
    const deadMount = await mounted(stubAuthn(), { port: deadPort })
    const failed = fakeResponse()
    await route(deadMount.routes, '/').handler(fakeRequest('GET', '/', { accept: '*/*' }), failed.response)
    expect(failed.state).toMatchObject({ status: 502, body: 'bad gateway' })
    await deadMount.dispose()
  })

  it('ends the proxy response without a body for HEAD requests and bodyless upstream answers', async () => {
    const upstream = await rawServer((req, res) => {
      if (req.url === '/empty') {
        res.writeHead(204)
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(req.method === 'HEAD' ? undefined : 'INDEX')
    })
    closers.push(upstream.close)
    const { routes, dispose } = await mounted(stubAuthn(), { port: upstream.port })
    const head = fakeResponse()
    await route(routes, '/').handler(fakeRequest('HEAD', '/', { accept: '*/*' }), head.response)
    expect(head.state.status).toBe(200)
    expect(head.state.body).toBeUndefined()
    await dispose()

    // A GET whose upstream answer carries no body (204) takes the same path.
    const emptyMountContext = new Context()
    const { server, routes: emptyRoutes } = fakeWebServer(upstream.port)
    emptyMountContext.provide('authn', stubAuthn())
    emptyMountContext.provide('webServer', server)
    const fiber = emptyMountContext.plugin({
      inject: [...inject],
      apply,
    }, { cookieName: 'dsh_auth', indexPath: '/empty' })
    await fiber.await()
    const empty = fakeResponse()
    await route(emptyRoutes, '/').handler(fakeRequest('GET', '/', { accept: '*/*' }), empty.response)
    expect(empty.state.status).toBe(204)
    expect(empty.state.body).toBeUndefined()
    await fiber.dispose()
  })
})

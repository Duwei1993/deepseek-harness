/**
 * Node half: the optional /api authentication fence. With an `authn` service
 * mounted, every /api request and WebSocket upgrade must carry a valid session
 * cookie; the privileged method set relaxes from loopback-only to
 * loopback-or-superadmin. Without the service the behavior is the
 * pre-authentication fence's, pinned by node-half.host.spec.ts.
 */
import { EventEmitter, once } from 'node:events'
import { PassThrough, Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { UserId } from '@deepseek-ai/dsh-auth'
import type { AuthnService, AuthUser } from '@deepseek-ai/dsh-auth'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { WebServer, WebRoute, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import { API_PATH, apply, inject, MUX_EVENTS_PATH } from '../src/index.ts'
import { DEFAULT_AUTH_COOKIE_NAME, resolveAuthnUser } from '../src/api-auth-gate.ts'

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

/** Authn stub resolving exactly the tokens named in `tokens`. */
function stubAuthn(tokens: Record<string, AuthUser>): AuthnService {
  return {
    resolveToken: (token: string) => Promise.resolve(tokens[token] ?? null),
  } as unknown as AuthnService
}

/** Structural webServer fake recording both route registries. */
function fakeHttpServer(
  routes: WebRoute[],
  upgrades: WebUpgradeRoute[],
): Pick<WebServer, 'register' | 'registerUpgrade' | 'tapIndex' | 'port'> {
  return {
    register(route) {
      routes.push(route)
      return () => { routes.splice(routes.indexOf(route), 1) }
    },
    registerUpgrade(route) {
      upgrades.push(route)
      return () => { upgrades.splice(upgrades.indexOf(route), 1) }
    },
    tapIndex: () => () => {},
    port: 0,
  }
}

/** Request stub carrying the given headers and an empty body. */
function fakeRequest(headers: Record<string, string>, url = `${API_PATH}/session.list`, method = 'GET'): IncomingMessage {
  const request = Readable.from([]) as unknown as IncomingMessage
  Object.assign(request, { url, method, headers })
  return request
}

/** Response recorder compatible with both the fence's short-circuit and the bridge. */
function fakeResponse(): { response: ServerResponse; state: { status?: number; body?: unknown } } {
  const state: { status?: number; body?: unknown } = {}
  const chunks: Buffer[] = []
  const response = Object.assign(new EventEmitter(), {
    writableEnded: false,
    writeHead(value: number) { state.status = value; return this },
    write(value: string | Uint8Array) { chunks.push(Buffer.from(value)); return true },
    end(this: { writableEnded: boolean }, value?: unknown) {
      if (typeof value === 'string' || value instanceof Uint8Array) chunks.push(Buffer.from(value))
      if (chunks.length > 0) state.body = Buffer.concat(chunks).toString()
      this.writableEnded = true
      return this
    },
  }) as unknown as ServerResponse
  return { response, state }
}

/** Mount the connection plugin by hand, optionally with an authn service. */
async function mounted(
  options: { authn?: AuthnService; trustedHosts?: string[]; authCookieName?: string } = {},
): Promise<{ routes: WebRoute[]; upgrades: WebUpgradeRoute[]; dispose: () => Promise<void> }> {
  const ctx = new Context()
  const routes: WebRoute[] = []
  const upgrades: WebUpgradeRoute[] = []
  ctx.provide('webServer', fakeHttpServer(routes, upgrades) as WebServer)
  ctx.provide('apiProxy', {} as unknown as ApiProxy)
  if (options.authn !== undefined) ctx.provide('authn', options.authn)
  const fiber = ctx.plugin({ inject: [...inject], apply }, {
    ...options.trustedHosts !== undefined ? { trustedHosts: options.trustedHosts } : {},
    ...options.authCookieName !== undefined ? { authCookieName: options.authCookieName } : {},
  })
  await fiber.await()
  return { routes, upgrades, dispose: () => fiber.dispose() }
}

/** Drive one upgrade route to completion and collect what it wrote to the socket. */
async function upgradeOutput(route: WebUpgradeRoute, req: IncomingMessage): Promise<string> {
  const socket = new PassThrough()
  const chunks: Buffer[] = []
  socket.on('data', (chunk: Buffer) => { chunks.push(Buffer.from(chunk)) })
  const ended = once(socket, 'end')
  await route.handler(req, socket, Buffer.alloc(0))
  await ended
  return Buffer.concat(chunks).toString()
}

describe('resolveAuthnUser', () => {
  const user = stubUser()
  const authn = stubAuthn({ 'tok-1': user })

  it('reads the cookie from node:http and Fetch header shapes', async () => {
    await expect(resolveAuthnUser(authn, { cookie: 'a=1; dsh_auth=tok-1' }, DEFAULT_AUTH_COOKIE_NAME)).resolves.toBe(user)
    await expect(resolveAuthnUser(authn, new Headers({ cookie: 'dsh_auth=tok-1' }), DEFAULT_AUTH_COOKIE_NAME)).resolves.toBe(user)
  })

  it('resolves null when the cookie header, the named cookie, or its value is absent', async () => {
    await expect(resolveAuthnUser(authn, {}, DEFAULT_AUTH_COOKIE_NAME)).resolves.toBeNull()
    await expect(resolveAuthnUser(authn, new Headers(), DEFAULT_AUTH_COOKIE_NAME)).resolves.toBeNull()
    // node:http types Cookie as a bare string; the array arm guards the raw duplicate-header shape.
    await expect(resolveAuthnUser(authn, { cookie: ['a=1', 'b=2'] as unknown as string }, DEFAULT_AUTH_COOKIE_NAME)).resolves.toBeNull()
    await expect(resolveAuthnUser(authn, { cookie: 'other=tok-1' }, DEFAULT_AUTH_COOKIE_NAME)).resolves.toBeNull()
    await expect(resolveAuthnUser(authn, { cookie: 'dsh_auth' }, DEFAULT_AUTH_COOKIE_NAME)).resolves.toBeNull()
    await expect(resolveAuthnUser(authn, { cookie: '=tok-1' }, DEFAULT_AUTH_COOKIE_NAME)).resolves.toBeNull()
    await expect(resolveAuthnUser(authn, { cookie: 'dsh_auth= ' }, DEFAULT_AUTH_COOKIE_NAME)).resolves.toBeNull()
  })

  it('keeps = inside the token value and honors the configured name', async () => {
    const withEquals = stubAuthn({ 'ab=c': user })
    await expect(resolveAuthnUser(withEquals, { cookie: 'dsh_auth=ab=c' }, DEFAULT_AUTH_COOKIE_NAME)).resolves.toBe(user)
    await expect(resolveAuthnUser(authn, { cookie: 'mine=tok-1' }, 'mine')).resolves.toBe(user)
    await expect(resolveAuthnUser(authn, { cookie: 'dsh_auth=tok-1' }, 'mine')).resolves.toBeNull()
  })

  it('propagates the provider verdict', async () => {
    await expect(resolveAuthnUser(authn, { cookie: 'dsh_auth=unknown' }, DEFAULT_AUTH_COOKIE_NAME)).resolves.toBeNull()
  })
})

describe('connection authentication fence', () => {
  it('answers 401 JSON for /api requests without a valid cookie when authn is mounted', async () => {
    const { routes, dispose } = await mounted({ authn: stubAuthn({ 'tok-1': stubUser() }) })
    for (const headers of [{ host: '127.0.0.1:3080' }, { host: '127.0.0.1:3080', cookie: 'dsh_auth=wrong' }]) {
      const { response, state } = fakeResponse()
      await routes[0]!.handler(fakeRequest(headers), response)
      expect(state.status).toBe(401)
      expect(JSON.parse(String(state.body))).toEqual({ error: 'authentication required' })
    }
    await dispose()
  })

  it('passes /api requests with a valid cookie through to the bridge', async () => {
    const { routes, dispose } = await mounted({ authn: stubAuthn({ 'tok-1': stubUser() }) })
    const { response, state } = fakeResponse()
    await routes[0]!.handler(fakeRequest({ host: '127.0.0.1:3080', cookie: 'dsh_auth=tok-1' }), response)
    // The empty apiProxy's carrier 404 proves the fence passed and the bridge ran.
    expect(state.status).toBe(404)
    await dispose()
  })

  it('relaxes the privileged pin from loopback-only to loopback-or-superadmin', async () => {
    const authn = stubAuthn({ 'tok-admin': stubUser({ role: 'superadmin' }), 'tok-user': stubUser() })
    const { routes, dispose } = await mounted({ authn, trustedHosts: ['harness.example'] })
    // A non-superadmin on a trusted authority stays refused, exactly as an
    // unauthenticated deployment refuses the whole privileged set.
    const denied = fakeResponse()
    await routes[0]!.handler(
      fakeRequest({ host: 'harness.example', cookie: 'dsh_auth=tok-user' }, `${API_PATH}/settings.describe`),
      denied.response,
    )
    expect(denied.state.status).toBe(403)
    // The superadmin passes from the same authority.
    const allowed = fakeResponse()
    await routes[0]!.handler(
      fakeRequest({ host: 'harness.example', cookie: 'dsh_auth=tok-admin' }, `${API_PATH}/settings.describe`),
      allowed.response,
    )
    expect(allowed.state.status).not.toBe(401)
    expect(allowed.state.status).not.toBe(403)
    // Loopback keeps its pass for any authenticated account.
    const loopback = fakeResponse()
    await routes[0]!.handler(
      fakeRequest({ host: '127.0.0.1:3080', cookie: 'dsh_auth=tok-user' }, `${API_PATH}/settings.describe`),
      loopback.response,
    )
    expect(loopback.state.status).not.toBe(401)
    expect(loopback.state.status).not.toBe(403)
    await dispose()
  })

  it('honors the configured cookie name', async () => {
    const { routes, dispose } = await mounted({ authn: stubAuthn({ 'tok-1': stubUser() }), authCookieName: 'mine' })
    const defaultName = fakeResponse()
    await routes[0]!.handler(fakeRequest({ host: '127.0.0.1:3080', cookie: 'dsh_auth=tok-1' }), defaultName.response)
    expect(defaultName.state.status).toBe(401)
    const configured = fakeResponse()
    await routes[0]!.handler(fakeRequest({ host: '127.0.0.1:3080', cookie: 'mine=tok-1' }), configured.response)
    expect(configured.state.status).toBe(404)
    await dispose()
  })

  it('rejects a WebSocket upgrade without a valid cookie and passes one with it', async () => {
    const { upgrades, dispose } = await mounted({ authn: stubAuthn({ 'tok-1': stubUser() }) })
    const mux = upgrades.find(route => route.path === MUX_EVENTS_PATH)!
    const refused = await upgradeOutput(mux, fakeRequest({ host: '127.0.0.1:3080' }, MUX_EVENTS_PATH))
    expect(refused).toContain('HTTP/1.1 401 Unauthorized')
    // A valid cookie reaches the WebSocket implementation, whose own handshake
    // validation answers the header-less probe (400), never the fence's 401/403.
    const accepted = await upgradeOutput(mux, fakeRequest({ host: '127.0.0.1:3080', cookie: 'dsh_auth=tok-1' }, MUX_EVENTS_PATH))
    expect(accepted).not.toContain('401')
    expect(accepted).not.toContain('403')
    await dispose()
  })
})

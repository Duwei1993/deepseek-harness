/**
 * REAL-composition coverage: a test-only cordis.yml booted through the
 * vendored Loader mounts the webserver, the local authn provider (in-memory
 * store), the auth gate, and a test fallback owner; every assertion observes
 * the user-visible HTTP surface of the running server (the gate matrix, the
 * login and administration flows, and the bootstrap warning lifecycle). The
 * single composition is stateful by design: later phases rely on the accounts
 * earlier phases created.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import AuthnLocal from '@deepseek-ai/dsh-authn-local'
import * as AuthGate from '../src/index.ts'

/** The test-only fallback owner: a stand-in for the frontend dist server. */
const TestFrontend = {
  name: 'test-frontend',
  inject: ['webServer'],
  apply(ctx: Context): void {
    ctx.effect(() => ctx.webServer.registerFallback((req, res) => {
      /* v8 ignore next -- node:http always sets url on server requests. */
      const pathname = new URL(req.url ?? '/', 'http://x').pathname
      if (pathname === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end('INDEX-HTML')
        return
      }
      res.writeHead(404)
      res.end()
    }), 'test-frontend: fallback')
  },
}

let root: string | undefined
let context: Context | undefined
let port: number

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-auth-gate-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    "- name: '@deepseek-ai/dsh-authn-local'",
    '  config:',
    "    path: ':memory:'",
    "- name: '@deepseek-ai/dsh-auth-gate'",
    "- name: 'test-frontend'",
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', HttpServer],
    ['@deepseek-ai/dsh-authn-local', AuthnLocal],
    ['@deepseek-ai/dsh-auth-gate', AuthGate],
    ['test-frontend', TestFrontend],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  port = context.webServer.port
}, 60_000)

afterAll(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** One HTTP call against the running server; redirects stay unobserved (manual). */
async function call(path: string, init?: RequestInit): Promise<{ status: number; headers: Headers; body: string }> {
  const response = await fetch(`http://127.0.0.1:${String(port)}${path}`, { redirect: 'manual', ...init })
  return { status: response.status, headers: response.headers, body: await response.text() }
}

/** The JSON POST result: status, the minted cookie, and the parsed body. */
interface PostJsonResult { status: number; cookie: string | undefined; body: Record<string, unknown> }

/** One JSON POST returning the status, the minted cookie, and the parsed body. */
async function postJson(path: string, payload: unknown, cookie?: string): Promise<PostJsonResult> {
  const { status, headers, body } = await call(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...cookie !== undefined ? { cookie } : {},
    },
    body: JSON.stringify(payload),
  })
  return { status, cookie: headers.get('set-cookie') ?? undefined, body: JSON.parse(body) as Record<string, unknown> }
}

/** Extract the `dsh_auth` cookie value from a Set-Cookie header. */
function cookieValue(setCookie: string | undefined): string {
  if (setCookie === undefined) throw new Error('expected a Set-Cookie header')
  return setCookie.slice(0, setCookie.indexOf(';'))
}

let superadminCookie: string
let aliceCookie: string

describe('real Loader composition', () => {
  it('gates the SPA entry navigation while leaving other paths to their owners', async () => {
    // Unauthenticated navigation redirects; non-navigation traffic passes.
    const navigation = await call('/', { headers: { accept: 'text/html,application/xhtml+xml' } })
    expect(navigation.status).toBe(302)
    expect(navigation.headers.get('location')).toBe('/auth/login')
    expect((await call('/', { headers: { accept: '*/*' } })).status).toBe(200)
    expect((await call('/', { headers: { accept: '*/*' } })).body).toBe('INDEX-HTML')
    expect((await call('/', { method: 'HEAD', headers: { accept: '*/*' } })).status).toBe(200)
    expect((await call('/', { method: 'POST' })).status).toBe(405)
    // Paths outside the gate keep their owners: the fallback answers, not the gate.
    const asset = await call('/assets/app.js', { headers: { accept: 'text/html' } })
    expect(asset.status).toBe(404)
  })

  it('serves the login page with the bootstrap warning while the seed password stands', async () => {
    const page = await call('/auth/login')
    expect(page.status).toBe(200)
    expect(page.body).toContain('登录 DeepSeek Harness')
    expect(page.body).toContain('检测到初始管理员账户')
    // force-change without a session still renders the login form.
    const forced = await call('/auth/login?force-change=1')
    expect(forced.body).toContain('登录 DeepSeek Harness')
    const status = await call('/auth/status')
    expect(JSON.parse(status.body)).toEqual({ authenticated: false, mustChangePasswordBootstrap: true })
  })

  it('rejects malformed login bodies with carrier statuses', async () => {
    expect((await call('/auth/login', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status).toBe(415)
    expect((await call('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })).status).toBe(400)
    expect((await call('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '[1]' })).status).toBe(400)
    expect((await postJson('/auth/login', { username: 'only' })).status).toBe(400)
    const oversized = await call('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: `{"username":"${'a'.repeat(70 * 1024)}"}`,
    })
    expect(oversized.status).toBe(413)
  })

  it('fails wrong credentials with one shared 401 and rate-limits a failure streak', async () => {
    const failed = await postJson('/auth/login', { username: 'nosuch-user', password: 'x' })
    expect(failed.status).toBe(401)
    expect(failed.body).toEqual({ error: 'invalid username or password' })
    expect(failed.cookie).toBeUndefined()
    const throttled = await postJson('/auth/login', { username: 'nosuch-user', password: 'x' })
    expect(throttled.status).toBe(429)
    expect(typeof (throttled.body as { retryAfterMs?: unknown }).retryAfterMs).toBe('number')
  })

  it('logs the seeded superadmin in, enforces the forced change, and clears the warning', async () => {
    const login = await postJson('/auth/login', { username: 'superadmin', password: '123456' })
    expect(login.status).toBe(200)
    expect(login.body).toMatchObject({ user: { username: 'superadmin', role: 'superadmin', mustChangePassword: true } })
    expect(login.cookie).toMatch(/^dsh_auth=\S+; HttpOnly; SameSite=Lax; Path=\//)
    superadminCookie = cookieValue(login.cookie)

    // The flagged account renders the change form and its navigations redirect to it.
    const page = await call('/auth/login', { headers: { cookie: superadminCookie } })
    expect(page.body).toContain('修改密码')
    expect(page.body).toContain('superadmin')
    const navigation = await call('/', { headers: { accept: 'text/html', cookie: superadminCookie } })
    expect(navigation.status).toBe(302)
    expect(navigation.headers.get('location')).toBe('/auth/login?force-change=1')
    // Non-navigation traffic still passes for the flagged account.
    expect((await call('/', { headers: { accept: '*/*', cookie: superadminCookie } })).body).toBe('INDEX-HTML')
    const status = await call('/auth/status', { headers: { cookie: superadminCookie } })
    expect(JSON.parse(status.body)).toMatchObject({
      authenticated: true,
      user: { username: 'superadmin', role: 'superadmin', mustChangePassword: true },
      mustChangePasswordBootstrap: true,
    })

    // The change requires the session and the current password.
    expect((await postJson('/auth/change-password', { oldPassword: '123456', newPassword: 'n3w-pass' })).status).toBe(401)
    expect((await call('/auth/change-password', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', cookie: superadminCookie },
      body: '{}',
    })).status).toBe(415)
    expect((await postJson('/auth/change-password', { oldPassword: 'wrong', newPassword: 'n3w-pass' }, superadminCookie)).status).toBe(401)
    expect((await postJson('/auth/change-password', { oldPassword: '123456', newPassword: '' }, superadminCookie)).status).toBe(400)
    expect((await postJson('/auth/change-password', { oldPassword: '123456' }, superadminCookie)).status).toBe(400)
    expect((await postJson('/auth/change-password', { oldPassword: '123456', newPassword: 'n3w-pass' }, superadminCookie)).status).toBe(200)

    // Clean account: the login page bounces to the SPA, the navigation gate serves it, the warning is gone.
    const bounced = await call('/auth/login', { headers: { cookie: superadminCookie } })
    expect(bounced.status).toBe(302)
    expect(bounced.headers.get('location')).toBe('/')
    const changeAnyway = await call('/auth/login?force-change=1', { headers: { cookie: superadminCookie } })
    expect(changeAnyway.body).toContain('修改密码')
    const served = await call('/', { headers: { accept: 'text/html', cookie: superadminCookie } })
    expect(served.status).toBe(200)
    expect(served.body).toBe('INDEX-HTML')
    expect(JSON.parse((await call('/auth/status')).body)).toEqual({ authenticated: false, mustChangePasswordBootstrap: false })
  })

  it('serves the administration surface to superadmin only', async () => {
    expect((await call('/auth/admin')).status).toBe(302)
    expect((await call('/auth/admin', { headers: { cookie: superadminCookie } })).status).toBe(200)
    expect((await call('/auth/admin', { headers: { cookie: superadminCookie } })).body).toContain('账户管理')

    // The admin endpoints answer 401 without a session and reject malformed bodies.
    expect((await call('/auth/admin/users')).status).toBe(401)
    expect((await call('/auth/admin/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: superadminCookie },
      body: '{',
    })).status).toBe(400)

    const list = await call('/auth/admin/users', { headers: { cookie: superadminCookie } })
    expect(JSON.parse(list.body)).toEqual({
      users: [{
        username: 'superadmin',
        displayName: 'Superadmin',
        role: 'superadmin',
        disabled: false,
        mustChangePassword: false,
      }],
    })

    // Create alice; validation and conflicts answer 400/409.
    const created = await postJson('/auth/admin/users', { username: 'alice', password: 'pw-alice', role: 'user' }, superadminCookie)
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({ user: { username: 'alice', role: 'user', mustChangePassword: true } })
    expect((await postJson('/auth/admin/users', { username: 'alice', password: 'x' }, superadminCookie)).status).toBe(409)
    expect((await postJson('/auth/admin/users', { username: ' ', password: 'x' }, superadminCookie)).status).toBe(400)
    expect((await postJson('/auth/admin/users', { username: 'bob' }, superadminCookie)).status).toBe(400)
    expect((await postJson('/auth/admin/users', { username: 'bob', password: 'x', role: 'root' }, superadminCookie)).status).toBe(400)
    expect((await postJson('/auth/admin/users', { username: 'bob', password: 'x', displayName: 42 }, superadminCookie)).status).toBe(400)
    expect((await call('/auth/admin/users', { method: 'PUT', headers: { cookie: superadminCookie } })).status).toBe(405)

    // Sub-actions: shape, lookup, method, and body errors.
    expect((await postJson('/auth/admin/users/alice/explode', {}, superadminCookie)).status).toBe(404)
    expect((await postJson('/auth/admin/users/alice/reset-password/extra', {}, superadminCookie)).status).toBe(404)
    expect((await postJson('/auth/admin/users//reset-password', {}, superadminCookie)).status).toBe(404)
    expect((await call('/auth/admin/users/alice/reset-password', { headers: { cookie: superadminCookie } })).status).toBe(405)
    expect((await postJson('/auth/admin/users/nobody/reset-password', { password: 'x' }, superadminCookie)).status).toBe(404)
    expect((await call('/auth/admin/users/alice/reset-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: superadminCookie },
      body: '{',
    })).status).toBe(400)
    expect((await postJson('/auth/admin/users/alice/reset-password', {}, superadminCookie)).status).toBe(400)
    expect((await postJson('/auth/admin/users/alice/set-disabled', { disabled: 'yes' }, superadminCookie)).status).toBe(400)
    // A created display name round-trips onto the user list.
    const withDisplayName = await postJson('/auth/admin/users', { username: 'bob', password: 'pw-bob', displayName: 'Bob' }, superadminCookie)
    expect(withDisplayName.status).toBe(201)
    expect(withDisplayName.body).toMatchObject({ user: { username: 'bob', displayName: 'Bob' } })
    expect((await postJson('/auth/admin/users/alice/reset-password', { password: 'pw-alice-2' }, superadminCookie)).status).toBe(200)
    // A malformed %-escape in the name reaches the webserver's per-request containment.
    expect((await call('/auth/admin/users/%zz/reset-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: superadminCookie },
      body: '{"password":"x"}',
    })).status).toBe(400)
  })

  it('logs alice in, keeps her off the admin surface, and honors disable and logout', async () => {
    const login = await postJson('/auth/login', { username: 'alice', password: 'pw-alice-2' })
    expect(login.status).toBe(200)
    aliceCookie = cookieValue(login.cookie)
    // A non-superadmin is refused on both the admin page and its endpoints.
    expect((await call('/auth/admin', { headers: { cookie: aliceCookie } })).status).toBe(403)
    expect((await call('/auth/admin/users', { headers: { cookie: aliceCookie } })).status).toBe(403)
    // A fresh account is flagged mustChangePassword: the gate redirects her navigation.
    const navigation = await call('/', { headers: { accept: 'text/html', cookie: aliceCookie } })
    expect(navigation.headers.get('location')).toBe('/auth/login?force-change=1')
    expect((await postJson('/auth/change-password', { oldPassword: 'pw-alice-2', newPassword: 'pw-alice-3' }, aliceCookie)).status).toBe(200)
    expect((await call('/', { headers: { accept: 'text/html', cookie: aliceCookie } })).status).toBe(200)

    // Disable blocks a new login; re-enable restores it.
    expect((await postJson('/auth/admin/users/alice/set-disabled', { disabled: true }, superadminCookie)).status).toBe(200)
    const disabled = await postJson('/auth/login', { username: 'alice', password: 'pw-alice-3' })
    expect(disabled.status).toBe(403)
    expect(disabled.body).toEqual({ error: 'this account is disabled' })
    // The existing token resolves null for a disabled account.
    expect(JSON.parse((await call('/auth/status', { headers: { cookie: aliceCookie } })).body)).toMatchObject({ authenticated: false })
    expect((await postJson('/auth/admin/users/alice/set-disabled', { disabled: false }, superadminCookie)).status).toBe(200)

    // Logout expires the cookie; the token itself stays valid until expiry (documented limitation).
    const logout = await call('/auth/logout', { method: 'POST', headers: { cookie: aliceCookie } })
    expect(logout.status).toBe(200)
    expect(logout.headers.get('set-cookie')).toContain('Max-Age=0')
    expect(JSON.parse((await call('/auth/status', { headers: { cookie: aliceCookie } })).body)).toMatchObject({ authenticated: true })
    expect((await call('/auth/logout', { method: 'GET' })).status).toBe(405)
  })
})

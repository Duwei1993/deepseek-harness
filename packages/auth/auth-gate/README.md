# @deepseek-ai/dsh-auth-gate

English | [中文](README.zh.md)

The HTTP enforcement consumer of the [authentication seam](../auth/README.md) (`ctx.authn`), mounted with `inject: ['authn', 'webServer']`. It serves the self-contained login and account-administration pages under `/auth/*`, owns the session-cookie contract, and redirects unauthenticated page navigations to the login page. The `/api` transport fence lives in [`dsh-client-connection`](../../client/connection/README.md), which resolves the same cookie.

## Behavior

**Routes.** `GET /auth/login` renders the login page: a credential form, or the forced password-change form when the caller is authenticated but flagged `mustChangePassword` (or arrives with `?force-change=1`, which doubles as the voluntary change form for any signed-in account). A clean authenticated visitor is redirected to `/`. While the seeded `superadmin` account still awaits its first password change, the page carries a prominent warning banner — the web composition tree has no console logger, so this banner is where the seed warning becomes visible. `POST /auth/login` verifies credentials through `ctx.authn.login` and sets the session cookie; failures answer 401 with the shared "invalid username or password" wording that never reveals whether an account exists (429 while a rate-limit lockout runs). `POST /auth/logout` expires the cookie, `POST /auth/change-password` rotates the caller's password (cookie required), and `GET /auth/status` answers `{ authenticated, user?, mustChangePasswordBootstrap }` for page and SPA probing. `GET /auth/admin` serves the account-administration page to superadmins (anyone else: 302 to login, or 403 when signed in), backed by `GET`/`POST /auth/admin/users` and `POST /auth/admin/users/<name>/reset-password` / `set-disabled`, all superadmin-only JSON.

**Pages.** Both pages are single HTML documents with inline styles and script and no external resource, so they render before the SPA dist exists and under any deployment path. Product copy is Chinese, matching the SPA.

**Page-navigation gate.** A `prefix /` route intercepts exactly the SPA entry path: the webserver's prefix semantics match `/` only against the exact path, so every other path keeps its own route or falls through to the frontend fallback untouched. An unauthenticated GET navigation (`Accept` containing `text/html`) is redirected to `/auth/login`; an authenticated but `mustChangePassword` one to `/auth/login?force-change=1`. Allowed requests are served by fetching the composition's index path (config `indexPath`, default `/index.html`) back from this same server. Static assets, `/api`, and every non-`/` path are never intercepted.

**Cookie.** Login sets `<cookieName>=<token>; HttpOnly; SameSite=Lax; Path=/` with the bearer token verbatim. There is deliberately no `Secure` attribute: the default deployment is loopback HTTP, and a non-loopback deployment belongs behind an HTTPS reverse proxy.

## Configuration

All fields are optional: `cookieName` (session-cookie name, default `dsh_auth`; must match `dsh-client-connection`'s `authCookieName` when renamed), `indexPath` (the ungated address the page gate fetches allowed navigations from, default `/index.html`; the frontend fallback answers it).

## Model Experience

None, as the gate sits on the HTTP carrier between the browser and the host; it registers no prompt, tool schema, or model-visible content.

#### KV Cache effect

None; nothing here reaches a model request.

## Known Limitations and Deferred Work

- **`/index.html` answers directly** — the page gate owns only `/`; the index path stays reachable so the gate can proxy it. The SPA shell is static markup and carries no data; the `/api` and WebSocket fences are the enforcement boundary.
- **No token revocation** — logout expires the cookie but the bearer token stays valid until its sliding expiry; the seam has no revoke operation yet (TODO in the logout handler).
- **No session-owner binding** — any authenticated account sees every session; per-user filtering lands in the next milestone.
- **The SPA does not auto-redirect on 401** — a page whose session expires mid-use surfaces carrier errors until reload; reconnect-time login redirection is deferred with the SPA's long-connection semantics.
- **`mustChangePassword` is enforced on page navigations only** — direct `/api` calls with the flagged account's valid token still succeed, which is also how first-boot rotation happens for API-only clients.
- **OIDC and external identity linking** — reserved by the seam's storage, landed in no provider yet.

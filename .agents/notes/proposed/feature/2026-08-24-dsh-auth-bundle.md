# Agent Note: dsh-auth bundle — authentication capability skeleton (M3a)

Status: proposed

English | [中文](2026-08-24-dsh-auth-bundle.zh.md)

## Problem

DeepSeek Harness exposes its HTTP surface (apiproxy/webserver) with no concept of a user: any caller that reaches the port can list, open, and drive every session. Multi-user deployments need an account system — authenticated identity, credential login, bearer tokens, and an administration surface — before any route can be gated or any session can belong to someone.

That capability has to land in stages. The HTTP gate, session-owner binding, and the login UI each need the account model and token mechanics to already exist and be pinned by tests; building them together with the store they sit on would make one unreviewable change. The first stage delivered the skeleton: the seam contract, one local provider with the complete domain logic, an opt-in bundle, and unit coverage. The second stage (this update) delivers the enforcement half: the HTTP gate with its self-contained login and administration pages, the `/api` 401 fence, and the page-navigation redirect — still without session-owner binding.

## Proposal

The `packages/auth/` group follows the capability-seam split, plus one bundle:

- **`packages/auth/auth` (`@deepseek-ai/dsh-auth`)** — the Service Definition, mounted as `ctx.authn`. `AuthUser` carries a branded `UserId` (`dsh-brand`), `username`, `displayName`, `role: 'superadmin' | 'user'`, optional `tenant`, and the `disabled` / `mustChangePassword` flags. The abstract `AuthnService` declares `resolveToken` (unknown, expired, or disabled-owned tokens all return `null`; a successful resolve slides expiry forward), `login`, `changePassword`, and the management surface `listUsers`/`createUser`/`resetPassword`/`setDisabled`. Failures carry `AuthError` with stable codes; `AUTH_INVALID_CREDENTIALS` shares one message for an unknown username and a wrong password so the failure channel never reveals whether an account exists.
- **`packages/auth/authn-local` (`@deepseek-ai/dsh-authn-local`)** — the local provider. `node:sqlite` at `auth.db` under the resolved harness home (`dshHomePath`), schema under a monotonic `PRAGMA user_version` ladder (`SCHEMA_VERSION = 1`): `users`, `external_identities` (`UNIQUE(provider, subject)`, storage-only plumbing reserved for M3b OIDC), and `auth_tokens` keyed by SHA-256 digest. Passwords are scrypt with random salts stored as `saltHex:hashHex`, verified with `timingSafeEqual`; unknown usernames verify against a standing dummy hash so failure timing does not reveal account existence. Tokens are 32 random bytes, live `tokenTtlMs` (7 days by default), and slide on every resolve; expired tokens are deleted when observed. Login failures lock the username under an in-memory exponential backoff (1s base doubling to a 5-minute cap, both Config fields); a credential success clears the streak. An empty `users` table at boot seeds `superadmin` / `123456` with `mustChangePassword: true` and a loud `ctx.logger.warn` banner; `seedSuperadminPassword` is a documented test hook consulted only while the store is empty. The database closes with the plugin fiber's disposer.
- **`packages/auth/auth-gate` (`@deepseek-ai/dsh-auth-gate`)** — the HTTP enforcement consumer, `inject: ['authn', 'webServer']`. It serves the self-contained pages (inline CSS/JS, no external resources, Chinese product copy like the SPA): `GET /auth/login` renders the credential form, or the forced password-change form for an authenticated `mustChangePassword` account (also reachable voluntarily via `?force-change=1`); while the seeded superadmin still awaits its first change, the page carries the warning banner — this is where the seed warning becomes visible, because the web composition tree has no console logger for `logger.warn` to reach. The JSON endpoints are `POST /auth/login` (mints the session cookie `<cookieName>=<token>; HttpOnly; SameSite=Lax; Path=`, deliberately no `Secure` — loopback is the default, and a public deployment belongs behind an HTTPS reverse proxy), `POST /auth/logout` (expires the cookie; the seam has no revocation yet — TODO), `POST /auth/change-password` (cookie required), `GET /auth/status` (`{ authenticated, user?, mustChangePasswordBootstrap }` for page/SPA probing), and the superadmin-only administration surface `GET /auth/admin` plus `GET`/`POST /auth/admin/users`, `POST /auth/admin/users/<name>/reset-password`, `POST /auth/admin/users/<name>/set-disabled`.
- **The page-navigation gate** — a `prefix /` route intercepts exactly the SPA entry path: the webserver's prefix semantics match `p` or `p/<anything>`, and `/` has no subpath form, so the registration owns `/` alone while every other path keeps its route or the frontend fallback. An unauthenticated GET navigation (`Accept` contains `text/html`) answers 302 to `/auth/login`; a `mustChangePassword` one 302 to `/auth/login?force-change=1`. An allowed request is served by fetching the composition's index path (`indexPath` config, default `/index.html`) back from the same server, because a matched webserver route owns the response and cannot defer to the fallback.
- **`packages/bundle/auth-bundle` (`@deepseek-ai/dsh-auth-bundle`)** — the opt-in bundle: one `cordis.patch.yml` insert list mounting `authn-local` and `auth-gate`, both rows resolvable from the bundle's own dependencies. Readiness order is inject-driven: the gate declares `inject: ['authn', 'webServer']`, so it activates after the provider and only in compositions that carry a web server.

**The `/api` fence is a minimal change to `packages/client/connection`, not a new package**: the connection plugin owns the `/api` prefix route and the upgrade routes, so no other package can gate them. When `ctx.get('authn')` finds the optional service, the route handler resolves the session cookie after the trust fence and answers 401 JSON before the bridge — a placement that also covers the Typert Remote interceptor, which bypasses the fetch fallback. The same cookie check rejects unauthenticated WebSocket upgrades with 401 before negotiation. The `PRIVILEGED_METHODS` loopback pin relaxes to loopback-or-superadmin: the fallback's privileged check re-resolves the cookie from the bridge-created `Request` and admits an authenticated `role === 'superadmin'` from any trusted authority; loopback keeps passing for any authenticated account, and without an `authn` service the behavior is byte-for-byte the pre-authentication fence. The cookie name is shared configuration: the gate's `cookieName` and the connection's `authCookieName` both default to `dsh_auth` and must be renamed together.

The package directory is `packages/bundle/auth-bundle`, not a same-name short directory: the tsconfig source-plane wildcard maps `@deepseek-ai/dsh-<dir>` by directory name, and a bundle directory named plain `auth` would shadow the `dsh-auth` package specifier.

Explicitly out of scope still: session-owner binding and list filtering, the OIDC provider (M3b), token revocation, and SPA-side automatic login redirects on 401 (deferred with the long-connection reconnect semantics). The seam mounts no model-facing surface, so no snapshot fixture is owed; behavior is pinned by unit tests against temporary-directory databases plus a real-Loader composition test driving the gate over live HTTP, never the real harness home.

## Alternatives considered

**Skip the Service Definition and mount a concrete store directly.** Rejected: the HTTP gate and OIDC provider (M3b) both target the seam; without the abstract contract, swapping providers later means re-touching every consumer, which is exactly what the capability-seam rule forbids.

**JWT bearer tokens instead of opaque digests.** Rejected for this skeleton: stateless tokens cannot be voided by `disabled` or expiry slides without a revocation list, which reintroduces the store the JWT was meant to avoid. Opaque tokens keep revocation semantics in one table.

**Argon2 or bcrypt for password hashing.** Rejected: `node:crypto` scrypt ships with the runtime and needs no dependency; the `salt:hash` record format leaves the algorithm replaceable without a schema change.

**Seed on first login attempt instead of first boot.** Rejected: a boot-time seed fails loud and warns once, at the same moment the store is created; a lazy seed would bury the default-credential warning inside an unrelated request.

**Fold the auth database into the session SQLite store.** Rejected: sessions and accounts have different lifecycles, backup posture, and ownership; one file per domain keeps each store's schema ladder independent.

**Add a middleware primitive to `dsh-host-webserver` for the page gate.** Rejected for this milestone: the webserver's route contract (exact > longest prefix > fallback, a matched route owns the response) is load-bearing for every existing consumer, and the gate needs to own only `/` — which the existing prefix semantics already deliver. Owning `/` and proxying allowed navigations from the fallback's own index path achieves the redirect without touching the webserver; if a later milestone needs genuine multi-path interception, a middleware hook can be designed with evidence.

**Client-side redirect through an index injection instead of HTTP 302.** Rejected: `webserver/index-inject` and `tapIndex` see markup, never the request, so they cannot key on the session cookie; a script-injected check would flash the SPA shell and still need the `/api` fence for enforcement. The carrier-level 302 is one line of policy at the route the composition already owns.

**Thread the resolved `AuthUser` to the privileged check with a `WeakMap<Request, AuthUser>`.** Rejected: the bridge constructs the WHATWG `Request` internally, so the route handler has no object to key on; re-resolving the cookie inside the privileged check is stateless, and the double `resolveToken` costs one SQLite digest lookup on configuration-plane calls only.

**Gate static assets and `/index.html` too.** Rejected: the SPA shell is static markup with no data, and the `/api` plus WebSocket fences are the enforcement boundary; the page gate exists for UX (land on the login page, not a broken shell), so owning just `/` is proportionate. The limitation is documented in the gate README.

## Acceptance criteria

- The packages register in the host aggregate and the `tsconfig.base.json` source-plane wildcards; each package builds alone through `tsc -b packages/<group>/<pkg>` and tests alone through `vitest run packages/<group>/<pkg>` (repo packages carry no per-package npm scripts), and the root `typecheck` passes.
- Unit tests cover password hashing and constant-time verification (including malformed records), token issue/resolve/sliding-expiry/expiry-deletion, seeding and its idempotency across remounts, the rate-limit backoff ladder and its cap, the management surface, and the external-identity link table — all against temporary directories and an injected clock.
- The gate's per-file 100% coverage gate passes: cookie helpers, the page renderers, body reading, the full route matrix (login success/failure/lockout, forced change, status, logout, admin CRUD and its permission refusals), and the page-gate redirect/proxy — including a real-Loader composition booting webserver + provider + gate over live HTTP, and a hand-built edge suite for provider crashes and proxy failures.
- The connection change pins both compositions: with `authn` mounted, cookie-less `/api` requests and upgrades get 401 and superadmins pass the privileged set from a trusted authority; without it, every pre-authentication test stands unchanged.
- The invariant companions register each package's own name; the cordis-config, package-invariant, README (Model Experience + Known Limitations), and translation-pairing gates pass.
- The bundle's patch rows resolve from the bundle manifest's dependencies, and mounting the bundle boots a working `ctx.authn` plus the gate.
- An end-to-end smoke against `dsh web --port 0 --no-open` demonstrates the matrix: unauthenticated navigation 302, wrong-password 401, login cookie, gated `/` 200, the bootstrap banner lifecycle, password change, admin user management, and the `/api` 401.

## Risks

The default seed password is a deliberate first-boot insecurity; the gate now forces its rotation before any page navigation succeeds, the login page banner shows while it stands, and the `/api` fence closes the unauthenticated RPC path — but nothing ships the bundle into a default profile, so an unauthenticated deployment is unchanged.

The page gate owns only `/`: `/index.html` and static assets answer unauthenticated, which is safe only because the SPA shell carries no data and the transport fence is complete — a future route that serves sensitive HTML outside `/` must revisit this.

The gate's index proxy adds one loopback hop per allowed `/` navigation; the hop is invisible to users but means the gate depends on the composition's fallback answering `indexPath`, which a composition without a frontend answers with the fallback's own 404.

Process-local rate limiting and lazy token cleanup are known simplifications; both are documented as limitations and sized for the single-process harness this provider serves.

The seam contract is designed ahead of its remaining consumers. Session-owner binding may still force adjustments (for example, token introspection metadata) that a later milestone will have to amend this note to record.

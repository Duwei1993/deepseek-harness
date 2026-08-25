# @deepseek-ai/dsh-auth-bundle

English | [中文](README.zh.md)

The opt-in authentication bundle. Its [`cordis.patch.yml`](cordis.patch.yml) — declared through the `dsh.bundle.patch` manifest field — inserts two rows over the profile it layers onto: `authn-local`, the [`ctx.authn` seam](../../auth/auth/README.md)'s [local SQLite provider](../../auth/authn-local/README.md), and `auth-gate`, the [HTTP gate](../../auth/auth-gate/README.md) that serves the login and account-administration pages under `/auth/*` and redirects unauthenticated page navigations. A deployment opts in by adding this bundle to its profile's bundles list; a later patch layer can still override or disable either row by id.

Both rows mount enabled: the provider opens `auth.db` under the harness home at boot and seeds the `superadmin` account (default password `123456`, flagged `mustChangePassword`, loudly warned), and the gate forces that account's first sign-in straight onto the change form. With the bundle mounted, `dsh-client-connection`'s optional `/api` fence activates too: every `/api` request and WebSocket upgrade must carry the gate's session cookie, and the privileged method set relaxes from loopback-only to loopback-or-superadmin. Session-owner binding lands in a later milestone (see the gate package's limitations). The package has no runtime API of its own.

## Model Experience

Indirectly, through the inserted rows: this bundle is a patch-list carrier whose rows' packages own their behavior, and none of it reaches a model request.

#### KV Cache effect

None; the inserted rows register nothing model-visible.

## Known Limitations and Deferred Work

- **No session-owner binding** — any authenticated account sees every session; per-owner filtering is the next milestone.
- **The bundle always mounts the local provider** — a deployment wanting a different provider disables the `authn-local` row and mounts its own in a later patch layer; there is no provider-selection config on the bundle itself.

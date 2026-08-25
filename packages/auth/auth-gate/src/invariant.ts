/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-auth-gate`.
 * @module @deepseek-ai/dsh-auth-gate/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-auth-gate'

/** Cordis companion plugin name. */
export const name = 'auth-gate-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the gate's only mutable state lives in the authn
 * provider's own store, and its route registrations are `ctx.effect`-owned
 * disposers whose symmetry the `dsh-host-webserver` invariant already probes
 * — no independent event stream or public mutable relation exists here to
 * cross-check.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */

/** Invariant companion registration for @deepseek-ai/dsh-auth-gate. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as AuthGateInvariant from '../src/invariant.ts'

describe('invariant companion', () => {
  it('registers the package ownership with an empty installer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await expect(ctx.plugin(AuthGateInvariant).await()).resolves.toBeDefined()
  })
})

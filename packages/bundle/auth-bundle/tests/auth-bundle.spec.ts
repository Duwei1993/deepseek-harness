/**
 * The bundle's substance is its patch file: the `dsh.bundle.patch` manifest
 * field must name a real, parseable patch list whose rows resolve from the
 * bundle's own dependencies.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

describe('dsh-auth-bundle', () => {
  it('declares a parseable patch that mounts the local authn provider and its HTTP gate', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(
      readFileSync(resolve(root, 'package.json'), 'utf8'),
    ) as {
      dependencies?: Record<string, string>
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    const parsed = yaml.load(
      readFileSync(resolve(root, manifest.dsh!.bundle!.patch!), 'utf8'),
      { schema: entryListSchema },
    )
    if (!Array.isArray(parsed)) throw new TypeError('auth patch must parse to a patch list')
    const rows = parsed.flatMap((patch): Record<string, unknown>[] =>
      typeof patch === 'object' && patch !== null
        ? (patch as { insert?: Record<string, unknown>[] }).insert ?? []
        : [],
    )
    const authn = rows.filter(row => row.id === 'authn-local')
    expect(authn).toHaveLength(1)
    expect(authn[0]).toMatchObject({ name: '@deepseek-ai/dsh-authn-local' })
    const gate = rows.filter(row => row.id === 'auth-gate')
    expect(gate).toHaveLength(1)
    expect(gate[0]).toMatchObject({ name: '@deepseek-ai/dsh-auth-gate' })
    // Bundle rows resolve from the bundle's own dependency closure.
    expect(manifest.dependencies).toHaveProperty('@deepseek-ai/dsh-authn-local')
    expect(manifest.dependencies).toHaveProperty('@deepseek-ai/dsh-auth-gate')
  })
})

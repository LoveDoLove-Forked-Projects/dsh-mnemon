import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import * as runtimePlugin from 'dsh-mnemon-source-runtime'
import * as documentsPlugin from 'dsh-mnemon-source-documents'
import * as spacesPlugin from 'dsh-mnemon-source-memory-spaces'
import * as strategyPlugin from 'dsh-mnemon-strategy-default-three-tier'
import native from 'dsh-mnemon-provider-mnemon-native'
import { MemoryCompositionRunner } from '../src/sdk/testing.ts'

/**
 * dshmarket mounts `mkt-client-<package>` without config for every profile
 * dependency that declares `dsh.client` but no `dsh.bundle`; DSH's Loader names
 * it `include:dsh-market:mkt-client-<package>`. A Source installed on its own in
 * a profile matches that rule, and dshmarket 1.66 imports its real module there
 * (#359). The Starter's Entries stay the only Source instances.
 */
const runners: MemoryCompositionRunner[] = []
afterEach(async () => { await Promise.all(runners.splice(0).map(runner => runner.dispose())) })

async function starterComposition() {
  const runner = new MemoryCompositionRunner()
  runners.push(runner)
  await runner.mount(strategyPlugin, { instanceId: 'include:mnemon-strategy-default-three-tier' })
  await runner.mount(runtimePlugin, { instanceId: 'include:mnemon-source-runtime' })
  await runner.mount(documentsPlugin, { instanceId: 'include:mnemon-source-documents' })
  await runner.mount({ inject: ['mnemonMemory'], async apply(ctx: Context) {
    await spacesPlugin.installMemorySpaces(ctx, [{ instanceId: native.id, module: native, config: undefined }])
  } }, { instanceId: 'include:mnemon-source-memory-spaces' })
  return runner
}

async function sourceKeys(runner: MemoryCompositionRunner) {
  return (await runner.managementCatalog()).sources.map(source => source.sourceInstanceKey).sort()
}

describe('dshmarket client-only shim Entries (#359)', () => {
  it('mounts each Source package a second time without an error or a second instance', async () => {
    const runner = await starterComposition()
    const before = await sourceKeys(runner)
    expect(before).toEqual(['source:include:mnemon-source-documents', 'source:include:mnemon-source-memory-spaces', 'source:include:mnemon-source-runtime'])

    for (const [name, plugin] of [
      ['dsh-mnemon-source-runtime', runtimePlugin],
      ['dsh-mnemon-source-documents', documentsPlugin],
      ['dsh-mnemon-source-memory-spaces', spacesPlugin],
    ] as const) await runner.mount(plugin as never, { instanceId: `include:dsh-market:mkt-client-${name}` })
    expect(await sourceKeys(runner)).toEqual(before)
  })

  it('still composes a second configured instance under an ordinary Entry', async () => {
    const runner = await starterComposition()
    await runner.mount(runtimePlugin, { instanceId: 'runtime-work' })
    await expect(runner.mount(spacesPlugin, { instanceId: 'spaces-work' })).rejects.toThrow('at least one explicit Provider child')
    expect(await sourceKeys(runner)).toContain('source:runtime-work')
  })
})

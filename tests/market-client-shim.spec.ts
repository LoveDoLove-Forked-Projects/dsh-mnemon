import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import * as runtimePlugin from 'dsh-mnemon-source-runtime'
import * as documentsPlugin from 'dsh-mnemon-source-documents'
import * as spacesPlugin from 'dsh-mnemon-source-memory-spaces'
import * as strategyPlugin from 'dsh-mnemon-strategy-default-three-tier'
import native from 'dsh-mnemon-provider-mnemon-native'
import { MemoryCompositionRunner } from '../src/sdk/testing.ts'

/**
 * dshmarket mounts `mkt-client-<package>` without config for a profile
 * dependency that declares `dsh.client` but no `dsh.bundle`; DSH's Loader names
 * it `include:dsh-market:mkt-client-<package>`. A Source installed on its own in
 * a profile matches that rule, and dshmarket 1.66 imports its real module there
 * (#359). The Starter's Entries stay the only Source instances.
 */
const shimEntry = (name: string) => `include:dsh-market:mkt-client-${name}`
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())) })

async function starterComposition() {
  const directory = mkdtempSync(join(tmpdir(), 'mnemon-market-shim-'))
  // The Starter's Runtime and Documents Entries read and write here, so both are available to a View.
  const runner = new MemoryCompositionRunner({
    strategyTypeId: 'default-three-tier',
    sourceConfiguration: source => source.manifest.typeId === 'runtime' || source.manifest.typeId === 'documents' ? { dataDir: directory } : {},
  })
  cleanups.push(async () => { await runner.dispose(); rmSync(directory, { recursive: true, force: true }) })
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
  it('adds no second Runtime Memory or Project Documents, so the layered View still composes', async () => {
    const runner = await starterComposition()
    const before = await sourceKeys(runner)
    expect(before).toEqual(['source:include:mnemon-source-documents', 'source:include:mnemon-source-memory-spaces', 'source:include:mnemon-source-runtime'])
    await runner.mount(runtimePlugin, { instanceId: shimEntry('dsh-mnemon-source-runtime') })
    await runner.mount(documentsPlugin, { instanceId: shimEntry('dsh-mnemon-source-documents') })
    // Two working-context Sources would make the default layered Strategy refuse every turn.
    const turn = await runner.beginTurn()
    expect(turn.view.sourcePresentations?.length).toBeGreaterThan(0)
    turn.release()
    expect(await sourceKeys(runner)).toEqual(before)
  })

  it('mounts Memory Spaces there without its Providers and without an error', async () => {
    const runner = await starterComposition()
    const before = await sourceKeys(runner)
    await runner.mount(spacesPlugin, { instanceId: shimEntry('dsh-mnemon-source-memory-spaces') })
    expect(await sourceKeys(runner)).toEqual(before)
  })

  it('still composes a second configured instance under an ordinary Entry', async () => {
    const runner = await starterComposition()
    await runner.mount(runtimePlugin, { instanceId: 'runtime-work' })
    await expect(runner.mount(spacesPlugin, { instanceId: 'spaces-work' })).rejects.toThrow('at least one explicit Provider child')
    expect(await sourceKeys(runner)).toContain('source:runtime-work')
  })
})

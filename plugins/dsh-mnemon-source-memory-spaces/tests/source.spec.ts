import { descriptor, provider, strategy } from './fixture.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'

import { DEFAULT_MEMORY_VIEW_BUDGET, MemoryCompositionRunner } from 'dsh-mnemon/testing'
import { installMemorySpaces } from '../src/index.ts'
import { MemorySpaceRegistry } from '../src/memory-spaces.ts'
import { createRunner } from '../src/runner.ts'
import { resolveMemorySpacesConfig } from '../src/config.ts'
import { defineMemorySpaceProvider, MEMORY_SPACE_PROVIDER_API_VERSION, NORMALIZED_RELEVANCE_SCORE } from '../src/provider-sdk.ts'
import { MemoryProviderCatalog } from '../src/providers/catalog.ts'

describe('standalone Memory Spaces Source', () => {
  it('admits only evidence actually returned under the View budget, not all Provider search hits', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mnemon-spaces-bounded-'))
    const runner = new MemoryCompositionRunner()
    const scope = { storage: 'custom' as const }
    const rows = [{ id: 'visible', content: 'needle😀 evidence one', score: 1, importance: 0.8, createdAt: '2026-08-30T00:00:00.000Z' }, { id: 'hidden', content: 'needle evidence two', score: 0.9 }]
    const related = vi.fn(async () => [...rows])
    const forget = vi.fn(async () => ({ action: 'deleted' }))
    const boundedProvider = defineMemorySpaceProvider<undefined>({ id: 'bounded', apply(ctx, host) {
      host.install(ctx, {
        manifest: { apiVersion: MEMORY_SPACE_PROVIDER_API_VERSION, kind: 'provider', typeId: 'bounded',
          packageName: 'dsh-mnemon-provider-bounded-test', version: '1.0.0', label: 'Bounded fixture', summary: 'Simulated Provider; real Source and Core.',
          origin: 'third-party', locality: 'remote', workspaceBinding: 'provider-global', fields: [], secrets: [], scoreSemantics: 'normalized-relevance',
          capabilities: { ...descriptor.capabilities, related: true, forget: true, deletionMode: 'hard' },
        },
        create: () => ({ id: 'bounded', scoreSemantics: NORMALIZED_RELEVANCE_SCORE,
          discover: async () => [{ externalId: 'notes', name: 'Notes', description: 'Fixture namespace', connection: {} }],
          status: async () => ({ healthy: true }), list: async () => [...rows], search: async () => ({ results: [...rows] }),
          graph: async () => ({ nodes: [], edges: [], generatedAt: new Date().toISOString() }),
          remember: async () => ({ action: 'queued', operationId: 'extraction-job' }), related, forget,
        }),
      })
    } })
    try {
      await runner.mount(strategy, { instanceId: 'strategy' })
      await runner.mount({ inject: ['mnemonMemory'], async apply(ctx: Context) {
        await installMemorySpaces(ctx, [{ instanceId: 'account', module: boundedProvider, config: undefined }], { config: { dataDir: directory } })
      } }, { instanceId: 'work' })
      const source = (await runner.managementCatalog(scope)).sources[0]!
      await runner.executeManagement({ scope, sourceInstanceKey: source.sourceInstanceKey, mode: 'mutate', confirmed: true,
        expectedRevision: source.revision, operation: 'provider-service-update', input: { providerId: 'account', settings: {}, enabled: true } })
      const turn = await runner.beginTurn({ scope, budget: { ...DEFAULT_MEMORY_VIEW_BUDGET, maxEvidenceCharacters: 5 } })
      const route = (id: string) => turn.view.routes.find(route => route.sourceRouteId === id)!.id
      const remember = turn.view.actionOffers.find(action => action.sourceActionId === 'remember')!
      const accepted = await turn.executeAction(remember.id, { content: 'Queued input.' }, () => true)
      expect(accepted).toMatchObject({ status: 'succeeded', completion: 'accepted', details: { result: { operationId: 'extraction-job' } } })
      expect(accepted.committedAt).toBeUndefined()
      const evidence = await turn.executeRoute(route('recall'), { query: 'needle' })
      expect(evidence.items.map(item => item.id)).toEqual(['visible'])
      expect(evidence.items[0]?.provenance).toMatchObject({ importance: 0.8, createdAt: '2026-08-30T00:00:00.000Z' })
      expect(evidence.items[0]?.text.length).toBeLessThanOrEqual(5)
      expect(evidence.truncated).toBe(true)
      await expect(turn.executeRoute(route('related'), { id: 'hidden' })).rejects.toThrow('already admitted')
      expect(related).not.toHaveBeenCalled()
      await turn.executeRoute(route('related'), { id: 'visible' })
      expect(related).toHaveBeenCalledOnce()
      const action = turn.view.actionOffers.find(action => action.sourceActionId === 'forget')!
      await expect(turn.executeAction(action.id, { id: 'hidden' }, () => true)).rejects.toThrow('already admitted')
      // Naming the space does not make an id usable when its Provider cannot look
      // ids up: that Provider's own forget may reach beyond the space (issue 337).
      const directoryRead = await runner.executeManagement({ scope, sourceInstanceKey: source.sourceInstanceKey, mode: 'read', confirmed: false, operation: 'body-directory', input: null })
      const notes = (directoryRead.value as unknown as { items: Array<{ id: string }> }).items[0]!.id
      await expect(turn.executeAction(action.id, { id: 'hidden', memoryBodyId: notes }, () => true)).rejects.toThrow('already admitted')
      await expect(turn.executeRoute(route('related'), { id: 'hidden', memoryBodyId: notes })).rejects.toThrow('already admitted')
      expect(forget).not.toHaveBeenCalled()
      const receipt = await turn.executeAction(action.id, { id: 'visible' }, () => true)
      expect(receipt.completion).toBe('committed')
      const catalog = await turn.executeRoute(route('inspect'), { section: 'directory' })
      expect(catalog.items).toEqual([]) // Never clip catalog JSON into invalid text.
      expect(catalog.unavailable).toContain('valid catalog JSON')
    } finally { await runner.dispose(); rmSync(directory, { recursive: true, force: true }) }
  })

  it('acts on a memory named by exact id that this View has not returned (issue 337)', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mnemon-spaces-exact-id-'))
    const runner = new MemoryCompositionRunner()
    const scope = { storage: 'custom' as const }
    // `written` exists only in Notes; `twin` exists in both spaces.
    const stored: Record<string, Array<{ id: string; content: string }>> = {
      notes: [{ id: 'written', content: 'Written a moment ago' }, { id: 'twin', content: 'Twin in Notes' }],
      archive: [{ id: 'twin', content: 'Twin in Archive' }],
    }
    const forget = vi.fn(async () => ({ action: 'deleted' }))
    const related = vi.fn(async () => [])
    const link = vi.fn(async () => ({ action: 'linked' }))
    const exactProvider = defineMemorySpaceProvider<undefined>({ id: 'exact', apply(ctx, host) {
      host.install(ctx, {
        manifest: { apiVersion: MEMORY_SPACE_PROVIDER_API_VERSION, kind: 'provider', typeId: 'exact',
          packageName: 'dsh-mnemon-provider-exact-test', version: '1.0.0', label: 'Exact fixture', summary: 'Looks memories up by id.',
          origin: 'third-party', locality: 'remote', workspaceBinding: 'provider-global', fields: [], secrets: [], scoreSemantics: 'normalized-relevance',
          capabilities: { ...descriptor.capabilities, related: true, link: true, forget: true, deletionMode: 'soft' },
        },
        create: () => ({ id: 'exact', scoreSemantics: NORMALIZED_RELEVANCE_SCORE,
          discover: async () => [
            { externalId: 'notes', name: 'Notes', description: 'Fixture namespace', connection: {} },
            { externalId: 'archive', name: 'Archive', description: 'Fixture namespace', connection: {} },
          ],
          status: async () => ({ healthy: true }), list: async () => [], search: async () => ({ results: [] }),
          graph: async () => ({ nodes: [], edges: [], generatedAt: new Date().toISOString() }),
          remember: async () => ({ action: 'stored' }),
          get: async (body, id) => stored[body.name.toLowerCase()]?.find(item => item.id === id),
          related, link, forget,
        }),
      })
    } })
    try {
      await runner.mount(strategy, { instanceId: 'strategy' })
      await runner.mount({ inject: ['mnemonMemory'], async apply(ctx: Context) {
        await installMemorySpaces(ctx, [{ instanceId: 'account', module: exactProvider, config: undefined }], { config: { dataDir: directory } })
      } }, { instanceId: 'work' })
      const source = (await runner.managementCatalog(scope)).sources[0]!
      await runner.executeManagement({ scope, sourceInstanceKey: source.sourceInstanceKey, mode: 'mutate', confirmed: true,
        expectedRevision: source.revision, operation: 'provider-service-update', input: { providerId: 'account', settings: {}, enabled: true } })
      const directoryRead = await runner.executeManagement({ scope, sourceInstanceKey: source.sourceInstanceKey, mode: 'read', confirmed: false, operation: 'body-directory', input: null })
      const spaces = (directoryRead.value as unknown as { items: Array<{ id: string; name: string }> }).items
      const notes = spaces.find(space => space.name === 'Notes')!.id
      const archive = spaces.find(space => space.name === 'Archive')!.id
      const turn = await runner.beginTurn({ scope })
      const offer = (id: string) => turn.view.actionOffers.find(action => action.sourceActionId === id)!.id
      const route = turn.view.routes.find(item => item.sourceRouteId === 'related')!.id

      // Nothing was recalled in this View: the Provider finds the id, in one space only.
      await expect(turn.executeAction(offer('forget'), { id: 'written' }, () => true)).resolves.toMatchObject({ completion: 'committed' })
      expect(forget.mock.calls.at(-1)?.slice(0, 2)).toEqual([expect.objectContaining({ id: notes }), 'written'])
      // An id no authorized space holds, or one two spaces hold, is not guessed.
      await expect(turn.executeAction(offer('forget'), { id: 'missing' }, () => true)).rejects.toThrow('already admitted')
      await expect(turn.executeAction(offer('forget'), { id: 'twin' }, () => true)).rejects.toThrow('already admitted')
      expect(forget).toHaveBeenCalledOnce()
      // Naming the space settles it.
      await turn.executeAction(offer('forget'), { id: 'twin', memoryBodyId: archive }, () => true)
      expect(forget.mock.calls.at(-1)?.slice(0, 2)).toEqual([expect.objectContaining({ id: archive }), 'twin'])
      // The same holds for traversal and links within one space.
      await turn.executeRoute(route, { id: 'twin', memoryBodyId: notes })
      expect(related.mock.calls.at(-1)?.slice(0, 3)).toEqual([expect.objectContaining({ id: notes }), 'twin', 2])
      await turn.executeAction(offer('link'), { sourceId: 'written', targetId: 'twin', memoryBodyId: notes }, () => true)
      expect(link.mock.calls.at(-1)?.slice(0, 3)).toEqual([expect.objectContaining({ id: notes }), 'written', 'twin'])
      await expect(turn.executeAction(offer('link'), { sourceId: 'written', targetId: 'twin', memoryBodyId: archive }, () => true)).rejects.toThrow('link requires two evidence items')
      turn.release()
    } finally { await runner.dispose(); rmSync(directory, { recursive: true, force: true }) }
  })

  it('owns two isolated Provider trees, storage roots, management and LLM routes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mnemon-spaces-source-'))
    const runner = new MemoryCompositionRunner()
    const scope = { storage: 'custom' as const }
    try {
      await runner.mount(strategy, { instanceId: 'strategy' })
      for (const id of ['work', 'personal']) await runner.mount({ inject: ['mnemonMemory'], async apply(ctx: Context) {
        await installMemorySpaces(ctx, [{ instanceId: 'account', module: provider, config: undefined }], { config: { dataDir: join(directory, id) } })
      } }, { instanceId: id })
      for (const sourceInstanceKey of ['source:work', 'source:personal']) {
        const source = (await runner.managementCatalog(scope)).sources.find(source => source.sourceInstanceKey === sourceInstanceKey)!
        await runner.executeManagement({ scope, sourceInstanceKey, mode: 'mutate', confirmed: true, expectedRevision: source.revision,
          operation: 'provider-service-update', input: { providerId: 'account', settings: {}, enabled: true } })
      }
      const first = await runner.beginTurn({ scope })
      expect(first.view.sourcePresentations?.filter(value => value.visibleItems > 0)).toEqual(expect.arrayContaining([
        expect.objectContaining({ mode: 'routed', visibleItems: 1, totalItems: 1,
          items: [expect.objectContaining({ title: 'Notes', excerpt: 'Provider namespace' })] }),
      ]))
      const action = first.view.actionOffers.find(offer => offer.sourceInstanceKey === 'source:work' && offer.sourceActionId === 'remember')!
      await first.executeAction(action.id, { content: 'Only for work' }, () => true)
      first.release()
      const next = await runner.beginTurn({ scope })
      for (const route of next.view.routes.filter(route => route.sourceRouteId === 'recall')) {
        const evidence = await next.executeRoute(route.id, { query: 'work' })
        expect(evidence.items).toHaveLength(route.sourceInstanceKey === 'source:work' ? 1 : 0)
      }
      expect(runner.context.get('mnemonProvider', false)).toBeUndefined()
      next.release()
    } finally { await runner.dispose(); rmSync(directory, { recursive: true, force: true }) }
  })

  it('observes durable metadata changed by another generation', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mnemon-spaces-authority-'))
    try {
      const nativeRunner = createRunner(resolveMemorySpacesConfig({ dataDir: directory }))
      const catalog = new MemoryProviderCatalog([descriptor])
      const first = new MemorySpaceRegistry(nativeRunner, true, undefined, catalog)
      first.syncProviderService('fixture', {}, [{ externalId: 'notes', name: 'Notes', description: 'A namespace', connection: {} }])
      const second = new MemorySpaceRegistry(nativeRunner, true, undefined, catalog)
      const id = first.list()[0]!.id
      first.setActive(id, false)
      expect(second.get(id).active).toBe(false)
      second.update(id, { name: 'Updated elsewhere' })
      expect(first.get(id).name).toBe('Updated elsewhere')
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })

  it('publishes nothing when configuration or a child fails', async () => {
    const runner = new MemoryCompositionRunner()
    try {
      await expect(runner.mount({ inject: ['mnemonMemory'], async apply(ctx: Context) {
        await installMemorySpaces(ctx, [{ instanceId: 'account', module: provider, config: undefined }], { config: { dataDir: 'relative' } })
      } }, { instanceId: 'invalid' })).rejects.toThrow('absolute')
      let released = false
      const failing = defineMemorySpaceProvider<undefined>({ id: 'failing', apply(ctx) {
        ctx.effect(() => () => { released = true })
        throw new Error('fixture child failed')
      } })
      await expect(runner.mount({ inject: ['mnemonMemory'], async apply(ctx: Context) {
        await installMemorySpaces(ctx, [{ instanceId: 'account', module: provider, config: undefined }, { instanceId: 'bad', module: failing, config: undefined }])
      } }, { instanceId: 'failed' })).rejects.toThrow('fixture child failed')
      expect(released).toBe(true)
      expect(runner.inspect().evaluation.sourceInstanceKeys).toHaveLength(0)
    } finally { await runner.dispose() }
  })
})

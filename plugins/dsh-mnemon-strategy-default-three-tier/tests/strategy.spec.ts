import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { defineMemorySource, installMemory, type MemoryAvailableSource } from 'dsh-mnemon/extension-sdk'
import { COMPOSABLE_MEMORY_API_VERSION } from 'dsh-mnemon/contracts'
import { MemoryCompositionRunner, DEFAULT_MEMORY_VIEW_BUDGET } from 'dsh-mnemon/testing'
import * as plugin from '../src/index.ts'
import { BOUNDED_RUNTIME_MEMORY_PROTOCOL, LOCAL_ARCHIVE_RUNTIME_MEMORY_PROTOCOL, ROUTING_GUIDANCE, ROUTING_GUIDANCE_WITHOUT_RECALL, THREE_TIER_REMINDERS, THREE_TIER_REMINDERS_WITHOUT_RECALL } from '../src/guidance.ts'

function fact(role: string, key = role): MemoryAvailableSource {
  return {
    sourceInstanceKey: `source:${key}`, sourceTypeId: key, role,
    routes: [], actions: [],
    availability: 'ready', revision: 'r1', capabilities: ['project'], routeIds: [], actionIds: [],
  }
}

describe('standalone default three-tier Strategy', () => {
  it('is deterministic and depends only on facts, not Source implementations', () => {
    const request = { scope: { storage: 'custom' as const }, scenario: 'test', budget: { ...DEFAULT_MEMORY_VIEW_BUDGET } }
    const facts = [fact('working-context'), fact('narrative'), fact('durable-evidence')]
    const first = plugin.DEFAULT_THREE_TIER_VIEW_STRATEGY.compose(request, facts)
    expect(first).toEqual(plugin.DEFAULT_THREE_TIER_VIEW_STRATEGY.compose(request, [...facts].reverse()))
    expect(first.sources.map(source => source.sourceInstanceKey)).toEqual(facts.map(source => source.sourceInstanceKey))
    expect(first.sources.reduce((sum, source) => sum + (source.projection?.maxCharacters ?? 0), 0)).toBeLessThanOrEqual(request.budget.maxProjectionCharacters)
  })

  it('names mnemon_recall only with recall, and archiving into Memory Spaces only with a space to write (issue 336)', () => {
    const request = { scope: { storage: 'custom' as const }, scenario: 'test', budget: { ...DEFAULT_MEMORY_VIEW_BUDGET } }
    const layer = (role: string, sourceTypeId: string, routeIds: string[] = [], actionIds: string[] = [], activeCount?: number) => ({
      ...fact(role, sourceTypeId), routeIds, actionIds, ...(activeCount === undefined ? {} : { hints: { activeCount } }),
    })
    const runtime = layer('working-context', 'runtime')
    const documents = layer('narrative', 'documents', ['search'])
    const spaces = (routeIds: string[], actionIds: string[], activeCount?: number) => layer('durable-evidence', 'memory-spaces', routeIds, actionIds, activeCount)
    const compose = (...facts: MemoryAvailableSource[]) => plugin.DEFAULT_THREE_TIER_VIEW_STRATEGY.compose(request, facts).guidance
    // With Memory Spaces to recall from and write to, the guidance is exactly what it was.
    expect(compose(runtime, documents, spaces(['inspect', 'recall'], ['manage-spaces', 'remember', 'forget'], 1)))
      .toEqual({ routing: ROUTING_GUIDANCE, reminders: THREE_TIER_REMINDERS, system: BOUNDED_RUNTIME_MEMORY_PROTOCOL })
    // Facts without hints keep it too.
    expect(compose(runtime, documents, spaces(['inspect', 'recall'], ['remember']))?.system).toBe(BOUNDED_RUNTIME_MEMORY_PROTOCOL)
    // No Provider, or no space yet: Documents routing and the write rules stay, without mnemon_recall.
    for (const memorySpaces of [spaces(['inspect'], [], 0), spaces(['inspect'], ['manage-spaces', 'remember'], 0)]) {
      const guidance = compose(runtime, documents, memorySpaces)
      expect(guidance).toEqual({ routing: ROUTING_GUIDANCE_WITHOUT_RECALL, reminders: THREE_TIER_REMINDERS_WITHOUT_RECALL, system: LOCAL_ARCHIVE_RUNTIME_MEMORY_PROTOCOL })
      expect(JSON.stringify(guidance)).not.toContain('mnemon_recall')
      expect(guidance?.routing).toContain('Search Mnemon Documents for substantial project records')
      expect(guidance?.reminders?.write).toBe(THREE_TIER_REMINDERS.write)
    }
    // Without the layer there is no three-tier routing, as before, and nothing points at Memory Spaces.
    const without = compose(runtime, documents)
    expect(without).toEqual({ system: LOCAL_ARCHIVE_RUNTIME_MEMORY_PROTOCOL })
    expect(without?.system).toContain('to a local archive file')
    expect(without?.system).toContain('budget-limited projection')
    // Recall without automatic writes archives locally; writes without recall archive into Memory Spaces.
    const recallOnly = compose(runtime, documents, spaces(['inspect', 'recall'], [], 2))
    expect(recallOnly?.routing).toBe(ROUTING_GUIDANCE)
    expect(recallOnly?.system).toContain('call mnemon_recall instead of inferring')
    expect(recallOnly?.system).toContain('to a local archive file')
    const writeOnly = compose(runtime, documents, spaces(['inspect'], ['remember'], 2))
    expect(writeOnly?.routing).toBe(ROUTING_GUIDANCE_WITHOUT_RECALL)
    expect(writeOnly?.system).not.toContain('mnemon_recall')
    expect(writeOnly?.system).toContain('into one or more semantically appropriate Memory Spaces')
    // Active spaces that only extract asynchronously cannot take an archive: it stays local.
    const asyncOnly = compose(runtime, documents, { ...spaces(['inspect', 'recall'], ['remember'], 2), hints: { activeCount: 2, archivableCount: 0 } })
    expect(asyncOnly?.system).toContain('call mnemon_recall instead of inferring')
    expect(asyncOnly?.system).toContain('to a local archive file')
  })

  it('rejects ambiguous roles instead of selecting by mount order', () => {
    expect(() => plugin.DEFAULT_THREE_TIER_VIEW_STRATEGY.compose({
      scope: { storage: 'custom' }, scenario: 'test', budget: { ...DEFAULT_MEMORY_VIEW_BUDGET },
    }, [fact('working-context', 'first'), fact('working-context', 'second')])).toThrow('ambiguous')
  })

  it('mounts and composes through real Cordis and the public test runner', async () => {
    const runner = new MemoryCompositionRunner()
    try {
      await runner.mount(plugin, { instanceId: 'strategy' })
      expect(runner.inspect().evaluation.state).toBe('incomplete')
      const source = defineMemorySource({
        manifest: {
          apiVersion: COMPOSABLE_MEMORY_API_VERSION, kind: 'source', typeId: 'fixture',
          packageName: 'test-source-fixture', role: 'working-context', capabilities: ['project'], consistency: 'exact-snapshot',
        },
        create: ctx => ({
          facts: () => ({ ...fact('working-context', 'fixture'), sourceInstanceKey: ctx.sourceInstanceKey }),
          project: request => ({ fragments: [{
            id: 'fixture', sourceInstanceKey: ctx.sourceInstanceKey, mode: request.mode,
            revision: 'r1', text: 'independent fixture',
          }] }),
        }),
      })
      const unmount = await runner.mount({
        inject: ['mnemonMemory'], apply(ctx: Context) { installMemory(ctx, { sources: [source] }) },
      }, { instanceId: 'source' })
      const turn = await runner.beginTurn()
      expect(turn.view.projection[0]?.text).toBe('independent fixture')
      await unmount()
      await expect(runner.beginTurn()).rejects.toThrow('no Serving')
      expect(runner.inspect().drainingGenerationIds).toContain(turn.view.runtimeGeneration)
      turn.release()
    } finally { await runner.dispose() }
  })
})

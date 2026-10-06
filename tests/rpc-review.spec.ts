import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Config } from '../src/host/config.ts'
import { resolveConfig } from '../src/host/config.ts'
import type { HostRpcHandler } from '../src/host/dsh.ts'
import type { MnemonLifecycle } from '../src/host/lifecycle.ts'
import { createPackHandler, createReviewHandler } from '../src/host/rpc.ts'
import type { LiveMnemonRuntime } from '../src/host/runtime.ts'
import { MnemonReviewLedger } from '../src/host/review-ledger.ts'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

function temporary(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `dsh-mnemon-${label}-`))
  directories.push(directory)
  return directory
}

/** A data root that already holds one runtime memory, so a move has something to carry. */
function populated(label: string): string {
  const root = temporary(label)
  mkdirSync(join(root, 'runtime'), { recursive: true })
  writeFileSync(join(root, 'runtime', 'memories.json'), `${JSON.stringify({
    version: 1,
    entries: [{
      content: 'Prefer concise answers', target: 'user', importance: 'normal',
      created_at: '2026-08-14T12:00:00.000Z', updated_at: '2026-08-14T12:00:00.000Z',
    }],
  }, null, 2)}\n`)
  return root
}

interface Fixture {
  runtime: LiveMnemonRuntime
  graph: Record<string, unknown>
  ledger: MnemonReviewLedger
  root: string
  runtimeSource: { read: ReturnType<typeof vi.fn>; mutate: ReturnType<typeof vi.fn> }
  documentsSource: { read: ReturnType<typeof vi.fn>; mutate: ReturnType<typeof vi.fn> }
}

function fixture(options: Config = {}): Fixture {
  const root = populated('rpc-review')
  const ledger = new MnemonReviewLedger({ effectiveDataDir: () => root })
  const runtimeSource = { read: vi.fn(async () => ({ entries: [], targets: {} })), mutate: vi.fn(async () => ({})) }
  const documentsSource = { read: vi.fn(async () => ({ documents: [], activeCount: 0 })), mutate: vi.fn(async () => ({})) }
  const sources: Record<string, unknown> = { runtime: runtimeSource, documents: documentsSource, 'memory-spaces': { read: vi.fn(async () => ({})), mutate: vi.fn(async () => ({})) } }
  const graph = {
    config: resolveConfig(options),
    directory: root,
    source: vi.fn((type: string) => sources[type]),
    // No live generation keeps the post-apply Memory Space reload out of these assertions.
    memoryComposition: { current: () => undefined, acquire: vi.fn(), inspect: () => ({ evaluation: { state: 'ready' } }) },
    storage: { catalog: vi.fn(() => ({ activeRoot: root })) },
    packs: { target: vi.fn(() => ({ root, scope: 'custom' })), exportPack: vi.fn(), inspectPack: vi.fn(), importPack: vi.fn() },
    sync: { status: vi.fn(), configure: vi.fn(), push: vi.fn(), preview: vi.fn(), pull: vi.fn() },
    reviews: ledger,
  }
  const route = { graph, selectedWorkspace: { id: 'workspace', title: 'Fixture', path: '/fixture/workspace' }, selectedRoot: root, effectiveRoot: root, aligned: true, liveSession: true }
  const runtime = { config: graph.config, route: vi.fn(() => route), reviews: ledger } as unknown as LiveMnemonRuntime
  return { runtime, graph, ledger, root, runtimeSource, documentsSource }
}

function lifecycle(methods: Record<string, unknown> = {}): MnemonLifecycle {
  return { workspaceRoot: () => '/fixture/workspace', snapshot: () => ({ enabled: true, taskAgentAvailable: true }), ...methods } as unknown as MnemonLifecycle
}

const proposal = {
  title: 'Merge duplicate answers',
  summary: 'Two installations recorded the same preference.',
  machine: { id: 'machine-a', label: 'laptop' },
  foreignMachines: ['desktop'],
  operations: [{ kind: 'runtime-remove' as const, target: 'user' as const, oldText: 'Prefer short answers', reason: 'Superseded by the concise preference.' }],
}

describe('Mnemon storage relocation endpoints', () => {
  it('plans a move without asking for a writable Host', async () => {
    const f = fixture({ writeEnabled: false })
    const handler = createPackHandler(f.runtime)
    const to = join(temporary('rpc-review-target'), 'moved')

    const planned = await handler('storage-plan', { dataDir: to })
    expect(planned).toMatchObject({ ok: true, value: { from: f.root, to, source: { files: 1 }, targetOccupied: false, sameDevice: true } })
    expect((planned as { value: { blocked?: string } }).value.blocked).toBeUndefined()
    expect(await handler('storage-plan', { dataDir: '   ' })).toMatchObject({ ok: false, error: { message: 'dataDir must be a non-empty directory' } })
    expect(await handler('storage-plan', { dataDir: parse(f.root).root })).toMatchObject({ ok: false, error: { message: 'the Mnemon data directory must not be a filesystem root' } })
  })

  it('reports every reason a target directory cannot be used', async () => {
    const f = fixture()
    const handler = createPackHandler(f.runtime)

    expect(await handler('storage-plan', { dataDir: f.root })).toMatchObject({ ok: true, value: { blocked: 'the data directory is already this directory' } })
    expect(await handler('storage-plan', { dataDir: join(f.root, 'nested') })).toMatchObject({ ok: true, value: { blocked: 'one directory is inside the other' } })
    const occupied = populated('rpc-review-occupied')
    expect(await handler('storage-plan', { dataDir: occupied })).toMatchObject({ ok: true, value: { targetOccupied: true, blocked: 'the target directory already holds data' } })
  })

  it('moves the data directory only when the page confirms the move', async () => {
    const f = fixture()
    const handler = createPackHandler(f.runtime)
    const to = join(temporary('rpc-review-destination'), 'moved')

    expect(await handler('storage-migrate', { dataDir: to })).toMatchObject({ ok: false, error: { message: 'Moving the Mnemon data directory requires confirmation' } })
    expect(existsSync(to)).toBe(false)

    const moved = await handler('storage-migrate', { dataDir: to, confirmed: true })
    expect(moved).toMatchObject({ ok: true, value: { from: f.root, to, source: 'rename', files: 1, removed: true } })
    expect(existsSync(join(f.root, 'runtime', 'memories.json'))).toBe(false)
    expect(JSON.parse(readFileSync(join(to, 'runtime', 'memories.json'), 'utf8'))).toMatchObject({ entries: [{ content: 'Prefer concise answers' }] })
  })

  it('records the new location on the Host that moved the data', async () => {
    const f = fixture()
    const relocated: string[] = []
    const handler = createPackHandler(f.runtime, { writable: true, relocate: async directory => { relocated.push(directory) } })
    const to = join(temporary('rpc-review-relocate'), 'moved')

    expect(await handler('storage-migrate', { dataDir: to })).toMatchObject({ ok: false, error: { message: 'Moving the Mnemon data directory requires confirmation' } })
    expect(relocated).toEqual([])

    const moved = await handler('storage-migrate', { dataDir: to, confirmed: true })
    expect(moved).toMatchObject({ ok: true, value: { from: f.root, to, removed: true } })
    expect(relocated).toEqual([to])
    expect(JSON.parse(readFileSync(join(to, 'runtime', 'memories.json'), 'utf8'))).toMatchObject({ entries: [{ content: 'Prefer concise answers' }] })
  })

  it('refuses the move before deleting anything when the Host cannot record a location', async () => {
    const f = fixture()
    const relocate = vi.fn(async () => {})
    const handler = createPackHandler(f.runtime, { writable: false, relocate })
    const to = join(temporary('rpc-review-unrecorded'), 'moved')

    const blocked = await handler('storage-migrate', { dataDir: to, confirmed: true })
    expect(blocked).toMatchObject({ ok: false, error: { message: expect.stringContaining('read-only') } })
    expect(relocate).not.toHaveBeenCalled()
    expect(existsSync(to)).toBe(false)
    expect(existsSync(join(f.root, 'runtime', 'memories.json'))).toBe(true)
  })

  it('refuses to move the data directory on a read-only Host', async () => {
    const f = fixture({ writeEnabled: false })
    const to = join(temporary('rpc-review-readonly'), 'moved')
    const blocked = await createPackHandler(f.runtime)('storage-migrate', { dataDir: to, confirmed: true })

    expect(blocked).toMatchObject({ ok: false, error: { message: expect.stringContaining('read-only') } })
    expect(existsSync(to)).toBe(false)
    expect(existsSync(join(f.root, 'runtime', 'memories.json'))).toBe(true)
  })
})

describe('Mnemon review endpoints', () => {
  it('reads and records review activity without a writable or scoped Host', async () => {
    const f = fixture({ writeEnabled: false })
    const handler = createReviewHandler(f.runtime)
    const created = f.ledger.create(proposal)

    expect(await handler('view', {})).toMatchObject({ ok: true, value: { pending: 1, entries: [{ id: created.id, status: 'pending', title: 'Merge duplicate answers' }] } })
    expect(await handler('opinion', { id: created.id, text: 'Keep the wording from the desktop.', author: 'user' })).toMatchObject({ ok: true })
    // Only the Host decides what an Agent is: an unrecognised author is recorded as the user.
    expect(await handler('opinion', { id: created.id, text: 'Also update the changelog.', author: 'robot' })).toMatchObject({ ok: true })
    expect(f.ledger.get(created.id)?.opinions.map(opinion => [opinion.author, opinion.text])).toEqual([
      ['user', 'Keep the wording from the desktop.'],
      ['user', 'Also update the changelog.'],
    ])
    expect(await handler('opinion', { id: created.id, text: '   ' })).toMatchObject({ ok: false, error: { message: 'a review opinion must not be empty' } })
    expect(await handler('decide', { id: created.id, status: 'rejected' })).toMatchObject({ ok: true, value: { status: 'rejected' } })
    expect(await handler('decide', { id: created.id, status: 'accepted' })).toMatchObject({ ok: false, error: { message: `this review was already decided: ${created.id}` } })
    expect(await handler('reopen', { id: created.id })).toMatchObject({ ok: true, value: { status: 'pending' } })
    expect(await handler('reopen', { id: 'missing' })).toMatchObject({ ok: false, error: { message: 'unknown review entry: missing' } })
    // Only a writable Host reaches endpoint dispatch at all.
    expect(await createReviewHandler(fixture().runtime)('nope', {})).toMatchObject({ ok: false, error: { code: 'bad-request', message: 'unknown review endpoint: nope' } })
  })

  it('runs a reconciliation only through a writable Host that owns the work', async () => {
    const f = fixture()
    const result = { title: 'Merge duplicate answers', summary: 'One preference is recorded twice.', action: 'planned' as const, operations: 1, foreignMachines: ['desktop'], provider: 'openai', runId: 'run-1' }
    const reconcile = vi.fn(async () => result)
    const handler = createReviewHandler(f.runtime, lifecycle({ reconcile }))

    expect(await handler('reconcile', { workspaceId: '/fixture/workspace' })).toMatchObject({ ok: true, value: result })
    expect(reconcile).toHaveBeenCalledWith(f.graph, { storage: 'global', workspaceId: '/fixture/workspace' }, expect.any(AbortSignal), {})
    // The reviewer's words reach the run that plans, and nothing else about it changes.
    expect(await handler('reconcile', { workspaceId: '/fixture/workspace', guidance: 'Merge the two answers.' })).toMatchObject({ ok: true, value: result })
    expect(reconcile).toHaveBeenLastCalledWith(f.graph, { storage: 'global', workspaceId: '/fixture/workspace' }, expect.any(AbortSignal), { guidance: 'Merge the two answers.' })
    expect(await handler('reconcile', { workspaceId: '/fixture/workspace', guidance: 7 })).toMatchObject({ ok: false, error: { message: 'the reconciliation guidance must be a string' } })
    expect(await createReviewHandler(f.runtime)('reconcile', {})).toMatchObject({ ok: false, error: { message: 'Mnemon memory reconciliation is unavailable' } })

    const readonly = fixture({ writeEnabled: false })
    expect(await createReviewHandler(readonly.runtime, lifecycle({ reconcile }))('reconcile', {})).toMatchObject({ ok: false, error: { message: expect.stringContaining('read-only') } })
    expect(reconcile).toHaveBeenCalledTimes(2)
  })

  it('applies an accepted review operation by operation', async () => {
    const f = fixture()
    const entry = f.ledger.create(proposal)
    const handler = createReviewHandler(f.runtime, lifecycle())

    expect(await handler('apply', { id: entry.id })).toMatchObject({ ok: false, error: { message: `accept the review before applying it: ${entry.id}` } })
    expect(f.runtimeSource.mutate).not.toHaveBeenCalled()
    expect(await handler('apply', { id: 'missing' })).toMatchObject({ ok: false, error: { message: 'unknown review entry: missing' } })

    f.ledger.decide(entry.id, 'accepted')
    const applied = await handler('apply', { id: entry.id })
    expect(applied).toMatchObject({ ok: true, value: { applied: 1, failures: [] } })
    expect(f.runtimeSource.mutate).toHaveBeenCalledWith('mutate', { action: 'remove', target: 'user', oldText: 'Prefer short answers' }, expect.any(AbortSignal))
    expect(f.ledger.get(entry.id)).toMatchObject({ status: 'accepted', appliedAt: expect.any(String) })
  })

  it('applies only the operations the reviewer selected, and refuses an index the plan does not hold', async () => {
    const f = fixture()
    const entry = f.ledger.create({ ...proposal, operations: [
      { kind: 'runtime-remove', target: 'user', oldText: 'Prefer short answers', reason: 'Superseded.' },
      { kind: 'runtime-remove', target: 'user', oldText: 'Prefer concise answers', reason: 'Superseded.' },
    ] })
    f.ledger.decide(entry.id, 'accepted')
    const handler = createReviewHandler(f.runtime, lifecycle())

    // A caller that believes it applied the whole review must not be told a subset did.
    expect(await handler('apply', { id: entry.id, operations: [2] })).toMatchObject({ ok: false, error: { message: 'the review holds no operation at index 2' } })
    expect(await handler('apply', { id: entry.id, operations: 'all' })).toMatchObject({ ok: false, error: { message: 'the operations to apply must be a list of operation indexes' } })
    expect(f.runtimeSource.mutate).not.toHaveBeenCalled()

    expect(await handler('apply', { id: entry.id, operations: [1] })).toMatchObject({ ok: true, value: { applied: 1, failures: [] } })
    expect(f.runtimeSource.mutate).toHaveBeenCalledTimes(1)
    expect(f.runtimeSource.mutate).toHaveBeenCalledWith('mutate', { action: 'remove', target: 'user', oldText: 'Prefer concise answers' }, expect.any(AbortSignal))
    // The review stays accepted and keeps the operations that were not applied.
    expect(f.ledger.get(entry.id)).toMatchObject({ status: 'accepted', operations: [{ oldText: 'Prefer short answers' }, { oldText: 'Prefer concise answers' }] })

    expect(await handler('apply', { id: entry.id, operations: [0] })).toMatchObject({ ok: true, value: { applied: 1, failures: [] } })
    expect(f.runtimeSource.mutate).toHaveBeenLastCalledWith('mutate', { action: 'remove', target: 'user', oldText: 'Prefer short answers' }, expect.any(AbortSignal))
  })

  it('records the failure and stops at the operation that no longer holds', async () => {
    const f = fixture()
    const entry = f.ledger.create({ ...proposal, operations: [
      { kind: 'runtime-remove', target: 'user', oldText: 'Prefer short answers', reason: 'Superseded.' },
      { kind: 'runtime-remove', target: 'user', oldText: 'Gone already', reason: 'Superseded.' },
    ] })
    f.ledger.decide(entry.id, 'accepted')
    f.runtimeSource.mutate.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('No user entry contains "Gone already".'))

    const applied = await createReviewHandler(f.runtime, lifecycle())('apply', { id: entry.id })

    expect(applied).toMatchObject({ ok: false, error: { message: 'operation 2 (runtime-remove) failed: No user entry contains "Gone already".' } })
    expect(f.runtimeSource.mutate).toHaveBeenCalledTimes(2)
    expect(f.ledger.get(entry.id)?.failure).toBe('operation 2 (runtime-remove) failed: No user entry contains "Gone already".')
  })

  it('keeps every review endpoint behind the Host it belongs to', async () => {
    const f = fixture()
    const entry = f.ledger.create(proposal)
    f.ledger.decide(entry.id, 'accepted')
    const handler = createReviewHandler(f.runtime, lifecycle())

    expect(await handler('view', 'not an object')).toMatchObject({ ok: false, error: { code: 'internal', message: 'payload must be an object' } })
    expect(await handler('apply', { id: entry.id, sessionId: 7 })).toMatchObject({ ok: false, error: { message: 'sessionId must be a string' } })
    expect(f.runtimeSource.mutate).not.toHaveBeenCalled()
  })
})

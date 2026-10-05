import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DocumentSnapshot } from 'dsh-mnemon-source-documents/contracts'
import type { RuntimeMemoryEntry, RuntimeMemorySnapshot, RuntimeMemoryTargetView } from 'dsh-mnemon-source-runtime/contracts'
import { sourceFixture } from './fixtures/sources.ts'
import type { MnemonMachineIdentity, MnemonReconcileOperation } from '../src/host/protocol.ts'
import type { MnemonReconcileApplier, MnemonReconcileSessions } from '../src/host/reconcile.ts'
import {
  MAX_RECONCILE_OPERATIONS,
  RECONCILE_SCHEMA,
  applyReconcileOperations,
  emptyDocumentSnapshot,
  foreignMachines,
  parseReconcileResult,
  reconcilePrompt,
  sourceApplier,
} from '../src/host/reconcile.ts'

const directories: string[] = []
const disposals: Array<() => Promise<void>> = []

function temporary(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `dsh-mnemon-${label}-`))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const machine: MnemonMachineIdentity = { id: 'machine-a', label: 'laptop', createdAt: '2026-08-14T12:00:00.000Z' }

function entry(content: string, overrides: Partial<RuntimeMemoryEntry> = {}): RuntimeMemoryEntry {
  return {
    content,
    created_at: '2026-08-14T12:00:00.000Z',
    updated_at: '2026-08-14T12:00:00.000Z',
    target: 'user',
    importance: 'normal',
    ...overrides,
  }
}

function snapshot(entries: RuntimeMemoryEntry[]): RuntimeMemorySnapshot {
  const view = (target: 'memory' | 'user'): RuntimeMemoryTargetView => ({ target, used: 0, limit: 1024, entryCount: 0, markdownPath: `/fixture/${target}.md` })
  return {
    directory: '/fixture/runtime',
    sourcePath: '/fixture/runtime/memories.json',
    revision: 'revision',
    generatedAt: '2026-08-14T12:00:00.000Z',
    entries,
    targets: { memory: view('memory'), user: view('user') },
  }
}

function documents(records: Array<{ id: string; title: string; status: 'active' | 'archived' }>): DocumentSnapshot {
  return {
    workspaceRoot: '/fixture',
    directory: '/fixture/documents',
    indexPath: '/fixture/documents/index.json',
    generatedAt: '2026-08-14T12:00:00.000Z',
    revision: 'revision',
    limitBytes: 1024,
    activeBytes: 0,
    activeCount: records.length,
    archivedCount: 0,
    total: records.length,
    documents: records.map(record => ({
      id: record.id,
      title: record.title,
      description: '',
      status: record.status,
      filename: `${record.id}.md`,
      relativePath: `documents/${record.id}.md`,
      sourcePaths: [],
      sessionIds: [],
      createdAt: '2026-08-14T12:00:00.000Z',
      updatedAt: '2026-08-14T12:00:00.000Z',
      lastAccessedAt: '2026-08-14T12:00:00.000Z',
      revision: 1,
      contentHash: 'hash',
      sizeBytes: 10,
      memoryBodyIds: [],
      healthy: true,
      excerpt: '',
    })),
  }
}

function evidence(entries: RuntimeMemoryEntry[], records: Array<{ id: string; title: string; status: 'active' | 'archived' }> = [], others: string[] = []): Parameters<typeof parseReconcileResult>[1] {
  return { machine, runtime: snapshot(entries), documents: documents(records), foreignMachines: others }
}

const planned = { title: 'Tidy duplicates', summary: 'Two entries say the same thing.', action: 'planned' as const }

describe('Mnemon memory reconciliation evidence', () => {
  it('names the other installations whose entries the merged memory holds', () => {
    const entries = [
      entry('local'),
      entry('from desktop', { origin: { machine: 'machine-b', label: 'desktop', at: 'now' } }),
      entry('also desktop', { origin: { machine: 'machine-b', label: 'desktop', at: 'later' } }),
      entry('unnamed', { origin: { machine: 'machine-c', label: '   ', at: 'now' } }),
      entry('mine', { origin: { machine: 'machine-a', label: 'laptop', at: 'now' } }),
    ]
    expect(foreignMachines(entries, machine)).toEqual(['desktop', 'machine-c'])
    expect(foreignMachines([entry('local')], machine)).toEqual([])
  })

  it('writes the evidence a model reads, and bounds it', () => {
    const prompt = reconcilePrompt(evidence([entry('Prefer short answers'), entry('Use tabs', { target: 'memory', importance: 'critical', branches: ['main', 'release'], origin: { machine: 'machine-b', label: 'desktop', at: 'now' } })], [{ id: 'doc-1', title: 'Design', status: 'active' }], ['desktop']))
    expect(prompt.split('\n')[0]).toBe('This installation: laptop (machine-a).')
    expect(prompt).toContain('Entries from these other installations are present: desktop.')
    expect(prompt).toContain('1. [user/normal] Prefer short answers')
    expect(prompt).toContain('2. [memory/critical] (from desktop) branches=main|release Use tabs')
    expect(prompt).toContain('Active documents (1; 0/1024 bytes):')
    expect(prompt).toContain('- doc-1 | Design | 10 bytes | ')

    const quiet = reconcilePrompt(evidence([entry('only local')]))
    expect(quiet).toContain('No entry in the local runtime memory was written by another installation.')
    expect(quiet).toContain('Active documents (0; 0/1024 bytes):\nnone')

    const bounded = reconcilePrompt(evidence(Array.from({ length: 400 }, (_, index) => entry(`Entry ${index} ${'x'.repeat(400)}`))))
    expect(bounded).toContain('further entries were withheld to bound this request.')
  })

  it('describes a documents-free snapshot without inventing a directory', () => {
    expect(emptyDocumentSnapshot('/fixture', '2026-08-14T12:00:00.000Z')).toEqual(expect.objectContaining({ directory: '/fixture', limitBytes: 0, documents: [] }))
  })

  it('publishes a result schema the host can hand to a run', () => {
    expect(RECONCILE_SCHEMA.required).toEqual(['title', 'summary', 'action', 'operations'])
    expect(RECONCILE_SCHEMA.properties.action.enum).toEqual(['planned', 'none', 'failed'])
    expect(RECONCILE_SCHEMA.properties.operations.items.properties.kind.enum).toEqual(['runtime-add', 'runtime-replace', 'runtime-remove', 'document-archive'])
    expect(MAX_RECONCILE_OPERATIONS).toBe(40)
  })
})

describe('Mnemon memory reconciliation parsing', () => {
  it('accepts one operation of every kind the applier understands', () => {
    const result = parseReconcileResult({
      ...planned,
      operations: [
        { kind: 'runtime-add', target: 'memory', content: 'Keep the changelog short', importance: 'low', reason: 'new' },
        { kind: 'runtime-replace', target: 'user', oldText: 'short answers', content: 'Prefer concise answers', branches: ['main', 'main'], reason: 'merge' },
        { kind: 'runtime-remove', target: 'user', oldText: 'Prefer short answers', reason: 'duplicate' },
        { kind: 'document-archive', documentId: 'doc-1', reason: 'superseded' },
      ],
    }, evidence([entry('Prefer short answers')], [{ id: 'doc-1', title: 'Design', status: 'active' }]))
    expect(result.action).toBe('planned')
    expect(result.operations).toEqual([
      { kind: 'runtime-add', target: 'memory', content: 'Keep the changelog short', importance: 'low', reason: 'new' },
      { kind: 'runtime-replace', target: 'user', oldText: 'short answers', content: 'Prefer concise answers', branches: ['main'], reason: 'merge' },
      { kind: 'runtime-remove', target: 'user', oldText: 'Prefer short answers', reason: 'duplicate' },
      { kind: 'document-archive', documentId: 'doc-1', reason: 'superseded' },
    ])
  })

  it('accepts a proposal that plans nothing', () => {
    expect(parseReconcileResult({ ...planned, action: 'none', operations: [] }, evidence([]))).toEqual({ title: 'Tidy duplicates', summary: 'Two entries say the same thing.', action: 'none', operations: [] })
  })

  it('refuses a result that is not a plan a reviewer could read', () => {
    const scope = evidence([])
    expect(() => parseReconcileResult(null, scope)).toThrow('memory reconciliation returned an invalid structured result')
    expect(() => parseReconcileResult({ ...planned, action: 'maybe', operations: [] }, scope)).toThrow('memory reconciliation returned an unsupported action: "maybe"')
    expect(() => parseReconcileResult({ summary: 's', action: 'planned', operations: [] }, scope)).toThrow('memory reconciliation returned no title')
    expect(() => parseReconcileResult({ title: 't', action: 'planned', operations: [] }, scope)).toThrow('memory reconciliation returned no summary')
    expect(() => parseReconcileResult({ ...planned, operations: 'none' }, scope)).toThrow('memory reconciliation returned an invalid operation list')
    expect(() => parseReconcileResult({ ...planned, operations: Array.from({ length: MAX_RECONCILE_OPERATIONS + 1 }, () => ({ kind: 'runtime-remove', target: 'user', oldText: 'x', reason: 'r' })) }, scope)).toThrow(`memory reconciliation proposed 41 operations; at most ${MAX_RECONCILE_OPERATIONS} are accepted at once`)
    expect(() => parseReconcileResult({ ...planned, action: 'failed', operations: [{ kind: 'runtime-remove', target: 'user', oldText: 'x', reason: 'r' }] }, evidence([entry('x')]))).toThrow('memory reconciliation reported a failure together with operations')
  })

  it('refuses an operation the host would have to guess at', () => {
    const scope = evidence([entry('Prefer short answers'), entry('Prefer short answers too')], [{ id: 'doc-1', title: 'Design', status: 'active' }, { id: 'doc-2', title: 'Old', status: 'archived' }])
    const plan = (operation: unknown) => () => parseReconcileResult({ ...planned, operations: [operation] }, scope)
    expect(plan('nonsense')).toThrow('reconcile operation 1 must be an object')
    expect(plan({ kind: 'runtime-nudge', reason: 'r' })).toThrow('reconcile operation 1 has an unsupported kind: "runtime-nudge"')
    expect(plan({ kind: 'runtime-remove', target: 'user', oldText: 'x' })).toThrow('reconcile operation 1 needs a non-empty reason')
    expect(plan({ kind: 'runtime-remove', target: 'everywhere', oldText: 'x', reason: 'r' })).toThrow('reconcile operation 1 needs a target of memory or user')
    expect(plan({ kind: 'runtime-add', target: 'user', content: 'c', reason: 'r' })).toThrow('reconcile operation 1 needs an importance of critical, normal, or low')
    expect(plan({ kind: 'runtime-add', target: 'user', content: 'c', importance: 'urgent', reason: 'r' })).toThrow('reconcile operation 1 needs an importance of critical, normal, or low')
    expect(plan({ kind: 'runtime-add', target: 'user', content: 'c', importance: 'low', branches: ['main', ''], reason: 'r' })).toThrow('reconcile operation 1 needs branches to be a list of branch names')
    expect(plan({ kind: 'runtime-add', target: 'user', importance: 'low', reason: 'r' })).toThrow('reconcile operation 1 needs a non-empty content')
    expect(plan({ kind: 'document-archive', reason: 'r' })).toThrow('reconcile operation 1 needs a documentId')
    expect(plan({ kind: 'document-archive', documentId: 'doc-9', reason: 'r' })).toThrow('reconcile operation 1 names an unknown document: doc-9')
    expect(plan({ kind: 'document-archive', documentId: 'doc-2', reason: 'r' })).toThrow('reconcile operation 1 names a document that is not active: doc-2')
    expect(plan({ kind: 'runtime-remove', target: 'user', oldText: 'nothing like this', reason: 'r' })).toThrow('reconcile operation 1 addresses no user entry containing "nothing like this"')
    expect(plan({ kind: 'runtime-remove', target: 'user', oldText: 'Prefer', reason: 'r' })).toThrow('reconcile operation 1 addresses more than one user entry; use a unique substring')
  })

  it('addresses an entry by exact text before falling back to a substring', () => {
    const scope = evidence([entry('Prefer short answers'), entry('Prefer short answers and no preamble')])
    const result = parseReconcileResult({ ...planned, operations: [{ kind: 'runtime-remove', target: 'user', oldText: 'Prefer short answers', reason: 'duplicate' }] }, scope)
    expect(result.operations).toEqual([{ kind: 'runtime-remove', target: 'user', oldText: 'Prefer short answers', reason: 'duplicate' }])
  })
})

describe('Mnemon memory reconciliation application', () => {
  const add: MnemonReconcileOperation = { kind: 'runtime-add', target: 'user', content: 'Prefer concise answers', importance: 'normal', reason: 'merge' }
  const remove: MnemonReconcileOperation = { kind: 'runtime-remove', target: 'user', oldText: 'Prefer short answers', reason: 'duplicate' }
  const archive: MnemonReconcileOperation = { kind: 'document-archive', documentId: 'doc-1', reason: 'superseded' }

  it('replays a plan in order and stops at the first failure', async () => {
    const runtime = vi.fn<MnemonReconcileApplier['runtime']>(async () => ({}))
    const archiveDocument = vi.fn<MnemonReconcileApplier['archive']>(async () => ({}))
    const applier = { runtime, archive: archiveDocument }
    expect(await applyReconcileOperations([add, remove, archive], applier, new AbortController().signal)).toEqual({ applied: 3, failures: [] })
    expect(runtime.mock.calls.map(call => call[0])).toEqual([
      { action: 'add', target: 'user', content: 'Prefer concise answers', importance: 'normal' },
      { action: 'remove', target: 'user', oldText: 'Prefer short answers' },
    ])
    expect(archiveDocument).toHaveBeenCalledWith('doc-1', 'superseded', expect.any(AbortSignal))

    const failing = vi.fn<MnemonReconcileApplier['runtime']>(async () => ({}))
    failing.mockRejectedValueOnce(new Error('gone')).mockResolvedValue({})
    expect(await applyReconcileOperations([add, remove, archive], { runtime: failing, archive: archiveDocument }, new AbortController().signal)).toEqual({ applied: 0, failures: ['operation 1 (runtime-add) failed: gone'] })
    expect(failing).toHaveBeenCalledTimes(1)

    const aborting = new AbortController()
    aborting.abort()
    await expect(applyReconcileOperations([add], applier, aborting.signal)).rejects.toThrow()
  })

  it('carries an optional importance and branch scope through a replace', async () => {
    const runtime = vi.fn<MnemonReconcileApplier['runtime']>(async () => ({}))
    await applyReconcileOperations([{ kind: 'runtime-replace', target: 'memory', oldText: 'Use tabs', content: 'Use two spaces', importance: 'low', branches: ['main'], reason: 'merge' }], { runtime, archive: vi.fn() }, new AbortController().signal)
    expect(runtime.mock.calls[0]![0]).toEqual({ action: 'replace', target: 'memory', oldText: 'Use tabs', content: 'Use two spaces', importance: 'low', branches: ['main'] })
  })

  it('archives through the revision the Documents Source reports, not one the plan guessed', async () => {
    const documentsRead = vi.fn(async () => ({ documents: [{ id: 'doc-1', revision: 7, status: 'active' }] }))
    const sessions = {
      runtime: { mutate: vi.fn(async () => ({})) },
      documents: { read: documentsRead, mutate: vi.fn(async () => ({})) },
    } as unknown as MnemonReconcileSessions
    const applier = sourceApplier(sessions)
    await applier.archive('doc-1', 'superseded', new AbortController().signal)
    expect(sessions.documents.mutate).toHaveBeenCalledWith('archive', { id: 'doc-1', documentRevision: 7, summary: 'superseded' }, expect.any(AbortSignal))

    documentsRead.mockResolvedValueOnce({ documents: [] })
    await expect(applier.archive('doc-1', 'superseded', new AbortController().signal)).rejects.toThrow('the document to archive is no longer present: doc-1')
  })

  it('applies a real proposal to the real Sources it names', async () => {
    const dataDir = temporary('reconcile')
    const workspace = temporary('reconcile-workspace')
    const fixture = await sourceFixture({ dataDir, workspace })
    disposals.push(fixture.dispose)
    const confirmed = { confirmed: true as const }
    await fixture.runtime.mutate('mutate', { action: 'add', target: 'user', content: 'Prefer short answers', importance: 'normal' }, confirmed)
    const created = await fixture.documents.mutate('mutate', { action: 'create', title: 'Design', content: '# Design' }, confirmed)
    const createdId = (created.value as { document: { id: string } }).document.id

    const live = (await fixture.runtime.read('snapshot')).value as unknown as RuntimeMemorySnapshot
    const liveDocuments = (await fixture.documents.read('snapshot')).value as unknown as DocumentSnapshot
    const scope = { machine, runtime: live, documents: liveDocuments, foreignMachines: [] }
    const result = parseReconcileResult({
      ...planned,
      operations: [
        { kind: 'runtime-add', target: 'memory', content: 'Keep the changelog short', importance: 'low', reason: 'new' },
        { kind: 'runtime-replace', target: 'user', oldText: 'short answers', content: 'Prefer concise answers', reason: 'merge' },
        { kind: 'document-archive', documentId: createdId, reason: 'superseded' },
      ],
    }, scope)
    // The Host's SourceSession confirms a management mutation itself; the test client asks for it
    // explicitly, which also proves the Source still refuses an unconfirmed write.
    await expect(fixture.runtime.mutate('mutate', { action: 'remove', target: 'user', oldText: 'short answers' } as never, { confirmed: false as never })).rejects.toThrow(/confirmation/u)
    const sessions = {
      runtime: { mutate: (operation: string, input: unknown) => fixture.runtime.mutate(operation, input as never, { confirmed: true }) },
      documents: {
        // SourceSession.read unwraps the management envelope; the test client hands it back whole.
        read: async (operation: string, input?: unknown) => (await fixture.documents.read(operation, input as never)).value,
        mutate: (operation: string, input: unknown) => fixture.documents.mutate(operation, input as never, { confirmed: true }),
      },
    } as unknown as MnemonReconcileSessions
    const outcome = await applyReconcileOperations(result.operations, sourceApplier(sessions), new AbortController().signal)
    expect(outcome).toEqual({ applied: 3, failures: [] })

    const after = (await fixture.runtime.read('snapshot')).value as unknown as RuntimeMemorySnapshot
    expect(after.entries.map(item => item.content).sort()).toEqual(['Keep the changelog short', 'Prefer concise answers'])
    const archived = (await fixture.documents.read('snapshot')).value as unknown as DocumentSnapshot
    expect(archived.documents.find(item => item.id === createdId)?.status).toBe('archived')
  })
})

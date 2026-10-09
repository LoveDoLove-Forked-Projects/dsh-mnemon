import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MnemonReviewLedger } from "../src/host/review-ledger.ts"

const directories: string[] = []

function temporary(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-mnemon-review-'))
  directories.push(directory)
  return directory
}

function ledger(root: string): MnemonReviewLedger {
  return new MnemonReviewLedger({ effectiveDataDir: () => root })
}

const proposal = {
  title: 'Merge duplicate preferences',
  summary: 'Two entries say the same thing with different wording.',
  machine: { id: 'machine-a', label: 'laptop' },
  foreignMachines: ['desktop'],
  operations: [{ kind: 'runtime-remove' as const, target: 'user' as const, oldText: 'Prefer short answers', reason: 'duplicate' }],
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('Mnemon review ledger', () => {
  it('files a proposal as pending and keeps the newest first', () => {
    const root = temporary()
    const store = ledger(root)
    const first = store.create(proposal)
    const second = store.create({ ...proposal, title: 'Archive stale notes' })
    expect(first.status).toBe('pending')
    expect(first.opinions).toEqual([])
    expect(first.decidedAt).toBeUndefined()
    expect(store.list().map(entry => entry.id)).toEqual([second.id, first.id])
    expect(store.view()).toEqual(expect.objectContaining({ path: join(root, 'state', 'review-ledger.json'), pending: 2 }))
    expect(store.get(first.id)?.title).toBe('Merge duplicate preferences')
    expect(store.get('missing')).toBeUndefined()
    expect(JSON.parse(readFileSync(store.path(), 'utf8')).version).toBe(1)
  })

  it('records opinions from the user and from an agent, and refuses an empty one', () => {
    const root = temporary()
    const store = ledger(root)
    const entry = store.create(proposal)
    const withUser = store.addOpinion(entry.id, 'user', '  Keep the shorter wording.  ')
    expect(withUser.opinions).toEqual([expect.objectContaining({ author: 'user', text: 'Keep the shorter wording.' })])
    const withAgent = store.addOpinion(entry.id, 'agent', 'The two entries differ in scope.')
    expect(withAgent.opinions.map(opinion => opinion.author)).toEqual(['user', 'agent'])
    expect(withAgent.opinions[1]!.id).not.toBe(withAgent.opinions[0]!.id)
    expect(() => store.addOpinion(entry.id, 'user', '   ')).toThrow('a review opinion must not be empty')
    expect(() => store.addOpinion('missing', 'user', 'hello')).toThrow('unknown review entry: missing')
    // The ledger stores what it is given; only the RPC layer narrows an author to user or agent.
    expect(store.addOpinion(entry.id, 'agent', 'A third note.').opinions.at(-1)!.author).toBe('agent')
  })

  it('accepts, rejects, applies, and reopens a proposal exactly once per step', () => {
    const root = temporary()
    const store = ledger(root)
    const accepted = store.decide(store.create(proposal).id, 'accepted')
    expect(accepted.status).toBe('accepted')
    expect(accepted.decidedAt).toBeDefined()
    expect(() => store.decide(accepted.id, 'rejected')).toThrow(`this review was already decided: ${accepted.id}`)

    const applied = store.applied(accepted.id)
    expect(applied.appliedAt).toBeDefined()
    expect(applied.failure).toBeUndefined()

    const rejected = store.decide(store.create(proposal).id, 'rejected')
    expect(rejected.status).toBe('rejected')
    const reopened = store.reopen(rejected.id)
    expect(reopened.status).toBe('pending')
    expect(reopened.decidedAt).toBeUndefined()
    expect(store.view().pending).toBe(1)
    expect(() => store.reopen('missing')).toThrow('unknown review entry: missing')
  })

  it('keeps a failed application visible instead of hiding it', () => {
    const root = temporary()
    const store = ledger(root)
    const entry = store.decide(store.create(proposal).id, 'accepted')
    const failed = store.applied(entry.id, 'operation 1 (runtime-remove) failed: gone')
    expect(failed.failure).toBe('operation 1 (runtime-remove) failed: gone')
    const reopened = store.reopen(entry.id)
    expect(reopened.failure).toBeUndefined()
    expect(reopened.status).toBe('pending')
  })

  it('refuses a ledger written by another version and drops entries it cannot parse', () => {
    const root = temporary()
    const store = ledger(root)
    const path = store.path()
    mkdirSync(join(root, 'state'), { recursive: true })
    writeFileSync(path, JSON.stringify({ version: 2, entries: [] }))
    expect(() => store.list()).toThrow(`review ledger is invalid: ${path}`)
    writeFileSync(path, JSON.stringify({ version: 1, entries: [{ id: 'kept', status: 'pending', title: 'Kept', summary: '', machine: {}, foreignMachines: [], operations: [], opinions: [], createdAt: 'now', updatedAt: 'now' }, { id: '', status: 'pending' }, 'nonsense'] }))
    expect(store.list().map(entry => entry.id)).toEqual(['kept'])
    expect(store.view().pending).toBe(1)
  })
})

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { strToU8, unzipSync, zipSync } from 'fflate'
import { resolveConfig } from '../src/host/config.ts'
import type { MnemonMachineIdentity, MnemonTombstoneFile } from '../src/host/protocol.ts'
import { MnemonPackManager } from '../src/host/pack.ts'
import { createStorageRoot } from '../src/host/storage-root.ts'
import { sourceFixture } from './fixtures/sources.ts'

const directories: string[] = []
const releases: Array<() => Promise<void>> = []

function temporary(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `dsh-mnemon-${label}-`))
  directories.push(directory)
  return directory
}

/**
 * Every read moves the clock forward so a later export outranks an earlier one. The start is far
 * in the future because the Source stamps entries with the real clock: a deletion only hides an
 * entry when the deletion happened at or after the entry was written.
 */
function tickingClock(start = '2030-01-01T00:00:00.000Z'): () => Date {
  let at = Date.parse(start)
  return () => new Date((at += 1_000))
}

interface Machine {
  root: string
  manager: MnemonPackManager
  runtime: Awaited<ReturnType<typeof sourceFixture>>['runtime']
}

async function machine(label: string, clock: () => Date = tickingClock()): Promise<Machine> {
  const root = temporary(label)
  const workspace = temporary(`${label}-workspace`)
  const config = resolveConfig({ storageScope: 'custom', dataDir: root, cliPath: '/fake/mnemon' })
  const runner = createStorageRoot(config)
  const sources = await sourceFixture({ dataDir: root, workspace })
  releases.push(sources.dispose)
  return { root, manager: new MnemonPackManager(runner, config, undefined, clock), runtime: sources.runtime }
}

async function add(target: Machine, content: string, scope: 'memory' | 'user' = 'user'): Promise<void> {
  await target.runtime.mutate('mutate', { action: 'add', target: scope, content, importance: 'normal' }, { confirmed: true })
}

async function remove(target: Machine, oldText: string, scope: 'memory' | 'user' = 'user'): Promise<void> {
  await target.runtime.mutate('mutate', { action: 'remove', target: scope, oldText }, { confirmed: true })
}

interface StoredEntry {
  content: string
  target: string
  updated_at: string
  origin?: { machine: string; label: string; at: string }
}

function entries(root: string): StoredEntry[] {
  return (JSON.parse(readFileSync(join(root, 'runtime', 'memories.json'), 'utf8')) as { entries: StoredEntry[] }).entries
}

interface StoredTombstone {
  target: string
  contentHash: string
  deletedAt: string
  machine?: string
}

function tombstones(root: string): StoredTombstone[] {
  return (JSON.parse(readFileSync(join(root, 'state', 'tombstones.json'), 'utf8')) as { tombstones: StoredTombstone[] }).tombstones
}

function identity(root: string): MnemonMachineIdentity {
  return JSON.parse(readFileSync(join(root, 'state', 'machine.json'), 'utf8')) as MnemonMachineIdentity
}

function archive(base64: string): Record<string, Uint8Array> {
  return unzipSync(new Uint8Array(Buffer.from(base64, 'base64')))
}

function packed(base64: string, path: string): unknown {
  const file = archive(base64)[path]
  if (file === undefined) throw new Error(`the Pack is missing ${path}`)
  return JSON.parse(new TextDecoder().decode(file)) as unknown
}

/** Replace one payload file and re-sign it, so the tampered Pack still passes its checksums. */
function forge(base64: string, path: string, text: string): string {
  const files = archive(base64)
  files[path] = strToU8(text)
  const checksums = JSON.parse(new TextDecoder().decode(files['checksums.json']!)) as { algorithm: string; files: Record<string, string> }
  checksums.files[path] = createHash('sha256').update(files[path]!).digest('hex')
  files['checksums.json'] = strToU8(`${JSON.stringify(checksums, null, 2)}\n`)
  return Buffer.from(zipSync(files, { level: 6, mtime: new Date(1980, 0, 1) })).toString('base64')
}

afterEach(async () => {
  for (const release of releases.splice(0)) await release()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('Mnemon Pack machine identity', () => {
  it('stamps the entries the sync channel publishes, and keeps the identity out of the archive', async () => {
    const source = await machine('pack-origin-source')
    await add(source, 'Prefer concise answers')
    const exported = await source.manager.exportPack('runtime', { stamp: true })

    const me = identity(source.root)
    expect(me.id).toMatch(/^[0-9a-f-]{36}$/u)
    expect(me.label.length).toBeGreaterThan(0)
    // The stamp is the moment the entry was written, not the moment it was exported.
    const stored = entries(source.root)[0]!
    expect(packed(exported.base64, 'payload/runtime/memories.json')).toMatchObject({
      entries: [{ content: 'Prefer concise answers', origin: { machine: me.id, label: me.label, at: stored.updated_at } }],
    })
    // The archive keeps the format every version reads: no identity, no sync extension,
    // and no machine-local file. Only a reader that reads the branch sees those.
    const manifest = packed(exported.base64, 'manifest.json') as Record<string, unknown>
    expect(manifest).not.toHaveProperty('machine')
    expect(manifest).not.toHaveProperty('sync')
    expect(Object.keys(archive(exported.base64)).filter(path => path.startsWith('payload/state/'))).toEqual([])
  })

  it('exports the same entries byte for byte when nothing was written in between', async () => {
    const source = await machine('pack-origin-stable')
    await add(source, 'Prefer concise answers')
    const first = await source.manager.exportPack('runtime', { stamp: true })
    const second = await source.manager.exportPack('runtime', { stamp: true })

    // The clock moves on every read, so the manifest still differs; only the payload has to
    // stay byte-identical, because that is what decides whether a push has anything to send.
    expect(first.manifest.exportedAt).not.toBe(second.manifest.exportedAt)
    expect(Buffer.from(archive(second.base64)['payload/runtime/memories.json']!))
      .toEqual(Buffer.from(archive(first.base64)['payload/runtime/memories.json']!))
    // The stamp travels with what is published only; the data directory keeps its own entry.
    const stored = entries(source.root)[0]!
    expect(stored.origin).toBeUndefined()
    expect(packed(second.base64, 'payload/runtime/memories.json')).toMatchObject({
      entries: [{ content: 'Prefer concise answers', origin: { at: stored.updated_at } }],
    })
  })

  it('never rewrites an origin that another installation already recorded', async () => {
    const source = await machine('pack-origin-preserved')
    mkdirSync(join(source.root, 'runtime'), { recursive: true })
    writeFileSync(join(source.root, 'runtime', 'memories.json'), `${JSON.stringify({
      version: 1,
      entries: [{
        content: 'Written on the desktop', target: 'memory', importance: 'normal',
        created_at: '2026-08-14T09:00:00.000Z', updated_at: '2026-08-14T09:00:00.000Z',
        origin: { machine: 'desktop-id', label: 'desktop', at: '2026-08-14T09:00:00.000Z' },
      }],
    }, null, 2)}\n`)

    const exported = await source.manager.exportPack('runtime', { stamp: true })

    expect(packed(exported.base64, 'payload/runtime/memories.json')).toMatchObject({
      entries: [{ content: 'Written on the desktop', origin: { machine: 'desktop-id', label: 'desktop' } }],
    })
  })

  it('leaves the identity and the ledger untouched for a backup that is only downloaded', async () => {
    const source = await machine('pack-origin-not-payload')
    await add(source, 'Prefer concise answers')
    const exported = await source.manager.exportPack('full')

    // A backup a person downloads is an archive, not a publication: it must not mint an
    // identity, must not advance the removal ledger, and must not carry either.
    expect(existsSync(join(source.root, 'state', 'machine.json'))).toBe(false)
    expect(existsSync(join(source.root, 'state', 'tombstones.json'))).toBe(false)
    expect(archive(exported.base64)['payload/state/machine.json']).toBeUndefined()
    expect(archive(exported.base64)['payload/runtime/tombstones.json']).toBeUndefined()
  })
})

describe('Mnemon Pack deletion tombstones', () => {
  it('records a deletion that happened between two exports', async () => {
    const source = await machine('pack-tombstone-source')
    await add(source, 'Keep the changelog short')
    await add(source, 'Prefer concise answers')
    await source.manager.exportPack('runtime', { stamp: true })
    expect(tombstones(source.root)).toEqual([])

    await remove(source, 'Keep the changelog short')
    const exported = await source.manager.exportPack('runtime', { stamp: true })

    const recorded = tombstones(source.root)
    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toMatchObject({ target: 'user', deletedAt: '2030-01-01T00:00:02.000Z', machine: identity(source.root).id })
    expect(recorded[0]?.contentHash).toMatch(/^[a-f0-9]{64}$/u)
    // The ledger is published over the sync channel, never inside the archive.
    expect(archive(exported.base64)['payload/runtime/tombstones.json']).toBeUndefined()
    expect(packed(exported.base64, 'payload/runtime/memories.json')).toMatchObject({ entries: [{ content: 'Prefer concise answers' }] })
  })

  it('does not tombstone anything on the first export of a root', async () => {
    const source = await machine('pack-tombstone-first')
    await add(source, 'Prefer concise answers')
    await source.manager.exportPack('runtime', { stamp: true })

    expect(tombstones(source.root)).toEqual([])
  })

  it('keeps a deletion invisible when an older Pack arrives over the sync channel', async () => {
    const desktop = await machine('pack-tombstone-desktop')
    await add(desktop, 'Keep the changelog short')
    const old = await desktop.manager.exportPack('runtime', { stamp: true })

    const laptop = await machine('pack-tombstone-laptop')
    await add(laptop, 'Keep the changelog short')
    await laptop.manager.exportPack('runtime', { stamp: true })
    await remove(laptop, 'Keep the changelog short')
    await laptop.manager.exportPack('runtime', { stamp: true })
    expect(entries(laptop.root)).toEqual([])

    await laptop.manager.importPack(old.base64, { mode: 'merge', tombstones: laptop.manager.tombstones() })

    expect(entries(laptop.root)).toEqual([])
    expect(tombstones(laptop.root)).toHaveLength(1)
  })

  it('adds a deleted entry back on a safe import, which carries no ledger', async () => {
    const source = await machine('pack-tombstone-safe-import')
    await add(source, 'Keep the changelog short')
    const older = await source.manager.exportPack('runtime', { stamp: true })
    await remove(source, 'Keep the changelog short')
    await source.manager.exportPack('runtime', { stamp: true })
    expect(entries(source.root)).toEqual([])
    const ledger = tombstones(source.root)
    expect(ledger).toHaveLength(1)

    // An archive a person opens by hand is not a channel: it adds what is missing and
    // removes nothing, so the entry comes back and the ledger stays exactly as it was.
    const imported = await source.manager.importPack(older.base64, { mode: 'merge' })

    expect(imported.runtime).toEqual({ added: 1, held: 0 })
    expect(entries(source.root).map(entry => entry.content)).toEqual(['Keep the changelog short'])
    expect(tombstones(source.root)).toEqual(ledger)
  })

  it('lets a deleted entry come back when it is added again later', async () => {
    const source = await machine('pack-tombstone-revive')
    await add(source, 'Keep the changelog short')
    await source.manager.exportPack('runtime', { stamp: true })
    await remove(source, 'Keep the changelog short')
    await source.manager.exportPack('runtime', { stamp: true })
    expect(entries(source.root)).toEqual([])

    await add(source, 'Keep the changelog short')
    const exported = await source.manager.exportPack('runtime', { stamp: true })

    expect(entries(source.root)).toHaveLength(1)
    expect(tombstones(source.root)).toHaveLength(1)
    expect(packed(exported.base64, 'payload/runtime/memories.json')).toMatchObject({ entries: [{ content: 'Keep the changelog short' }] })
  })

  it('brings a deleted entry back on request, and stops hiding it afterwards', async () => {
    const desktop = await machine('pack-tombstone-revive-desktop')
    await add(desktop, 'Keep the changelog short')
    const published = await desktop.manager.exportPack('runtime', { stamp: true })

    const laptop = await machine('pack-tombstone-revive-laptop')
    await add(laptop, 'Keep the changelog short')
    await laptop.manager.exportPack('runtime', { stamp: true })
    await remove(laptop, 'Keep the changelog short')
    await laptop.manager.exportPack('runtime', { stamp: true })

    // A merge that carries the ledger honours this machine's own deletion: the entry stays
    // out, and the answer says so, which is the difference between "nothing to do" and
    // "nothing written".
    const held = await laptop.manager.importPack(published.base64, { mode: 'merge', tombstones: laptop.manager.tombstones() })
    expect(held.runtime).toEqual({ added: 0, held: 1 })
    expect(entries(laptop.root)).toEqual([])
    expect(tombstones(laptop.root)).toHaveLength(1)

    // Reviving is the reader overruling that deletion, once.
    const revived = await laptop.manager.importPack(published.base64, { mode: 'merge', revive: true, tombstones: laptop.manager.tombstones() })
    expect(revived.runtime).toEqual({ added: 1, held: 0 })
    expect(entries(laptop.root).map(entry => entry.content)).toEqual(['Keep the changelog short'])
    // The overruled tombstone leaves the state this import commits, so the merge that
    // follows behaves the same way instead of hiding the entry all over again.
    expect(tombstones(laptop.root)).toEqual([])

    const again = await laptop.manager.importPack(published.base64, { mode: 'merge', tombstones: laptop.manager.tombstones() })
    expect(again.runtime).toEqual({ added: 0, held: 0 })
    expect(entries(laptop.root).map(entry => entry.content)).toEqual(['Keep the changelog short'])
  })

  it('keeps the newest deletion when two installations deleted the same entry', async () => {
    const desktop = await machine('pack-tombstone-newer-desktop')
    await add(desktop, 'Keep the changelog short')
    await desktop.manager.exportPack('runtime', { stamp: true })
    await remove(desktop, 'Keep the changelog short')
    const later = await desktop.manager.exportPack('runtime', { stamp: true })
    expect(tombstones(desktop.root)[0]?.deletedAt).toBe('2030-01-01T00:00:02.000Z')

    const laptop = await machine('pack-tombstone-newer-laptop', tickingClock('2029-01-01T00:00:00.000Z'))
    await add(laptop, 'Keep the changelog short')
    await laptop.manager.exportPack('runtime', { stamp: true })
    await remove(laptop, 'Keep the changelog short')
    await laptop.manager.exportPack('runtime', { stamp: true })
    expect(tombstones(laptop.root)[0]?.deletedAt).toBe('2029-01-01T00:00:02.000Z')

    // The channel carries the other side's ledger alongside its payload.
    await laptop.manager.importPack(later.base64, { mode: 'merge', tombstones: desktop.manager.tombstones() })

    const merged = tombstones(laptop.root)
    expect(merged).toHaveLength(1)
    expect(merged[0]?.deletedAt).toBe('2030-01-01T00:00:02.000Z')
    expect(entries(laptop.root)).toEqual([])
  })

  it('survives a corrupted runtime index by falling back to no deletions', async () => {
    const source = await machine('pack-tombstone-corrupt-index')
    await add(source, 'Keep the changelog short')
    await source.manager.exportPack('runtime', { stamp: true })
    writeFileSync(join(source.root, 'state', 'runtime-index.json'), '{ broken')

    await remove(source, 'Keep the changelog short')
    await source.manager.exportPack('runtime', { stamp: true })

    expect(tombstones(source.root)).toEqual([])
  })

  it('refuses a removal ledger that is malformed', async () => {
    const source = await machine('pack-tombstone-malformed')
    await add(source, 'Keep the changelog short')
    const exported = await source.manager.exportPack('runtime', { stamp: true })
    const malformed = { version: 1, tombstones: [{ target: 'user', contentHash: 'nope', deletedAt: '2030-01-01T00:00:00.000Z' }] } as unknown as MnemonTombstoneFile

    const target = await machine('pack-tombstone-malformed-target')
    await expect(target.manager.importPack(exported.base64, { mode: 'merge', tombstones: malformed }))
      .rejects.toThrow('runtime tombstones.json contains an invalid entry')
  })

  it('refuses a Pack whose runtime index cannot be read', async () => {
    const source = await machine('pack-tombstone-broken-index')
    await add(source, 'Keep the changelog short')
    const exported = await source.manager.exportPack('runtime', { stamp: true })
    const broken = forge(exported.base64, 'payload/runtime/memories.json', '{"version":1,"entries":[{"content":"x"}]}')

    const target = await machine('pack-tombstone-broken-index-target')
    await expect(target.manager.importPack(broken, { mode: 'merge' })).rejects.toThrow('runtime memories.json contains an invalid entry')
  })
})

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { unzipSync } from 'fflate'
import { resolveConfig } from '../src/host/config.ts'
import { MnemonPackManager } from '../src/host/pack.ts'
import { createStorageRoot } from '../src/host/storage-root.ts'
import { sourceFixture } from './fixtures/sources.ts'
import { UpstreamPackManager } from './fixtures/upstream-0.5.24-pack.mjs'

/**
 * Both directions of the archive format, driven by the released implementation itself.
 *
 * `tests/fixtures/upstream-0.5.24-pack.mjs` is the Pack code of dsh-mnemon 0.5.24, lifted
 * verbatim from the published tarball, so these cases answer the question a person actually
 * asks: a backup written here opens in the version they already have, and a backup written
 * there opens here. Reconstructing the old rules by hand would only prove they were copied
 * correctly.
 */
const directories: string[] = []
const releases: Array<() => Promise<void>> = []
const now = () => new Date('2026-08-14T12:00:00.000Z')
const COMPONENTS = ['runtime', 'documents', 'memory-spaces']

function temporary(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `dsh-mnemon-${label}-`))
  directories.push(directory)
  return directory
}

function sqlite(seed: number): Buffer {
  const bytes = Buffer.alloc(4096)
  bytes.write('SQLite format 3\0', 0, 'binary')
  bytes[4095] = seed
  return bytes
}

function runner(root: string) {
  const config = resolveConfig({ storageScope: 'custom', dataDir: root, cliPath: '/fake/mnemon' })
  return { config, runner: createStorageRoot(config) }
}

/** One machine with all three components, and both implementations pointed at it. */
async function machine(label: string, seed: number) {
  const root = temporary(label)
  const workspace = temporary(`${label}-workspace`)
  const created = runner(root)
  const sources = await sourceFixture({ dataDir: root, workspace })
  releases.push(sources.dispose)
  await sources.runtime.mutate('mutate', { action: 'add', target: 'user', content: 'Prefer concise answers', importance: 'normal' }, { confirmed: true })
  await sources.documents.mutate('mutate', { action: 'create', title: `Design ${seed}`, content: `# Design\n\nSeed ${seed}` }, { confirmed: true })
  const data = join(root, 'data')
  mkdirSync(join(data, 'project'), { recursive: true })
  writeFileSync(join(data, 'project', 'mnemon.db'), sqlite(seed))
  writeFileSync(join(data, '.dsh-memory-bodies.json'), `${JSON.stringify({
    version: 1,
    bodies: [{ id: 'project', name: `Space ${seed}`, description: `Seed ${seed}`, active: true, createdAt: now().toISOString(), updatedAt: now().toISOString() }],
  }, null, 2)}\n`)
  writeFileSync(join(root, 'active'), 'project\n')
  return {
    root, workspace, ...created,
    mine: new MnemonPackManager(created.runner, created.config, undefined, now),
    released: new UpstreamPackManager(created.runner, created.config, undefined, now),
  }
}

/** An empty data directory, where an import has to create everything it lands. */
function empty(label: string) {
  const root = temporary(label)
  const created = runner(root)
  return {
    root, ...created,
    mine: new MnemonPackManager(created.runner, created.config, undefined, now),
    released: new UpstreamPackManager(created.runner, created.config, undefined, now),
  }
}

function archive(base64: string): Record<string, Uint8Array> {
  return unzipSync(new Uint8Array(Buffer.from(base64, 'base64')))
}

function entries(root: string): Array<Record<string, unknown>> {
  const file = JSON.parse(readFileSync(join(root, 'runtime', 'memories.json'), 'utf8')) as { entries: Array<Record<string, unknown>> }
  return file.entries
}

function documents(root: string): Array<{ relativePath: string }> {
  const index = JSON.parse(readFileSync(join(root, 'documents', 'index.json'), 'utf8')) as { documents: Array<{ relativePath: string }> }
  return index.documents
}

function manifestOf(files: Record<string, Uint8Array>): Record<string, unknown> {
  return JSON.parse(Buffer.from(files['manifest.json']!).toString('utf8')) as Record<string, unknown>
}

/** Everything an import must have reproduced, asserted against the machine it came from. */
function landed(root: string, source: string): void {
  expect(entries(root)).toEqual(entries(source))
  expect(documents(root).map(document => document.relativePath)).toEqual(documents(source).map(document => document.relativePath))
  expect(readFileSync(join(root, 'documents', 'index.json'), 'utf8')).toBe(readFileSync(join(source, 'documents', 'index.json'), 'utf8'))
  expect(readFileSync(join(root, 'data', '.dsh-memory-bodies.json'), 'utf8')).toBe(readFileSync(join(source, 'data', '.dsh-memory-bodies.json'), 'utf8'))
  expect(readFileSync(join(root, 'data', 'project', 'mnemon.db'))).toEqual(readFileSync(join(source, 'data', 'project', 'mnemon.db')))
}

afterEach(async () => {
  vi.unstubAllEnvs()
  for (const release of releases.splice(0)) await release()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('the Pack format shared with dsh-mnemon 0.5.24', () => {
  it('writes an archive the released 0.5.24 opens, and lands every component in it', async () => {
    const source = await machine('compat-ours', 7)
    const exported = await source.mine.exportPack('full')
    const files = archive(exported.base64)
    const manifest = manifestOf(files)
    const payload = Object.keys(files).filter(path => path.startsWith('payload/'))

    expect(manifest['components']).toEqual(COMPONENTS)
    // Machine-local state travels over the sync channel, never inside an archive: a Pack
    // that carried a deletion ledger or an identity would stop opening in a version that
    // does not know them.
    expect(manifest).not.toHaveProperty('machine')
    expect(manifest).not.toHaveProperty('sync')
    expect(Object.keys(files).filter(path => path.startsWith('payload/state/'))).toEqual([])
    const checksums = JSON.parse(Buffer.from(files['checksums.json']!).toString('utf8')) as { files: Record<string, string> }
    expect(Object.keys(checksums.files).sort()).toEqual(payload.sort())

    const target = empty('compat-ours-target')
    const preview = target.released.inspectPack(exported.base64, 'from-this-branch.zip')
    expect(preview.fileName).toBe('from-this-branch.zip')
    expect(preview.manifest.components).toEqual(COMPONENTS)
    expect(preview.occupied).toEqual({ runtime: false, documents: false, 'memory-spaces': false })
    expect(preview.archiveBytes).toBe(Buffer.from(exported.base64, 'base64').length)

    const imported = await target.released.importPack(exported.base64, { mode: 'merge' })
    expect(imported.components).toEqual(COMPONENTS)
    landed(target.root, source.root)
  })

  it('writes the stamped payload the sync channel publishes, and the released 0.5.24 reads it too', async () => {
    const source = await machine('compat-stamp', 8)
    const exported = await source.mine.exportPack('full', { stamp: true })
    const files = archive(exported.base64)
    const stamped = JSON.parse(Buffer.from(files['payload/runtime/memories.json']!).toString('utf8')) as { entries: Array<Record<string, unknown>> }
    // Guard the case: without the stamp this test would pass for the wrong reason.
    expect(stamped.entries[0]?.['origin']).toMatchObject({ machine: expect.any(String), label: expect.any(String) })
    expect(Object.keys(files).filter(path => path.startsWith('payload/state/'))).toEqual([])

    const target = empty('compat-stamp-target')
    await target.released.importPack(exported.base64, { mode: 'merge' })
    const landedEntries = entries(target.root)
    expect(landedEntries.map(entry => entry['content'])).toContain('Prefer concise answers')
    // 0.5.24 rebuilds each entry from the fields it knows, so provenance written by a newer
    // branch is dropped rather than refused — that is what keeps one archive readable by both.
    expect(landedEntries.every(entry => entry['origin'] === undefined)).toBe(true)
  })

  it('opens an archive the released 0.5.24 wrote', async () => {
    const source = await machine('compat-theirs', 9)
    const exported = await source.released.exportPack('full')
    expect(exported.manifest.components).toEqual(COMPONENTS)

    const target = empty('compat-theirs-target')
    const preview = target.mine.inspectPack(exported.base64, 'from-0.5.24.zip')
    expect(preview.manifest.components).toEqual(COMPONENTS)
    expect(preview.manifest.scope).toBe('full')
    expect(preview.manifest).not.toHaveProperty('sync')

    const imported = await target.mine.importPack(exported.base64, { mode: 'merge' })
    expect(imported.components).toEqual(COMPONENTS)
    landed(target.root, source.root)
  })

  it('carries one archive through both implementations without changing what it holds', async () => {
    const source = await machine('compat-round', 10)
    const written = await source.mine.exportPack('full')

    const middle = empty('compat-round-middle')
    await middle.released.importPack(written.base64, { mode: 'merge' })
    const rewritten = await middle.released.exportPack('full')

    const last = empty('compat-round-last')
    await last.mine.importPack(rewritten.base64, { mode: 'merge' })
    landed(last.root, source.root)
  })
})

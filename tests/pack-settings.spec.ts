import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { unzipSync } from 'fflate'
import { resolveConfig } from '../src/host/config.ts'
import { MnemonPackManager, type MnemonSettingsBridge } from '../src/host/pack.ts'
import { createStorageRoot } from '../src/host/storage-root.ts'
import type { MnemonSettingsPayload } from '../src/host/protocol.ts'
import { sourceFixture } from './fixtures/sources.ts'

const directories: string[] = []
const releases: Array<() => Promise<void>> = []

function temporary(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `dsh-mnemon-${label}-`))
  directories.push(directory)
  return directory
}

/** Every read moves the clock forward so that a later export outranks an earlier one. */
function tickingClock(start = '2026-08-14T12:00:00.000Z'): () => Date {
  let at = Date.parse(start)
  return () => new Date((at += 1_000))
}

function runner(root: string) {
  const config = resolveConfig({ storageScope: 'custom', dataDir: root, cliPath: '/fake/mnemon' })
  return { config, runner: createStorageRoot(config) }
}

interface Machine {
  root: string
  manager: MnemonPackManager
  runtime: Awaited<ReturnType<typeof sourceFixture>>['runtime']
}

async function machine(label: string, clock: () => Date = tickingClock(), bridge?: MnemonSettingsBridge): Promise<Machine> {
  const root = temporary(label)
  const workspace = temporary(`${label}-workspace`)
  const created = runner(root)
  const sources = await sourceFixture({ dataDir: root, workspace })
  releases.push(sources.dispose)
  return { root, manager: new MnemonPackManager(created.runner, created.config, undefined, clock, bridge), runtime: sources.runtime }
}

function archive(base64: string): Record<string, Uint8Array> {
  return unzipSync(new Uint8Array(Buffer.from(base64, 'base64')))
}

function packed(base64: string, path: string): unknown {
  const file = archive(base64)[path]
  if (file === undefined) throw new Error(`the Pack is missing ${path}`)
  return JSON.parse(new TextDecoder().decode(file)) as unknown
}

function entries(root: string): Array<{ content: string; target: string }> {
  return (JSON.parse(readFileSync(join(root, 'runtime', 'memories.json'), 'utf8')) as { entries: Array<{ content: string; target: string }> }).entries
}

function bridge(payload: MnemonSettingsPayload): MnemonSettingsBridge & { apply: ReturnType<typeof vi.fn> } {
  return { collect: async () => payload, apply: vi.fn(async () => {}) }
}

afterEach(async () => {
  for (const release of releases.splice(0)) await release()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('Mnemon Pack settings component', () => {
  it('carries what the bridge collected and hands it back on import', async () => {
    const payload: MnemonSettingsPayload = {
      version: 1,
      exportedAt: '2026-08-14T12:00:00.000Z',
      namespaces: [{ ns: 'mnemon-ui', user: { displayMode: 'sidebar' }, updatedAt: '2026-08-14T12:00:00.000Z' }],
    }
    const source = await machine('pack-settings-source', tickingClock(), bridge(payload))
    const exported = await source.manager.exportPack('settings')

    expect(exported.manifest.components).toEqual(['settings'])
    expect(packed(exported.base64, 'payload/settings/mnemon.json')).toEqual(payload)

    const received = bridge(payload)
    const target = await machine('pack-settings-target', tickingClock(), received)
    await target.manager.importPack(exported.base64, { mode: 'merge' })

    expect(received.apply).toHaveBeenCalledTimes(1)
    expect(received.apply.mock.calls[0]?.[0]).toEqual(payload)
    expect(JSON.parse(readFileSync(join(target.root, 'settings', 'mnemon.json'), 'utf8'))).toEqual(payload)
  })

  it('exports an empty settings payload when this installation has no bridge', async () => {
    const source = await machine('pack-settings-absent')
    const exported = await source.manager.exportPack('settings')

    expect(packed(exported.base64, 'payload/settings/mnemon.json')).toEqual({
      version: 1, exportedAt: '2026-08-14T12:00:01.000Z', namespaces: [],
    })
    expect(exported.manifest.summary).toEqual([{ component: 'settings', files: 1, bytes: expect.any(Number), items: 0 }])
  })

  it('never applies a Pack that carries no settings component', async () => {
    const source = await machine('pack-settings-unrelated')
    await source.runtime.mutate('mutate', { action: 'add', target: 'user', content: 'Prefer concise answers', importance: 'normal' }, { confirmed: true })
    const exported = await source.manager.exportPack('runtime')

    const received = bridge({ version: 1, exportedAt: '2026-08-14T12:00:00.000Z', namespaces: [] })
    const target = await machine('pack-settings-unrelated-target', tickingClock(), received)
    await target.manager.importPack(exported.base64, { mode: 'merge' })

    expect(received.apply).not.toHaveBeenCalled()
  })

  it('keeps the newer namespace when two installations merge their settings', async () => {
    const incoming: MnemonSettingsPayload = {
      version: 1,
      exportedAt: '2026-08-14T12:00:00.000Z',
      namespaces: [
        { ns: 'mnemon-ui', user: { displayMode: 'sidebar' }, updatedAt: '2026-08-14T11:00:00.000Z' },
        { ns: 'mnemon', user: { idleReviewMs: 45_000 }, updatedAt: '2026-08-14T13:00:00.000Z' },
      ],
    }
    const source = await machine('pack-settings-recency-source', tickingClock(), bridge(incoming))
    const exported = await source.manager.exportPack('settings')

    const local: MnemonSettingsPayload = {
      version: 1,
      exportedAt: '2026-08-14T10:00:00.000Z',
      namespaces: [
        { ns: 'mnemon-ui', user: { displayMode: 'window' }, updatedAt: '2026-08-14T12:30:00.000Z' },
        { ns: 'mnemon', user: { idleReviewMs: 90_000 }, updatedAt: '2026-08-14T09:00:00.000Z' },
      ],
    }
    const target = await machine('pack-settings-recency-target', tickingClock(), bridge(local))
    // Settings only reach the data directory when this installation exports, so the
    // target has to publish once before a merge can weigh its snapshot against the Pack.
    await target.manager.exportPack('settings')
    await target.manager.importPack(exported.base64, { mode: 'merge' })

    expect(packed(exported.base64, 'payload/settings/mnemon.json')).toEqual(incoming)
    expect(JSON.parse(readFileSync(join(target.root, 'settings', 'mnemon.json'), 'utf8'))).toEqual({
      version: 1,
      exportedAt: incoming.exportedAt,
      namespaces: [
        { ns: 'mnemon-ui', user: { displayMode: 'window' }, updatedAt: '2026-08-14T12:30:00.000Z' },
        { ns: 'mnemon', user: { idleReviewMs: 45_000 }, updatedAt: '2026-08-14T13:00:00.000Z' },
      ],
    })
  })

  it('replaces the local settings outright in replace mode', async () => {
    const incoming: MnemonSettingsPayload = {
      version: 1, exportedAt: '2026-08-14T12:00:00.000Z',
      namespaces: [{ ns: 'mnemon-ui', user: { displayMode: 'sidebar' }, updatedAt: '2026-08-14T09:00:00.000Z' }],
    }
    const source = await machine('pack-settings-replace-source', tickingClock(), bridge(incoming))
    const exported = await source.manager.exportPack('settings')

    const local: MnemonSettingsPayload = {
      version: 1, exportedAt: '2026-08-14T10:00:00.000Z',
      namespaces: [{ ns: 'mnemon-ui', user: { displayMode: 'window' }, updatedAt: '2026-08-14T12:30:00.000Z' }],
    }
    const target = await machine('pack-settings-replace-target', tickingClock(), bridge(local))
    await target.manager.importPack(exported.base64, { mode: 'replace' })

    expect(packed(exported.base64, 'payload/settings/mnemon.json')).toEqual(incoming)
    expect(JSON.parse(readFileSync(join(target.root, 'settings', 'mnemon.json'), 'utf8'))).toEqual(incoming)
  })

  it('keeps an unchanged profile byte-identical across two exports', async () => {
    const payload: MnemonSettingsPayload = {
      version: 1,
      exportedAt: '2026-08-14T12:00:00.000Z',
      namespaces: [{ ns: 'mnemon-ui', user: { displayMode: 'sidebar' }, updatedAt: '2026-08-14T12:00:00.000Z' }],
    }
    const source = await machine('pack-settings-stable', tickingClock(), bridge(payload))
    const first = await source.manager.exportPack('settings')
    const second = await source.manager.exportPack('settings')

    // The clock moved between the two exports; the payload must not follow it,
    // because a push compares payload bytes to decide whether to commit at all.
    expect(packed(second.base64, 'payload/settings/mnemon.json')).toEqual(payload)
    expect(archive(second.base64)['payload/settings/mnemon.json']).toEqual(archive(first.base64)['payload/settings/mnemon.json'])
  })

  it('restamps the namespace whose settings really changed', async () => {
    let payload: MnemonSettingsPayload = {
      version: 1,
      exportedAt: '2026-08-14T12:00:00.000Z',
      namespaces: [{ ns: 'mnemon-ui', user: { displayMode: 'sidebar' }, updatedAt: '2026-08-14T12:00:00.000Z' }],
    }
    const source = await machine('pack-settings-restamp', tickingClock(), {
      collect: async () => payload,
      apply: vi.fn(async () => {}),
    })
    await source.manager.exportPack('settings')
    payload = {
      version: 1,
      exportedAt: '2026-08-14T12:00:05.000Z',
      namespaces: [
        { ns: 'mnemon-ui', user: { displayMode: 'window' }, updatedAt: '2026-08-14T12:00:05.000Z' },
        { ns: 'mnemon', user: { idleReviewMs: 45_000 }, updatedAt: '2026-08-14T12:00:05.000Z' },
      ],
    }
    const exported = await source.manager.exportPack('settings')

    expect(packed(exported.base64, 'payload/settings/mnemon.json')).toEqual(payload)
  })

  it('refuses a settings payload that lost its export stamp', async () => {
    const source = await machine('pack-settings-stampless')
    mkdirSync(join(source.root, 'settings'), { recursive: true })
    writeFileSync(join(source.root, 'settings', 'mnemon.json'), '{"version":1,"namespaces":[]}\n')

    await expect(source.manager.exportPack('settings')).rejects.toThrow('settings mnemon.json is invalid')
  })
})

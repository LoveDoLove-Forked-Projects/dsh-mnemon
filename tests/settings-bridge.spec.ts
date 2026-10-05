import { describe, expect, it, vi } from 'vitest'
import type { HostSettingsService } from '../src/host/dsh.ts'
import { MNEMON_MACHINE_LOCAL_KEYS, MnemonProfileSettingsBridge } from '../src/host/settings-bridge.ts'
import type { MnemonSettingsPayload, SettingsOperation } from '../src/host/protocol.ts'

interface FixtureNamespace {
  ns: string
  user: Record<string, unknown>
  revision: number
  applies?: 'live' | 'restart'
}

/** A profile document the bridge can edit, with the revision fence the real service enforces. */
function profile(initial: FixtureNamespace[], options: { writable?: boolean } = {}) {
  const namespaces = initial.map(entry => ({ applies: 'restart' as const, ...entry }))
  const writes: Array<{ ns: string; ops: SettingsOperation[]; expected?: number }> = []
  const mutate = vi.fn(async (ns: string, ops: SettingsOperation[], expected?: number) => {
    const target = namespaces.find(entry => entry.ns === ns)
    if (target === undefined) throw new Error('unknown namespace: ' + ns)
    if (expected !== undefined && expected !== target.revision) throw new Error('settings revision mismatch')
    for (const op of ops) {
      if (op.op === 'set') assign(target.user, op.path, op.value)
      else unset(target.user, op.path)
    }
    target.revision += 1
    writes.push({ ns, ops, ...(expected === undefined ? {} : { expected }) })
  })
  const settings = {
    writable: options.writable ?? true,
    register: vi.fn(),
    mutate,
    describe: () => namespaces.map(entry => ({ ns: entry.ns, value: structuredClone(entry.user), base: {}, user: structuredClone(entry.user), revision: entry.revision, applies: entry.applies })),
  } as unknown as HostSettingsService
  return { settings, namespaces, writes, mutate }
}

function assign(target: Record<string, unknown>, path: string[], value: unknown): void {
  let cursor = target
  for (const key of path.slice(0, -1)) {
    const next = cursor[key]
    if (typeof next !== 'object' || next === null) cursor[key] = {}
    cursor = cursor[key] as Record<string, unknown>
  }
  cursor[path.at(-1)!] = value
}

function unset(target: Record<string, unknown>, path: string[]): void {
  let cursor = target
  for (const key of path.slice(0, -1)) {
    const next = cursor[key]
    if (typeof next !== 'object' || next === null) return
    cursor = next as Record<string, unknown>
  }
  delete cursor[path.at(-1)!]
}

const now = () => new Date('2026-08-14T12:00:00.000Z')

describe('Mnemon profile settings bridge', () => {
  it('exports the user layer of every Mnemon namespace and nothing machine-local', async () => {
    const { settings } = profile([
      { ns: 'mnemon', revision: 1, user: { storageScope: 'custom', dataDir: 'D:/data', cliPath: '/fake', customPackId: 'pack', customPacks: [], idleReviewMs: 45_000, runtimeUserScope: 'global' } },
      { ns: 'mnemon-ui', revision: 3, user: { displayMode: 'sidebar' } },
      { ns: 'other', revision: 1, user: { untouched: true } },
      { ns: 'empty', revision: 1, user: {} },
    ])
    const payload = await new MnemonProfileSettingsBridge(settings, now).collect()
    expect(payload).toEqual({
      version: 1,
      exportedAt: '2026-08-14T12:00:00.000Z',
      namespaces: [
        { ns: 'mnemon', user: { idleReviewMs: 45_000, runtimeUserScope: 'global' }, updatedAt: '2026-08-14T12:00:00.000Z' },
        { ns: 'mnemon-ui', user: { displayMode: 'sidebar' }, updatedAt: '2026-08-14T12:00:00.000Z' },
        { ns: 'other', user: { untouched: true }, updatedAt: '2026-08-14T12:00:00.000Z' },
      ],
    })
    for (const key of MNEMON_MACHINE_LOCAL_KEYS) expect(JSON.stringify(payload)).not.toContain(`"${key}"`)
  })

  it('never exports a secret the profile redacted', async () => {
    const { settings } = profile([{ ns: 'mnemon', revision: 1, user: { embedding: { enabled: true, model: 'qwen' } } }])
    const payload = await new MnemonProfileSettingsBridge(settings, now).collect()
    expect(payload.namespaces[0]!.user).toEqual({ embedding: { enabled: true, model: 'qwen' } })
  })

  it('writes back only the fields that differ, one namespace at a time', async () => {
    const { settings, writes } = profile([{ ns: 'mnemon', revision: 4, user: { idleReviewMs: 30_000, runtimeUserScope: 'global', embedding: { enabled: false, model: 'qwen' } } }])
    const incoming: MnemonSettingsPayload = {
      version: 1,
      exportedAt: '2026-08-14T12:00:00.000Z',
      namespaces: [{ ns: 'mnemon', user: { idleReviewMs: 30_000, runtimeUserScope: 'workspace', embedding: { enabled: false, model: 'qwen3-embedding' } }, updatedAt: '2026-08-14T12:00:00.000Z' }],
    }
    await new MnemonProfileSettingsBridge(settings, now).apply(incoming)
    expect(writes).toEqual([{
      ns: 'mnemon',
      expected: 4,
      ops: [
        { op: 'set', path: ['runtimeUserScope'], value: 'workspace' },
        { op: 'set', path: ['embedding', 'model'], value: 'qwen3-embedding' },
      ],
    }])
  })

  it('drops a field the Pack does not carry, without touching the machine-local ones', async () => {
    const { settings, writes } = profile([{ ns: 'mnemon', revision: 1, user: { idleReviewMs: 30_000, staleField: true, storageScope: 'custom' } }])
    await new MnemonProfileSettingsBridge(settings, now).apply({
      version: 1,
      exportedAt: '2026-08-14T12:00:00.000Z',
      namespaces: [{ ns: 'mnemon', user: { idleReviewMs: 30_000, storageScope: 'global' }, updatedAt: '2026-08-14T12:00:00.000Z' }],
    })
    expect(writes).toEqual([{ ns: 'mnemon', expected: 1, ops: [{ op: 'unset', path: ['staleField'] }] }])
  })

  it('writes nothing when the profile already holds the Pack settings', async () => {
    const { settings, mutate } = profile([{ ns: 'mnemon', revision: 2, user: { idleReviewMs: 30_000 } }])
    await new MnemonProfileSettingsBridge(settings, now).apply({
      version: 1,
      exportedAt: '2026-08-14T12:00:00.000Z',
      namespaces: [{ ns: 'mnemon', user: { idleReviewMs: 30_000 }, updatedAt: '2026-08-14T12:00:00.000Z' }],
    })
    expect(mutate).not.toHaveBeenCalled()
  })

  it('ignores a namespace this Host never registered', async () => {
    const { settings, mutate } = profile([{ ns: 'mnemon', revision: 1, user: {} }])
    await new MnemonProfileSettingsBridge(settings, now).apply({
      version: 1,
      exportedAt: '2026-08-14T12:00:00.000Z',
      namespaces: [{ ns: 'from-another-plugin', user: { anything: true }, updatedAt: '2026-08-14T12:00:00.000Z' }],
    })
    expect(mutate).not.toHaveBeenCalled()
  })

  it('refuses to write into a read-only profile and says why', async () => {
    const { settings, mutate } = profile([{ ns: 'mnemon', revision: 1, user: {} }], { writable: false })
    await expect(new MnemonProfileSettingsBridge(settings, now).apply({
      version: 1,
      exportedAt: '2026-08-14T12:00:00.000Z',
      namespaces: [{ ns: 'mnemon', user: { idleReviewMs: 1 }, updatedAt: '2026-08-14T12:00:00.000Z' }],
    })).rejects.toThrow('DSH settings are read-only; the Pack settings were not applied')
    expect(mutate).not.toHaveBeenCalled()
  })

  it('names the namespace that refused the write', async () => {
    const { settings } = profile([{ ns: 'mnemon', revision: 9, user: {} }])
    settings.mutate = vi.fn(async () => { throw new Error('settings revision mismatch') }) as unknown as HostSettingsService['mutate']
    await expect(new MnemonProfileSettingsBridge(settings, now).apply({
      version: 1,
      exportedAt: '2026-08-14T12:00:00.000Z',
      namespaces: [{ ns: 'mnemon', user: { idleReviewMs: 1 }, updatedAt: '2026-08-14T12:00:00.000Z' }],
    })).rejects.toThrow('Mnemon Pack settings could not be applied to mnemon: settings revision mismatch')
  })
})

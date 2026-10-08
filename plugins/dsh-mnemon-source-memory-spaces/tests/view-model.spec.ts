import { describe, expect, it } from 'vitest'
import type { MemorySpacesStatus } from '../src/contracts.ts'
import { modelStatus } from '../src/view-model.ts'

function status(overrides: Partial<MemorySpacesStatus> = {}): MemorySpacesStatus {
  return {
    healthy: true,
    cliPath: '/opt/mnemon/bin/mnemon',
    commandFound: true,
    dataDir: '/data',
    store: 'none',
    mnemonDefaultStore: 'default',
    dshActiveStores: [],
    writeEnabled: true,
    timeoutMs: 10_000,
    defaultRecallLimit: 10,
    memoryBodyDirectory: '/data/.dsh-memory-bodies.json',
    memoryBodies: [],
    providerServices: [],
    ...overrides,
  } as unknown as MemorySpacesStatus
}

describe('Memory Spaces health for model tools', () => {
  it('says what durable memory needs when no Memory Space exists, without calling memory unhealthy (issue 336)', () => {
    // No Mnemon CLI and no other Provider: a space cannot be created yet.
    const blocked = modelStatus(status({ commandFound: false }))
    expect(blocked).toMatchObject({ healthy: true, memorySpaces: { total: 0 } })
    expect(blocked.notice).toBe('No Memory Space exists, and none can be created until a memory Provider is ready, so durable memory has nowhere to go and a full MEMORY.md archives to a local file. Install the Mnemon CLI for Mnemon Native, or connect another Provider on the dsh-mnemon page under Plugins, then create and activate a Memory Space.')

    // A ready Provider: only the space is missing.
    const native = modelStatus(status({ commandFound: true }))
    expect(native.notice).toBe('No Memory Space exists yet, so durable memory has nowhere to go and a full MEMORY.md archives to a local file. Create and activate a Memory Space to keep durable memory.')
    const remote = modelStatus(status({ commandFound: false, providerServices: [{ providerId: 'mem0', label: 'Mem0', enabled: true, configured: true, status: 'idle', memoryBodyCount: 0, activeMemoryBodyCount: 0 }] as never }))
    expect(remote.notice).toBe(native.notice)
    // A service saved but switched off cannot create a space either.
    const disabled = modelStatus(status({ commandFound: false, providerServices: [{ providerId: 'mem0', label: 'Mem0', enabled: false, configured: true, status: 'disabled', memoryBodyCount: 0, activeMemoryBodyCount: 0 }] as never }))
    expect(disabled.notice).toBe(blocked.notice)
  })

  it('adds nothing once a Memory Space exists', () => {
    const value = modelStatus(status({ memoryBodies: [{ id: 'default', name: 'Default', active: true, providerEnabled: true, healthy: true }] as never }))
    expect(value).not.toHaveProperty('notice')
    expect(value).toMatchObject({ healthy: true, memorySpaces: { total: 1, active: 1, healthy: 1 } })
  })
})

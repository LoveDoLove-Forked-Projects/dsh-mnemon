import { describe, expect, it, vi } from 'vitest'
import type { HostAgent, HostSubagentActivation, HostSubagentResult, HostSubagentsService } from '../src/host/dsh.ts'
import { startSubagent } from '../src/host/subagent-start.ts'

const agent = (id: string) => ({ id, status: 'idle', session: { header: {} } }) as unknown as HostAgent

function request(signal = new AbortController().signal) {
  return {
    label: 'Consolidate local user profile',
    prompt: [{ type: 'text' as const, text: 'Run local USER.md compaction now.' }],
    parent: agent('parent'),
    signal,
    agentOptions: { maxTokens: 8_192 },
    maxDepth: 1,
    toolFilter: { allow: ['mnemon_subagent_result'] },
    persona: 'You are the local USER.md compactor.',
  }
}

/** DSH 0.2.1-alpha.2: `start` is gone and every child is a managed activation. */
function activations() {
  const result = Promise.withResolvers<HostSubagentResult>()
  const dispose = vi.fn(async () => {})
  const activation: HostSubagentActivation = { childId: 'child-1', messageId: 'message-1', result: result.promise, dispose }
  const startActivation = vi.fn(async (_spec: Parameters<NonNullable<HostSubagentsService['startActivation']>>[0]) => activation)
  const subagents = { list: () => ['spawn'], getProvider: () => undefined, startActivation } as unknown as HostSubagentsService
  return { subagents, startActivation, result, dispose }
}

describe('Starting a delegated child on the running DSH (#356)', () => {
  it('starts a caller-delivered activation where DSH has replaced start', async () => {
    const host = activations()
    const child = agent('child-1')
    const input = request()
    const agents = { get: vi.fn((id: string) => id === 'child-1' ? child : undefined), isOwnedBy: vi.fn((id: string, owner: HostAgent) => id === 'child-1' && owner === input.parent) }

    const run = await startSubagent(host.subagents, agents, 'spawn', input)

    expect(host.startActivation).toHaveBeenCalledWith({
      provider: 'spawn',
      label: 'Consolidate local user profile',
      request: {
        prompt: input.prompt,
        parent: input.parent,
        agentOptions: { maxTokens: 8_192 },
        maxDepth: 1,
        toolFilter: { allow: ['mnemon_subagent_result'] },
        persona: 'You are the local USER.md compactor.',
      },
      signal: input.signal,
      delivery: 'caller',
    })
    expect(run.id).toBe('child-1')
    expect(run.localAgent).toBe(child)
    host.result.resolve({ output: [], stopReason: 'completed' })
    await expect(run.result).resolves.toEqual({ output: [], stopReason: 'completed' })
    await run.dispose()
    expect(host.dispose).toHaveBeenCalledOnce()
  })

  it('keeps the child it found once the activation releases it before settling', async () => {
    // As on DSH 0.2.1-alpha.2: the child is resident when startActivation resolves and leaves the
    // registry before the result settles, at least one model turn later.
    const host = activations()
    const input = request()
    const live = new Map([['child-1', agent('child-1')]])
    const agents = { get: (id: string) => live.get(id), isOwnedBy: () => true }
    const run = await startSubagent(host.subagents, agents, 'spawn', input)
    const child = run.localAgent
    setTimeout(() => { live.delete('child-1'); host.result.resolve({ output: [], stopReason: 'error' }) }, 0)

    await expect(run.result).resolves.toMatchObject({ stopReason: 'error' })
    expect(live.has('child-1')).toBe(false)
    expect(child?.id).toBe('child-1')
    expect(run.localAgent).toBe(child)
  })

  it('prefers activations when a DSH offers both APIs', async () => {
    const host = activations()
    const start = vi.fn()
    const subagents = { ...host.subagents, start } as HostSubagentsService

    await startSubagent(subagents, undefined, 'spawn', request())

    expect(host.startActivation).toHaveBeenCalledOnce()
    expect(start).not.toHaveBeenCalled()
  })

  it('disposes an activation it cannot hand over', async () => {
    const host = activations()
    const agents = { get: () => { throw new Error('registry unavailable') } }

    await expect(startSubagent(host.subagents, agents, 'spawn', request())).rejects.toThrow('registry unavailable')
    expect(host.dispose).toHaveBeenCalledOnce()
  })

  it('names no local child that the parent does not own', async () => {
    const host = activations()
    const agents = { get: () => agent('child-1'), isOwnedBy: () => false }

    const run = await startSubagent(host.subagents, agents, 'spawn', request())

    expect(run.localAgent).toBeUndefined()
    expect('localAgent' in run).toBe(false)
  })

  it('disposes a running activation when the caller aborts, as a one-shot run stopped', async () => {
    const host = activations()
    const controller = new AbortController()
    const run = await startSubagent(host.subagents, undefined, 'spawn', request(controller.signal))
    expect(host.dispose).not.toHaveBeenCalled()

    controller.abort()

    expect(host.dispose).toHaveBeenCalledOnce()
    host.result.resolve({ output: [], stopReason: 'aborted' })
    await expect(run.result).resolves.toMatchObject({ stopReason: 'aborted' })
  })

  it('disposes an activation whose caller aborted while it was starting', async () => {
    const host = activations()
    const controller = new AbortController()
    host.startActivation.mockImplementationOnce(async () => {
      controller.abort()
      return { childId: 'child-1', result: host.result.promise, dispose: host.dispose }
    })

    await startSubagent(host.subagents, undefined, 'spawn', request(controller.signal))

    expect(host.dispose).toHaveBeenCalledOnce()
  })

  it('leaves a settled activation alone when the caller aborts later', async () => {
    const host = activations()
    const controller = new AbortController()
    const run = await startSubagent(host.subagents, undefined, 'spawn', request(controller.signal))
    host.result.resolve({ output: [], stopReason: 'completed' })
    await run.result

    controller.abort()

    expect(host.dispose).not.toHaveBeenCalled()
  })

  it('starts a one-shot run unchanged on DSH 0.2.0', async () => {
    const run = { id: 'child-1', result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: vi.fn(async () => {}) }
    const start = vi.fn(async () => run)
    const subagents = { list: () => ['spawn'], getProvider: () => undefined, start } as unknown as HostSubagentsService
    const input = request()

    await expect(startSubagent(subagents, { get: () => agent('child-1') }, 'spawn', input)).resolves.toBe(run)
    expect(start).toHaveBeenCalledWith('spawn', input)
  })

  it('says why no memory subagent can start on a DSH with neither API', async () => {
    const subagents = { list: () => ['spawn'], getProvider: () => undefined } as unknown as HostSubagentsService

    await expect(startSubagent(subagents, undefined, 'spawn', request())).rejects.toThrow('This DSH has neither subagents.startActivation nor subagents.start, so dsh-mnemon cannot start its memory subagent')
  })
})

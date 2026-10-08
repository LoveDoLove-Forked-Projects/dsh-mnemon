import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MnemonAutoBackupScheduler } from '../src/host/auto-backup.ts'
import type { LiveMnemonRuntime } from '../src/host/runtime.ts'

/** One minute in the units the scheduler works in. */
const MINUTE = 60_000

interface Harness {
  minutes: number
  repoUrl?: string
  writeEnabled: boolean
  pushes: number
  failure?: Error
  pushed: boolean
  committed: boolean
}

/**
 * The scheduler only ever reads the interval, the write gate and the push, so
 * the graph it is handed is a stand-in: driving real Git for a timer would test
 * Git, not the timer.
 */
function runtimeFor(state: Harness): LiveMnemonRuntime {
  return {
    config: { get writeEnabled(): boolean { return state.writeEnabled } },
    sync: {
      settings: () => ({ read: () => ({ ...(state.repoUrl === undefined ? {} : { repoUrl: state.repoUrl }), autoBackupMinutes: state.minutes }) }),
      push: async () => {
        state.pushes += 1
        if (state.failure !== undefined) throw state.failure
        return { commit: 'abcdef1234567890', committed: state.committed, pushed: state.pushed }
      },
    },
  } as unknown as LiveMnemonRuntime
}

/** A clock the test moves, so "an hour later" is a fact rather than a wait. */
function clock(start = '2026-08-14T12:00:00.000Z'): { now: () => Date; set: (at: string) => void } {
  let at = start
  return { now: () => new Date(at), set: next => { at = next } }
}

let warn: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.useFakeTimers()
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  warn.mockRestore()
  vi.useRealTimers()
})

describe('automatic Git backup', () => {
  it('arms nothing while the interval is off', async () => {
    const state: Harness = { minutes: 0, writeEnabled: true, pushes: 0, pushed: true, committed: true }
    const scheduler = new MnemonAutoBackupScheduler(runtimeFor(state), clock().now)
    const stop = scheduler.start()

    // Off is the default a channel nobody configured keeps, and it says so
    // rather than naming a time that will never arrive.
    expect(scheduler.snapshot()).toEqual({ available: false })
    await vi.advanceTimersByTimeAsync(12 * 60 * MINUTE)
    expect(state.pushes).toBe(0)
    stop()
  })

  it('pushes once per interval and moves the next run forward', async () => {
    const state: Harness = { minutes: 60, repoUrl: '/srv/memory.git', writeEnabled: true, pushes: 0, pushed: true, committed: true }
    const time = clock()
    const scheduler = new MnemonAutoBackupScheduler(runtimeFor(state), time.now)
    const stop = scheduler.start()

    expect(scheduler.snapshot()).toEqual({ available: true, nextAt: '2026-08-14T13:00:00.000Z' })
    await vi.advanceTimersByTimeAsync(59 * MINUTE)
    expect(state.pushes).toBe(0)
    await vi.advanceTimersByTimeAsync(MINUTE)
    expect(state.pushes).toBe(1)
    expect(scheduler.snapshot()).toMatchObject({ available: true, lastAt: '2026-08-14T12:00:00.000Z', lastCommit: 'abcdef1234567890', lastPushed: true })

    // The next run is an interval after the one that just ran, not an interval
    // after the first one was armed.
    time.set('2026-08-14T13:00:00.000Z')
    await vi.advanceTimersByTimeAsync(60 * MINUTE)
    expect(state.pushes).toBe(2)
    expect(scheduler.snapshot().lastAt).toBe('2026-08-14T13:00:00.000Z')
    stop()
  })

  it('takes a saved change to the interval without a restart', async () => {
    const state: Harness = { minutes: 0, repoUrl: '/srv/memory.git', writeEnabled: true, pushes: 0, pushed: true, committed: true }
    const scheduler = new MnemonAutoBackupScheduler(runtimeFor(state), clock().now)
    const stop = scheduler.start()
    expect(scheduler.snapshot().available).toBe(false)

    // The settings page saved a cadence: the timer is armed from that save, not
    // from whenever the Host started.
    state.minutes = 30
    scheduler.refresh()
    expect(scheduler.snapshot()).toMatchObject({ available: true, nextAt: '2026-08-14T12:30:00.000Z' })
    await vi.advanceTimersByTimeAsync(30 * MINUTE)
    expect(state.pushes).toBe(1)

    // Turning it off again drops the timer, so no later tick can surprise anyone.
    state.minutes = 0
    scheduler.refresh()
    expect(scheduler.snapshot().available).toBe(false)
    await vi.advanceTimersByTimeAsync(10 * 60 * MINUTE)
    expect(state.pushes).toBe(1)
    stop()
  })

  it('keeps the timer running when there is no repository yet', async () => {
    const state: Harness = { minutes: 60, writeEnabled: true, pushes: 0, pushed: true, committed: true }
    const scheduler = new MnemonAutoBackupScheduler(runtimeFor(state), clock().now)
    const stop = scheduler.start()

    // Nothing to publish to yet is not a failure: the timer keeps its cadence,
    // so a repository configured later needs no second visit to the page.
    await vi.advanceTimersByTimeAsync(60 * MINUTE)
    expect(state.pushes).toBe(0)
    expect(scheduler.snapshot().lastError).toBeUndefined()
    expect(scheduler.snapshot().available).toBe(true)

    state.repoUrl = '/srv/memory.git'
    await vi.advanceTimersByTimeAsync(60 * MINUTE)
    expect(state.pushes).toBe(1)
    stop()
  })

  it('reports a read-only Host instead of pushing, and pushes once it is writable', async () => {
    const state: Harness = { minutes: 60, repoUrl: '/srv/memory.git', writeEnabled: false, pushes: 0, pushed: true, committed: true }
    const scheduler = new MnemonAutoBackupScheduler(runtimeFor(state), clock().now)
    const stop = scheduler.start()

    // A read-only Host refuses the push, and the timer says so rather than
    // disappearing: the interval is a setting, not a permission. The message is
    // the one the RPC layer refuses with, so the page never shows two names for
    // the same fact.
    await vi.advanceTimersByTimeAsync(60 * MINUTE)
    expect(state.pushes).toBe(0)
    expect(scheduler.snapshot().lastError).toBe('dsh-mnemon is configured read-only')
    expect(scheduler.snapshot().available).toBe(true)

    state.writeEnabled = true
    await vi.advanceTimersByTimeAsync(60 * MINUTE)
    expect(state.pushes).toBe(1)
    expect(scheduler.snapshot().lastError).toBeUndefined()
    stop()
  })

  it('reports a failed push and says nothing about the lock it is meant to lose to', async () => {
    const state: Harness = { minutes: 60, repoUrl: '/srv/memory.git', writeEnabled: true, pushes: 0, pushed: true, committed: true, failure: new Error('authentication failed') }
    const scheduler = new MnemonAutoBackupScheduler(runtimeFor(state), clock().now)
    const stop = scheduler.start()

    await vi.advanceTimersByTimeAsync(60 * MINUTE)
    expect(scheduler.snapshot().lastError).toBe('authentication failed')
    expect(warn).toHaveBeenCalledWith('dsh-mnemon: automatic Git backup failed', expect.anything())
    // A failure does not stop the cadence: the next tick tries again.
    await vi.advanceTimersByTimeAsync(60 * MINUTE)
    expect(state.pushes).toBe(2)

    // The reader is working, so the timer simply stands aside; reporting it
    // would put a failure on the page for something that is not one.
    warn.mockClear()
    state.failure = new Error('another Mnemon sync operation is still running')
    await vi.advanceTimersByTimeAsync(60 * MINUTE)
    expect(scheduler.snapshot().lastError).toBe('authentication failed')
    expect(warn).not.toHaveBeenCalled()
    stop()
  })

  it('stops with the runtime it reads', async () => {
    const state: Harness = { minutes: 60, repoUrl: '/srv/memory.git', writeEnabled: true, pushes: 0, pushed: true, committed: true }
    const scheduler = new MnemonAutoBackupScheduler(runtimeFor(state), clock().now)
    const stop = scheduler.start()
    stop()

    await vi.advanceTimersByTimeAsync(10 * 60 * MINUTE)
    expect(state.pushes).toBe(0)
    expect(scheduler.snapshot().available).toBe(false)
    // A refresh after teardown must not arm a new timer on a disposed runtime.
    scheduler.refresh()
    await vi.advanceTimersByTimeAsync(10 * 60 * MINUTE)
    expect(state.pushes).toBe(0)
  })
})

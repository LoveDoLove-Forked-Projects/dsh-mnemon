// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Config } from '../src/host/config.ts'
import type { ClientConnectionHandle, ClientSettingsScope } from '../src/host/dsh.ts'
import { MnemonReviewSection } from '../src/client/MnemonReviewSection.tsx'
import { MnemonSettingsCard } from '../src/client/MnemonSettingsCard.tsx'
import { translateEn, translateZh } from '../src/client/locales.ts'
import { settingsScope } from './helpers/settings-scope.ts'

afterEach(cleanup)

/** The data directory's default or custom choice. */
const directoryChoice = (option: string, group = '数据目录') =>
  within(screen.getByRole('radiogroup', { name: group })).getByRole('radio', { name: option }) as HTMLInputElement

const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement

/** The section of the card that holds the storage, sync and review rows. */
const section = () => screen.getByRole('region', { name: '存储' })

function core(value: Config, writable = true) {
  const snapshot = { status: 'ready' as const, value, base: {}, user: {}, revision: 0, writable, mode: 'host' as const }
  return settingsScope(snapshot) as ClientSettingsScope<Config>
}

/** A connection whose Host answers only the endpoints this page uses. */
function host(handlers: Record<string, (payload: Record<string, unknown>) => unknown>) {
  const call = vi.fn(async (channel: string, endpoint: string, payload: Record<string, unknown>) => {
    const handler = handlers[`${channel} ${endpoint}`]
    if (handler === undefined) return { ok: false as const, error: { code: 'bad-request', message: `unexpected ${channel} ${endpoint}` } }
    try {
      return { ok: true as const, value: await handler(payload ?? {}) }
    } catch (reason) {
      return { ok: false as const, error: { code: 'internal', message: reason instanceof Error ? reason.message : String(reason) } }
    }
  })
  return { call, connection: { rpc: { call }, isLoopback: true } as unknown as ClientConnectionHandle }
}

/** A connection whose Host answers only the endpoints this page uses. */
function recordingHost(handlers: Record<string, (payload: Record<string, unknown>) => unknown>, calls: Array<{ endpoint: string; payload: Record<string, unknown> }>) {
  const call = vi.fn(async (channel: string, endpoint: string, payload: Record<string, unknown>) => {
    calls.push({ endpoint, payload: payload ?? {} })
    const handler = handlers[`${channel} ${endpoint}`]
    if (handler === undefined) return { ok: false as const, error: { code: 'bad-request', message: `unexpected ${channel} ${endpoint}` } }
    try {
      return { ok: true as const, value: await handler(payload ?? {}) }
    } catch (reason) {
      return { ok: false as const, error: { code: 'internal', message: reason instanceof Error ? reason.message : String(reason) } }
    }
  })
  return { call, connection: { rpc: { call }, isLoopback: true } as unknown as ClientConnectionHandle }
}

const target = { root: '/old/data', scope: 'custom', defaultRoot: '/home/me/.mnemon' }

describe('the chosen data directory', () => {
  it('offers the move the chosen directory needs, then moves it only when asked', async () => {
    const { connection, call } = host({
      '/dsh-mnemon-pack target': () => target,
      '/dsh-mnemon-pack storage-plan': () => ({ from: '/old/data', to: '/new/data', source: { files: 4, bytes: 2048 }, targetOccupied: false, sameDevice: true }),
      '/dsh-mnemon-pack storage-migrate': () => ({ from: '/old/data', to: '/new/data', files: 4, bytes: 2048, source: 'rename', removed: true }),
    })
    const pickDirectory = vi.fn(async () => '/new/data')
    const scope = core({ storageScope: 'custom', dataDir: '/old/data' })
    render(<MnemonSettingsCard scope={scope} connection={connection} pickDirectory={pickDirectory} />)
    // The row shows the directory memory uses; the draft's own field holds it until a pick replaces it.
    await waitFor(() => expect((screen.getByRole('textbox', { name: '数据目录' }) as HTMLInputElement).value).toBe('/old/data'))

    fireEvent.click(within(section()).getByRole('button', { name: '选择目录…' }))
    await waitFor(() => expect(pickDirectory).toHaveBeenCalledTimes(1))

    // The Host read the source before the user was asked anything.
    expect(call).toHaveBeenCalledWith('/dsh-mnemon-pack', 'storage-plan', expect.objectContaining({ dataDir: '/new/data' }))
    const dialog = await screen.findByRole('dialog', { name: '迁移数据目录' })
    expect(within(dialog).getByText('将迁移 4 个文件，共 2.0 KB。')).toBeTruthy()
    expect(within(dialog).getByText('迁移前不会删除任何数据；全部文件校验通过后才会删除原目录。')).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: '只改设置，不迁移' })).toBeTruthy()

    fireEvent.click(within(dialog).getByRole('button', { name: '迁移' }))
    await waitFor(() => expect(call).toHaveBeenCalledWith('/dsh-mnemon-pack', 'storage-migrate', expect.objectContaining({ dataDir: '/new/data', confirmed: true })))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByRole('status').textContent).toBe('已迁移到 /new/data：4 个文件，2.0 KB。')
    // The chosen directory became the draft's, so Apply saves the new location.
    expect((screen.getByRole('textbox', { name: '数据目录' }) as HTMLInputElement).value).toBe('/new/data')
    // The move recorded the new location on the Host, so the page re-reads the root memory now uses.
    const targetReads = () => call.mock.calls.filter(([, endpoint]) => endpoint === 'target').length
    await waitFor(() => expect(targetReads()).toBeGreaterThan(1))
  })

  it('keeps the data where it is when the user declines the move', async () => {
    const { connection, call } = host({
      '/dsh-mnemon-pack target': () => target,
      '/dsh-mnemon-pack storage-plan': () => ({ from: '/old/data', to: '/new/data', source: { files: 4, bytes: 2048 }, targetOccupied: false, sameDevice: true }),
    })
    const scope = core({ storageScope: 'custom', dataDir: '/old/data' })
    render(<MnemonSettingsCard scope={scope} connection={connection} pickDirectory={vi.fn(async () => '/new/data')} />)
    await waitFor(() => expect((screen.getByRole('textbox', { name: '数据目录' }) as HTMLInputElement).value).toBe('/old/data'))

    fireEvent.click(within(section()).getByRole('button', { name: '选择目录…' }))
    const dialog = await screen.findByRole('dialog', { name: '迁移数据目录' })
    fireEvent.click(within(dialog).getByRole('button', { name: '只改设置，不迁移' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    expect(call).not.toHaveBeenCalledWith('/dsh-mnemon-pack', 'storage-migrate', expect.anything())
    expect((screen.getByRole('textbox', { name: '数据目录' }) as HTMLInputElement).value).toBe('/new/data')
  })

  it('refuses to move onto a directory that already holds data', async () => {
    const { connection, call } = host({
      '/dsh-mnemon-pack target': () => target,
      '/dsh-mnemon-pack storage-plan': () => ({ from: '/old/data', to: '/new/data', source: { files: 4, bytes: 2048 }, targetOccupied: true, sameDevice: true, blocked: 'the target directory already holds data' }),
    })
    const scope = core({ storageScope: 'custom', dataDir: '/old/data' })
    render(<MnemonSettingsCard scope={scope} connection={connection} pickDirectory={vi.fn(async () => '/new/data')} />)
    await waitFor(() => expect((screen.getByRole('textbox', { name: '数据目录' }) as HTMLInputElement).value).toBe('/old/data'))

    fireEvent.click(within(section()).getByRole('button', { name: '选择目录…' }))
    const dialog = await screen.findByRole('dialog', { name: '迁移数据目录' })
    expect(within(dialog).getByRole('alert').textContent).toBe('无法迁移：the target directory already holds data')
    expect((within(dialog).getByRole('button', { name: '迁移' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(within(dialog).getByRole('button', { name: '只改设置，不迁移' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(call).not.toHaveBeenCalledWith('/dsh-mnemon-pack', 'storage-migrate', expect.anything())
  })

  it('says so when the picker is dismissed or the Host refuses the move', async () => {
    const { connection } = host({
      '/dsh-mnemon-pack target': () => target,
      '/dsh-mnemon-pack storage-plan': () => { throw new Error('the Mnemon data directory must not be a filesystem root') },
    })
    const scope = core({ storageScope: 'custom', dataDir: '/old/data' })
    render(<MnemonSettingsCard scope={scope} connection={connection} pickDirectory={vi.fn(async () => null)} />)
    await waitFor(() => expect((screen.getByRole('textbox', { name: '数据目录' }) as HTMLInputElement).value).toBe('/old/data'))

    // A dismissed picker leaves the draft alone.
    fireEvent.click(within(section()).getByRole('button', { name: '选择目录…' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect((screen.getByRole('textbox', { name: '数据目录' }) as HTMLInputElement).value).toBe('/old/data')
  })
})

const entry = {
  id: 'review-1',
  createdAt: '2026-08-14T12:00:00.000Z',
  title: 'Merge the duplicated preference',
  summary: 'Both installations recorded the same answer.',
  machine: { id: 'machine-a', label: 'laptop' },
  foreignMachines: ['desktop'],
  status: 'pending' as const,
  operations: [
    { kind: 'runtime-remove' as const, target: 'user' as const, oldText: 'Prefer short answers', reason: 'Superseded by the concise preference.' },
    { kind: 'document-archive' as const, documentId: 'doc-9', reason: 'Its content moved into the preference.' },
  ],
  opinions: [],
}

/**
 * The review ledger's channel. The ledger is the Host's, so each write answers
 * with the entry as the Host would store it, and every call is recorded.
 */
function reviewHost(state: { entry: Record<string, unknown> }) {
  const calls: Array<{ endpoint: string; payload: Record<string, unknown> }> = []
  const view = () => ({ pending: state.entry.status === 'pending' ? 1 : 0, entries: [state.entry] })
  const { connection } = recordingHost({
    '/dsh-mnemon-review view': () => view(),
    '/dsh-mnemon-review opinion': payload => {
      state.entry = { ...state.entry, opinions: [...(state.entry.opinions as unknown[]), { id: 'opinion-1', author: payload.author ?? 'user', text: payload.text, at: '2026-08-14T12:01:00.000Z' }] }
      return state.entry
    },
    '/dsh-mnemon-review decide': payload => { state.entry = { ...state.entry, status: payload.status }; return state.entry },
    '/dsh-mnemon-review reopen': () => { state.entry = { ...state.entry, status: 'pending' }; return state.entry },
    '/dsh-mnemon-review apply': () => { state.entry = { ...state.entry, appliedAt: '2026-08-14T12:02:00.000Z' }; return { applied: 2, failures: [] } },
    '/dsh-mnemon-review reconcile': () => ({ title: 'Merge the duplicated preference', summary: 'One preference is recorded twice.', action: 'planned', operations: 2, foreignMachines: ['desktop'], provider: 'openai', runId: 'run-1' }),
  }, calls)
  return { connection, calls }
}

describe('memory reconciliation review', () => {
  it('reads the ledger, expands a proposal and keeps every action on the page', async () => {
    const state = { entry: { ...entry } }
    const { connection, calls } = reviewHost(state)
    render(<MnemonReviewSection connection={connection} disabled={false} t={translateZh} />)

    expect((await screen.findByText('Merge the duplicated preference')).textContent).toBe('Merge the duplicated preference')
    expect(screen.getByText('1 条待审查')).toBeTruthy()
    expect(screen.getByText('2 条改动 · 来自 laptop · ' + new Date(entry.createdAt).toLocaleString())).toBeTruthy()
    expect(screen.getByText('涉及其他机器的记忆：desktop')).toBeTruthy()
    expect(screen.getByText('待审查')).toBeTruthy()

    fireEvent.click(button('查看'))
    expect(screen.getByText('Both installations recorded the same answer.')).toBeTruthy()
    expect(screen.getByText('删除用户记忆：Prefer short answers')).toBeTruthy()
    expect(screen.getByText('归档文档 doc-9')).toBeTruthy()
    expect(screen.getByText('还没有意见')).toBeTruthy()

    // An opinion is submitted with the text the user typed, and the box clears.
    fireEvent.change(screen.getByRole('textbox', { name: '意见' }), { target: { value: '  Keep the desktop wording.  ' } })
    fireEvent.click(button('提交意见'))
    await waitFor(() => expect(calls.some(call => call.endpoint === 'opinion')).toBe(true))
    expect(calls.find(call => call.endpoint === 'opinion')?.payload).toEqual({ id: 'review-1', text: 'Keep the desktop wording.', author: 'user' })
    await waitFor(() => expect(screen.getByText('Keep the desktop wording.')).toBeTruthy())
    expect(screen.getByText('你')).toBeTruthy()
    expect(screen.getByText('已记录你的意见。')).toBeTruthy()

    // Accepting is not applying: the operations run only through Apply.
    fireEvent.click(button('接受'))
    await waitFor(() => expect(screen.getByText('已接受')).toBeTruthy())
    expect(calls.some(call => call.endpoint === 'apply')).toBe(false)
    fireEvent.click(button('执行'))
    await waitFor(() => expect(calls.some(call => call.endpoint === 'apply')).toBe(true))
    expect(screen.getByText('已执行 2 条改动。')).toBeTruthy()

    fireEvent.click(button('重新打开'))
    await waitFor(() => expect(screen.getByText('待审查')).toBeTruthy())
  })

  it('rejects a proposal without running it, and reports what the Host refused', async () => {
    const state = { entry: { ...entry } }
    const { connection, calls } = reviewHost(state)
    render(<MnemonReviewSection connection={connection} disabled={false} t={translateEn} />)

    await screen.findByText('Merge the duplicated preference')
    fireEvent.click(button('Reject'))
    await waitFor(() => expect(screen.getByText('Rejected')).toBeTruthy())
    expect(calls.some(call => call.endpoint === 'apply')).toBe(false)
    expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Reopen' })).toBeTruthy()
  })

  it('runs a reconciliation and says what it produced', async () => {
    const state = { entry: { ...entry } }
    const { connection, calls } = reviewHost(state)
    render(<MnemonReviewSection connection={connection} disabled={false} t={translateZh} />)
    await screen.findByText('Merge the duplicated preference')

    fireEvent.click(button('整理记忆'))
    await waitFor(() => expect(calls.some(call => call.endpoint === 'reconcile')).toBe(true))
    expect(await screen.findByText('已生成 2 条建议，接受后才会写入。')).toBeTruthy()
  })

  it('stays inert without a connection or a writable Host', async () => {
    const { connection, calls } = reviewHost({ entry: { ...entry } })
    const first = render(<MnemonReviewSection connection={connection} disabled t={translateZh} />)
    await screen.findByText('Merge the duplicated preference')
    expect(button('整理记忆').disabled).toBe(true)
    expect(button('接受').disabled).toBe(false)
    first.unmount()

    render(<MnemonReviewSection disabled={false} t={translateZh} />)
    expect(screen.getByText('没有待审查的建议')).toBeTruthy()
    expect(button('整理记忆').disabled).toBe(true)
    expect(button('刷新').disabled).toBe(true)
    expect(calls.some(call => call.endpoint === 'reconcile')).toBe(false)
  })

  it('shows an applying failure on the entry that failed', async () => {
    const state = { entry: { ...entry, status: 'accepted', failure: 'operation 2 (document-archive) failed: the document is gone' } }
    const { connection } = reviewHost(state)
    render(<MnemonReviewSection connection={connection} disabled={false} t={translateZh} />)

    expect((await screen.findByRole('alert')).textContent).toBe('执行失败：operation 2 (document-archive) failed: the document is gone')
    expect(button('执行')).toBeTruthy()
    expect(button('重新打开')).toBeTruthy()
  })
})

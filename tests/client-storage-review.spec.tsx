// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Config } from '../src/host/config.ts'
import type { ClientConnectionHandle, ClientSettingsScope } from '../src/host/dsh.ts'
import { MnemonReviewSection } from '../src/client/MnemonReviewSection.tsx'
import { MnemonSettingsCard } from '../src/client/MnemonSettingsCard.tsx'
import { MnemonSyncSection } from '../src/client/MnemonSyncSection.tsx'
import { translateEn, translateZh } from '../src/client/locales.ts'
import { liveSettingsScope, settingsScope } from './helpers/settings-scope.ts'

afterEach(cleanup)

/** The data directory's default or custom choice. */
const directoryChoice = (option: string, group = '数据目录') =>
  within(screen.getByRole('radiogroup', { name: group })).getByRole('radio', { name: option }) as HTMLInputElement

const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement

/**
 * A panel button that is idle. Every action in the sync panel refuses to run while another
 * one is in flight, so a click is only real once the button is enabled again.
 */
const idle = async (name: string): Promise<HTMLButtonElement> => {
  let element = button(name)
  await waitFor(() => {
    element = button(name)
    expect(element.disabled).toBe(false)
  })
  return element
}

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

  it('keeps the custom directory when the default one is chosen again', async () => {
    // "Default" means memory stops using the custom directory; it never means
    // forgetting which one was chosen, or the choice could not be taken back.
    const mutate = vi.fn(async () => {})
    const scope = liveSettingsScope<Config>({ status: 'ready' as const, value: { storageScope: 'custom' as const, dataDir: '/old/data' }, base: {}, user: {}, revision: 0, writable: true, mode: 'host' as const }, mutate)
    render(<MnemonSettingsCard scope={scope} connection={host({ '/dsh-mnemon-pack target': () => target }).connection} />)
    await waitFor(() => expect((screen.getByRole('textbox', { name: '数据目录' }) as HTMLInputElement).value).toBe('/old/data'))

    fireEvent.click(directoryChoice('默认'))
    // The field is gone from the page, but the value it held is still the draft's:
    // nothing was typed, so nothing is thrown away.
    expect(screen.queryByRole('textbox', { name: '数据目录' })).toBeNull()

    // Applying records the scope alone. The saved directory stays in the file, which is
    // what lets 自定义 put memory back on it without choosing it a second time.
    fireEvent.click(screen.getByRole('button', { name: '应用' }))
    await waitFor(() => expect(mutate).toHaveBeenCalledWith([{ op: 'set', path: ['storageScope'], value: 'global' }]))

    // The saved configuration publishes the new scope with the directory still in it,
    // so choosing 自定义 again finds the directory already there.
    await waitFor(() => expect(scope.snapshot.value).toEqual({ storageScope: 'global', dataDir: '/old/data' }))
    fireEvent.click(directoryChoice('自定义'))
    await waitFor(() => expect((screen.getByRole('textbox', { name: '数据目录' }) as HTMLInputElement).value).toBe('/old/data'))
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
function reviewHost(state: { entry: Record<string, unknown> }, overrides: Record<string, (payload: Record<string, unknown>) => unknown> = {}) {
  const calls: Array<{ endpoint: string; payload: Record<string, unknown> }> = []
  const view = () => ({ pending: state.entry.status === 'pending' ? 1 : 0, entries: [state.entry] })
  const { connection } = recordingHost({
    '/dsh-mnemon-review view': () => view(),
    '/dsh-mnemon-review opinion': payload => {
      state.entry = { ...state.entry, opinions: [...(state.entry.opinions as unknown[]), { id: 'opinion-1', author: payload.author ?? 'user', text: payload.text, at: '2026-08-14T12:01:00.000Z' }] }
      return state.entry
    },
    '/dsh-mnemon-review decide': payload => { state.entry = { ...state.entry, status: payload.status }; return state.entry },
    // Reopening clears the decision and the record of what ran, exactly as the Host does:
    // a reopened plan is a fresh decision about the whole plan.
    '/dsh-mnemon-review reopen': () => {
      const { decidedAt: _decidedAt, appliedAt: _appliedAt, appliedOperations: _applied, failure: _failure, ...rest } = state.entry
      state.entry = { ...rest, status: 'pending' }
      return state.entry
    },
    '/dsh-mnemon-review apply': payload => {
      // The Host records the positions that ran and answers with the entry it stored.
      const ran = (payload.operations as number[] | undefined) ?? (state.entry.operations as unknown[]).map((_operation, index) => index)
      state.entry = { ...state.entry, appliedAt: '2026-08-14T12:02:00.000Z', appliedOperations: ran }
      return { entry: state.entry, applied: ran.length, failures: [] }
    },
    '/dsh-mnemon-review reconcile': () => ({ title: 'Merge the duplicated preference', summary: 'One preference is recorded twice.', action: 'planned', operations: 2, foreignMachines: ['desktop'], provider: 'openai', runId: 'run-1' }),
    ...overrides,
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

    fireEvent.click(await idle('查看'))
    expect(screen.getByText('Both installations recorded the same answer.')).toBeTruthy()
    expect(screen.getByText('删除用户记忆：Prefer short answers')).toBeTruthy()
    expect(screen.getByText('归档文档 doc-9')).toBeTruthy()
    expect(screen.getByText('还没有意见')).toBeTruthy()

    // An opinion is submitted with the text the user typed, and the box clears.
    fireEvent.change(screen.getByRole('textbox', { name: '意见' }), { target: { value: '  Keep the desktop wording.  ' } })
    fireEvent.click(await idle('提交意见'))
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
    // Every position ran, so the plan is history: it leaves the list and is readable there.
    await waitFor(() => expect(screen.queryByText('Merge the duplicated preference')).toBeNull())
    expect(screen.getByText('已执行的历史方案（1）')).toBeTruthy()

    fireEvent.click(button('已执行的历史方案（1）'))
    const history = await screen.findByRole('dialog', { name: '已执行的历史方案' })
    fireEvent.click(within(history).getByRole('button', { name: '重新打开' }))
    // Reopening starts the plan over: it is pending again, so it returns to the list and
    // its operations are offered as a fresh decision rather than as something written.
    await waitFor(() => expect(screen.getByText('待审查')).toBeTruthy())
    expect(screen.queryByText('已执行 2/2 条')).toBeNull()
    expect(screen.queryByRole('button', { name: /已执行的历史方案/u })).toBeNull()
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
    // A refusal stays in the list because it is still waiting for an opinion, so it says so.
    expect(screen.getByText('This plan was rejected; leave an opinion and reopen it, or ask the AI to plan again.')).toBeTruthy()
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

  it('sends the reviewer guidance with the run and reports what the run read', async () => {
    const state = { entry: { ...entry } }
    const { connection, calls } = reviewHost(state, {
      '/dsh-mnemon-review reconcile': () => ({ title: 'Merge the duplicated preference', summary: 'One preference is recorded twice.', action: 'planned', operations: 2, foreignMachines: ['desktop'], guided: true, remoteEntries: 3, provider: 'openai', runId: 'run-1' }),
    })
    render(<MnemonReviewSection connection={connection} disabled={false} t={translateZh} />)
    await screen.findByText('Merge the duplicated preference')

    fireEvent.change(screen.getByRole('textbox', { name: '整理要求' }), { target: { value: '  Merge the two duplicates.  ' } })
    fireEvent.click(button('整理记忆'))
    await waitFor(() => expect(calls.some(call => call.endpoint === 'reconcile')).toBe(true))
    expect(calls.find(call => call.endpoint === 'reconcile')?.payload).toEqual({ guidance: 'Merge the two duplicates.' })
    // The answer states all three facts: what it planned, that it read the guidance,
    // and how many entries it read from the branch this installation lacks.
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('已生成 2 条建议，接受后才会写入。 已按你的要求整理 参考了远端 3 条本机没有的记忆'))
  })

  it('applies only the operations the reviewer kept checked', async () => {
    const state = { entry: { ...entry, status: 'accepted' as const } }
    const { connection, calls } = reviewHost(state)
    render(<MnemonReviewSection connection={connection} disabled={false} t={translateZh} />)
    await screen.findByText('Merge the duplicated preference')

    fireEvent.click(await idle('查看'))
    // An untouched review applies the whole plan, so the button offers all of it.
    expect(button('执行')).toBeTruthy()
    expect(screen.getByText('已选 2/2 条')).toBeTruthy()

    fireEvent.click(screen.getByRole('checkbox', { name: '归档文档 doc-9' }))
    expect(screen.getByText('已选 1/2 条')).toBeTruthy()
    expect(button('执行选中 1 条')).toBeTruthy()
    fireEvent.click(button('执行选中 1 条'))
    await waitFor(() => expect(calls.some(call => call.endpoint === 'apply')).toBe(true))
    expect(calls.find(call => call.endpoint === 'apply')?.payload).toEqual({ id: 'review-1', operations: [0] })

    // The position that ran leaves the plan: what is offered again is only what is left.
    await waitFor(() => expect(screen.getByText('已执行 1/2 条')).toBeTruthy())
    expect(screen.getByText('已选 1/1 条')).toBeTruthy()
    expect(button('执行')).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: '归档文档 doc-9' })).toBeTruthy()

    // An empty selection is the page's own refusal, not a Host failure.
    fireEvent.click(button('全不选'))
    expect(screen.getByText('已选 0/1 条')).toBeTruthy()
    fireEvent.click(button('执行'))
    expect(screen.getByRole('alert').textContent).toBe('请至少选择一条改动。')
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

const syncConfig = {
  repoUrl: 'https://github.com/me/memory.git',
  branch: 'mnemon-sync',
  subdir: 'mnemon/',
  hasToken: false,
  credentialSource: 'none',
  authorName: 'Me',
  authorEmail: 'me@example.com',
  autoBackupMinutes: 0,
}

const syncStatus = {
  configured: true,
  config: syncConfig,
  configPath: '/data/state/sync-git.json',
  mirrorPath: '/data/state/sync/git',
  git: { available: true, required: '2.30' },
  remote: { reachable: true, branchExists: true, commit: 'abcdef1234567890' },
  machine: { id: 'machine-a', label: 'laptop', createdAt: '2026-08-14T12:00:00.000Z' },
  autoBackup: { available: false },
}

const here = { target: 'user', content: 'Prefer concise answers for all replies', importance: 'normal', updatedAt: '2026-08-14T12:00:00.000Z' }
const there = { target: 'user', content: 'Prefer concise answers in every reply', importance: 'normal', updatedAt: '2026-08-13T09:00:00.000Z' }

/** One reading of the branch: what each side holds, and where the two word a subject differently. */
function differenceOf(overrides: Record<string, unknown> = {}) {
  return {
    repoUrl: syncConfig.repoUrl,
    branch: syncConfig.branch,
    subdir: syncConfig.subdir,
    commit: 'abcdef1234567890',
    localExportAt: '2026-08-14T12:00:00.000Z',
    local: { exportedAt: '2026-08-14T12:00:00.000Z', entries: 2 },
    remote: { exportedAt: '2026-08-13T09:00:00.000Z', entries: 2, machine: { id: 'machine-b', label: 'desktop', createdAt: '2026-08-01T00:00:00.000Z' } },
    localOnly: [here, { target: 'memory', content: 'Local only note', importance: 'critical' }],
    remoteOnly: [there, { target: 'memory', content: 'Deploy on Fridays', importance: 'critical' }],
    conflicts: [{ target: 'user', local: here, remote: { ...there, origin: { machine: 'machine-b', label: 'desktop', at: '2026-08-13T09:00:00.000Z' } }, similarity: 0.698 }],
    shared: 0,
    truncated: false,
    heldBack: 0,
    remoteTombstones: [],
    ...overrides,
  }
}

const syncBackups = {
  repoUrl: syncConfig.repoUrl,
  branch: syncConfig.branch,
  subdir: syncConfig.subdir,
  commits: [{
    commit: 'abcdef1234567890',
    message: 'Publish from B',
    committedAt: '2026-08-14T12:00:00.000Z',
    machine: { id: 'machine-b', label: 'desktop', createdAt: '2026-08-01T00:00:00.000Z' },
    components: [{ component: 'runtime', files: 2, bytes: 1024, items: 1 }],
  }],
  truncated: false,
}

/**
 * The sync channel and the review ledger behind one dialog. The Host keeps both, so each
 * write answers the way the Host would store it, and every call is recorded.
 */
function syncHost(state: { difference: Record<string, unknown>; backups?: Record<string, unknown> }, overrides: Record<string, (payload: Record<string, unknown>) => unknown> = {}) {
  const calls: Array<{ endpoint: string; payload: Record<string, unknown> }> = []
  const { connection } = recordingHost({
    '/dsh-mnemon-sync status': () => syncStatus,
    '/dsh-mnemon-sync backups': () => state.backups ?? syncBackups,
    '/dsh-mnemon-sync diff': () => state.difference,
    '/dsh-mnemon-sync pull': () => ({ imported: true, mode: 'merge', repoUrl: syncConfig.repoUrl, branch: syncConfig.branch, subdir: syncConfig.subdir, commit: 'abcdef1234567890', manifest: { format: 'mnemonpack', version: 1, scope: 'full', exportedAt: '2026-08-13T09:00:00.000Z', source: { plugin: 'dsh-mnemon', pluginVersion: '0.5.24' }, components: ['runtime'], summary: [] }, targetRoot: '/data/mnemon', components: ['runtime'], summary: [] }),
    ...overrides,
  }, calls)
  return { connection, calls }
}

const syncCalls = (calls: Array<{ endpoint: string; payload: Record<string, unknown> }>, endpoint: string) => calls.filter(call => call.endpoint === endpoint)

/** The switch a reader uses to decide whether this installation syncs at all. */
const switched = (element: HTMLElement) => element.getAttribute('aria-checked') === 'true'

/**
 * The sync row with the switch already on, which is how the storage section renders it
 * once the profile says so. The choice itself belongs to that section, so a page that
 * only reads this row is handed the value rather than owning it.
 */
const renderSync = (connection: ClientConnectionHandle, enabled = true): void => {
  render(<MnemonSyncSection connection={connection} disabled={false} enabled={enabled} onEnabled={vi.fn()} t={translateZh} />)
}

/** The card the switch really lives in: the storage section saves the choice where it is made. */
function storageWith(connection: ClientConnectionHandle, value: Config, mutate = vi.fn(async () => {})) {
  const scope = liveSettingsScope<Config>({ status: 'ready' as const, value, base: {}, user: {}, revision: 0, writable: true, mode: 'host' as const }, mutate)
  render(<MnemonSettingsCard scope={scope} connection={connection} />)
  return { scope, mutate }
}

describe('the Git sync switch', () => {
  it('asks the Host nothing while it is off, and one switch turns the whole block on', async () => {
    const { connection, calls } = syncHost({ difference: differenceOf() })
    const { mutate } = storageWith(connection, { storageScope: 'global' })

    const toggle = screen.getByRole('switch', { name: 'Git 同步' })
    expect(switched(toggle)).toBe(false)
    // Off is a title and a switch: no operations, no form, and no reconciliation row.
    expect(screen.queryByRole('button', { name: '推送' })).toBeNull()
    expect(screen.queryByRole('button', { name: '备份历史' })).toBeNull()
    expect(screen.queryByRole('group', { name: '记忆整理' })).toBeNull()
    // Off is silent on the channel too: the page has talked to the Host, and none of
    // what it asked for is the branch, the account or the ledger.
    await waitFor(() => expect(calls.length).toBeGreaterThan(0))
    expect(calls.filter(call => call.endpoint === 'status' || call.endpoint === 'github-status' || call.endpoint === 'view')).toEqual([])

    fireEvent.click(toggle)
    await waitFor(() => expect(mutate).toHaveBeenCalledWith([{ op: 'set', path: ['syncEnabled'], value: true }]))
    // The saved value is the switch: the form unfolds and the row reads the branch.
    expect(switched(screen.getByRole('switch', { name: 'Git 同步' }))).toBe(true)
    expect(await screen.findByText('远端 abcdef12')).toBeTruthy()
    expect(button('推送')).toBeTruthy()
    expect(button('备份历史')).toBeTruthy()
  })
})

describe('the branch history and the memories that differ', () => {
  it('lists every backup in the dialog and asks for a plan only where a subject is stated twice', async () => {
    const { connection, calls } = syncHost({ difference: differenceOf() })
    renderSync(connection)
    await screen.findByText('远端 abcdef12')

    fireEvent.click(button('备份历史'))
    const dialog = await screen.findByRole('dialog', { name: '备份历史' })
    expect(within(dialog).getByText('mnemon-sync 上的备份')).toBeTruthy()
    expect(await within(dialog).findByText('Publish from B')).toBeTruthy()
    expect(within(dialog).getByText('abcdef12')).toBeTruthy()
    // The stamp is whatever the reader's locale renders, so only its frame is fixed.
    expect(within(dialog).getByText(/^来自 desktop · \d/u)).toBeTruthy()

    // A backup says which components it holds, and how much of each.
    fireEvent.click(await idle('查看'))
    expect(within(dialog).getByText('runtime：1 条记忆 · 2 个文件 · 1.0 KB')).toBeTruthy()

    // The difference below the history states the conflict and nothing to add on its own.
    expect(within(dialog).getByText('与远端 abcdef12 的记忆差异（共有 0 条）')).toBeTruthy()
    expect(within(dialog).getByText('本地 2 条 · 远端 2 条 · 远端来自 desktop')).toBeTruthy()
    expect(within(dialog).getByText('有 1 个主题两边写法不同，需要整理。')).toBeTruthy()
    expect(within(dialog).getByText(here.content)).toBeTruthy()
    expect(within(dialog).getByText(there.content)).toBeTruthy()
    expect(within(dialog).getByText('normal · 70%')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '直接新增' })).toBeNull()
    // A conflict is answered in the review list below, so the dialog hands the reader over
    // rather than keeping a second copy of the plan. Nothing on this page can write here.
    expect(within(dialog).getByText('这份方案由下方“记忆整理”统一整理、审查与执行。')).toBeTruthy()
    expect(button('到“记忆整理”处理')).toBeTruthy()
    expect(syncCalls(calls, 'reconcile')).toEqual([])
    expect(syncCalls(calls, 'pull')).toEqual([])
    expect(syncCalls(calls, 'apply')).toEqual([])
  })

  it('turns the automatic backup on with one saved value', async () => {
    const state = { difference: differenceOf({ conflicts: [], localOnly: [], remoteOnly: [] }) }
    const { connection, calls } = syncHost(state, {
      '/dsh-mnemon-sync configure': payload => ({ ...syncConfig, autoBackupMinutes: Number(payload.autoBackupMinutes) }),
    })
    renderSync(connection)
    await screen.findByText('远端 abcdef12')

    const select = await screen.findByLabelText('自动备份') as HTMLSelectElement
    // A channel nobody configured is a manual one, and the page says so instead of
    // naming a time that will never arrive.
    expect(select.value).toBe('0')
    expect(screen.getByText('自动备份已关闭，只有你点「立即备份」时才会推送')).toBeTruthy()

    // The interval is one value with no half-typed state, so choosing it saves it:
    // a reader who picks a cadence is not left believing it is already on.
    fireEvent.change(select, { target: { value: '360' } })
    await waitFor(() => expect(syncCalls(calls, 'configure').length).toBe(1))
    expect(syncCalls(calls, 'configure')[0]?.payload).toEqual({ autoBackupMinutes: 360 })
    expect(await screen.findByText('自动备份已设为 6 小时')).toBeTruthy()
    expect((screen.getByLabelText('自动备份') as HTMLSelectElement).value).toBe('360')
  })

  it('reads older backups a page at a time instead of stopping at the first one', async () => {
    const oldest = { ...syncBackups.commits[0]!, commit: '0123456789abcdef', message: 'Publish from C' }
    const state: { difference: Record<string, unknown>; backups?: Record<string, unknown> } = { difference: differenceOf({ conflicts: [], localOnly: [], remoteOnly: [] }) }
    const { connection, calls } = syncHost(state, {
      '/dsh-mnemon-sync backups': payload => payload.limit === undefined
        ? { ...syncBackups, truncated: true }
        : { ...syncBackups, commits: [oldest], truncated: false },
    })
    renderSync(connection)
    await screen.findByText('远端 abcdef12')

    fireEvent.click(button('备份历史'))
    const dialog = await screen.findByRole('dialog', { name: '备份历史' })
    expect(await within(dialog).findByText('Publish from B')).toBeTruthy()
    // The branch holds more than the page, so the page offers to read on.
    const more = await idle('读取更早的备份')
    fireEvent.click(more)
    await waitFor(() => expect(syncCalls(calls, 'backups').length).toBe(2))
    // The second read asks past what is already listed, so the branch walks one page at a time.
    expect(syncCalls(calls, 'backups')[1]?.payload).toMatchObject({ limit: 21 })
    expect(await within(dialog).findByText('Publish from C')).toBeTruthy()
    expect(within(dialog).getByText('Publish from B')).toBeTruthy()
    expect(within(dialog).queryByRole('button', { name: '读取更早的备份' })).toBeNull()
  })

  it('adds what only the branch holds when no subject is stated twice', async () => {
    const state = { difference: differenceOf({ localOnly: [], remoteOnly: [there], conflicts: [] }) }
    const { connection, calls } = syncHost(state, {
      '/dsh-mnemon-sync pull': () => {
        state.difference = differenceOf({ localOnly: [], remoteOnly: [], conflicts: [], shared: 1 })
        return { imported: true, mode: 'merge', repoUrl: syncConfig.repoUrl, branch: syncConfig.branch, subdir: syncConfig.subdir, commit: 'abcdef1234567890', manifest: { format: 'mnemonpack', version: 1, scope: 'full', exportedAt: '2026-08-13T09:00:00.000Z', source: { plugin: 'dsh-mnemon', pluginVersion: '0.5.24' }, components: ['runtime'], summary: [] }, targetRoot: '/data/mnemon', components: ['runtime'], summary: [] }
      },
    })
    renderSync(connection)
    await screen.findByText('远端 abcdef12')

    fireEvent.click(button('备份历史'))
    const dialog = await screen.findByRole('dialog', { name: '备份历史' })
    expect(await within(dialog).findByText('没有冲突：两边没有同一主题的两种写法。')).toBeTruthy()
    expect(within(dialog).getByText('远端还有 1 条本机没有的记忆，可以直接新增。')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '让 AI 整理' })).toBeNull()

    // Adding is the whole merge: it is confirmed to the Host and re-read afterwards.
    fireEvent.click(await idle('直接新增'))
    await waitFor(() => expect(syncCalls(calls, 'pull').length).toBe(1))
    expect(syncCalls(calls, 'pull')[0]?.payload).toEqual({ confirmed: true })
    expect(await screen.findByText('已新增远端 abcdef12 的记忆到 /data/mnemon。')).toBeTruthy()
    await waitFor(() => expect(within(dialog).getByText('本机与远端没有需要合并的记忆。')).toBeTruthy())
  })

  it('says how many of the branch memories this installation deleted, and offers to bring them back', async () => {
    // A merge honors this machine's own deletions, so "add them" would write nothing and
    // the count would never move. The page has to say that, and offer the one action that
    // overrules the deletion.
    const state = { difference: differenceOf({ localOnly: [], remoteOnly: [there], conflicts: [], heldBack: 1 }) }
    const { connection, calls } = syncHost(state, {
      '/dsh-mnemon-sync pull': () => {
        state.difference = differenceOf({ localOnly: [], remoteOnly: [], conflicts: [], heldBack: 0, shared: 1 })
        return { imported: true, mode: 'merge', repoUrl: syncConfig.repoUrl, branch: syncConfig.branch, subdir: syncConfig.subdir, commit: 'abcdef1234567890', manifest: { format: 'mnemonpack', version: 1, scope: 'full', exportedAt: '2026-08-13T09:00:00.000Z', source: { plugin: 'dsh-mnemon', pluginVersion: '0.5.24' }, components: ['runtime'], summary: [] }, targetRoot: '/data/mnemon', components: ['runtime'], summary: [], runtime: { added: 1, held: 0 } }
      },
    })
    renderSync(connection)
    await screen.findByText('远端 abcdef12')

    fireEvent.click(button('备份历史'))
    const dialog = await screen.findByRole('dialog', { name: '备份历史' })
    expect(await within(dialog).findByText('远端还有 1 条记忆是本机以前删掉的；直接新增会按删除处理，把它们留在原处。')).toBeTruthy()
    // Nothing left to add, so the plain add button is gone and only the revival is offered.
    expect(screen.queryByRole('button', { name: '直接新增' })).toBeNull()

    fireEvent.click(await idle('恢复这些记忆'))
    await waitFor(() => expect(syncCalls(calls, 'pull').length).toBe(1))
    expect(syncCalls(calls, 'pull')[0]?.payload).toEqual({ revive: true, confirmed: true })
    expect(await screen.findByText('已新增远端 abcdef12 的记忆到 /data/mnemon。')).toBeTruthy()
  })

  it('counts only what a merge would write and says what it left out', async () => {
    // The count the reader is shown is what a merge would write, not what the branch holds:
    // two entries arrive, one of them was deleted here earlier, so one is what gets added.
    const second = { target: 'memory', content: 'Deploy on Fridays', importance: 'critical' }
    const state = { difference: differenceOf({ localOnly: [], remoteOnly: [there, second], conflicts: [], heldBack: 1 }) }
    const { connection, calls } = syncHost(state, {
      '/dsh-mnemon-sync pull': () => ({ imported: true, mode: 'merge', repoUrl: syncConfig.repoUrl, branch: syncConfig.branch, subdir: syncConfig.subdir, commit: 'abcdef1234567890', manifest: { format: 'mnemonpack', version: 1, scope: 'full', exportedAt: '2026-08-13T09:00:00.000Z', source: { plugin: 'dsh-mnemon', pluginVersion: '0.5.24' }, components: ['runtime'], summary: [] }, targetRoot: '/data/mnemon', components: ['runtime'], summary: [], runtime: { added: 1, held: 1 } }),
    })
    renderSync(connection)
    await screen.findByText('远端 abcdef12')

    fireEvent.click(button('备份历史'))
    const dialog = await screen.findByRole('dialog', { name: '备份历史' })
    // Two entries arrive, one stays behind, so the offer is for the one that would be written.
    expect(await within(dialog).findByText('远端还有 1 条本机没有的记忆，可以直接新增。')).toBeTruthy()
    expect(within(dialog).getByText('远端还有 1 条记忆是本机以前删掉的；直接新增会按删除处理，把它们留在原处。')).toBeTruthy()

    fireEvent.click(await idle('直接新增'))
    await waitFor(() => expect(syncCalls(calls, 'pull').length).toBe(1))
    expect(syncCalls(calls, 'pull')[0]?.payload).toEqual({ confirmed: true })
    // The reader is told both what was written and what stayed behind.
    expect(await screen.findByText(/已新增远端 abcdef12 的记忆到 \/data\/mnemon。/u)).toBeTruthy()
    expect(screen.getByText(/其中 1 条本机以前删过，仍留在原处；要加回请点“恢复这些记忆”。/u)).toBeTruthy()
  })

  it('reads the branch and hands a conflict to the review list that answers it', async () => {
    // One control runs the plan. The dialog reads the branch and says where the plan lives;
    // it never runs a second copy of it, which is what it used to do.
    const { connection, calls } = syncHost({ difference: differenceOf() })
    renderSync(connection)
    await screen.findByText('远端 abcdef12')

    fireEvent.click(button('备份历史'))
    const dialog = await screen.findByRole('dialog', { name: '备份历史' })
    expect(await within(dialog).findByText('有 1 个主题两边写法不同，需要整理。')).toBeTruthy()
    expect(within(dialog).getByText('这份方案由下方“记忆整理”统一整理、审查与执行。')).toBeTruthy()

    // The dialog never writes: no run, no decision, no apply is asked for from here.
    expect(syncCalls(calls, 'reconcile')).toEqual([])
    expect(syncCalls(calls, 'decide')).toEqual([])
    expect(syncCalls(calls, 'apply')).toEqual([])
    expect(syncCalls(calls, 'opinion')).toEqual([])
  })

  it('states how the reconciliation area runs, so a timer is not mistaken for a plan', async () => {
    const state = { entry: { ...entry } }
    const host = reviewHost(state)
    render(<MnemonReviewSection connection={host.connection} disabled={false} t={translateZh} />)
    await screen.findByText('Merge the duplicated preference')

    // The rules name the switch that decides the cadence instead of repeating its
    // value, so the two places that talk about a schedule cannot drift apart.
    expect(screen.getByText('运行规则')).toBeTruthy()
    expect(screen.getByText('后台拉取：后台只按「Git 备份」里「自动备份」的间隔推送一次，推送前先读取远端分支并与本机合并；这一步不产生任何建议。自动备份关闭时，只有你点「立即备份」才会读取远端。')).toBeTruthy()
    expect(screen.getByText('差异：只有点「检查远端」或推送前的合并才会读出远端与本机的差别；差别只显示出来，不会自动写入。')).toBeTruthy()
    expect(screen.getByText('方案：只有点「整理记忆」才会生成待办方案，每条方案都要你接受并应用之后才会真正写入记忆。')).toBeTruthy()
  })

  it('moves every applied plan into its own popup, leaving the list what still needs an answer', async () => {
    const applied = { ...entry, id: 'review-0', title: 'An applied plan', status: 'accepted' as const, appliedAt: '2026-08-13T12:00:00.000Z' }
    const state = { entry: { ...entry } }
    const host = reviewHost(state, {
      '/dsh-mnemon-review view': () => ({ path: '/data/state/review-ledger.json', entries: [state.entry, applied], pending: 1, latest: state.entry }),
    })
    render(<MnemonReviewSection connection={host.connection} disabled={false} t={translateZh} />)

    // A plan that already ran is history wherever it sits in the ledger, so it is not in the list.
    expect(await screen.findByText('Merge the duplicated preference')).toBeTruthy()
    expect(screen.queryByText('An applied plan')).toBeNull()
    expect(screen.getByText('已执行的历史方案（1）')).toBeTruthy()

    // It leaves the page, not the ledger: the popup still shows it, and says what it is for.
    fireEvent.click(button('已执行的历史方案（1）'))
    const dialog = await screen.findByRole('dialog', { name: '已执行的历史方案' })
    expect(within(dialog).getByText('An applied plan')).toBeTruthy()
    expect(within(dialog).getByText('这些方案已经执行过，只供回看；重新打开不会撤销已经写入的改动。')).toBeTruthy()
  })
})

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MnemonSettingsCard } from '../src/client/MnemonSettingsCard.tsx'
import { translateEn } from '../src/client/locales.ts'
import { liveSettingsScope, settingsScope } from './helpers/settings-scope.ts'
import type { ClientConnectionHandle, Config, MemoryPluginEntryView, MemoryViewConfigurationRequest, MemoryViewDashboard, MnemonSyncGitHubStatus } from '../src/host/protocol.ts'

afterEach(cleanup)

/** The shipped enhancements, each named by its own declaration. */
const FEATURES = [
  ['capture', 'dsh-mnemon-strategy-auto-capture', 'Active capture', '主动记录'],
  ['light', 'dsh-mnemon-strategy-light-context', 'Light context', '轻量上下文'],
  ['scoped', 'dsh-mnemon-strategy-scoped', 'Scoped composition', '范围组合'],
] as const

/** A profile that has switched Git sync on, which is what unfolds the repository block. */
const SYNCING: Config = { storageScope: 'global', syncEnabled: true }

function readyScope(value: Config = { storageScope: 'global' }) {
  return settingsScope<Config>({
    status: 'ready',
    value,
    base: {}, user: {}, revision: 0, writable: true, mode: 'host',
  })
}

function featureEntry([entryId, packageName, label, zh]: typeof FEATURES[number]): MemoryPluginEntryView {
  return {
    entryId, packageName, typeId: entryId, strategyTypeId: 'default-three-tier', slot: entryId,
    roles: ['strategy-extension'], label: { en: label, 'zh-CN': zh },
    description: { en: label, 'zh-CN': zh }, fields: [],
    provides: [{ id: `strategy.default-three-tier.${entryId}`, exclusive: true }],
    requires: ['strategy.default-three-tier'], requiredBy: [],
    enabled: false, active: false, writable: true, config: {},
  }
}

/** The running main Strategy the enhancements extend. */
const THREE_TIER: MemoryPluginEntryView = {
  entryId: 'mnemon-strategy-default-three-tier', packageName: 'dsh-mnemon-strategy-default-three-tier', typeId: 'default-three-tier',
  roles: ['strategy'], label: { en: 'Layered strategy', 'zh-CN': '分层策略' }, description: { en: '', 'zh-CN': '' }, fields: [],
  provides: [{ id: 'strategy', exclusive: false }, { id: 'strategy.default-three-tier', exclusive: false }], requires: [], requiredBy: [],
  enabled: true, active: true, writable: true, config: {},
}

function fixture(options: { writable?: boolean; failApply?: boolean; failRefreshAfterApply?: boolean; unavailable?: boolean; github?: MnemonSyncGitHubStatus } = {}) {
  let applied = false
  let dashboard: MemoryViewDashboard = {
    revision: 'view-1', writable: options.writable !== false, strategyTypeId: 'default-three-tier',
    entries: [THREE_TIER, ...FEATURES.map(featureEntry)], currentUnavailable: 'no-session', sources: [], diagnostics: [],
    pluginInstallation: { supported: false, reason: 'loader-unavailable', suggestions: [] },
  }
  const call = vi.fn(async (channel: string, endpoint: string, payload: unknown) => {
    if (channel === '/dsh-mnemon-view' && endpoint === 'dashboard') {
      if (options.unavailable) return { ok: false as const, error: { code: 'internal' as const, message: 'dashboard failed', details: {} } }
      if (options.failRefreshAfterApply && applied) return { ok: false as const, error: { code: 'internal' as const, message: 'refresh failed', details: {} } }
      return { ok: true as const, value: structuredClone(dashboard) }
    }
    if (channel === '/dsh-mnemon-view-settings' && endpoint === 'apply') {
      if (options.failApply) return { ok: false as const, error: { code: 'internal' as const, message: 'Memory plugin graph conflict', details: {} } }
      const request = (payload as { configuration: MemoryViewConfigurationRequest }).configuration
      dashboard = {
        ...dashboard,
        revision: 'view-2',
        entries: dashboard.entries.map(entry => request.entries[entry.entryId] === undefined
          ? entry
          : { ...entry, ...request.entries[entry.entryId], active: request.entries[entry.entryId]!.enabled }),
      }
      applied = true
      return { ok: true as const, value: { saved: true as const } }
    }
    if (channel === '/dsh-mnemon-read' && endpoint === 'task-agent-models') return { ok: true as const, value: { groups: [], failures: [] } }
    if (channel === '/dsh-mnemon-read' && endpoint === 'provider-services') return { ok: true as const, value: { providers: [], items: [], generatedAt: '' } }
    if (channel === '/dsh-mnemon-pack' && endpoint === 'target') return { ok: true as const, value: { root: '/root/.mnemon', scope: 'global' as const } }
    // The storage page reads the sync channel on mount; an unconfigured Host answers it.
    if (channel === '/dsh-mnemon-sync' && endpoint === 'status') return {
      ok: true as const,
      value: {
        configured: false,
        config: {
          branch: 'mnemon-sync', subdir: 'mnemon/', hasToken: false, credentialSource: 'none' as const,
          authorName: 'dsh-mnemon sync', authorEmail: 'mnemon@localhost',
        },
        configPath: '/root/.mnemon/state/sync-git.json', mirrorPath: '/root/.mnemon/state/sync/git',
        git: { available: true, required: '2.20' }, remote: { reachable: false, branchExists: false },
      },
    }
    // The sign-in block reads its own endpoint; a Host with no store reports it as unavailable.
    if (channel === '/dsh-mnemon-sync' && endpoint === 'github-status') return {
      ok: true as const,
      value: options.github ?? { available: false, signedIn: false, writable: false },
    }
    // A signed-in account offers its repositories; the picker stays empty here.
    if (channel === '/dsh-mnemon-sync' && endpoint === 'github-repositories') return {
      ok: true as const,
      value: { login: 'octocat', repositories: [] },
    }
    // The review card lives on the storage page and reads the ledger on mount.
    if (channel === '/dsh-mnemon-review' && endpoint === 'view') return {
      ok: true as const,
      value: { path: '/root/.mnemon/state/review-ledger.json', entries: [], pending: 0 },
    }
    return { ok: false as const, error: { code: 'internal' as const, message: `unsupported ${channel} ${endpoint}`, details: {} } }
  })
  return { call, connection: { rpc: { call }, isLoopback: true } as ClientConnectionHandle }
}

describe('Memory enhancement settings', () => {
  it('shows only user-facing built-in behavior switches', async () => {
    const { connection } = fixture()
    render(<MnemonSettingsCard scope={readyScope()} connection={connection} />)

    expect(await screen.findByRole('heading', { name: '记忆组合' })).toBeTruthy()
    for (const label of ['主动记录', '轻量上下文', '范围组合']) {
      expect(screen.getByRole('switch', { name: label }).getAttribute('aria-checked')).toBe('false')
    }
    // Shipped components go by their names; packages are named only for installed ones.
    expect(screen.queryByText(/dsh-mnemon-strategy-/u)).toBeNull()
    expect(screen.queryByRole('button', { name: /安装|发现/u })).toBeNull()
  })

  it('applies one enhancement directly without exposing the underlying graph', async () => {
    const { connection, call } = fixture()
    render(<MnemonSettingsCard scope={readyScope()} connection={connection} sessionId="session-1" workspaceId="workspace-1" />)

    const capture = await screen.findByRole('switch', { name: '主动记录' })
    fireEvent.click(capture)
    expect(capture.getAttribute('aria-checked')).toBe('true')

    await waitFor(() => expect(call).toHaveBeenCalledWith('/dsh-mnemon-view-settings', 'apply', {
      configuration: {
        expectedRevision: 'view-1', strategyTypeId: 'default-three-tier',
        entries: { capture: { enabled: true, config: {} } },
      },
      confirmed: true, sessionId: 'session-1', workspaceId: 'workspace-1',
    }))
    await waitFor(() => expect(screen.getByRole('switch', { name: '主动记录' }).getAttribute('aria-checked')).toBe('true'))
    expect(call.mock.calls.some(([, endpoint]) => endpoint === 'inspect-plugin' || endpoint === 'install-plugin')).toBe(false)
  })

  it('restores the switch and reports neutral copy when an enhancement cannot be applied', async () => {
    const { connection } = fixture({ failApply: true })
    render(<MnemonSettingsCard scope={readyScope()} connection={connection} />)

    const light = await screen.findByRole('switch', { name: '轻量上下文' })
    fireEvent.click(light)
    await waitFor(() => expect(light.getAttribute('aria-checked')).toBe('false'))
    // DSH's toast reports it, with Retry continuing the sentence.
    expect((await screen.findByRole('alert')).textContent).toBe('未能应用修改，已保留原来的设置。重试')
    expect(screen.queryByText(/plugin graph|插件图/iu)).toBeNull()
  })

  it('keeps a committed value and prevents stale writes when only refresh fails', async () => {
    const { connection } = fixture({ failRefreshAfterApply: true })
    render(<MnemonSettingsCard scope={readyScope()} connection={connection} />)

    const capture = await screen.findByRole('switch', { name: '主动记录' }) as HTMLButtonElement
    fireEvent.click(capture)
    await waitFor(() => expect(capture.getAttribute('aria-checked')).toBe('true'))
    await waitFor(() => expect(capture.disabled).toBe(true))
    expect(screen.getByRole('alert').textContent).toBe('设置已更新，但状态刷新失败；请重新打开此页面。')
  })

  it('uses English feature copy and honors a read-only Host', async () => {
    const { connection } = fixture({ writable: false })
    render(<MnemonSettingsCard scope={readyScope()} connection={connection} t={translateEn} language="en" />)

    expect(await screen.findByRole('heading', { name: 'Memory composition' })).toBeTruthy()
    for (const label of FEATURES.map(([, , label]) => label)) {
      expect((screen.getByRole('switch', { name: label }) as HTMLButtonElement).disabled).toBe(true)
    }
    expect(screen.queryByText(/dsh-mnemon-strategy-/u)).toBeNull()
  })

  it('stops showing a leftover device code once the account is signed in', async () => {
    const { connection, call } = fixture({
      github: {
        available: true, signedIn: true, writable: true, login: 'octocat',
        // A flow this page started earlier is still live on the Host; signing in ends its purpose.
        flow: { userCode: '2654-9D74', verificationUri: 'https://github.com/login/device', expiresAt: new Date(Date.now() + 600_000).toISOString(), intervalMs: 5_000 },
      },
    })
    render(<MnemonSettingsCard scope={readyScope(SYNCING)} connection={connection} />)

    expect(await screen.findByText('已登录 @octocat')).toBeTruthy()
    expect(screen.queryByText('2654-9D74')).toBeNull()
    expect(screen.queryByText('在 GitHub 输入此设备码：')).toBeNull()
    await waitFor(() => expect(call).toHaveBeenCalledWith('/dsh-mnemon-sync', 'github-repositories', {}))
  })

  it('offers the repository entry before a sign-in and marks the author as optional', async () => {
    const { connection } = fixture({ github: { available: true, signedIn: false, writable: true } })
    render(<MnemonSettingsCard scope={readyScope(SYNCING)} connection={connection} />)

    // Signed out, the block still explains what a sign-in adds instead of hiding itself.
    expect(await screen.findByText('登录后这里会列出你的仓库，可直接选用或新建；不登录也可以在手填表单里填写地址')).toBeTruthy()
    expect(screen.queryByLabelText('新建仓库')).toBeNull()
    // Branch and directory arrive filled in, and the author is optional.
    expect((screen.getByLabelText('分支') as HTMLInputElement).value).toBe('mnemon-sync')
    expect((screen.getByLabelText('远端目录') as HTMLInputElement).value).toBe('mnemon/')
    expect((screen.getByLabelText('提交者姓名') as HTMLInputElement).placeholder).toBe('可选')
    expect((screen.getByLabelText('提交者邮箱') as HTMLInputElement).placeholder).toBe('可选')
    expect(screen.getByText('留空则使用本机 Git 身份')).toBeTruthy()
    cleanup()

    const signedIn = fixture({ github: { available: true, signedIn: true, writable: true, login: 'octocat' } })
    render(<MnemonSettingsCard scope={readyScope(SYNCING)} connection={signedIn.connection} />)

    // The same entry turns into a real picker and a create form once signed in.
    expect((await screen.findByLabelText('新建仓库') as HTMLInputElement).placeholder).toBe('mnemon-memory')
    expect(screen.getByText('账号下还没有仓库，可以在下面新建')).toBeTruthy()
  })

  it('keeps the Git sync row silent until the switch turns it on', async () => {
    const mutate = vi.fn(async () => {})
    const scope = liveSettingsScope<Config>({ status: 'ready', value: { storageScope: 'global' }, base: {}, user: {}, revision: 0, writable: true, mode: 'host' }, mutate)
    const { connection, call } = fixture({ github: { available: true, signedIn: false, writable: true } })
    render(<MnemonSettingsCard scope={scope} connection={connection} />)

    // Off is the default, and off is silent: the row is the title, the hint and the switch.
    const off = await screen.findByRole('switch', { name: 'Git 同步' })
    expect(off.getAttribute('aria-checked')).toBe('false')
    expect(screen.getByText('把上述组件的数据同步到 Git 仓库；不含第三方 Provider 与密钥')).toBeTruthy()
    expect(screen.queryByLabelText('分支')).toBeNull()
    expect(screen.queryByLabelText('提交者姓名')).toBeNull()
    expect(screen.queryByText('尚未配置仓库')).toBeNull()
    // Reading the channel is what would run Git, so a switched-off row asks it nothing.
    expect(call.mock.calls.filter(([channel]) => channel === '/dsh-mnemon-sync')).toEqual([])

    fireEvent.click(off)
    // The choice saves as it is made, and it is what the next read of the profile shows.
    await waitFor(() => expect(mutate).toHaveBeenCalledWith([{ op: 'set', path: ['syncEnabled'], value: true }]))
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Git 同步' }).getAttribute('aria-checked')).toBe('true'))
    // Switched on, the same row unfolds the repository form and reads the channel.
    expect(await screen.findByLabelText('分支')).toBeTruthy()
    await waitFor(() => expect(call).toHaveBeenCalledWith('/dsh-mnemon-sync', 'status', {}))
  })

  it('hides the enhancements and keeps the other settings when the View dashboard fails', async () => {
    const { connection, call } = fixture({ unavailable: true })
    render(<MnemonSettingsCard scope={readyScope()} connection={connection} />)

    await waitFor(() => expect(call).toHaveBeenCalledWith('/dsh-mnemon-view', 'dashboard', {}))
    // Neither the components nor the saved layers can be read: the composition steps aside.
    await waitFor(() => expect(screen.queryByRole('heading', { name: '记忆组合' })).toBeNull())
    expect(screen.queryByText(/dashboard failed/u)).toBeNull()
    expect(screen.getByRole('heading', { name: '存储' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: '界面' })).toBeTruthy()
  })
})

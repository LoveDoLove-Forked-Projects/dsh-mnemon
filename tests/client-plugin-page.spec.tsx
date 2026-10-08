// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PluginPackageRef, PluginsSubject } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { StandardSourceBinding } from '@deepseek-ai/dsh-client-ui-slots'

const RUNTIME = 'dsh-mnemon-source-runtime'

vi.mock('../src/client/MnemonSettingsCard.tsx', () => ({
  // The card's composition board shows a component's gear and page from what it is given.
  MnemonSettingsCard: ({ language, componentSettings }: { language?: string; componentSettings?: { has(name: string): boolean; render(entry: unknown, page: unknown): ReactNode } }) => (
    <section aria-label="configuration" data-language={language}>
      {componentSettings?.has(RUNTIME) === true
        ? componentSettings.render({ packageName: RUNTIME }, { enabled: true, label: 'Runtime Memory', writable: true, language: language ?? 'en' })
        : <p>No component settings</p>}
    </section>
  ),
}))

import { MnemonActionSeat } from '../src/client/action-seat.ts'
import { MnemonPluginActions } from '../src/client/MnemonPluginActions.tsx'
import { MnemonSettingsHost } from '../src/client/MnemonSettingsHost.tsx'
import { translateEn } from '../src/client/locales.ts'
import type { Config } from '../src/host/protocol.ts'
import { settingsScope } from './helpers/settings-scope.ts'

afterEach(cleanup)

function store<T>(value: T) {
  return { getSnapshot: () => value, subscribe: () => () => {} }
}

const pkg: PluginPackageRef = { name: 'dsh-mnemon', installed: true, enabled: true, rows: [{ rowId: 'mnemon', moduleName: 'dsh-mnemon', enabled: true }] }
const bundle = (overrides: Partial<PluginPackageRef> = {}): PluginsSubject => ({ kind: 'bundle', pkg: { ...pkg, ...overrides } })

describe('dsh-mnemon page under DSH Plugins', () => {
  it('renders the configuration only for the page view the Plugins page asks for', () => {
    const props = {
      scope: settingsScope<Config>({ status: 'ready', value: {}, writable: true, mode: 'host' }),
      currentSession: store<StandardSourceBinding>({ key: undefined, hooks: {}, keyedHooks: {}, props: {} }),
      sessions: { list: store({ byId: {} }) } as never,
      workspaces: { list: store({ items: [] }) } as never,
      localeRuntime: { ...store({ active: 'en', locales: [], revision: 0 }) } as never,
      t: translateEn,
    }
    const { rerender } = render(<MnemonSettingsHost {...props} view="summary" />)
    expect(screen.queryByRole('region', { name: 'configuration' })).toBeNull()
    rerender(<MnemonSettingsHost {...props} view="page" />)
    expect(screen.getByRole('region', { name: 'configuration' }).dataset.language).toBe('en')
  })

  it('renders the settings components contributed, also where the page is drawn outside DSH\'s slot renderer', () => {
    const props = {
      scope: settingsScope<Config>({ status: 'ready', value: {}, writable: true, mode: 'host' }),
      currentSession: store<StandardSourceBinding>({ key: undefined, hooks: {}, keyedHooks: {}, props: {} }),
      sessions: { list: store({ byId: {} }) } as never,
      workspaces: { list: store({ items: [] }) } as never,
      localeRuntime: { ...store({ active: 'en', locales: [], revision: 0 }) } as never,
      componentSettingsDirectory: store<ReadonlySet<string>>(new Set([RUNTIME])),
      t: translateEn,
    }
    const renderContributed = vi.fn((packageName: string) => <p>{packageName} contributed</p>)
    const renderSlot = vi.fn((_slot: string, _owner: unknown, options: { entryKey: string }) => <p>{options.entryKey} through DSH</p>)

    // DSH's Plugins page renders the entry itself and passes its renderSlot.
    const { rerender } = render(<MnemonSettingsHost {...props} view="page" renderSlot={renderSlot as never} renderContributed={renderContributed} />)
    expect(screen.getByText(`${RUNTIME} through DSH`)).toBeTruthy()
    expect(renderContributed).not.toHaveBeenCalled()

    // Issue #340: a shell that draws the page itself passes no renderSlot.
    rerender(<MnemonSettingsHost {...props} view="page" renderContributed={renderContributed} />)
    expect(screen.getByText(`${RUNTIME} contributed`)).toBeTruthy()
    expect(renderContributed).toHaveBeenCalledWith(RUNTIME, expect.objectContaining({ component: { packageName: RUNTIME, label: 'Runtime Memory', enabled: true }, writable: true, language: 'en' }))

    // Without either, the page has no way to show them.
    rerender(<MnemonSettingsHost {...props} view="page" />)
    expect(screen.getByText('No component settings')).toBeTruthy()
  })

  it('offers the memory workspace from the dsh-mnemon page only while a placement can show it', () => {
    const workspace = new MnemonActionSeat()
    const { rerender } = render(<MnemonPluginActions subject={bundle()} workspace={workspace} t={translateEn} />)
    expect(screen.queryByRole('button')).toBeNull()

    const open = vi.fn()
    let withdraw = (): void => {}
    act(() => { withdraw = workspace.provide(open) })
    fireEvent.click(screen.getByRole('button', { name: 'Open Memory System' }))
    expect(open).toHaveBeenCalledOnce()

    for (const subject of [
      bundle({ enabled: false }),
      bundle({ name: 'dsh-mnemon-strategy-general' }),
      { kind: 'row', pkg, row: pkg.rows[0]! },
      { kind: 'item', id: 'web-search' },
    ] satisfies PluginsSubject[]) {
      rerender(<MnemonPluginActions subject={subject} workspace={workspace} t={translateEn} />)
      expect(screen.queryByRole('button')).toBeNull()
    }

    rerender(<MnemonPluginActions subject={bundle()} workspace={workspace} t={translateEn} />)
    act(() => withdraw())
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('keeps the newest offer when an older owner withdraws late', () => {
    const seat = new MnemonActionSeat()
    const listener = vi.fn()
    seat.subscribe(listener)
    const first = vi.fn()
    const second = vi.fn()
    const withdrawFirst = seat.provide(first)
    const withdrawSecond = seat.provide(second)
    withdrawFirst()
    expect(seat.getSnapshot()).toBe(second)
    withdrawSecond()
    expect(seat.getSnapshot()).toBeUndefined()
    expect(listener).toHaveBeenCalledTimes(3)
  })
})

// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClientConnectionHandle, ClientSettingsScope, Config } from '../src/host/protocol.ts'

const snapshot = { status: 'ready' as const, value: {}, writable: true, mode: 'host' as const }
const settingsScope = {
  getSnapshot: () => snapshot,
  subscribe: () => () => {},
  set: async () => {}, unset: async () => {}, setPath: async () => {}, unsetPath: async () => {},
} satisfies ClientSettingsScope<Config>
const localeSnapshot = { active: 'en', locales: [], revision: 0 }
const localeRuntime = { getSnapshot: () => localeSnapshot, subscribe: () => () => {} }

afterEach(() => {
  cleanup()
  vi.doUnmock('@deepseek-ai/dsh-client-ui-primitives')
  vi.resetModules()
})

describe('host UI icon compatibility', () => {
  it.each(['size', 'weight'] as const)('renders the overlay and save action with %s-named DSH icons', async generation => {
    const actual = await vi.importActual<typeof import('@deepseek-ai/dsh-client-ui-primitives')>('@deepseek-ai/dsh-client-ui-primitives')
    // 0.1.7-alpha.1 removed the size-suffixed exports. Preserve the other
    // real primitives while exposing exactly one generation of icon names.
    vi.doMock('@deepseek-ai/dsh-client-ui-primitives', () => ({
      ...actual,
      IconChevronLeftOutline14: generation === 'size' ? actual.IconChevronLeftOutline14 : undefined,
      IconDataOutline16: generation === 'size' ? actual.IconDataOutline16 : undefined,
      IconChevronLeftOutlineRegular: generation === 'weight' ? actual.IconChevronLeftOutline14 : undefined,
      IconDataOutlineRegular: generation === 'weight' ? actual.IconDataOutline16 : undefined,
    }))
    const { MnemonWorkbench } = await import('../src/client/MnemonWorkbench.tsx')
    const { MnemonSaveAction } = await import('../src/client/MnemonSaveAction.tsx')
    const sdk = await import('../src/client/extension-sdk.ts')
    const close = vi.fn()
    // RPC failure is handled by these views; this test exercises the render
    // path that crashed before the Host could display any memory data.
    const connection = { rpc: { call: vi.fn(async () => { throw new Error('Host unavailable') }) } } as unknown as ClientConnectionHandle

    await act(async () => {
      render(<>
        <MnemonWorkbench connection={connection} settingsScope={settingsScope} surface="sidebar" onClose={close} t={key => key} />
        <MnemonSaveAction messageId="message-1" connection={connection} settingsScope={settingsScope} localeRuntime={localeRuntime} t={key => key} />
      </>)
    })

    const back = screen.getByRole('button', { name: 'header.backToConversation' })
    expect(back.querySelector('svg')?.getAttribute('width')).toBe('14')
    fireEvent.click(back)
    expect(close).toHaveBeenCalledOnce()
    expect(sdk.IconChevronLeftOutline14).toBe(actual.IconChevronLeftOutline14)

    const save = screen.getByRole('button', { name: 'saveAction.button' })
    expect(save.querySelector('svg')?.getAttribute('width')).toBe('16')
    await act(async () => { fireEvent.click(save) })
    expect(screen.getByRole('dialog', { name: 'saveAction.title' })).toBeTruthy()
  })

  it('describes DSH-managed live settings in both languages without a host-version-specific path', async () => {
    const { MnemonSettingsCard } = await import('../src/client/MnemonSettingsCard.tsx')
    const { translateEn, translateZh } = await import('../src/client/locales.ts')
    const view = render(<MnemonSettingsCard scope={settingsScope} t={translateZh} />)
    expect(screen.getByText('配置由 DSH 保存，点击保存后实时生效。切换范围不会自动迁移旧内容。')).toBeTruthy()
    expect(screen.queryByText(/settings\.yaml/)).toBeNull()

    view.rerender(<MnemonSettingsCard scope={settingsScope} t={translateEn} />)
    expect(screen.getByText('DSH saves configuration changes and applies them live after Save. Switching scopes never migrates existing content automatically.')).toBeTruthy()
    expect(screen.queryByText(/settings\.yaml/)).toBeNull()
  })
})

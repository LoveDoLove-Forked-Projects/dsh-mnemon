import { useEffect, useSyncExternalStore } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PluginDetailProps } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { MnemonActionSeat } from './action-seat.ts'
import { STARTER_GROUP_ROW_ID, type MnemonComponentListSeat } from './component-list-seat.ts'
import type { MnemonTranslate } from './locales.ts'
import { MemoryIcon } from './memory-icon.tsx'

/** The npm package whose page under DSH Plugins carries the Mnemon configuration. */
export const MNEMON_PACKAGE_NAME = 'dsh-mnemon'

interface MnemonPluginActionsProps extends PluginDetailProps {
  /** Opens the memory workspace in its current placement; absent while no placement can show it. */
  workspace: MnemonActionSeat
  /** Where the page's component rows are reported for the configuration above DSH's list. */
  componentList?: MnemonComponentListSeat
  t: MnemonTranslate
}

/**
 * Head controls on the dsh-mnemon page under Plugins: a way back to the memory
 * workspace. They also report the rows DSH lists below the configuration.
 */
export function MnemonPluginActions({ subject, workspace, componentList, t }: MnemonPluginActionsProps): JSX.Element | null {
  const open = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot, workspace.getSnapshot)
  const groupRow = subject.kind === 'bundle' && subject.pkg.name === MNEMON_PACKAGE_NAME
    ? subject.pkg.rows.some(row => row.rowId === STARTER_GROUP_ROW_ID) : undefined
  useEffect(() => groupRow === undefined ? undefined : componentList?.report(groupRow), [groupRow, componentList])
  if (subject.kind !== 'bundle' || subject.pkg.name !== MNEMON_PACKAGE_NAME || !subject.pkg.enabled || open === undefined) return null
  return <Button variant="outline" size="sm" icon={<MemoryIcon size={13} />} onClick={open}>{t('plugin.openWorkspace')}</Button>
}

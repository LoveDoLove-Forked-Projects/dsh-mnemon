import { memo, useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type JSX } from 'react'
import { Button, Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ClientConnectionHandle, ClientSettingsScope, Config, StatusView } from "../host/protocol.ts"
import { MnemonClient } from './api.ts'
import { dispatchMnemonAnchor } from './anchor.ts'
import type { MnemonKey } from './locales.ts'
import type { MnemonClientContext } from './dsh-context.ts'
import { MemoryIcon } from './memory-icon.tsx'
import { message } from './page-kit.tsx'
import { SelectField, TaskAgentTag, WriteReceipt, type FieldOption } from './page-controls.tsx'
import css from './MnemonSaveAction.module.css'

interface MnemonSaveActionProps {
  /** Stable identity of the finalized assistant message this action addresses. */
  messageId: string
  /** Injected by the slot host: the session this message belongs to. */
  sessionId?: string
  connection: ClientConnectionHandle
  settingsScope: ClientSettingsScope<Config>
  localeRuntime: Pick<MnemonClientContext['locale'], 'getSnapshot' | 'subscribe'>
  t: (key: MnemonKey, params?: Record<string, unknown>) => string
}

/** Where a candidate goes: a task Agent decides, or the user names the place. */
type SaveDestination = 'agent' | 'runtime:memory' | 'runtime:user' | `space:${string}`

/** What the task Agent, or the chosen place, did with the text it was given. */
interface SaveOutcome {
  /** The candidate and place the outcome answers; sending them again waits for an edit or another place. */
  content: string
  destination: SaveDestination
  action?: string
  summary?: string
  error?: string
}

const PREVIEW_LIMIT = 8000

type Translate = (key: MnemonKey, params?: Record<string, unknown>) => string

/**
 * The places a candidate can go. What the status does not say counts as
 * available, so a partial status never hides the task Agent.
 */
function saveDestinations(status: Partial<StatusView> | undefined, taskAgent: boolean | undefined, t: Translate): Array<FieldOption<SaveDestination>> {
  const layers = status?.memorySystem?.configuration.layers
  const runtimeOn = layers?.['runtime']?.enabled !== false
  const spacesOn = layers?.['memory-spaces']?.enabled !== false
  // A Mnemon Native space takes writes only while its CLI is found.
  const spaces = spacesOn ? (status?.memoryBodies ?? []).filter(body => body.providerEnabled !== false && body.provider.capabilities.remember
    && ((body.provider.typeId ?? body.provider.id) !== 'mnemon-native' || status?.commandFound !== false)) : []
  // The task Agent writes to Memory Spaces only: it needs one, or a ready Provider to create one with.
  const providerReady = spaces.length > 0 || status?.commandFound !== false || (status?.providerServices ?? []).some(provider => provider.enabled && provider.configured)
  return [
    { value: 'agent', label: t('saveAction.to.agent'), detail: t('saveAction.to.agentDetail'), disabled: taskAgent === false || !spacesOn || !providerReady },
    ...(runtimeOn ? [
      { value: 'runtime:memory' as const, label: t('saveAction.to.memory') },
      { value: 'runtime:user' as const, label: t('saveAction.to.user') },
    ] : []),
    ...spaces.map(body => ({ value: `space:${body.id}` as const, label: body.name, detail: t('saveAction.to.space', { provider: body.provider.label }) })),
  ]
}

/** Write the text as it is to the place the user chose, through that Source's own operation. */
async function saveDirectly(client: MnemonClient, destination: Exclude<SaveDestination, 'agent'>, place: string, content: string, t: Translate): Promise<{ action: string; summary: string }> {
  const sourceTypeId = destination.startsWith('runtime:') ? 'runtime' : 'memory-spaces'
  const source = (await client.sourceManagementCatalog()).sources.find(item => item.sourceTypeId === sourceTypeId)
  if (source === undefined) throw new Error(t('saveAction.unavailable'))
  if (destination === 'runtime:memory' || destination === 'runtime:user') {
    const result = (await client.mutateSourceManagement(source.sourceInstanceKey, 'mutate',
      { action: 'add', target: destination === 'runtime:user' ? 'user' : 'memory', content }, source.revision, true)).value as { message?: string; entryCount?: number; maintenance?: unknown }
    // Runtime Memory keeps one copy of an entry and says so.
    if (result.message?.startsWith('Entry already exists') === true) return { action: 'skipped', summary: t('saveAction.saved.duplicate') }
    return { action: 'added', summary: t(result.maintenance === undefined ? 'saveAction.saved.runtime' : 'saveAction.saved.runtimeMaintained', { target: place, count: result.entryCount }) }
  }
  const result = (await client.mutateSourceManagement(source.sourceInstanceKey, 'remember',
    { content, memoryBodyId: destination.slice('space:'.length), source: 'user' }, source.revision, true)).value as { action?: unknown }
  const action = typeof result.action === 'string' ? result.action : 'stored'
  return { action, summary: action === 'skipped' ? t('saveAction.saved.duplicate') : t('saveAction.saved.space', { space: place }) }
}

/**
 * Save-to-memory action on finalized assistant messages. A task Agent decides
 * whether the (editable) reply is worth keeping and where it goes, or the user
 * names the place and the text is written there as it is. The dialog shows the
 * same receipt as Save to memory on the Memory Spaces page.
 */
export const MnemonSaveAction = memo(function MnemonSaveAction({ messageId, sessionId, connection, settingsScope, localeRuntime, t }: MnemonSaveActionProps): JSX.Element {
  const subscribeLocale = useCallback((listener: () => void) => localeRuntime.subscribe(listener), [localeRuntime])
  const getLocale = useCallback(() => localeRuntime.getSnapshot(), [localeRuntime])
  useSyncExternalStore(subscribeLocale, getLocale, getLocale)
  const subscribeSettings = useCallback((listener: () => void) => settingsScope.subscribe(listener), [settingsScope])
  const getSettingsSnapshot = useCallback(() => settingsScope.getSnapshot(), [settingsScope])
  const settingsSnapshot = useSyncExternalStore(subscribeSettings, getSettingsSnapshot, getSettingsSnapshot)
  const managementWritable = settingsSnapshot.status === 'ready' && settingsSnapshot.writable
  const [open, setOpen] = useState(false)
  const [writeEnabled, setWriteEnabled] = useState<boolean | undefined>(undefined)
  const [taskAgent, setTaskAgent] = useState<boolean | undefined>(undefined)
  const [status, setStatus] = useState<Partial<StatusView> | undefined>(undefined)
  const [chosen, setChosen] = useState<SaveDestination | undefined>(undefined)
  const [candidate, setCandidate] = useState<string | undefined>(undefined)
  const [truncated, setTruncated] = useState(false)
  const [missing, setMissing] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [outcome, setOutcome] = useState<SaveOutcome | null>(null)
  const candidateId = useId()
  const openRef = useRef(false)
  const requestVersionRef = useRef(0)
  const submitActiveRef = useRef(false)

  const setPanelOpen = (next: boolean): void => {
    requestVersionRef.current += 1
    openRef.current = next
    setOpen(next)
  }

  useEffect(() => {
    if (!open) {
      setWriteEnabled(undefined)
      setTaskAgent(undefined)
      setStatus(undefined)
      setChosen(undefined)
      setCandidate(undefined)
      setTruncated(false)
      setMissing(false)
      setSubmitting(submitActiveRef.current)
      setOutcome(null)
      return
    }
    const requestVersion = ++requestVersionRef.current
    let alive = true
    setSubmitting(submitActiveRef.current)
    const client = new MnemonClient(connection, sessionId)
    client.status()
      .then(status => {
        if (!alive || requestVersionRef.current !== requestVersion) return
        setWriteEnabled(status.writeEnabled && managementWritable)
        setTaskAgent(status.lifecycle?.taskAgentAvailable)
        setStatus(status)
      })
      .catch(() => { if (alive && requestVersionRef.current === requestVersion) setWriteEnabled(false) })
    client.assistantMessageText(messageId)
      .then(result => {
        if (!alive || requestVersionRef.current !== requestVersion) return
        if (result === null || result.text === '') setMissing(true)
        else {
          setTruncated(result.text.length > PREVIEW_LIMIT)
          setCandidate(result.text.slice(0, PREVIEW_LIMIT))
        }
      })
      .catch(() => { if (alive && requestVersionRef.current === requestVersion) setMissing(true) })
    return () => { alive = false }
  }, [open, connection, sessionId, messageId, managementWritable])

  const content = candidate?.trim() ?? ''
  const options = saveDestinations(status, taskAgent, t)
  const usable = options.filter(option => option.disabled !== true)
  // The user's choice, else the first place open: the task Agent while it can write, then working memory.
  const destination: SaveDestination = chosen ?? usable[0]?.value ?? 'agent'
  const selected = options.find(option => option.value === destination)
  // A result answers one text in one place: sending the same text there again
  // waits for an edit. A failure can be sent again as it is.
  const answered = outcome !== null && outcome.error === undefined && outcome.content === content && outcome.destination === destination
  const canSubmit = content !== '' && !submitting && writeEnabled === true && selected !== undefined && selected.disabled !== true && !answered

  const submit = (): void => {
    if (!canSubmit || submitActiveRef.current) return
    const requestVersion = requestVersionRef.current
    submitActiveRef.current = true
    setSubmitting(true)
    setOutcome(null)
    const client = new MnemonClient(connection, sessionId)
    const target = destination
    const written = target === 'agent'
      ? client.supervise(content, messageId).then(result => ({ action: result.action, summary: result.summary }))
      : saveDirectly(client, target, selected?.label ?? target, content, t)
    written
      .then(result => {
        if (openRef.current && requestVersionRef.current === requestVersion) setOutcome({ content, destination: target, action: result.action, summary: result.summary })
      })
      .catch(reason => {
        if (openRef.current && requestVersionRef.current === requestVersion) setOutcome({ content, destination: target, error: message(reason) })
      })
      .finally(() => {
        submitActiveRef.current = false
        if (openRef.current) setSubmitting(false)
      })
  }

  const viewMemory = (): void => {
    const page = outcome?.destination.startsWith('runtime:') === true ? 'runtime/entries' : 'memory-spaces/content'
    setPanelOpen(false)
    dispatchMnemonAnchor({ page, ...(sessionId === undefined ? {} : { sessionId }) })
  }
  const direct = destination !== 'agent'

  return (
    <div className={css.wrap}>
      <Tooltip label={t('saveAction.tooltip')} side="bottom" disabled={open}>
        <button
          type="button"
          className={css.button}
          aria-label={t('saveAction.button')}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setPanelOpen(!openRef.current)}
        >
          <span className={css.icon}><MemoryIcon size={16} /></span>
        </button>
      </Tooltip>
      <Modal
        open={open}
        onClose={() => setPanelOpen(false)}
        title={t('saveAction.title')}
        closeLabel={t('saveAction.close')}
        description={t(direct ? 'saveAction.hintDirect' : 'saveAction.hint')}
        className={css.modal as string}
        contentClassName={css.modalContent as string}
        footer={(
          <>
            <Button variant="outline" className={css.modalAction} disabled={submitting} onClick={() => setPanelOpen(false)}>
              {outcome === null ? t('common.cancel') : t('saveAction.close')}
            </Button>
            <Button variant="primary" className={css.modalAction} disabled={!canSubmit} onClick={submit}>
              {direct ? (submitting ? t('saveAction.saving') : t('saveAction.save')) : (submitting ? t('saveAction.submitting') : t('saveAction.submit'))}
            </Button>
          </>
        )}
      >
        {writeEnabled === false && <div className={css.readOnly} role="status">{t('saveAction.readOnly')}</div>}
        {candidate === undefined && !missing && <div className={css.status}>{t('saveAction.fetching')}</div>}
        {missing && <div className={css.status} role="status">{t('saveAction.missing')}</div>}
        {candidate !== undefined && (
          <div className={css.candidate}>
            <div className={css.candidateHeading}>
              <label htmlFor={candidateId}>{t('saveAction.candidate')}</label>
              {writeEnabled === true && !direct && taskAgent !== undefined && <TaskAgentTag available={taskAgent} t={t} />}
            </div>
            <textarea id={candidateId} rows={12} value={candidate} onChange={event => setCandidate(event.target.value)} autoFocus />
            {truncated && <small className={css.truncated}>{t('saveAction.truncated', { limit: PREVIEW_LIMIT })}</small>}
            {writeEnabled === true && (
              <SelectField
                className={css.destination}
                label={t('saveAction.to')}
                value={destination}
                options={options}
                disabled={submitting}
                onChange={setChosen}
              />
            )}
          </div>
        )}
        {outcome !== null && <WriteReceipt t={t} action={outcome.action} summary={outcome.summary} error={outcome.error} onView={viewMemory}
          {...(outcome.destination.startsWith('runtime:') ? { viewLabel: t('receipt.viewRuntime') } : {})} />}
      </Modal>
    </div>
  )
})

import { memo, useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type JSX } from 'react'
import { Button, Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { isDefaultSourceInstance, type ClientConnectionHandle, type ClientSettingsScope, type Config, type StatusView } from "../host/protocol.ts"
import { MnemonClient } from './api.ts'
import { dispatchMnemonAnchor } from './anchor.ts'
import type { MnemonKey } from './locales.ts'
import type { MnemonClientContext } from './dsh-context.ts'
import { MemoryIcon } from './memory-icon.tsx'
import { humanBytes, message } from './page-kit.tsx'
import { SelectField, TaskAgentTag, WriteReceipt, writeOutcome, type FieldOption } from './page-controls.tsx'
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

/** A summary the dialog writes itself, rendered in the language of the moment. */
interface SaveNote {
  key: MnemonKey
  params?: Record<string, unknown>
  /** A place named by a key, translated with the rest. */
  place?: MnemonKey
}

/** What the task Agent, or the chosen place, did with the text it was given. */
interface SaveOutcome {
  /** The candidate and place the outcome answers; sending them again waits for an edit or another place. */
  content: string
  destination: SaveDestination
  action?: string
  summary?: string
  note?: SaveNote
  error?: string
}

type RuntimePlace = 'runtime:memory' | 'runtime:user'
type RuntimeUsage = Partial<Record<'memory' | 'user', { used: number; limit: number }>>

const PREVIEW_LIMIT = 8000
/** One working-memory entry as Runtime Memory stores it: one line of at most 8 KiB, without the § delimiter. */
const RUNTIME_ENTRY_BYTES = 8 * 1024
const RUNTIME_PLACES: Readonly<Record<RuntimePlace, MnemonKey>> = { 'runtime:memory': 'saveAction.to.memory', 'runtime:user': 'saveAction.to.user' }

type Translate = (key: MnemonKey, params?: Record<string, unknown>) => string

function isRuntimePlace(destination: SaveDestination): destination is RuntimePlace {
  return destination === 'runtime:memory' || destination === 'runtime:user'
}

/**
 * The places a candidate can go. A layer takes it while it is on, its Source
 * runs and its writes are not switched off. What the status does not say
 * counts as available, so a partial status never hides the task Agent.
 */
function saveDestinations(status: Partial<StatusView> | undefined, taskAgent: boolean | undefined, t: Translate): Array<FieldOption<SaveDestination>> {
  const system = status?.memorySystem
  const takes = (sourceTypeId: string): boolean => {
    const layer = system?.configuration.layers[sourceTypeId]
    return layer?.enabled !== false && layer?.participation?.write !== 'off'
      && (system?.sources === undefined || system.sources.some(source => source.sourceTypeId === sourceTypeId))
  }
  const runtimeOn = takes('runtime')
  const spacesOn = takes('memory-spaces')
  // Active spaces, as the Agent sees them. A Mnemon Native space takes writes only while its CLI is found.
  const spaces = spacesOn ? (status?.memoryBodies ?? []).filter(body => body.active !== false && body.providerEnabled !== false && body.provider.capabilities.remember
    && ((body.provider.typeId ?? body.provider.id) !== 'mnemon-native' || status?.commandFound !== false)) : []
  // The task Agent writes to Memory Spaces only: it needs one, or a ready Provider to create one with.
  const providerReady = spaces.length > 0 || status?.commandFound !== false || (status?.providerServices ?? []).some(provider => provider.enabled && provider.configured)
  return [
    { value: 'agent', label: t('saveAction.to.agent'), detail: t('saveAction.to.agentDetail'), disabled: taskAgent === false || !spacesOn || !providerReady },
    ...(runtimeOn ? (Object.keys(RUNTIME_PLACES) as RuntimePlace[]).map(value => ({ value, label: t(RUNTIME_PLACES[value]) })) : []),
    ...spaces.map(body => ({ value: `space:${body.id}` as const, label: body.name, detail: t('saveAction.to.space', { provider: body.provider.label }) })),
  ]
}

/** The default instance of a Source type, as the workbench picks it, else the first. */
function placeSource<Source extends { sourceInstanceKey: string; sourceTypeId: string }>(catalog: { sources: readonly Source[] }, sourceTypeId: string): Source | undefined {
  const sources = catalog.sources.filter(source => source.sourceTypeId === sourceTypeId)
  return sources.find(source => isDefaultSourceInstance(source.sourceInstanceKey, sourceTypeId)) ?? sources[0]
}

/** Write the text to the place the user chose, through that Source's own operation, with a fresh revision. */
async function saveDirectly(client: MnemonClient, destination: Exclude<SaveDestination, 'agent'>, place: string, content: string, t: Translate): Promise<{ action: string; note: SaveNote }> {
  const source = placeSource(await client.sourceManagementCatalog(), isRuntimePlace(destination) ? 'runtime' : 'memory-spaces')
  if (source === undefined) throw new Error(t('saveAction.unavailable'))
  if (isRuntimePlace(destination)) {
    const input = { action: 'add', target: destination === 'runtime:user' ? 'user' : 'memory', content }
    // The Runtime Memory page's own path: Host assistance checks the layer's
    // writes and makes room when the file is full.
    const written = source.assistance?.includes('mutate') === true
      ? await client.assistSource(source.sourceInstanceKey, 'mutate', input, source.revision, true)
      : await client.mutateSourceManagement(source.sourceInstanceKey, 'mutate', input, source.revision, true)
    const result = written.value as { message?: string; entryCount?: number; maintenance?: unknown }
    // Runtime Memory keeps one copy of an entry and says so.
    if (result.message?.startsWith('Entry already exists') === true) return { action: 'skipped', note: { key: 'saveAction.saved.duplicate' } }
    return { action: 'added', note: { key: result.maintenance === undefined ? 'saveAction.saved.runtime' : 'saveAction.saved.runtimeMaintained', params: { count: result.entryCount }, place: RUNTIME_PLACES[destination] } }
  }
  const result = (await client.mutateSourceManagement(source.sourceInstanceKey, 'remember',
    { content, memoryBodyId: destination.slice('space:'.length), source: 'user' }, source.revision, true)).value as { action?: unknown }
  const answered = typeof result.action === 'string' ? result.action : 'stored'
  // A Provider that queues its writes confirms them later.
  const action = answered === 'queued' ? 'accepted' : answered
  const outcome = writeOutcome(action)
  const key: MnemonKey = outcome === 'skipped' ? 'saveAction.saved.duplicate'
    : outcome === 'pending' ? 'saveAction.saved.spacePending'
      : outcome === 'written' || outcome === 'updated' ? 'saveAction.saved.space' : 'saveAction.saved.spaceOther'
  return { action, note: { key, params: { space: place, action: answered } } }
}

/** What a working-memory place says about this text before it is saved, and whether it can take it at all. */
function runtimePlaceNote(destination: SaveDestination, content: string, usage: RuntimeUsage | undefined, taskAgent: boolean | undefined, t: Translate): { text: string; blocked: boolean } | undefined {
  if (!isRuntimePlace(destination) || content === '') return undefined
  const target = t(RUNTIME_PLACES[destination])
  // Runtime Memory stores an entry as one line.
  const entry = content.replace(/\s+/gu, ' ')
  if (entry.includes('§')) return { text: t('saveAction.place.delimiter', { target }), blocked: true }
  const bytes = new TextEncoder().encode(entry).length
  if (bytes > RUNTIME_ENTRY_BYTES) return { text: t('saveAction.place.tooLong', { target, size: humanBytes(bytes), limit: humanBytes(RUNTIME_ENTRY_BYTES) }), blocked: true }
  const room = usage?.[destination === 'runtime:user' ? 'user' : 'memory']
  if (room === undefined || room.used + bytes + (room.used > 0 ? 4 : 0) <= room.limit) return undefined
  // A full profile makes room only through a task Agent.
  if (destination === 'runtime:user' && taskAgent === false) return { text: t('saveAction.place.userFull'), blocked: true }
  return { text: t('saveAction.place.full', { target, used: humanBytes(room.used), limit: humanBytes(room.limit) }), blocked: false }
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
  const [usage, setUsage] = useState<RuntimeUsage | undefined>(undefined)
  const candidateId = useId()
  const openRef = useRef(false)
  const requestVersionRef = useRef(0)
  // The place a running save writes to, and a direct save's result the dialog
  // was closed for: neither is lost when the dialog closes and opens again.
  const inFlightRef = useRef<SaveDestination | undefined>(undefined)
  const unseenRef = useRef<SaveOutcome | undefined>(undefined)

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
      setSubmitting(inFlightRef.current !== undefined)
      setOutcome(null)
      setUsage(undefined)
      return
    }
    const requestVersion = ++requestVersionRef.current
    let alive = true
    setSubmitting(inFlightRef.current !== undefined)
    const unseen = unseenRef.current
    unseenRef.current = undefined
    if (unseen !== undefined) {
      setChosen(unseen.destination)
      setOutcome(unseen)
    } else if (inFlightRef.current !== undefined) setChosen(inFlightRef.current)
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
  const runtimeTarget = isRuntimePlace(destination) ? destination : undefined

  // A working-memory place says up front when the text cannot fit, or will make room first.
  useEffect(() => {
    if (!open || runtimeTarget === undefined || usage !== undefined || status === undefined) return
    const runtime = status.memorySystem === undefined ? undefined : placeSource(status.memorySystem, 'runtime')
    if (runtime === undefined) return
    let alive = true
    new MnemonClient(connection, sessionId).readSourceManagement(runtime.sourceInstanceKey, 'snapshot')
      .then(result => { if (alive) setUsage((result.value as { targets?: RuntimeUsage } | null)?.targets ?? {}) }, () => { if (alive) setUsage({}) })
    return () => { alive = false }
  }, [open, runtimeTarget, usage, status, connection, sessionId])
  const placeNote = runtimePlaceNote(destination, content, usage, taskAgent, t)

  // A result answers one text in one place: sending the same text there again
  // waits for an edit. A failure can be sent again as it is.
  const answered = outcome !== null && outcome.error === undefined && outcome.content === content && outcome.destination === destination
  const canSubmit = content !== '' && !submitting && writeEnabled === true && selected !== undefined && selected.disabled !== true && placeNote?.blocked !== true && !answered

  const submit = (): void => {
    if (!canSubmit || inFlightRef.current !== undefined) return
    const requestVersion = requestVersionRef.current
    const target = destination
    inFlightRef.current = target
    setSubmitting(true)
    setOutcome(null)
    const client = new MnemonClient(connection, sessionId)
    const written: Promise<Omit<SaveOutcome, 'content' | 'destination'>> = target === 'agent'
      ? client.supervise(content, messageId).then(result => ({ action: result.action, summary: result.summary }))
      : saveDirectly(client, target, selected?.label ?? target, content, t)
    void written
      .then(result => ({ content, destination: target, ...result }), (reason: unknown) => ({ content, destination: target, error: message(reason) }))
      .then((result: SaveOutcome) => {
        inFlightRef.current = undefined
        // The task Agent's request is keyed by its reply and can be sent again
        // safely. A direct write has no such guard, so a dialog opened again
        // meanwhile, or later, still gets its receipt.
        if (openRef.current && (target !== 'agent' || requestVersionRef.current === requestVersion)) setOutcome(result)
        else if (!openRef.current && target !== 'agent') unseenRef.current = result
        if (openRef.current) setSubmitting(false)
        if (isRuntimePlace(target) && result.error === undefined) setUsage(undefined)
      })
  }

  const viewMemory = (): void => {
    const runtime = outcome !== null && isRuntimePlace(outcome.destination)
    setPanelOpen(false)
    // Runtime Memory opens on the entry it now holds, stored as one line.
    dispatchMnemonAnchor({ page: runtime ? 'runtime/entries' : 'memory-spaces/content',
      ...(runtime ? { seed: outcome.content.replace(/\s+/gu, ' ') } : {}),
      ...(sessionId === undefined ? {} : { sessionId }) })
  }
  const direct = writeEnabled === true && destination !== 'agent'
  const receiptSummary = outcome?.note === undefined ? outcome?.summary
    : t(outcome.note.key, { ...outcome.note.params, ...(outcome.note.place === undefined ? {} : { target: t(outcome.note.place) }) })

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
              {writeEnabled === true && !direct && taskAgent !== undefined && <TaskAgentTag available={taskAgent && selected?.disabled !== true} t={t} />}
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
            {writeEnabled === true && placeNote !== undefined && <small className={css.placeNote} data-tone={placeNote.blocked ? 'blocked' : 'caution'}>{placeNote.text}</small>}
          </div>
        )}
        {outcome !== null && <WriteReceipt t={t} action={outcome.action} summary={receiptSummary} error={outcome.error} onView={viewMemory}
          {...(isRuntimePlace(outcome.destination) ? { viewLabel: t('receipt.viewRuntime') } : {})} />}
      </Modal>
    </div>
  )
})

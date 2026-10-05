import { useCallback, useEffect, useMemo, useState, type JSX } from 'react'
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { type ClientConnectionHandle, type MnemonReconcileOperation, type MnemonReviewLedgerView, type MnemonReviewStatus } from '../host/protocol.ts'
import { MnemonClient } from './api.ts'
import type { MnemonTranslate } from './locales.ts'
import css from './MnemonSettingsCard.module.css'
import { message } from './page-kit.tsx'
import { SettingRow } from './settings-controls.tsx'

export interface MnemonReviewSectionProps {
  connection?: ClientConnectionHandle
  sessionId?: string
  workspaceId?: string
  disabled: boolean
  t: MnemonTranslate
}

const STATUS_KEY: Record<MnemonReviewStatus, 'review.statusPending' | 'review.statusAccepted' | 'review.statusRejected'> = {
  pending: 'review.statusPending',
  accepted: 'review.statusAccepted',
  rejected: 'review.statusRejected',
}

const STATUS_TONE: Record<MnemonReviewStatus, 'warning' | 'success' | 'quiet'> = {
  pending: 'warning',
  accepted: 'success',
  rejected: 'quiet',
}

function brief(value: string, max: number): string {
  const text = value.replace(/\s+/gu, ' ').trim()
  return text.length <= max ? text : text.slice(0, max - 1) + '…'
}

function targetName(t: MnemonTranslate, target: 'memory' | 'user'): string {
  return target === 'user' ? t('review.targetUser') : t('review.targetMemory')
}

/** One operation as a reviewer reads it: what changes, and to which entry. */
function operationText(t: MnemonTranslate, operation: MnemonReconcileOperation): string {
  switch (operation.kind) {
    case 'runtime-add': return t('review.opAdd', { target: targetName(t, operation.target), content: brief(operation.content, 160) })
    case 'runtime-replace': return t('review.opReplace', { target: targetName(t, operation.target), from: brief(operation.oldText, 80), to: brief(operation.content, 160) })
    case 'runtime-remove': return t('review.opRemove', { target: targetName(t, operation.target), text: brief(operation.oldText, 160) })
    case 'document-archive': return t('review.opArchive', { id: operation.documentId })
  }
}

function stamp(value: string): string {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString()
}

/**
 * What an agent proposes to do with memory that arrived from another machine.
 * The proposal is evidence, not an instruction: it changes nothing until the
 * user accepts it, and the user can leave an opinion on it either way, which
 * the next reconciliation run reads back as part of its own evidence.
 */
export function MnemonReviewSection(props: MnemonReviewSectionProps): JSX.Element {
  const { t } = props
  const client = useMemo(
    () => props.connection === undefined ? null : new MnemonClient(props.connection, props.sessionId, props.workspaceId),
    [props.connection, props.sessionId, props.workspaceId],
  )
  const [ledger, setLedger] = useState<MnemonReviewLedgerView | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [opinion, setOpinion] = useState('')

  const refresh = useCallback(async (): Promise<void> => {
    if (client === null) return
    setLedger(await client.reviewLedger())
  }, [client])

  useEffect(() => {
    if (client === null) return
    let active = true
    client.reviewLedger()
      .then(value => { if (active) setLedger(value) })
      .catch(reason => { if (active) setFailed(message(reason)) })
    return () => { active = false }
  }, [client])

  // Every action ends the same way: re-read the ledger, then say what happened.
  const submit = (id: string, work: (api: MnemonClient) => Promise<unknown>): void => {
    if (client === null) return
    setBusy(id)
    setFailed(null)
    setNotice(null)
    void work(client).then(refresh).catch(reason => setFailed(message(reason))).finally(() => setBusy(null))
  }

  const runReconcile = (): void => {
    if (client === null) return
    setBusy('reconcile')
    setFailed(null)
    setNotice(null)
    void client.reconcile()
      .then(async result => {
        setNotice(result.action === 'planned' ? t('review.planned', { operations: result.operations }) : t('review.none'))
        setLedger(await client.reviewLedger())
      })
      .catch(reason => setFailed(message(reason)))
      .finally(() => setBusy(null))
  }

  const leaveOpinion = (id: string): void => {
    const text = opinion.trim()
    if (text === '') return
    submit(id, api => api.reviewOpinion(id, text).then(() => {
      setOpinion('')
      setNotice(t('review.opinionAdded'))
    }))
  }

  const entries = ledger?.entries ?? []
  const pending = ledger?.pending ?? 0
  return <div className={css.syncRow} role="group" aria-labelledby="mnemon-review-heading">
    <SettingRow title={t('config.reconcileTitle')} titleId="mnemon-review-heading" hint={t('config.reconcileDescription')}>
      <div className={css.rowActions}>
        <Button variant="outline" size="sm" disabled={props.disabled || client === null || busy !== null}
          onClick={runReconcile}>{busy === 'reconcile' ? t('review.reconciling') : t('review.reconcile')}</Button>
        <Button variant="ghost" size="sm" disabled={client === null || busy !== null}
          onClick={() => { submit('load', refresh) }}>{t('review.refresh')}</Button>
      </div>
    </SettingRow>
    <div className={css.syncState} aria-live="polite">
      <span>{pending === 0 ? t('review.empty') : t('review.pending', { count: pending })}</span>
    </div>
    {failed !== null && <p className={css.error} role="alert">{t('review.failed', { error: failed })}</p>}
    {notice !== null && <p className={css.syncSuccess} role="status">{notice}</p>}
    {entries.length > 0 && <div className={css.reviewList}>
      {entries.map(entry => {
        const open = openId === entry.id
        return <div key={entry.id} className={css.reviewEntry} data-status={entry.status}>
          <header>
            <div className={css.reviewTitle}>
              <strong>{entry.title}</strong>
              <Tag tone={STATUS_TONE[entry.status]}>{t(STATUS_KEY[entry.status])}</Tag>
            </div>
            <div className={css.rowActions}>
              <Button variant="ghost" size="sm" onClick={() => { setOpenId(open ? null : entry.id) }}>{open ? t('review.collapse') : t('review.expand')}</Button>
              {entry.status === 'pending' && <>
                <Button variant="outline" size="sm" disabled={busy !== null}
                  onClick={() => { submit(entry.id, api => api.decideReview(entry.id, 'accepted')) }}>{t('review.accept')}</Button>
                <Button variant="ghost" size="sm" disabled={busy !== null}
                  onClick={() => { submit(entry.id, api => api.decideReview(entry.id, 'rejected')) }}>{t('review.reject')}</Button>
              </>}
              {entry.status === 'accepted' && <Button variant="primary" size="sm" disabled={busy !== null || props.disabled}
                onClick={() => { submit(entry.id, api => api.applyReview(entry.id).then(result => { setNotice(t('review.applied', { count: result.applied })) })) }}>
                {busy === entry.id ? t('review.applying') : t('review.apply')}</Button>}
              {entry.status !== 'pending' && <Button variant="ghost" size="sm" disabled={busy !== null}
                onClick={() => { submit(entry.id, api => api.reopenReview(entry.id)) }}>{t('review.reopen')}</Button>}
            </div>
          </header>
          <small>{t('review.meta', { count: entry.operations.length, machine: entry.machine.label, time: stamp(entry.createdAt) })}</small>
          {entry.foreignMachines.length > 0 && <small>{t('review.foreign', { machines: entry.foreignMachines.join(', ') })}</small>}
          {entry.appliedAt !== undefined && <small className={css.syncSuccess}>{t('review.appliedAt', { time: stamp(entry.appliedAt) })}</small>}
          {entry.failure !== undefined && <p className={css.error} role="alert">{t('review.applyFailed', { error: entry.failure })}</p>}
          {open && <>
            <p>{entry.summary}</p>
            <ol className={css.reviewOperations}>
              {entry.operations.map((operation, index) => <li key={index}>{operationText(t, operation)}<small>{operation.reason}</small></li>)}
            </ol>
            <div className={css.reviewOpinions}>
              <strong>{t('review.opinions')}</strong>
              {entry.opinions.length === 0
                ? <small>{t('review.noOpinions')}</small>
                : entry.opinions.map(item => <div key={item.id}>
                    <strong>{item.author === 'agent' ? t('review.authorAgent') : t('review.authorUser')}</strong>
                    <span>{item.text}</span>
                  </div>)}
            </div>
            <div className={css.reviewOpinionForm}>
              <input type="text" value={opinion} placeholder={t('review.opinionPlaceholder')} aria-label={t('review.opinions')}
                disabled={busy !== null} onChange={event => setOpinion(event.target.value)} />
              <Button variant="outline" size="sm" disabled={busy !== null || opinion.trim() === ''}
                onClick={() => { leaveOpinion(entry.id) }}>{t('review.opinionSend')}</Button>
            </div>
          </>}
        </div>
      })}
    </div>}
  </div>
}

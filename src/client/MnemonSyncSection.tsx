import { useCallback, useEffect, useMemo, useState, type JSX } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { MNEMON_SYNC_TOKEN_ENV, type ClientConnectionHandle, type MnemonSyncConfigView, type MnemonSyncPreview, type MnemonSyncStatus } from '../host/protocol.ts'
import { MnemonClient } from './api.ts'
import type { MnemonTranslate } from './locales.ts'
import { humanBytes, message } from './page-kit.tsx'
import css from './MnemonSettingsCard.module.css'
import { SettingRow } from './settings-controls.tsx'

/** What the configuration form holds; an empty token field keeps the saved one. */
interface SyncDraft {
  repoUrl: string
  branch: string
  subdir: string
  token: string
  clearToken: boolean
  authorName: string
  authorEmail: string
}

function draftOf(config: MnemonSyncConfigView | undefined): SyncDraft {
  return {
    repoUrl: config?.repoUrl ?? '',
    branch: config?.branch ?? '',
    subdir: config?.subdir ?? '',
    token: '',
    clearToken: false,
    authorName: config?.authorName ?? '',
    authorEmail: config?.authorEmail ?? '',
  }
}

/** The branch and directory the form shows as placeholders while nothing is configured. */
function configured(draft: SyncDraft): boolean {
  return draft.repoUrl.trim() !== ''
}

interface MnemonSyncSectionProps {
  connection?: ClientConnectionHandle
  sessionId?: string
  workspaceId?: string
  /** Whether the Host accepts writes at all; a read-only Host only reports status. */
  disabled: boolean
  t: MnemonTranslate
}

/**
 * Git repository sync: the repository this root publishes its Mnemon Pack to,
 * the token that authenticates the push, and the two operations that move the
 * payload. The form reads the Host's status first, so a repository the Host
 * cannot reach, a missing Git, or a read-only Host is visible before anything
 * runs.
 */
export function MnemonSyncSection({ connection, sessionId, workspaceId, disabled, t }: MnemonSyncSectionProps): JSX.Element {
  const client = useMemo(() => connection === undefined ? null : new MnemonClient(connection, sessionId, workspaceId), [connection, sessionId, workspaceId])
  const [status, setStatus] = useState<MnemonSyncStatus | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<SyncDraft>(() => draftOf(undefined))
  const [pending, setPending] = useState<MnemonSyncPreview | null>(null)
  const [busy, setBusy] = useState<'save' | 'push' | 'preview' | 'pull' | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    if (client === null) return
    try {
      setStatus(await client.syncStatus())
    } catch (reason) {
      setFailed(message(reason))
    } finally {
      setLoaded(true)
    }
  }, [client])

  useEffect(() => {
    if (client === null) { setLoaded(true); return }
    let active = true
    void client.syncStatus().then(
      next => { if (active) { setStatus(next); setLoaded(true) } },
      reason => { if (active) { setFailed(message(reason)); setLoaded(true) } },
    )
    return () => { active = false }
  }, [client])

  // The saved configuration seeds the form; a repository typed here is not saved until the user saves it.
  const saved = status?.config
  useEffect(() => { setDraft(draftOf(saved)) }, [saved?.repoUrl, saved?.branch, saved?.subdir, saved?.authorName, saved?.authorEmail, saved?.hasToken])

  const save = async (): Promise<void> => {
    if (client === null || busy !== null) return
    setBusy('save'); setFailed(null); setNotice(null)
    try {
      const patch: { repoUrl?: string | null; branch?: string; subdir?: string; token?: string | null; authorName?: string; authorEmail?: string } = {
        branch: draft.branch, subdir: draft.subdir, authorName: draft.authorName, authorEmail: draft.authorEmail,
        repoUrl: draft.repoUrl.trim() === '' ? null : draft.repoUrl.trim(),
      }
      if (draft.clearToken) patch.token = null
      else if (draft.token.trim() !== '') patch.token = draft.token.trim()
      await client.configureSync(patch)
      setNotice(t('config.syncSaved'))
      setDraft(current => ({ ...current, token: '', clearToken: false }))
      await refresh()
    } catch (reason) {
      setFailed(message(reason))
    } finally { setBusy(null) }
  }

  const push = async (): Promise<void> => {
    if (client === null || busy !== null) return
    setBusy('push'); setFailed(null); setNotice(null); setPending(null)
    try {
      const result = await client.pushSync()
      setNotice(result.pushed
        ? t('config.syncPushed', { commit: result.commit.slice(0, 8), files: result.files, size: humanBytes(result.bytes) })
        : result.committed
          ? t('config.syncPushedLocal', { commit: result.commit.slice(0, 8), reason: result.reason ?? '' })
          : t('config.syncPushIdle'))
      await refresh()
    } catch (reason) {
      setFailed(message(reason))
    } finally { setBusy(null) }
  }

  const preview = async (): Promise<void> => {
    if (client === null || busy !== null) return
    setBusy('preview'); setFailed(null); setNotice(null); setPending(null)
    try {
      setPending(await client.previewSync())
    } catch (reason) {
      setFailed(message(reason))
    } finally { setBusy(null) }
  }

  const pull = async (): Promise<void> => {
    if (client === null || pending === null || busy !== null) return
    setBusy('pull'); setFailed(null); setNotice(null)
    try {
      const result = await client.pullSync()
      setNotice(t('config.syncPulled', { commit: result.commit.slice(0, 8), root: result.targetRoot }))
      setPending(null)
      await refresh()
    } catch (reason) {
      setFailed(message(reason))
    } finally { setBusy(null) }
  }

  // One line of state: the repository, then whatever the Host says about it.
  const states: string[] = []
  if (!loaded) states.push(t('config.syncLoading'))
  else if (status === null) states.push(t('config.syncUnavailable'))
  else {
    if (!status.configured) states.push(t('config.syncNotConfigured'))
    if (!status.git.available) states.push(t('config.syncGitMissing', { required: status.git.required }))
    if (status.configured && status.git.available) {
      if (!status.remote.reachable) states.push(t('config.syncRemoteUnreachable'))
      else if (!status.remote.branchExists) states.push(t('config.syncRemoteBranchMissing', { branch: status.config.branch }))
      else if (status.remote.commit !== undefined) states.push(t('config.syncRemoteCommit', { commit: status.remote.commit.slice(0, 8) }))
    }
    states.push(status.config.hasToken ? t('config.syncTokenSaved') : t('config.syncTokenNone'))
  }
  const ready = client !== null && status !== null && status.configured && status.git.available
  const editable = !disabled && client !== null
  const changed = pending?.components.filter(component => component.changed).length ?? 0

  return <div className={css.syncRow} role="group" aria-labelledby="mnemon-sync-heading">
    <SettingRow title={t('config.syncTitle')} titleId="mnemon-sync-heading" hint={t('config.syncSimpleDescription')}>
      <div className={css.rowActions}>
        <Button variant="outline" size="sm" disabled={!editable || busy !== null} onClick={() => setOpen(current => !current)}>{open ? t('config.syncHide') : t('config.syncConfigure')}</Button>
        <Button variant="outline" size="sm" disabled={!ready || busy !== null} onClick={() => void preview()}>{busy === 'preview' ? t('config.syncPreviewing') : t('config.syncPreview')}</Button>
        <Button variant="primary" size="sm" disabled={!ready || disabled || busy !== null} onClick={() => void push()}>{busy === 'push' ? t('config.syncPushing') : t('config.syncPush')}</Button>
      </div>
    </SettingRow>
    <div className={css.syncState} aria-live="polite">{states.map(state => <span key={state}>{state}</span>)}</div>
    {open && <div className={css.syncForm}>
      <div className={css.syncField}>
        <label htmlFor="mnemon-sync-repo">{t('config.syncRepoUrl')}</label>
        <input id="mnemon-sync-repo" type="text" value={draft.repoUrl} placeholder="https://github.com/owner/repository.git"
          disabled={!editable} autoComplete="off" spellCheck={false} autoCapitalize="none" autoCorrect="off"
          onChange={event => setDraft(current => ({ ...current, repoUrl: event.target.value }))} />
        <small>{t('config.syncRepoUrlHint')}</small>
      </div>
      <div className={css.syncField}>
        <label htmlFor="mnemon-sync-branch">{t('config.syncBranch')}</label>
        <input id="mnemon-sync-branch" type="text" value={draft.branch} placeholder={saved?.branch ?? 'mnemon-sync'}
          disabled={!editable} autoComplete="off" spellCheck={false} autoCapitalize="none" autoCorrect="off"
          onChange={event => setDraft(current => ({ ...current, branch: event.target.value }))} />
        <small>{t('config.syncBranchHint', { branch: saved?.branch ?? 'mnemon-sync' })}</small>
      </div>
      <div className={css.syncField}>
        <label htmlFor="mnemon-sync-subdir">{t('config.syncSubdir')}</label>
        <input id="mnemon-sync-subdir" type="text" value={draft.subdir} placeholder={saved?.subdir ?? 'mnemon/'}
          disabled={!editable} autoComplete="off" spellCheck={false} autoCapitalize="none" autoCorrect="off"
          onChange={event => setDraft(current => ({ ...current, subdir: event.target.value }))} />
        <small>{t('config.syncSubdirHint', { subdir: saved?.subdir ?? 'mnemon/' })}</small>
      </div>
      <div className={css.syncField}>
        <label htmlFor="mnemon-sync-token">{t('config.syncToken')}</label>
        <input id="mnemon-sync-token" type="password" value={draft.token} disabled={!editable || draft.clearToken}
          placeholder={saved?.hasToken ? t('config.syncTokenSaved') : t('config.syncTokenNone')}
          autoComplete="new-password" spellCheck={false}
          onChange={event => setDraft(current => ({ ...current, token: event.target.value }))} />
        <small>{t('config.syncTokenHint', { path: status?.configPath ?? '', env: MNEMON_SYNC_TOKEN_ENV })}</small>
        <small>{t('config.syncTokenKeep')}</small>
        <label className={css.syncCheck}>
          <input type="checkbox" checked={draft.clearToken} disabled={!editable}
            onChange={event => setDraft(current => ({ ...current, clearToken: event.target.checked, token: '' }))} />
          <span>{t('config.syncTokenClear')}</span>
        </label>
      </div>
      <div className={css.syncField}>
        <label htmlFor="mnemon-sync-author-name">{t('config.syncAuthorName')}</label>
        <input id="mnemon-sync-author-name" type="text" value={draft.authorName} disabled={!editable}
          autoComplete="off" spellCheck={false}
          onChange={event => setDraft(current => ({ ...current, authorName: event.target.value }))} />
      </div>
      <div className={css.syncField}>
        <label htmlFor="mnemon-sync-author-email">{t('config.syncAuthorEmail')}</label>
        <input id="mnemon-sync-author-email" type="text" value={draft.authorEmail} disabled={!editable}
          autoComplete="off" spellCheck={false}
          onChange={event => setDraft(current => ({ ...current, authorEmail: event.target.value }))} />
      </div>
      <div className={css.syncFormActions}>
        <Button variant="primary" size="sm" disabled={!editable || busy !== null || !configured(draft)} onClick={() => void save()}>{busy === 'save' ? t('config.syncSave') + '…' : t('config.syncSave')}</Button>
      </div>
    </div>}
    {pending !== null && <div className={css.syncBar} role="status">
      <div>
        <strong>{t('config.syncPreviewReady', { commit: pending.commit.slice(0, 8), components: pending.manifest.components.length, size: humanBytes(pending.archiveBytes) })}</strong>
        <small>{t('config.syncPreviewComponents', { changed, total: pending.components.length })}</small>
        <small>{t('config.syncPreviewFiles', { added: pending.files.added, removed: pending.files.removed, changed: pending.files.changed })}</small>
      </div>
      <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => setPending(null)}>{t('common.cancel')}</Button>
      <Button variant="primary" size="sm" disabled={busy !== null || disabled} onClick={() => void pull()}>{busy === 'pull' ? t('config.syncPulling') : t('config.syncPull')}</Button>
    </div>}
    <div className={css.syncFeedback} aria-live="polite">
      {failed !== null && <p className={css.error} role="alert">{t('config.syncFailed', { error: failed })}</p>}
      {notice !== null && <p className={css.syncSuccess}>{notice}</p>}
      {client === null && <p className={css.readOnly}>{t('config.syncUnavailable')}</p>}
    </div>
  </div>
}

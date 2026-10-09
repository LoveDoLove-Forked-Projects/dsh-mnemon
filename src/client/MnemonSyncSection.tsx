import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { Button, Tag, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  MNEMON_SYNC_DEFAULT_BRANCH,
  MNEMON_SYNC_DEFAULT_SUBDIR,
  MNEMON_SYNC_TOKEN_ENV,
  type ClientConnectionHandle,
  type MnemonSyncBackup,
  type MnemonSyncBackupList,
  type MnemonSyncConfigView,
  type MnemonSyncDiff,
  type MnemonSyncGitHubRepository,
  type MnemonSyncGitHubStatus,
  type MnemonSyncPreview,
  type MnemonSyncPullResult,
  type MnemonSyncStatus,
} from '../host/protocol.ts'
import { MnemonClient } from './api.ts'
import type { MnemonTranslate } from './locales.ts'
import { humanBytes, message } from './page-kit.tsx'
import css from './MnemonSettingsCard.module.css'
import { ToggleRow } from './settings-controls.tsx'
import { MnemonDialog } from './MnemonDialog.tsx'

/** How many backups one page of the branch history holds. */
const BACKUP_PAGE = 20

/** What the configuration form holds; an empty token field keeps the saved one. */
interface SyncDraft {
  repoUrl: string
  branch: string
  subdir: string
  token: string
  clearToken: boolean
  authorName: string
  authorEmail: string
  /** Minutes between automatic backups; zero keeps the channel manual. */
  autoBackupMinutes: number
}

/**
 * The intervals the form offers. The floor is an hour: a backup more often than
 * that is a repository being rewritten, not a memory being kept. The ceiling is
 * a week, and off is the first choice because it is what a channel that has
 * never been configured does.
 */
const AUTO_BACKUP_CHOICES: readonly number[] = [0, 60, 180, 360, 720, 1_440, 4_320, 10_080]

/** One interval as the reader reads it: off, whole days, or whole hours. */
function intervalLabel(t: MnemonTranslate, minutes: number): string {
  if (minutes <= 0) return t('config.syncAutoBackupOff')
  if (minutes % 1_440 === 0) return t('config.syncAutoBackupDays', { days: minutes / 1_440 })
  return t('config.syncAutoBackupHours', { hours: minutes / 60 })
}

function draftOf(config: MnemonSyncConfigView | undefined): SyncDraft {
  return {
    repoUrl: config?.repoUrl ?? '',
    // The branch and the directory always carry a value: the Host fills them
    // with its defaults, so the form shows what a push would really use. The
    // commit author stays empty when nobody set one, because Git then records
    // the identity this machine already has.
    branch: config?.branch ?? MNEMON_SYNC_DEFAULT_BRANCH,
    subdir: config?.subdir ?? MNEMON_SYNC_DEFAULT_SUBDIR,
    token: '',
    clearToken: false,
    authorName: config?.authorName ?? '',
    authorEmail: config?.authorEmail ?? '',
    autoBackupMinutes: config?.autoBackupMinutes ?? 0,
  }
}

/** A repository is the one thing a save cannot invent, so it gates the save button. */
function configured(draft: SyncDraft): boolean {
  return draft.repoUrl.trim() !== ''
}

/**
 * What a merge actually did. The Host states it as counts, because "added the branch's
 * memories" is false when this machine's own deletions kept every one of them out, and a
 * reader who is told the wrong thing will not look for the button that overrules them.
 */
function addedNotice(t: MnemonTranslate, result: MnemonSyncPullResult): string {
  const report = result.runtime
  const commit = result.commit.slice(0, 8)
  const root = result.targetRoot
  if (report !== undefined && report.added === 0 && report.held > 0) return t('config.syncDiffAddHeld', { count: report.held })
  const parts = [t('config.syncDiffAdded', { commit, root })]
  if (report !== undefined && report.held > 0) parts.push(t('config.syncDiffAddHeld', { count: report.held }))
  return parts.join(' ')
}

function stamp(value: string | undefined): string {
  if (value === undefined) return ''
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString()
}

/** The name a backup or a difference is attributed to, as a reader can act on it. */
function ownerName(t: MnemonTranslate, machine: { id: string; label: string } | undefined): string {
  if (machine === undefined) return t('config.syncBackupUnknownMachine')
  return machine.label.trim() === '' ? machine.id : machine.label
}

/** One line of text as a reader scans it: whitespace collapsed, then cut to a readable length. */
function clip(value: string, max: number): string {
  const text = value.replace(/\s+/gu, ' ').trim()
  return text.length <= max ? text : text.slice(0, max - 1) + '…'
}

interface MnemonSyncSectionProps {
  connection?: ClientConnectionHandle
  sessionId?: string
  workspaceId?: string
  /** Whether the Host accepts writes at all; a read-only Host only reports status. */
  disabled: boolean
  /**
   * Whether this installation syncs at all. Off is the default, and off is
   * silent: the section asks the Host nothing and runs no Git.
   */
  enabled: boolean
  /** Saves the switch's choice; the storage section above owns the stored value. */
  onEnabled: (enabled: boolean) => void
  t: MnemonTranslate
}

/**
 * Git repository sync: the repository this root publishes its Mnemon Pack to,
 * the credential that authenticates the push, and the two operations that move
 * the payload. The form reads the Host's status first, so a repository the Host
 * cannot reach, a missing Git, or a read-only Host is visible before anything
 * runs.
 *
 * The credential is optional: signing in to GitHub stores a grant the Host reads
 * per operation, and the repository then comes from the account instead of being
 * typed. The access token field stays as the fallback for every other host.
 *
 * The switch is the whole gate: switched off, this section is one row that asks
 * the Host nothing — no status, no repository, no Git — and switching it on is
 * what unfolds the form, the operations and the branch history.
 */
/** How long the row waits for the Host to report the switch it just saved. */
const STATUS_SETTLE_MS = 250
const STATUS_SETTLE_ATTEMPTS = 20

export function MnemonSyncSection({ connection, sessionId, workspaceId, disabled, enabled, onEnabled, t }: MnemonSyncSectionProps): JSX.Element {
  const client = useMemo(() => connection === undefined ? null : new MnemonClient(connection, sessionId, workspaceId), [connection, sessionId, workspaceId])
  const [status, setStatus] = useState<MnemonSyncStatus | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [draft, setDraft] = useState<SyncDraft>(() => draftOf(undefined))
  const [pending, setPending] = useState<MnemonSyncPreview | null>(null)
  const [busy, setBusy] = useState<'save' | 'push' | 'preview' | 'pull' | 'backups' | 'more' | 'diff' | 'add' | 'revive' | 'github' | 'repos' | 'create' | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [github, setGithub] = useState<MnemonSyncGitHubStatus | null>(null)
  const [githubFailed, setGithubFailed] = useState<string | null>(null)
  const [repositories, setRepositories] = useState<MnemonSyncGitHubRepository[] | null>(null)
  const [repositoryName, setRepositoryName] = useState('')
  const [repositoryPrivate, setRepositoryPrivate] = useState(true)
  const [backups, setBackups] = useState<MnemonSyncBackupList | null>(null)
  const [openCommit, setOpenCommit] = useState<string | null>(null)
  const [difference, setDifference] = useState<MnemonSyncDiff | null>(null)
  // The branch history and the differences are one reading of the same branch, so they
  // share one dialog; the dialog opens as soon as either answer is asked for.
  const [dialog, setDialog] = useState(false)
  const [copied, setCopied] = useState(false)
  // The automatic backup interval is written the moment it is chosen: it is one
  // number with no half-typed state, and waiting for a Save would let a reader
  // believe a cadence is on while the Host still holds the old one.
  const [autoBackupSaving, setAutoBackupSaving] = useState(false)
  // The sign-in poll reschedules itself; a counter re-runs the effect after each answer.
  const [pollTick, setPollTick] = useState(0)
  const [pollMs, setPollMs] = useState(5_000)
  const askedRepositories = useRef(false)

  const refresh = useCallback(async (): Promise<void> => {
    if (client === null || !enabled) return
    try {
      setStatus(await client.syncStatus())
    } catch (reason) {
      setFailed(message(reason))
    } finally {
      setLoaded(true)
    }
    try {
      setGithub(await client.githubStatus())
    } catch {
      // The sign-in block reports its own failures; the repository row works without it.
    }
  }, [client, enabled])

  useEffect(() => {
    if (client === null) { setLoaded(true); return }
    // Switched off there is nothing to report: reading the channel here would run
    // Git for a reader who never asked for a repository.
    if (!enabled) return
    let active = true
    // The switch saves the profile first, and until the Host's runtime has the new value
    // the channel still answers as switched off, with nothing checked. Read again for a
    // moment instead of showing that answer as the state of Git and the remote.
    setLoaded(false)
    void (async () => {
      let next = await client.syncStatus()
      for (let attempt = 0; active && next.enabled === false && attempt < STATUS_SETTLE_ATTEMPTS; attempt += 1) {
        await new Promise(settle => setTimeout(settle, STATUS_SETTLE_MS))
        next = await client.syncStatus()
      }
      return next
    })().then(
      next => { if (active) { setStatus(next); setLoaded(true) } },
      reason => { if (active) { setFailed(message(reason)); setLoaded(true) } },
    )
    void client.githubStatus().then(
      next => { if (active) setGithub(next) },
      () => { if (active) setGithub(null) },
    )
    return () => { active = false }
  }, [client, enabled])

  // The saved configuration seeds the form; a repository typed here is not saved until the user saves it.
  const saved = status?.config
  useEffect(() => { setDraft(draftOf(saved)) }, [saved?.repoUrl, saved?.branch, saved?.subdir, saved?.authorName, saved?.authorEmail, saved?.hasToken, saved?.autoBackupMinutes])

  const save = async (): Promise<void> => {
    if (client === null || busy !== null) return
    setBusy('save'); setFailed(null); setNotice(null)
    try {
      const patch: { repoUrl?: string | null; branch?: string; subdir?: string; token?: string | null; authorName?: string; authorEmail?: string; autoBackupMinutes?: number } = {
        branch: draft.branch, subdir: draft.subdir, authorName: draft.authorName, authorEmail: draft.authorEmail,
        autoBackupMinutes: draft.autoBackupMinutes,
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
    setBusy('push'); setFailed(null); setNotice(null); setPending(null); setBackups(null); setDifference(null)
    try {
      const result = await client.pushSync()
      const parts = [result.pushed
        ? t('config.syncPushed', { commit: result.commit.slice(0, 8), files: result.files, size: humanBytes(result.bytes) })
        : result.committed
          ? t('config.syncPushedLocal', { commit: result.commit.slice(0, 8), reason: result.reason ?? '' })
          : t('config.syncPushIdle')]
      // Folding the mirror's loose objects is housekeeping the push did on its
      // own; saying what it recovered is the only way the size is ever visible.
      const compaction = result.compaction
      if (compaction !== undefined && compaction.warning === undefined && compaction.loose > 0) {
        parts.push(t('config.syncCompacted', { count: compaction.loose, before: humanBytes(compaction.bytes), after: humanBytes(compaction.packedBytes) }))
      }
      setNotice(parts.join(' '))
      await refresh()
    } catch (reason) {
      setFailed(message(reason))
    } finally { setBusy(null) }
  }

  /** Turning the automatic backup on, off or to another interval is one saved value. */
  const setAutoBackup = async (minutes: number): Promise<void> => {
    if (client === null || busy !== null || autoBackupSaving) return
    setAutoBackupSaving(true); setFailed(null); setNotice(null)
    try {
      const next = await client.configureSync({ autoBackupMinutes: minutes })
      setStatus(current => current === null ? current : { ...current, config: next })
      setNotice(t('config.syncAutoBackupSaved', { interval: intervalLabel(t, minutes) }))
    } catch (reason) {
      setFailed(message(reason))
    } finally { setAutoBackupSaving(false) }
  }

  const preview = async (): Promise<void> => {
    if (client === null || busy !== null) return
    setBusy('preview'); setFailed(null); setNotice(null); setPending(null); setDifference(null)
    try {
      setPending(await client.previewSync())
      // The byte-level answer says how much differs; the entry-level answer says which
      // memories do. A difference that cannot be read leaves the preview standing.
      try {
        setDifference(await client.syncDiff())
        setDialog(true)
      } catch { setDifference(null) }
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
      setPending(null); setBackups(null); setDifference(null)
      await refresh()
    } catch (reason) {
      setFailed(message(reason))
    } finally { setBusy(null) }
  }

  /**
   * The branch as one reading: the history of what was published, when, and by which
   * installation, and - below it - which memories differ. The commit message is whatever
   * its author typed, so the manifest inside the commit is what names the machine and
   * says what the backup held.
   *
   * A difference that cannot be read still leaves the history standing: the two answers
   * are separate requests and either one alone is worth showing.
   */
  const loadHistory = async (): Promise<void> => {
    if (client === null || busy !== null) return
    setBusy('backups'); setFailed(null); setNotice(null); setDialog(true)
    try {
      setBackups(await client.syncBackups())
    } catch (reason) {
      setFailed(message(reason))
    } finally { setBusy(null) }
    try {
      setDifference(await client.syncDiff())
    } catch {
      setDifference(null)
    }
  }

  /**
   * Older backups, appended to the page already read. The branch's history is a window
   * that grows one page at a time; a page the branch no longer holds is not read twice,
   * so the list keeps what it already had.
   */
  const loadMore = async (): Promise<void> => {
    if (client === null || busy !== null || backups === null) return
    setBusy('more'); setFailed(null); setNotice(null)
    try {
      const page = await client.syncBackups(backups.commits.length + BACKUP_PAGE)
      setBackups({ ...page, commits: [...backups.commits, ...page.commits.filter(commit => !backups.commits.some(held => held.commit === commit.commit))] })
    } catch (reason) {
      setFailed(message(reason))
    } finally { setBusy(null) }
  }

  /** Which memories are only here and which are only on the branch, before merging anything. */
  const loadDifference = async (): Promise<void> => {
    if (client === null || busy !== null) return
    setBusy('diff'); setFailed(null); setNotice(null); setDialog(true)
    try {
      setDifference(await client.syncDiff())
    } catch (reason) {
      setFailed(message(reason))
    } finally { setBusy(null) }
  }

  /**
   * The plain case: the branch holds memories this installation does not, and no subject
   * is stated twice. Merging is additive and honors the branch's removals, so there is
   * nothing to decide - the entries are simply added.
   */
  const addRemote = async (revive = false): Promise<void> => {
    if (client === null || busy !== null || difference === null) return
    setBusy(revive ? 'revive' : 'add'); setFailed(null); setNotice(null)
    try {
      const result = await client.pullSync(undefined, revive)
      setNotice(addedNotice(t, result))
      setPending(null)
      await refresh()
      try {
        setDifference(await client.syncDiff())
      } catch {
        setDifference(null)
      }
    } catch (reason) {
      setFailed(message(reason))
    } finally { setBusy(null) }
  }

  /**
   * A conflict needs a plan, and the plan is the review ledger's: **整理记忆** below runs
   * the reconciliation, reads the proposal and applies it, so this page never keeps a
   * second copy of it. What this page does is read the branch and say what differs.
   */
  /**
   * The plan is the review ledger's, and the review list below this row is the one place it
   * is read, decided and applied. This closes the dialog and puts the reader on that row,
   * so a conflict found here has one obvious way to be answered.
   */
  const goToReview = (): void => {
    setDialog(false)
    const heading = document.getElementById('mnemon-review-heading')
    if (heading === null) return
    if (typeof heading.scrollIntoView === 'function') heading.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }

  /** Choosing a repository is the whole configuration step, so it is saved at once. */
  const choose = async (repository: MnemonSyncGitHubRepository): Promise<void> => {
    if (client === null || busy !== null || !editable) return
    setBusy('save'); setFailed(null); setNotice(null)
    try {
      await client.configureSync({ repoUrl: repository.url })
      setNotice(t('config.syncSaved'))
      await refresh()
    } catch (reason) {
      setFailed(message(reason))
    } finally { setBusy(null) }
  }

  const loadRepositories = useCallback(async (): Promise<void> => {
    if (client === null || busy !== null) return
    setBusy('repos'); setGithubFailed(null)
    try {
      const answer = await client.githubRepositories()
      setRepositories(answer.repositories)
    } catch (reason) {
      setGithubFailed(message(reason))
    } finally { setBusy(null) }
  }, [client, busy])

  const signIn = async (): Promise<void> => {
    if (client === null || busy !== null) return
    setBusy('github'); setGithubFailed(null); setNotice(null)
    try {
      const next = await client.githubStart()
      setGithub(next)
      setPollMs(next.flow?.intervalMs ?? 5_000)
      setPollTick(0)
    } catch (reason) {
      setGithubFailed(message(reason))
    } finally { setBusy(null) }
  }

  const cancelSignIn = async (): Promise<void> => {
    if (client === null || busy !== null) return
    setBusy('github'); setGithubFailed(null)
    try {
      setGithub(await client.githubCancel())
    } catch (reason) {
      setGithubFailed(message(reason))
    } finally { setBusy(null) }
  }

  const signOut = async (): Promise<void> => {
    if (client === null || busy !== null) return
    setBusy('github'); setGithubFailed(null); setNotice(null)
    try {
      setGithub(await client.githubSignOut())
      askedRepositories.current = false
      setRepositories(null)
      await refresh()
    } catch (reason) {
      setGithubFailed(message(reason))
    } finally { setBusy(null) }
  }

  const createRepository = async (): Promise<void> => {
    if (client === null || busy !== null || repositoryName.trim() === '') return
    setBusy('create'); setFailed(null); setGithubFailed(null); setNotice(null)
    try {
      const created = await client.githubCreateRepository(repositoryName.trim(), repositoryPrivate)
      setNotice(t('config.syncRepositoryCreated', { name: created.fullName }))
      setRepositoryName('')
      askedRepositories.current = false
      await loadRepositories()
      await choose(created)
    } catch (reason) {
      setGithubFailed(message(reason))
    } finally { setBusy(null) }
  }

  const copyCode = async (code: string): Promise<void> => {
    try {
      setCopied(await writeClipboard(code))
    } catch {
      setCopied(false)
    }
  }

  const flow = github?.flow
  const signedIn = github?.signedIn === true

  // The device flow is polled on the cadence GitHub asked for, and only while the form is open.
  useEffect(() => {
    if (client === null || !enabled || flow === undefined) return
    let active = true
    const timer = setTimeout(() => {
      void (async (): Promise<void> => {
        try {
          const answer = await client.githubPoll()
          if (!active) return
          if (answer.status === 'pending') {
            if (answer.intervalMs !== undefined) setPollMs(answer.intervalMs)
            setPollTick(current => current + 1)
            return
          }
          const next = await client.githubStatus()
          if (!active) return
          setGithub(next)
          if (answer.status === 'success') {
            askedRepositories.current = false
            setRepositories(null)
            setNotice(next.login === undefined ? t('config.syncTokenGitHub') : t('config.syncGitHubSignedIn', { login: next.login }))
          } else if (answer.status === 'expired') setGithubFailed(t('config.syncGitHubExpired'))
          else if (answer.status === 'denied') setGithubFailed(t('config.syncGitHubDenied'))
          else if (answer.message !== undefined) setGithubFailed(answer.message)
        } catch (reason) {
          if (active) setGithubFailed(message(reason))
        }
      })()
    }, Math.max(pollMs, 1_000))
    return () => { active = false; clearTimeout(timer) }
  }, [client, enabled, flow?.userCode, pollMs, pollTick, t])

  // A signed-in account offers its repositories as soon as the form opens, once per sign-in.
  useEffect(() => {
    if (!enabled || !signedIn || repositories !== null || askedRepositories.current) return
    askedRepositories.current = true
    void loadRepositories()
  }, [enabled, signedIn, repositories, loadRepositories])

  // One line of state: the repository, then whatever the Host says about it.
  const states: string[] = []
  if (!loaded) states.push(t('config.syncLoading'))
  else if (status === null) states.push(t('config.syncUnavailable'))
  // An answer from before the switch reached the Host checked nothing, so it says nothing about Git.
  else if (status.enabled === false) states.push(t('config.syncLoading'))
  else {
    if (!status.configured) states.push(t('config.syncNotConfigured'))
    if (!status.git.available) states.push(t('config.syncGitMissing', { required: status.git.required }))
    if (status.configured && status.git.available) {
      if (!status.remote.reachable) states.push(t('config.syncRemoteUnreachable'))
      else if (!status.remote.branchExists) states.push(t('config.syncRemoteBranchMissing', { branch: status.config.branch }))
      else if (status.remote.commit !== undefined) states.push(t('config.syncRemoteCommit', { commit: status.remote.commit.slice(0, 8) }))
    }
    const credential = status.config.credentialSource
    if (credential === 'github') states.push(status.config.credentialLogin === undefined ? t('config.syncTokenGitHub') : t('config.syncGitHubSignedIn', { login: status.config.credentialLogin }))
    else if (credential === 'environment') states.push(t('config.syncTokenEnvironment'))
    else if (credential === 'token') states.push(t('config.syncTokenSaved'))
    else states.push(t('config.syncTokenNone'))
  }
  const autoBackup = status?.autoBackup
  const ready = client !== null && status !== null && status.configured && status.git.available
  const editable = !disabled && client !== null
  const changed = pending?.components.filter(component => component.changed).length ?? 0
  const selected = repositories?.some(repository => repository.url === draft.repoUrl) === true ? draft.repoUrl : ''
  // What the difference asks of the reader: a plan only where a subject is stated twice,
  // a plain addition where the branch only holds memories this installation lacks. The two
  // sides of a conflict stay in the raw diffs, so they are taken out of both counts here:
  // neither of them can be added or pushed on its own.
  const conflicts = difference?.conflicts ?? []
  const conflicted = new Set(conflicts.flatMap(conflict => [conflict.target + '\u0000' + conflict.local.content, conflict.target + '\u0000' + conflict.remote.content]))
  const additions = difference === null ? 0 : difference.remoteOnly.filter(entry => !conflicted.has(entry.target + '\u0000' + entry.content)).length
  // The branch's entries this machine once deleted: a merge honors those deletions, so
  // offering to "add" them is an offer that would write nothing at all.
  const heldBack = difference?.heldBack ?? 0
  const addable = Math.max(additions - heldBack, 0)
  const onlyHere = difference === null ? 0 : difference.localOnly.filter(entry => !conflicted.has(entry.target + '\u0000' + entry.content)).length

  return <div className={css.syncRow} role="group" aria-labelledby="mnemon-sync-heading">
    <ToggleRow id="mnemon-sync-enabled" titleId="mnemon-sync-heading" label={t('config.syncTitle')} hint={t('config.syncSimpleDescription')}
      checked={enabled} disabled={disabled} onChange={onEnabled} />
    {enabled && <>
      <div className={css.rowActions}>
        <Button variant="outline" size="sm" disabled={!ready || busy !== null} onClick={() => void preview()}>{busy === 'preview' ? t('config.syncPreviewing') : t('config.syncPreview')}</Button>
        <Button variant="outline" size="sm" disabled={!ready || busy !== null} onClick={() => void loadHistory()}>{busy === 'backups' ? t('config.syncBackupsLoading') : t('config.syncBackups')}</Button>
        <Button variant="primary" size="sm" disabled={!ready || disabled || busy !== null} onClick={() => void push()}>{busy === 'push' ? t('config.syncPushing') : t('config.syncPush')}</Button>
      </div>
      <div className={css.syncState} aria-live="polite">{states.map(state => <span key={state}>{state}</span>)}</div>
      <div className={css.syncForm}>
        <div className={css.syncBlock}>
          <header>
            <strong>{t('config.syncGitHub')}</strong>
            {signedIn && <div className={css.syncAccount}>
              <span>{github?.login === undefined ? t('config.syncTokenGitHub') : t('config.syncGitHubSignedIn', { login: github.login })}</span>
              <Button variant="ghost" size="sm" disabled={!editable || busy !== null} onClick={() => void signOut()}>{t('config.syncGitHubSignOut')}</Button>
            </div>}
          </header>
          {github === null && <small>{t('config.syncLoading')}</small>}
          {github !== null && !github.available && <small>{t('config.syncGitHubUnavailable')}</small>}
          {github !== null && github.available && !signedIn && flow === undefined && <>
            <small>{t('config.syncGitHubHint')}</small>
            {github.writable
              ? <div className={css.syncFormActions}>
                <Button variant="outline" size="sm" disabled={!editable || busy !== null} onClick={() => void signIn()}>{busy === 'github' ? t('config.syncGitHubStarting') : t('config.syncGitHubSignIn')}</Button>
              </div>
              : <small>{t('config.syncGitHubReadOnly')}</small>}
          </>}
          {flow !== undefined && !signedIn && <>
            <small>{t('config.syncGitHubCode')}</small>
            <div className={css.syncCode}>
              <code>{flow.userCode}</code>
              <Button variant="outline" size="sm" onClick={() => void copyCode(flow.userCode)}>{copied ? t('config.syncGitHubCopied') : t('config.syncGitHubCopy')}</Button>
              <a href={flow.verificationUri} target="_blank" rel="noreferrer noopener">{t('config.syncGitHubOpen')}</a>
            </div>
            <small>{t('config.syncGitHubWaiting')}</small>
            <div className={css.syncFormActions}>
              <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void cancelSignIn()}>{t('common.cancel')}</Button>
            </div>
          </>}
          {githubFailed !== null && <p className={css.error}>{t('config.syncGitHubFailed', { error: githubFailed })}</p>}
        </div>
        <div className={css.syncBlock}>
          <header>
            <strong>{t('config.syncAutoBackup')}</strong>
          </header>
          <small>{t('config.syncAutoBackupHint')}</small>
          <div className={css.syncField}>
            <label htmlFor="mnemon-sync-auto-backup">{t('config.syncAutoBackup')}</label>
            <select id="mnemon-sync-auto-backup" value={String(draft.autoBackupMinutes)} disabled={!editable || autoBackupSaving}
              onChange={event => void setAutoBackup(Number(event.target.value))}>
              {AUTO_BACKUP_CHOICES.map(minutes => <option key={minutes} value={String(minutes)}>{intervalLabel(t, minutes)}</option>)}
            </select>
          </div>
          {autoBackup !== undefined && <small>{autoBackup.available
            ? (autoBackup.nextAt === undefined ? '' : t('config.syncAutoBackupNext', { at: stamp(autoBackup.nextAt) }))
            : t('config.syncAutoBackupNever')}</small>}
          {autoBackup?.lastAt !== undefined && <small>{t('config.syncAutoBackupLast', { at: stamp(autoBackup.lastAt) })}</small>}
          {autoBackup?.lastError !== undefined && <small className={css.error}>{t('config.syncAutoBackupFailed', { error: autoBackup.lastError })}</small>}
        </div>
        {github !== null && github.available && <div className={css.syncBlock}>
          <header>
            <strong>{t('config.syncRepositories')}</strong>
            {repositories !== null && <Button variant="ghost" size="sm" disabled={!editable || busy !== null} onClick={() => void loadRepositories()}>{busy === 'repos' ? t('config.syncRepositoriesLoading') : t('config.syncRepositoriesLoad')}</Button>}
          </header>
          {!signedIn && <small>{t('config.syncRepositoriesSignIn')}</small>}
          {signedIn && <>
            {repositories === null && <small>{busy === 'repos' ? t('config.syncRepositoriesLoading') : t('config.syncRepositoriesHint')}</small>}
            {repositories !== null && repositories.length === 0 && <small>{t('config.syncRepositoriesEmpty')}</small>}
            {repositories !== null && repositories.length > 0 && <div className={css.syncField}>
              <label htmlFor="mnemon-sync-repository">{t('config.syncRepositories')}</label>
              <select id="mnemon-sync-repository" value={selected} disabled={!editable || busy !== null}
                onChange={event => {
                  const repository = repositories.find(candidate => candidate.url === event.target.value)
                  if (repository !== undefined) void choose(repository)
                }}>
                <option value="">{t('config.syncRepositoriesChoose')}</option>
                {repositories.map(repository => <option key={repository.fullName} value={repository.url} disabled={!repository.push}>
                  {repository.fullName + (repository.private ? ' · ' + t('config.syncRepositoriesPrivate') : '') + (repository.push ? '' : ' · ' + t('config.syncRepositoriesNoPush'))}
                </option>)}
              </select>
              <small>{t('config.syncRepoUrlHint')}</small>
            </div>}
            <div className={css.syncField}>
              <label htmlFor="mnemon-sync-repository-name">{t('config.syncRepositoryName')}</label>
              <input id="mnemon-sync-repository-name" type="text" value={repositoryName} placeholder="mnemon-memory"
                disabled={!editable || busy !== null} autoComplete="off" spellCheck={false} autoCapitalize="none" autoCorrect="off"
                onChange={event => setRepositoryName(event.target.value)} />
              <label className={css.syncCheck}>
                <input type="checkbox" checked={repositoryPrivate} disabled={!editable || busy !== null}
                  onChange={event => setRepositoryPrivate(event.target.checked)} />
                <span>{t('config.syncRepositoryPrivate')}</span>
              </label>
            </div>
            <div className={css.syncFormActions}>
              <Button variant="outline" size="sm" disabled={!editable || busy !== null || repositoryName.trim() === ''} onClick={() => void createRepository()}>{busy === 'create' ? t('config.syncRepositoryCreating') : t('config.syncRepositoryCreate')}</Button>
            </div>
          </>}
        </div>}
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
          <small>{t('config.syncTokenOptional')}</small>
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
          <input id="mnemon-sync-author-name" type="text" value={draft.authorName} placeholder={t('config.syncAuthorOptional')} disabled={!editable}
            autoComplete="off" spellCheck={false}
            onChange={event => setDraft(current => ({ ...current, authorName: event.target.value }))} />
          <small>{t('config.syncAuthorHint')}</small>
        </div>
        <div className={css.syncField}>
          <label htmlFor="mnemon-sync-author-email">{t('config.syncAuthorEmail')}</label>
          <input id="mnemon-sync-author-email" type="text" value={draft.authorEmail} placeholder={t('config.syncAuthorOptional')} disabled={!editable}
            autoComplete="off" spellCheck={false}
            onChange={event => setDraft(d => ({ ...d, authorEmail: event.target.value }))} />
        </div>
        <div className={css.syncFormActions}>
          <Button variant="primary" size="sm" disabled={!editable || busy !== null || !configured(draft)} onClick={() => void save()}>{busy === 'save' ? t('config.syncSave') + '…' : t('config.syncSave')}</Button>
        </div>
      </div>
      {pending !== null && <div className={css.syncBar} role="status">
        <div>
          <strong>{t('config.syncPreviewReady', { commit: pending.commit.slice(0, 8), components: pending.manifest.components.length, size: humanBytes(pending.archiveBytes) })}</strong>
          <small>{t('config.syncPreviewComponents', { changed, total: pending.components.length })}</small>
          <small>{t('config.syncPreviewFiles', { added: pending.files.added, removed: pending.files.removed, changed: pending.files.changed })}</small>
        </div>
        <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => setPending(null)}>{t('common.cancel')}</Button>
        <Button variant="primary" size="sm" disabled={busy !== null || disabled} onClick={() => void pull()}>{busy === 'pull' ? t('config.syncPulling') : t('config.syncPull')}</Button>
      </div>}
      {dialog && <MnemonDialog title={t('config.syncBackups')} closeLabel={t('common.close')} wide
        busy={busy !== null} onClose={() => setDialog(false)}>
        <div className={css.syncDialogBody}>
          <div className={css.syncBackups}>
            <header>
              <strong>{t('config.syncBackupsTitle', { branch: backups?.branch ?? status?.config.branch ?? '' })}</strong>
              <div className={css.rowActions}>
                <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void loadHistory()}>{busy === 'backups' ? t('config.syncBackupsLoading') : t('review.refresh')}</Button>
              </div>
            </header>
            {backups === null
              ? <small>{t('config.syncBackupsLoading')}</small>
              : <>
                <small>{t('config.syncBackupsHint', { subdir: backups.subdir })}</small>
                {backups.commits.length === 0
                  ? <small>{t('config.syncBackupsEmpty')}</small>
                  : <div className={css.syncBackupList}>
                    {backups.commits.map(commit => <div key={commit.commit} className={css.syncBackupEntry}>
                      <header>
                        <div className={css.reviewTitle}>
                          <strong>{commit.message}</strong>
                          <Tag tone="quiet">{commit.commit.slice(0, 8)}</Tag>
                        </div>
                        <div className={css.rowActions}>
                          <Button variant="ghost" size="sm" disabled={busy !== null}
                            onClick={() => setOpenCommit(openCommit === commit.commit ? null : commit.commit)}>
                            {openCommit === commit.commit ? t('review.collapse') : t('review.expand')}</Button>
                        </div>
                      </header>
                      <small>{t('config.syncBackupMeta', { machine: ownerName(t, commit.machine), time: stamp(commit.committedAt) })}</small>
                      {commit.pushedAt !== undefined && <small>{t('config.syncBackupPushedAt', { time: stamp(commit.pushedAt) })}</small>}
                      {openCommit === commit.commit && <div className={css.syncBackupComponents}>
                        {commit.components.length === 0
                          ? <small>{t('config.syncBackupNoComponents')}</small>
                          : commit.components.map(component => <small key={component.component}>
                              {t('config.syncBackupComponent', { component: component.component, items: component.items, files: component.files, size: humanBytes(component.bytes) })}
                            </small>)}
                      </div>}
                    </div>)}
                    {/* The history is read one page at a time; asking for more appends what the
                        branch holds beyond the page already read, and stops offering once it is done. */}
                    {backups.truncated && <div className={css.rowActions}>
                      <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void loadMore()}>
                        {busy === 'more' ? t('config.syncBackupsLoading') : t('config.syncBackupsMore')}</Button>
                    </div>}
                  </div>}
              </>}
          </div>
          <div className={css.syncDiff}>
            <header>
              <strong>{t('config.syncDiffTitle', { commit: difference?.commit.slice(0, 8) ?? '', shared: difference?.shared ?? 0 })}</strong>
              <div className={css.rowActions}>
                <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void loadDifference()}>{busy === 'diff' ? t('config.syncPreviewing') : t('review.refresh')}</Button>
              </div>
            </header>
            {difference === null
              ? <small>{t('config.syncBackupsLoading')}</small>
              : <>
                <small>{t('config.syncDiffSides', { local: difference.local.entries, remote: difference.remote.entries, machine: ownerName(t, difference.remote.machine) })}</small>
                {difference.truncated && <small>{t('config.syncDiffTruncated')}</small>}
                {difference.remoteTombstones.length > 0 && <small>{t('config.syncDiffTombstones', { count: difference.remoteTombstones.length })}</small>}
                {conflicts.length === 0
                  ? <p className={css.syncDialogNote}>{additions === 0 ? t('config.syncDiffNothing') : t('config.syncDiffClear')}</p>
                  : <p className={css.syncDialogNote}>{t('config.syncDiffConflicts', { count: conflicts.length })}</p>}
                {conflicts.length === 0 && addable > 0 && <p className={css.syncDialogNote}>{t('config.syncDiffAdditions', { count: addable })}</p>}
                {/* Entries this machine deleted itself: a merge leaves them out, and only an
                    explicit revival puts them back, so the page says so before it offers it. */}
                {conflicts.length === 0 && heldBack > 0 && <p className={css.syncDialogNote}>{t('config.syncDiffHeldBack', { count: heldBack })}</p>}
                {conflicts.length === 0 && onlyHere > 0 && <p className={css.syncDialogNote}>{t('config.syncDiffLocalOnlyNote', { count: onlyHere })}</p>}
                {conflicts.length > 0 && <div className={css.syncConflictList}>
                  {conflicts.map(conflict => <div key={conflict.target + '\u0000' + conflict.local.content} className={css.syncConflict} data-target={conflict.target}>
                    <header>
                      <strong>{t(conflict.target === 'user' ? 'review.targetUser' : 'review.targetMemory')}</strong>
                      <small>{conflict.local.importance + ' · ' + Math.round(conflict.similarity * 100) + '%'}</small>
                    </header>
                    <div className={css.syncConflictSides}>
                      <div>
                        <small>{t('config.syncDiffHere')}</small>
                        <span>{clip(conflict.local.content, 400)}</span>
                      </div>
                      <div>
                        <small>{t('config.syncDiffThere')}</small>
                        <span>{clip(conflict.remote.content, 400)}</span>
                      </div>
                    </div>
                  </div>)}
                </div>}
                {conflicts.length === 0 && (addable > 0 || heldBack > 0) && <div className={css.rowActions}>
                  {addable > 0 && <Button variant="primary" size="sm" disabled={busy !== null || disabled} onClick={() => void addRemote()}>
                    {busy === 'add' ? t('config.syncDiffAdding') : t('config.syncDiffAdd')}</Button>}
                  {heldBack > 0 && <Button variant="outline" size="sm" disabled={busy !== null || disabled} onClick={() => void addRemote(true)}>
                    {busy === 'revive' ? t('config.syncDiffReviving') : t('config.syncDiffRevive')}</Button>}
                </div>}
                {/* The plan is the review ledger's, and the review list below this row is the one
                    place it is read, decided and applied: a second copy here would be a second place
                    to keep in step, which is what this dialog used to be. */}
                {conflicts.length > 0 && <div className={css.syncPlan}>
                  <p className={css.syncDialogNote}>{t('config.syncPlanWhere')}</p>
                  <div className={css.rowActions}>
                    <Button variant="outline" size="sm" onClick={goToReview}>{t('config.syncPlanGo')}</Button>
                  </div>
                </div>}
              </>}
          </div>
        </div>
      </MnemonDialog>}
      <div className={css.syncFeedback} aria-live="polite">
        {failed !== null && <p className={css.error} role="alert">{t('config.syncFailed', { error: failed })}</p>}
        {notice !== null && <p className={css.syncSuccess}>{notice}</p>}
        {client === null && <p className={css.readOnly}>{t('config.syncUnavailable')}</p>}
      </div>
    </>}
  </div>
}

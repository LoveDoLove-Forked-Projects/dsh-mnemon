import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { Button, Tag, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  MNEMON_SYNC_DEFAULT_BRANCH,
  MNEMON_SYNC_DEFAULT_SUBDIR,
  MNEMON_SYNC_TOKEN_ENV,
  type ClientConnectionHandle,
  type MnemonReviewEntry,
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
import { SettingRow } from './settings-controls.tsx'
import { MnemonDialog } from './MnemonDialog.tsx'
import { STATUS_KEY, STATUS_TONE, operationText } from './MnemonReviewSection.tsx'

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
 */
export function MnemonSyncSection({ connection, sessionId, workspaceId, disabled, t }: MnemonSyncSectionProps): JSX.Element {
  const client = useMemo(() => connection === undefined ? null : new MnemonClient(connection, sessionId, workspaceId), [connection, sessionId, workspaceId])
  const [status, setStatus] = useState<MnemonSyncStatus | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<SyncDraft>(() => draftOf(undefined))
  const [pending, setPending] = useState<MnemonSyncPreview | null>(null)
  const [busy, setBusy] = useState<'save' | 'push' | 'preview' | 'pull' | 'backups' | 'diff' | 'add' | 'revive' | 'plan' | 'apply' | 'github' | 'repos' | 'create' | null>(null)
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
  const [plan, setPlan] = useState<MnemonReviewEntry | null>(null)
  const [opinion, setOpinion] = useState('')
  const [copied, setCopied] = useState(false)
  // The sign-in poll reschedules itself; a counter re-runs the effect after each answer.
  const [pollTick, setPollTick] = useState(0)
  const [pollMs, setPollMs] = useState(5_000)
  const askedRepositories = useRef(false)

  const refresh = useCallback(async (): Promise<void> => {
    if (client === null) return
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
  }, [client])

  useEffect(() => {
    if (client === null) { setLoaded(true); return }
    let active = true
    void client.syncStatus().then(
      next => { if (active) { setStatus(next); setLoaded(true) } },
      reason => { if (active) { setFailed(message(reason)); setLoaded(true) } },
    )
    void client.githubStatus().then(
      next => { if (active) setGithub(next) },
      () => { if (active) setGithub(null) },
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
    setBusy('push'); setFailed(null); setNotice(null); setPending(null); setBackups(null); setDifference(null); setPlan(null)
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
    setBusy('preview'); setFailed(null); setNotice(null); setPending(null); setDifference(null); setPlan(null)
    try {
      setPending(await client.previewSync())
      // The byte-level answer says how much differs; the entry-level answer says which
      // memories do. A difference that cannot be read leaves the preview standing.
      try {
        setDifference(await client.syncDiff())
        setDialog(true)
      } catch { setDifference(null) }
      await readPlanQuietly()
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
      setPending(null); setBackups(null); setDifference(null); setPlan(null)
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
    await readPlanQuietly()
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
    await readPlanQuietly()
  }

  /** What the newest proposal holds; the ledger keeps every run, so it is read fresh each time. */
  const readPlan = async (): Promise<void> => {
    if (client === null) return
    const ledger = await client.reviewLedger()
    setPlan(ledger.latest ?? null)
  }

  /**
   * The plan is read whenever the dialog opens, because the review list and the dialog
   * share one ledger: a proposal made or rejected elsewhere is what the reviewer sees here.
   * A ledger that cannot be read leaves the history and the difference standing.
   */
  const readPlanQuietly = async (): Promise<void> => {
    try {
      await readPlan()
    } catch {
      setPlan(null)
    }
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
      await readPlanQuietly()
    } catch (reason) {
      setFailed(message(reason))
    } finally { setBusy(null) }
  }

  /**
   * Only a conflict needs a plan: the run reads both sides, and what it proposes is
   * staged, never written. The reviewer then reads it, says what they think, and either
   * approves it, asks again, or applies it as it stands.
   */
  const planDifference = async (guidance: string): Promise<void> => {
    if (client === null || busy !== null) return
    setBusy('plan'); setFailed(null); setNotice(null)
    try {
      const result = await client.reconcile(guidance)
      const parts = [result.action === 'planned' ? t('review.planned', { operations: result.operations }) : t('review.none')]
      if (result.guided === true) parts.push(t('review.guided'))
      if (result.remoteEntries !== undefined && result.remoteEntries > 0) parts.push(t('review.remoteEntries', { count: result.remoteEntries }))
      setNotice(parts.join(' '))
      await readPlan()
    } catch (reason) {
      setFailed(message(reason))
    } finally { setBusy(null) }
  }

  /** An opinion never decides anything: it is what the next run reads. */
  /**
   * Asking the AI again after a rejection. A decided proposal is answered by its decision,
   * so the reviewer's words only reach the next run once the proposal is open again;
   * reopening is what makes them part of the evidence the run reads.
   */
  const replan = async (): Promise<void> => {
    if (client === null || busy !== null) return
    if (plan !== null && plan.status === 'rejected') {
      setBusy('plan'); setFailed(null); setNotice(null)
      try {
        await client.reopenReview(plan.id)
      } catch (reason) {
        setFailed(message(reason)); setBusy(null); return
      }
      setBusy(null)
    }
    await planDifference('')
  }

  const leavePlanOpinion = async (): Promise<void> => {
    const text = opinion.trim()
    if (client === null || plan === null || text === '') return
    setBusy('plan'); setFailed(null); setNotice(null)
    try {
      setPlan(await client.reviewOpinion(plan.id, text))
      setOpinion('')
      setNotice(t('review.opinionAdded'))
    } catch (reason) {
      setFailed(message(reason))
    } finally { setBusy(null) }
  }

  /** Approving decides the review; nothing is written until it is applied. */
  const approvePlan = async (): Promise<void> => {
    if (client === null || plan === null) return
    setBusy('plan'); setFailed(null); setNotice(null)
    try {
      setPlan(await client.decideReview(plan.id, 'accepted'))
    } catch (reason) {
      setFailed(message(reason))
    } finally { setBusy(null) }
  }

  const applyPlan = async (): Promise<void> => {
    if (client === null || plan === null || busy !== null) return
    setBusy('apply'); setFailed(null); setNotice(null)
    try {
      const result = await client.applyReview(plan.id)
      setNotice(t('review.applied', { count: result.applied }))
      await readPlan()
      await refresh()
    } catch (reason) {
      setFailed(message(reason))
    } finally { setBusy(null) }
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
    if (client === null || !open || flow === undefined) return
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
  }, [client, open, flow?.userCode, pollMs, pollTick, t])

  // A signed-in account offers its repositories as soon as the form opens, once per sign-in.
  useEffect(() => {
    if (!open || !signedIn || repositories !== null || askedRepositories.current) return
    askedRepositories.current = true
    void loadRepositories()
  }, [open, signedIn, repositories, loadRepositories])

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
    const credential = status.config.credentialSource
    if (credential === 'github') states.push(status.config.credentialLogin === undefined ? t('config.syncTokenGitHub') : t('config.syncGitHubSignedIn', { login: status.config.credentialLogin }))
    else if (credential === 'environment') states.push(t('config.syncTokenEnvironment'))
    else if (credential === 'token') states.push(t('config.syncTokenSaved'))
    else states.push(t('config.syncTokenNone'))
  }
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
  const rejected = plan !== null && plan.status === 'rejected'
  // A decided proposal is answered by its decision, so its opinions only reach the next
  // run once the proposal is open again: a rejected plan waits for an opinion first.
  const awaitingOpinion = rejected && plan.opinions.length === 0

  return <div className={css.syncRow} role="group" aria-labelledby="mnemon-sync-heading">
    <SettingRow title={t('config.syncTitle')} titleId="mnemon-sync-heading" hint={t('config.syncSimpleDescription')}>
      <div className={css.rowActions}>
        <Button variant="outline" size="sm" disabled={!editable || busy !== null} onClick={() => setOpen(current => !current)}>{open ? t('config.syncHide') : t('config.syncConfigure')}</Button>
        <Button variant="outline" size="sm" disabled={!ready || busy !== null} onClick={() => void preview()}>{busy === 'preview' ? t('config.syncPreviewing') : t('config.syncPreview')}</Button>
        <Button variant="outline" size="sm" disabled={!ready || busy !== null} onClick={() => void loadHistory()}>{busy === 'backups' ? t('config.syncBackupsLoading') : t('config.syncBackups')}</Button>
        <Button variant="primary" size="sm" disabled={!ready || disabled || busy !== null} onClick={() => void push()}>{busy === 'push' ? t('config.syncPushing') : t('config.syncPush')}</Button>
      </div>
    </SettingRow>
    <div className={css.syncState} aria-live="polite">{states.map(state => <span key={state}>{state}</span>)}</div>
    {open && <div className={css.syncForm}>
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
                  {backups.truncated && <small>{t('config.syncBackupsTruncated')}</small>}
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
              {conflicts.length > 0 && <div className={css.syncPlan}>
                <header>
                  <strong>{t('config.syncDiffPlan')}</strong>
                  <div className={css.rowActions}>
                    <Button variant="outline" size="sm" disabled={busy !== null || disabled || awaitingOpinion} onClick={() => void replan()}>
                      {busy === 'plan' ? t('config.syncDiffReconciling') : plan === null ? t('config.syncDiffReconcile') : t('config.syncDiffPlanAgain')}</Button>
                    {plan !== null && plan.status === 'pending' && <Button variant="primary" size="sm" disabled={busy !== null || disabled}
                      onClick={() => void approvePlan()}>{t('config.syncDiffPlanApprove')}</Button>}
                    {plan !== null && plan.status === 'accepted' && plan.appliedAt === undefined && <Button variant="primary" size="sm" disabled={busy !== null || disabled}
                      onClick={() => void applyPlan()}>{busy === 'apply' ? t('review.applying') : t('config.syncDiffPlanApply')}</Button>}
                  </div>
                </header>
                {plan === null
                  ? <small>{t('review.noOpinions')}</small>
                  : <>
                    <header>
                      <strong>{plan.title}</strong>
                      <Tag tone={STATUS_TONE[plan.status]}>{t(STATUS_KEY[plan.status])}</Tag>
                    </header>
                    <p>{plan.summary}</p>
                    <ol className={css.reviewOperations}>
                      {plan.operations.map((operation, index) => <li key={index}>
                        <span>{operationText(t, operation)}</span>
                        <small>{operation.reason}</small>
                      </li>)}
                    </ol>
                    {plan.appliedAt !== undefined && <small className={css.syncSuccess}>{t('review.appliedAt', { time: stamp(plan.appliedAt) })}</small>}
                    {/* Applying writes this installation only: the branch keeps the old text until a push. */}
                    {plan.appliedAt !== undefined && conflicts.length > 0 && <small className={css.warning}>{t('config.syncDiffAppliedPush')}</small>}
                    {plan.status === 'rejected' && <small>{t('config.syncDiffPlanRejected')}</small>}
                    <div className={css.reviewOpinions}>
                      <strong>{t('review.opinions')}</strong>
                      {plan.opinions.length === 0
                        ? <small>{t('review.noOpinions')}</small>
                        : plan.opinions.map(item => <div key={item.id}>
                            <strong>{item.author === 'agent' ? t('review.authorAgent') : t('review.authorUser')}</strong>
                            <span>{item.text}</span>
                          </div>)}
                    </div>
                    <div className={css.reviewOpinionForm}>
                      <input type="text" value={opinion} placeholder={t('review.opinionPlaceholder')} aria-label={t('review.opinions')}
                        disabled={busy !== null} onChange={event => setOpinion(event.target.value)} />
                      <Button variant="outline" size="sm" disabled={busy !== null || opinion.trim() === ''}
                        onClick={() => void leavePlanOpinion()}>{t('review.opinionSend')}</Button>
                    </div>
                  </>}
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
  </div>
}

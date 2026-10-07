import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { zipSync, unzipSync, type Unzipped } from 'fflate'
import type { ResolvedConfig } from './config.ts'
import { runProcess, type ProcessRunner } from './process.ts'
import {
  MnemonPackManager, MNEMON_PACK_MAX_EXPANDED_BYTES, RUNTIME_MEMORIES_PATH, RUNTIME_TOMBSTONE_PATH,
  entryKey, parseManifest as parseManifestJson, parseRuntime, parseTombstones, tombstoneCovers, tombstoneKey,
  type RuntimeFile, type StoredRuntimeEntry,
} from './pack.ts'
import type {
  MnemonPackComponent, MnemonPackImportMode, MnemonPackManifest, MnemonSyncBackup, MnemonSyncBackupList,
  MnemonSyncComponentDelta, MnemonSyncConfigView, MnemonSyncCredentialSource, MnemonSyncDiff, MnemonSyncDiffConflict,
  MnemonSyncDiffEntry,
  MnemonSyncFileDelta, MnemonSyncGitStatus, MnemonSyncPreview, MnemonSyncPullResult, MnemonSyncPushResult,
  MnemonSyncRemoteStatus, MnemonSyncStatus, MnemonTombstone, MnemonTombstoneFile,
} from './protocol.ts'
import { RUNTIME_MEMORY_LIMITS, type RuntimeMemoryLimits } from 'dsh-mnemon-source-runtime/contracts'
import { MNEMON_PACK_COMPONENTS, MNEMON_SYNC_TOKEN_ENV } from './protocol.ts'
import { MnemonGitHubAuth } from './github-auth.ts'
import { MnemonMachineStore } from './machine-identity.ts'
import type { StorageRoot } from './storage-root.ts'
import { MnemonSyncSettingsStore, type MnemonSyncSettings } from './sync-config.ts'

/** The oldest Git the channel drives: `archive`, `ls-remote`, `-C`, and `credential` all predate it. */
export const MNEMON_SYNC_MINIMUM_GIT = '2.20'
export const MNEMON_SYNC_GIT_TIMEOUT_MS = 120_000

const GIT_LABEL = 'git'
const MANIFEST = 'manifest.json'
const CHECKSUMS = 'checksums.json'
const SYNC_EXTENSION = 'sync'
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024
const MAX_PAYLOAD_BYTES = 256 * 1024 * 1024
const MAX_FILE_BYTES = 128 * 1024 * 1024
const LOCK_TIMEOUT_MS = 30_000
/** One log page stays well under the process output cap, and the reader sees the newest first. */
const MAX_BACKUPS = 100
const DEFAULT_BACKUP_LIMIT = 20
/** How many older commits a page says it withheld before it stops paying for the walk. */
const BACKUP_WALK_LIMIT = 200
const MAX_DIFF_ENTRIES = 200
/** Git on Windows would otherwise rewrite line endings and break every checksum. */
const NO_REWRITE = ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf']
/**
 * Git reads where the repository is from the environment, so a launcher that
 * exports `GIT_DIR` for its own reasons hijacks every command below: the shell
 * shims shipped with the harness set it to the directory holding a bundled Git
 * binary, which Git then treats as the repository. Each invocation therefore
 * gets a copy of the environment with those variables removed.
 */
const GIT_LOCATION_ENV = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_INDEX_FILE',
  'GIT_NAMESPACE',
  'GIT_QUARANTINE_PATH',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
])

/**
 * Windows environment variables are case-insensitive, so the comparison is
 * upper-cased rather than trusting the spelling a launcher happened to use.
 */
export function gitEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined || GIT_LOCATION_ENV.has(name.toUpperCase())) continue
    sanitized[name] = value
  }
  return sanitized
}

interface GitOptions {
  cwd?: string | undefined
  signal?: AbortSignal | undefined
  token?: string | undefined
  authenticated?: boolean | undefined
  /** Raised for the one command that legitimately prints a whole payload file back out of a commit. */
  maxOutputBytes?: number | undefined
}

interface MnemonSyncRemoteExtension {
  channel: 'git'
  branch: string
  subdir: string
  pushedAt: string
}

/** The credential one operation resolved, and where it came from. */
interface SyncCredential {
  source: MnemonSyncCredentialSource
  token?: string
  login?: string
}

interface RemotePayload {
  commit: string
  manifest: MnemonPackManifest
  pushedAt?: string
  files: Record<string, Uint8Array>
  archive: Uint8Array
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function tail(output: string): string {
  const text = output.trim().replace(/\s+/gu, ' ')
  return text.length > 300 ? '...' + text.slice(-300) : text
}

function versionAtLeast(version: string, minimum: string): boolean {
  const left = version.split('.').map(part => Number.parseInt(part, 10) || 0)
  const right = minimum.split('.').map(part => Number.parseInt(part, 10) || 0)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference > 0
  }
  return true
}

function componentDirectory(component: MnemonPackComponent): string {
  if (component === 'runtime') return 'payload/runtime/'
  if (component === 'documents') return 'payload/documents/'
  if (component === 'memory-spaces') return 'payload/data/'
  return 'payload/settings/'
}

/** How many deletions the payload carries; a merge reports them so a push is not silent about them. */
function tombstoneCount(entries: Record<string, Uint8Array>): number {
  const bytes = entries['payload/runtime/tombstones.json']
  if (bytes === undefined) return 0
  try {
    const value = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown)
    return Array.isArray(value?.tombstones) ? value.tombstones.length : 0
  } catch {
    return 0
  }
}

/** Whether the payload of one component differs between two sets of files. */
function componentChanged(before: Record<string, Uint8Array>, after: Record<string, Uint8Array>, component: MnemonPackComponent): boolean {
  const prefix = componentDirectory(component)
  for (const path of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!path.startsWith(prefix)) continue
    const published = before[path]
    const mine = after[path]
    if (published === undefined || mine === undefined || sha256Hex(published) !== sha256Hex(mine)) return true
  }
  return false
}

/** Manifest fields that record when a payload was written, not what it holds. */
const TIMESTAMP_FIELDS = new Set(['exportedAt', 'pushedAt'])

/** The same manifest without its timestamps describes the same payload. */
function withoutTimestamps(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutTimestamps)
  const parsed = record(value)
  if (parsed === undefined) return value
  return Object.fromEntries(
    Object.entries(parsed)
      .filter(([key]) => !TIMESTAMP_FIELDS.has(key))
      .map(([key, item]) => [key, withoutTimestamps(item)]),
  )
}

/** The identity of a manifest: everything except the two timestamps. */
function manifestIdentity(bytes: Uint8Array | undefined): string | undefined {
  if (bytes === undefined) return undefined
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
  } catch {
    return undefined
  }
  return record(value) === undefined ? undefined : JSON.stringify(withoutTimestamps(value))
}

/**
 * Whether the mirror already holds exactly this payload. Every push re-exports
 * the pack, so `exportedAt` and `sync.pushedAt` always differ; the rest of the
 * payload has to match byte for byte, or the branch does not hold it yet.
 */
function holdsPayload(published: Record<string, Uint8Array>, entries: Unzipped): boolean {
  const identity = manifestIdentity(entries[MANIFEST])
  if (identity === undefined || manifestIdentity(published[MANIFEST]) !== identity) return false
  for (const path of new Set([...Object.keys(published), ...Object.keys(entries)])) {
    if (path === MANIFEST) continue
    const remote = published[path]
    const mine = entries[path]
    if (remote === undefined || mine === undefined || sha256Hex(remote) !== sha256Hex(mine)) return false
  }
  return true
}

/** A commit message stays one line, and never grows without bound. */
function commitMessage(value: unknown, at: Date): string {
  const raw = String(value ?? '').replace(/\s+/gu, ' ').trim()
  if (raw === '') return 'Mnemon sync ' + at.toISOString().replace(/\.\d{3}Z$/u, 'Z')
  return raw.length > 200 ? raw.slice(0, 200) : raw
}

/** The path of one branch inside the mirror, which is flattened the way `git check-ref-format --branch` flattens it. */
function branchSlug(branch: string): string {
  return branch.replace(/[^A-Za-z0-9._-]+/gu, '-').slice(0, 120)
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'"
}

/** The empty projection the runtime contract publishes when one side carries no entries. */
function emptyRuntime(): RuntimeFile {
  return { version: 1, entries: [] }
}

function emptyTombstones(): MnemonTombstoneFile {
  return { version: 1, tombstones: [] }
}

/**
 * The runtime payload one commit holds. The mirror is already at the branch tip,
 * so reading a file out of a commit never moves the work tree, the index, or
 * `HEAD` — which is what keeps `git status --porcelain` empty for the next push.
 * `git show` on a path the commit does not hold fails, so the payload's own
 * absence is the empty projection rather than an error.
 */
function showText(stdout: string): Uint8Array {
  return new TextEncoder().encode(stdout)
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
  } catch {
    throw new Error(label + ' is not valid JSON')
  }
}

/** How many commits one page asks for: the caller's window, clamped to what one listing should carry. */
function backupLimit(value: unknown): number {
  const requested = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : DEFAULT_BACKUP_LIMIT
  return Math.min(Math.max(requested, 1), MAX_BACKUPS)
}

/** One `git log` row: the commit, when it was made, and the message its author chose. */
interface CommitRow {
  commit: string
  committedAt: string
  message: string
}

/** One entry as a difference shows it: its text and the installation that wrote it, never its bookkeeping. */
function diffEntry(entry: StoredRuntimeEntry): MnemonSyncDiffEntry {
  return {
    target: entry.target,
    content: entry.content,
    importance: entry.importance,
    ...(entry.origin === undefined ? {} : { origin: entry.origin }),
  }
}

/** How alike two texts must read before they count as the same subject written twice. */
const CONFLICT_SIMILARITY = 0.6
/** How many conflicts one difference lists; a page past this says it was cut short. */
const MAX_DIFF_CONFLICTS = 40

/** Case, spacing, and punctuation carry no meaning when two memories are compared. */
function normalizeForSimilarity(text: string): string {
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

function bigramsOf(value: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (let index = 0; index + 1 < value.length; index += 1) {
    const gram = value.slice(index, index + 2)
    counts.set(gram, (counts.get(gram) ?? 0) + 1)
  }
  return counts
}

/**
 * How alike two memories read, from 0 to 1, as the Sørensen–Dice coefficient of their
 * character bigrams. Comparing characters rather than words is what lets a reworded
 * sentence score high in any language, including the ones written without spaces.
 */
function similarityOf(left: string, right: string): number {
  const first = normalizeForSimilarity(left)
  const second = normalizeForSimilarity(right)
  if (first === second) return 1
  if (first.length < 2 || second.length < 2) return 0
  const mine = bigramsOf(first)
  const theirs = bigramsOf(second)
  let mineSize = 0
  let theirsSize = 0
  let overlap = 0
  for (const count of mine.values()) mineSize += count
  for (const count of theirs.values()) theirsSize += count
  for (const [gram, count] of mine) overlap += Math.min(count, theirs.get(gram) ?? 0)
  return (2 * overlap) / (mineSize + theirsSize)
}

/**
 * The subjects both sides wrote down differently. A pair counts only when the two texts
 * talk about the same thing — the same target, and alike enough that keeping both would
 * record one answer twice. Every other entry on one side alone is an addition, which
 * needs no reconciling at all.
 */
function conflictsOf(local: readonly MnemonSyncDiffEntry[], remote: readonly MnemonSyncDiffEntry[]): MnemonSyncDiffConflict[] {
  const conflicts: MnemonSyncDiffConflict[] = []
  for (const mine of local) {
    let best: { entry: MnemonSyncDiffEntry; similarity: number } | undefined
    for (const theirs of remote) {
      if (theirs.target !== mine.target) continue
      const similarity = similarityOf(mine.content, theirs.content)
      if (similarity < CONFLICT_SIMILARITY) continue
      if (best === undefined || similarity > best.similarity) best = { entry: theirs, similarity }
    }
    if (best !== undefined) conflicts.push({ target: mine.target, local: mine, remote: best.entry, similarity: best.similarity })
  }
  return conflicts
}

/**
 * The runtime projection one side of a diff carries, read through the same parser
 * an import uses. A side without the file holds nothing; a side whose file does not
 * parse is a failure the caller names, because "no entries" and "unreadable entries"
 * must never look alike in a merge decision.
 */
function runtimeOf(files: Record<string, Uint8Array>, limits: RuntimeMemoryLimits, label: string): RuntimeFile {
  const bytes = files[RUNTIME_MEMORIES_PATH]
  if (bytes === undefined) return emptyRuntime()
  try {
    return parseRuntime(parseJson(bytes, label + ' runtime memories.json'), limits)
  } catch (error) {
    throw new Error(label + ' runtime memories.json is invalid: ' + (error instanceof Error ? error.message : String(error)))
  }
}

/** The removals the branch recorded. A missing or unreadable file means it recorded none. */
function tombstonesOf(files: Record<string, Uint8Array>): MnemonTombstone[] {
  const bytes = files[RUNTIME_TOMBSTONE_PATH]
  if (bytes === undefined) return []
  try {
    return parseTombstones(parseJson(bytes, 'runtime tombstones.json')).tombstones
  } catch {
    return []
  }
}

/**
 * The removals this machine has not applied yet. The branch carries every removal both
 * sides ever recorded — tombstones only grow — so the raw file is not the answer to "what
 * does the branch know that I do not". A removal this machine already applied is not
 * outstanding, and one this machine has since written over no longer hides anything.
 * What remains is what the branch recorded and this machine has not carried out.
 */
function unappliedRemovals(local: Record<string, Uint8Array>, remote: Record<string, Uint8Array>): MnemonTombstone[] {
  const mine = tombstonesOf(local)
  const held = new Set(mine.map(tombstoneKey))
  const entries = runtimeOf(local, RUNTIME_MEMORY_LIMITS, 'the local').entries
  return tombstonesOf(remote).filter(tombstone =>
    !held.has(tombstoneKey(tombstone)) && entries.some(entry => tombstoneCovers(tombstone, entry)),
  )
}

/** Read every file below one directory as forward-slash keyed bytes. */
function readFiles(root: string, limit = MAX_PAYLOAD_BYTES): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {}
  let total = 0
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = prefix === '' ? entry.name : prefix + '/' + entry.name
      if (entry.isDirectory()) {
        walk(join(directory, entry.name), path)
        continue
      }
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('the Mnemon payload holds a non-file entry: ' + path)
      const bytes = readFileSync(join(directory, entry.name))
      if (bytes.byteLength > MAX_FILE_BYTES) throw new Error('the Mnemon payload holds an oversized file: ' + path)
      total += bytes.byteLength
      if (total > limit) throw new Error('the Mnemon payload exceeds the expanded safety limit')
      files[path] = bytes
    }
  }
  if (existsSync(root)) walk(root, '')
  return files
}

function unpack(archive: Uint8Array): Unzipped {
  let entries: Unzipped
  try {
    entries = unzipSync(archive)
  } catch {
    throw new Error('the Mnemon payload is not a readable archive')
  }
  let total = 0
  for (const [path, bytes] of Object.entries(entries)) {
    total += bytes.byteLength
    if (total > MNEMON_PACK_MAX_EXPANDED_BYTES) throw new Error('the Mnemon payload exceeds the expanded safety limit')
    if (path.includes('\\') || path.startsWith('/') || path.split('/').some(part => part === '.' || part === '..')) {
      throw new Error('the Mnemon payload holds an unsafe entry path: ' + JSON.stringify(path))
    }
  }
  return entries
}

/**
 * Publish the Mnemon Pack payload to one branch of a Git repository the user
 * owns, and read it back on another machine.
 *
 * The payload is exactly the pack the ZIP path produces: the same collector,
 * the same manifest, the same checksums, and the same importer. Git only moves
 * the bytes, so any reader still sees a valid Mnemon Pack, and a pull validates
 * what an Import ZIP validates.
 */
export class MnemonGitSync {
  private readonly root: string
  private readonly store: MnemonSyncSettingsStore
  private readonly machine: MnemonMachineStore
  private sequence = 0
  private auth: MnemonGitHubAuth | undefined

  constructor(
    runner: StorageRoot,
    private readonly config: Pick<ResolvedConfig, 'storageScope' | 'runtimeMemory'>,
    private readonly packs: MnemonPackManager,
    private readonly run: ProcessRunner = runProcess,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.root = resolve(runner.effectiveDataDir())
    this.store = new MnemonSyncSettingsStore(runner)
    this.machine = new MnemonMachineStore(runner)
  }

  /** Where the channel keeps its configuration and its disposable mirror. */
  settings(): MnemonSyncSettingsStore {
    return this.store
  }

  /**
   * Hand the channel the Host's GitHub sign-in. Every runtime generation shares
   * one instance, so a grant stored from the settings page reaches the graphs
   * an Agent executes in as well.
   */
  useGitHubAuth(auth: MnemonGitHubAuth | undefined): void {
    this.auth = auth
  }

  /** The sign-in surface, or undefined on a Host that provides no store. */
  github(): MnemonGitHubAuth | undefined {
    return this.auth
  }

  /**
   * The credential one operation authenticates with, and where it came from.
   * The environment wins over the stored token, and the GitHub grant is the
   * fallback a user reaches for when neither is set.
   */
  private async credential(settings: MnemonSyncSettings): Promise<SyncCredential> {
    const token = this.store.token(settings)
    if (token !== undefined && token !== '') {
      return { source: (process.env[MNEMON_SYNC_TOKEN_ENV]?.trim() ?? '') === '' ? 'token' : 'environment', token }
    }
    const grant = await this.auth?.grant()
    if (grant === undefined) return { source: 'none' }
    return { source: 'github', token: grant.accessToken, ...(grant.login === undefined ? {} : { login: grant.login }) }
  }

  /** The saved view, with the source the channel would actually authenticate with. */
  private async credentialView(settings: MnemonSyncSettings): Promise<MnemonSyncConfigView> {
    const credential = await this.credential(settings)
    return {
      ...this.store.view(settings),
      hasToken: credential.token !== undefined,
      credentialSource: credential.source,
      ...(credential.login === undefined ? {} : { credentialLogin: credential.login }),
    }
  }

  async status(signal?: AbortSignal): Promise<MnemonSyncStatus> {
    const settings = this.store.read()
    const repoUrl = settings.repoUrl
    const git = await this.gitStatus(signal)
    const remote = repoUrl === undefined
      ? { reachable: false, branchExists: false }
      : git.available
        ? await this.remoteStatus({ ...settings, repoUrl }, signal)
        : { reachable: false, branchExists: false, error: git.issue ?? 'Git is not available on this Host' }
    const commit = existsSync(this.store.mirror()) && git.available ? await this.lastCommit(signal) : undefined
    return {
      configured: repoUrl !== undefined,
      config: await this.credentialView(settings),
      configPath: this.store.path(),
      mirrorPath: this.store.mirror(),
      git,
      remote,
      machine: this.machine.read(),
      ...(commit === undefined ? {} : { lastCommit: commit }),
    }
  }

  async configure(patch: unknown): Promise<MnemonSyncConfigView> {
    const next = this.store.patch(patch)
    this.store.write(next)
    return this.credentialView(next)
  }

  /**
   * Fold the branch into this machine, then collect the full pack, write it into
   * the mirror when it changed, and publish the difference. A push therefore never
   * overwrites what another machine published: the remote payload is merged first,
   * and the merged result is what the new commit holds.
   */
  async push(input: { message?: unknown; signal?: AbortSignal } = {}): Promise<MnemonSyncPushResult> {
    const settings = this.requireRepository()
    await this.requireGit(input.signal)
    const message = commitMessage(input.message, this.now())
    return this.lock(async () => {
      const prepared = await this.ensureMirror(settings, input.signal)
      // The deletions this machine made since its last export have to be recorded before
      // the branch is folded in: the merge would otherwise restore an entry this machine
      // deleted, and the export that follows would report no removal at all.
      await this.packs.recordDeletions()
      const remote = await this.readRemote(settings, input.signal)
      let merged: MnemonSyncPushResult['merged']
      if (remote !== undefined) {
        const imported = await this.packs.importPack(Buffer.from(remote.archive).toString('base64'), { mode: 'merge' })
        merged = {
          commit: remote.commit,
          ...(remote.manifest.machine === undefined ? {} : { machine: { id: remote.manifest.machine.id, label: remote.manifest.machine.label } }),
          components: imported.components, summary: imported.summary,
          tombstones: tombstoneCount(remote.files),
        }
      }
      const exported = await this.packs.exportPack('full')
      const entries = unpack(Buffer.from(exported.base64, 'base64'))
      const extension: MnemonSyncRemoteExtension = {
        channel: 'git', branch: settings.branch, subdir: settings.subdir, pushedAt: exported.manifest.exportedAt,
      }
      entries[MANIFEST] = new TextEncoder().encode(JSON.stringify({ ...exported.manifest, [SYNC_EXTENSION]: extension }, null, 2) + '\n')
      const before = readFiles(this.payloadRoot(settings.subdir))
      // A payload the branch already holds is left untouched: the work tree
      // stays clean, so Git records no second commit for the same bytes.
      if (prepared.tip === undefined || !holdsPayload(before, entries)) this.writePayload(settings.subdir, entries)
      const staged = await this.git(['add', '--all', '--', settings.subdir], { cwd: this.store.mirror(), signal: input.signal })
      if (staged.exitCode !== 0) throw new Error('git add failed: ' + tail(staged.stderr || staged.stdout))
      const changed = await this.git(['status', '--porcelain', '--', settings.subdir], { cwd: this.store.mirror(), signal: input.signal })
      const committed = changed.stdout.trim() !== ''
      if (committed) {
        // An author the user cleared is not passed at all: Git then records the
        // commit with the identity this machine already has, which is what an
        // optional field promises.
        const identity = [
          ...(settings.authorName === '' ? [] : ['-c', 'user.name=' + settings.authorName]),
          ...(settings.authorEmail === '' ? [] : ['-c', 'user.email=' + settings.authorEmail]),
        ]
        const result = await this.git(
          [...identity, 'commit', '--quiet', '-m', message, '--', settings.subdir],
          { cwd: this.store.mirror(), signal: input.signal },
        )
        if (result.exitCode !== 0) throw new Error('git commit failed: ' + tail(result.stderr || result.stdout))
      }
      const head = await this.head(input.signal)
      const published = committed
        ? await this.publish(settings, await this.credential(settings), input.signal)
        : { pushed: false, reason: prepared.tip === undefined ? 'nothing to publish' : 'the branch already holds this payload' }
      const summary = exported.manifest.summary.map(entry => ({ ...entry, changed: componentChanged(before, entries, entry.component) }))
      return {
        repoUrl: settings.repoUrl, branch: settings.branch, subdir: settings.subdir,
        commit: head, committed, message,
        files: Object.keys(entries).length,
        bytes: Object.values(entries).reduce((total, bytes) => total + bytes.byteLength, 0),
        summary, pushed: published.pushed,
        ...(merged === undefined ? {} : { merged }),
        ...(published.reason === undefined ? {} : { reason: published.reason }),
      }
    })
  }

  /** Read the remote payload and report what it would change, without importing anything. */
  async preview(signal?: AbortSignal): Promise<MnemonSyncPreview> {
    const settings = this.requireRepository()
    await this.requireGit(signal)
    const exported = await this.packs.exportPack('full')
    return this.lock(async () => {
      const remote = await this.readRemote(settings, signal)
      if (remote === undefined) throw new Error(this.absentPayload(settings))
      const local = unpack(Buffer.from(exported.base64, 'base64'))
      const components = MNEMON_PACK_COMPONENTS.map((component): MnemonSyncComponentDelta => {
        const published = remote.manifest.summary.find(entry => entry.component === component)
        return {
          component,
          files: published?.files ?? 0, bytes: published?.bytes ?? 0, items: published?.items ?? 0,
          changed: componentChanged(remote.files, local, component),
        }
      })
      const pack = this.packs.inspectPack(Buffer.from(remote.archive).toString('base64'), MANIFEST)
      return {
        repoUrl: settings.repoUrl, branch: settings.branch, subdir: settings.subdir,
        commit: remote.commit, ...(remote.pushedAt === undefined ? {} : { pushedAt: remote.pushedAt }),
        manifest: remote.manifest, archiveBytes: remote.archive.byteLength, expandedBytes: pack.expandedBytes,
        targetRoot: pack.targetRoot, targetScope: pack.targetScope, occupied: pack.occupied,
        components, files: compareFiles(remote.files, local), localExportAt: exported.manifest.exportedAt,
      }
    })
  }

  /**
   * The commits on the branch that carry a Mnemon payload, newest first. The commit
   * message is whatever its author typed, so the manifest inside the commit is what
   * names the installation and says what the backup held. A commit whose manifest is
   * missing or unreadable is not a backup and is skipped rather than reported empty.
   */
  async backups(input: { limit?: number } = {}, signal?: AbortSignal): Promise<MnemonSyncBackupList> {
    const settings = this.requireRepository()
    await this.requireGit(signal)
    const limit = backupLimit(input.limit)
    return this.lock(async () => {
      // A branch with no payload yet is an empty history, not a failure: the reader
      // is asking what exists, and nothing existing is a valid answer.
      const prepared = await this.ensureMirror(settings, signal)
      const commits: MnemonSyncBackup[] = []
      let truncated = false
      if (prepared.tip !== undefined) {
        const rows = await this.log(settings.subdir, limit + 1, signal)
        truncated = rows.length > limit
        for (const row of rows.slice(0, limit)) {
          const backup = await this.backup(row, settings.subdir, signal)
          if (backup !== undefined) commits.push(backup)
        }
      }
      return { repoUrl: settings.repoUrl, branch: settings.branch, subdir: settings.subdir, commits, truncated }
    })
  }

  /**
   * What this machine holds and the branch tip holds, stated as entries. The byte-level
   * difference already lives in the preview; this answers the question a person asks
   * before merging — which memories are only here, which are only there, which subjects
   * both sides wrote down differently, and which removals the branch recorded that this
   * machine has not applied.
   */
  async diff(signal?: AbortSignal): Promise<MnemonSyncDiff> {
    const settings = this.requireRepository()
    await this.requireGit(signal)
    const exported = await this.packs.exportPack('full')
    return this.lock(async () => {
      const remote = await this.readRemote(settings, signal)
      if (remote === undefined) throw new Error(this.absentPayload(settings))
      const local = unpack(Buffer.from(exported.base64, 'base64'))
      const limits = this.runtimeLimits()
      const mine = runtimeOf(local, limits, 'the local')
      const theirs = runtimeOf(remote.files, limits, 'the remote')
      const mineKeys = new Set(mine.entries.map(entry => entryKey(entry)))
      const theirsKeys = new Set(theirs.entries.map(entry => entryKey(entry)))
      const localOnly: MnemonSyncDiffEntry[] = []
      const remoteOnly: MnemonSyncDiffEntry[] = []
      let shared = 0
      for (const entry of mine.entries) {
        if (theirsKeys.has(entryKey(entry))) shared += 1
        else if (localOnly.length < MAX_DIFF_ENTRIES) localOnly.push(diffEntry(entry))
      }
      for (const entry of theirs.entries) {
        if (!mineKeys.has(entryKey(entry)) && remoteOnly.length < MAX_DIFF_ENTRIES) remoteOnly.push(diffEntry(entry))
      }
      // The same subject written twice is the only thing a person must decide about;
      // a memory that exists on one side alone is simply missing on the other.
      const found = conflictsOf(localOnly, remoteOnly).sort((left, right) => right.similarity - left.similarity)
      const conflicts = found.slice(0, MAX_DIFF_CONFLICTS)
      // An entry the branch holds and this machine once deleted stays out of every merge
      // until the reader says that deletion was wrong. Counting them here is what lets a
      // page that offers to add the branch's memories say how many the offer would skip.
      const mineTombstones = tombstonesOf(local)
      const heldBack = theirs.entries.filter(entry =>
        !mineKeys.has(entryKey(entry)) && mineTombstones.some(tombstone => tombstoneCovers(tombstone, entry)),
      ).length
      return {
        repoUrl: settings.repoUrl, branch: settings.branch, subdir: settings.subdir,
        commit: remote.commit, ...(remote.pushedAt === undefined ? {} : { pushedAt: remote.pushedAt }),
        localExportAt: exported.manifest.exportedAt,
        local: {
          exportedAt: exported.manifest.exportedAt, entries: mine.entries.length,
          ...(exported.manifest.machine === undefined ? {} : { machine: exported.manifest.machine }),
        },
        remote: {
          exportedAt: remote.manifest.exportedAt, entries: theirs.entries.length,
          ...(remote.manifest.machine === undefined ? {} : { machine: remote.manifest.machine }),
        },
        localOnly, remoteOnly, conflicts, shared,
        // A page that stopped early must say so: a reader who cannot tell a complete
        // difference from a cut-off one will merge on evidence that was never shown.
        truncated: mine.entries.length - shared > localOnly.length
          || theirs.entries.length - shared > remoteOnly.length
          || found.length > conflicts.length,
        heldBack,
        remoteTombstones: unappliedRemovals(local, remote.files),
      }
    })
  }

  /**
   * The branch side of the difference, for a planner that reads it as evidence rather
   * than as an answer. Every reason the difference cannot be read — no repository, no
   * git, an unpublished branch, an unreadable payload — means the same thing here: the
   * plan is local, exactly as it was before the branch could be read at all. Cancelling
   * the run is the one failure that still propagates.
   */
  async readRemoteForEvidence(signal?: AbortSignal): Promise<MnemonSyncDiff | undefined> {
    try {
      return await this.diff(signal)
    } catch (error) {
      if (signal?.aborted === true) throw error
      return undefined
    }
  }

  /** Preview the remote payload, then merge it through the importer Import ZIP uses. */
  async pull(input: { mode?: MnemonPackImportMode; components?: MnemonPackComponent[]; revive?: boolean; signal?: AbortSignal } = {}): Promise<MnemonSyncPullResult> {
    const settings = this.requireRepository()
    await this.requireGit(input.signal)
    const mode = input.mode ?? 'merge'
    const options: { mode: MnemonPackImportMode; components?: MnemonPackComponent[]; revive?: boolean } = {
      mode,
      ...(input.components === undefined ? {} : { components: input.components }),
      // Reviving is the reader overruling their own deletion; a plain merge keeps it.
      ...(input.revive === true ? { revive: true } : {}),
    }
    return this.lock(async () => {
      const remote = await this.readRemote(settings, input.signal)
      if (remote === undefined) throw new Error(this.absentPayload(settings))
      const imported = await this.packs.importPack(Buffer.from(remote.archive).toString('base64'), options)
      return {
        imported: true, mode: imported.mode,
        repoUrl: settings.repoUrl, branch: settings.branch, subdir: settings.subdir,
        commit: remote.commit, ...(remote.pushedAt === undefined ? {} : { pushedAt: remote.pushedAt }),
        manifest: remote.manifest, targetRoot: imported.targetRoot,
        components: imported.components, summary: imported.summary,
        ...(imported.runtime === undefined ? {} : { runtime: imported.runtime }),
      }
    })
  }

  private absentPayload(settings: MnemonSyncSettings & { repoUrl: string }): string {
    return 'the branch ' + settings.branch + ' holds no Mnemon payload at ' + settings.subdir + ' yet; push one first'
  }

  private requireRepository(): MnemonSyncSettings & { repoUrl: string } {
    const settings = this.store.read()
    if (settings.repoUrl === undefined) {
      throw new Error('no sync repository is configured; set repoUrl in ' + this.store.path() + ' first')
    }
    return { ...settings, repoUrl: settings.repoUrl }
  }

  private async gitStatus(signal?: AbortSignal): Promise<MnemonSyncGitStatus> {
    const required = MNEMON_SYNC_MINIMUM_GIT
    let version: string | undefined
    try {
      const result = await this.git(['--version'], { signal })
      version = /(\d+\.\d+(?:\.\d+)?)/u.exec(result.stdout)?.[1]
    } catch (error) {
      return { available: false, required, issue: error instanceof Error ? error.message : String(error) }
    }
    if (version === undefined) return { available: false, required, issue: 'git --version did not report a version' }
    if (!versionAtLeast(version, required)) {
      return { available: false, required, version, issue: 'Git ' + version + ' is older than ' + required + ', which this channel needs' }
    }
    return { available: true, required, version }
  }

  private async requireGit(signal?: AbortSignal): Promise<void> {
    const status = await this.gitStatus(signal)
    if (!status.available) throw new Error('Git is not available on this Host: ' + (status.issue ?? 'unknown reason'))
  }

  private async remoteStatus(settings: MnemonSyncSettings & { repoUrl: string }, signal?: AbortSignal): Promise<MnemonSyncRemoteStatus> {
    const credential = await this.credential(settings)
    try {
      const tip = await this.lsRemote(settings, credential, signal)
      return tip === undefined ? { reachable: true, branchExists: false } : { reachable: true, branchExists: true, commit: tip }
    } catch (error) {
      return { reachable: false, branchExists: false, error: this.mask(error instanceof Error ? error.message : String(error), credential) }
    }
  }

  private async lsRemote(settings: MnemonSyncSettings & { repoUrl: string }, credential: SyncCredential, signal?: AbortSignal): Promise<string | undefined> {
    const reference = 'refs/heads/' + settings.branch
    const result = await this.git(['ls-remote', '--heads', settings.repoUrl, reference], { signal, token: credential.token, authenticated: true })
    if (result.exitCode !== 0) throw new Error(tail(result.stderr || result.stdout) || 'git ls-remote failed')
    for (const line of result.stdout.split('\n')) {
      const [commit, name] = line.trim().split(/\s+/u)
      if (name === reference && commit !== undefined) return commit
    }
    return undefined
  }

  private async lastCommit(signal?: AbortSignal): Promise<{ id: string; message: string; committedAt: string } | undefined> {
    const result = await this.git(['log', '-1', '--format=%H%x1f%cI%x1f%s'], { cwd: this.store.mirror(), signal })
    if (result.exitCode !== 0) return undefined
    const [id, committedAt, message] = result.stdout.trim().split('\u001f')
    if (id === undefined || id === '') return undefined
    return { id, message: message ?? '', committedAt: committedAt ?? '' }
  }

  private async head(signal?: AbortSignal): Promise<string> {
    const result = await this.git(['rev-parse', 'HEAD'], { cwd: this.store.mirror(), signal })
    if (result.exitCode !== 0) throw new Error('the sync mirror has no commit yet: ' + tail(result.stderr || result.stdout))
    return result.stdout.trim()
  }

  /**
   * The commits that touched the payload directory, newest first, as raw log rows.
   * Path filtering is what makes this the backup history rather than the branch's
   * whole history: a commit that never touched the payload is not a backup.
   */
  private async log(subdir: string, count: number, signal?: AbortSignal): Promise<CommitRow[]> {
    const result = await this.git(
      ['log', '--max-count=' + String(Math.min(count, BACKUP_WALK_LIMIT)), '--format=%H%x1f%cI%x1f%s', '--', subdir],
      { cwd: this.store.mirror(), signal },
    )
    if (result.exitCode !== 0) throw new Error('git log failed: ' + tail(result.stderr || result.stdout))
    const rows: CommitRow[] = []
    for (const line of result.stdout.split('\n')) {
      if (line.trim() === '') continue
      const [commit, committedAt, message] = line.split('\u001f')
      if (commit === undefined || commit === '') continue
      rows.push({ commit, committedAt: committedAt ?? '', message: message ?? '' })
    }
    return rows
  }

  /**
   * One file out of one commit, or nothing when that commit does not hold it.
   * Reading through the object store is what keeps the work tree, the index, and
   * `HEAD` untouched, so the next push still sees a clean tree.
   */
  private async show(commit: string, path: string, signal?: AbortSignal): Promise<Uint8Array | undefined> {
    const result = await this.git(['show', commit + ':' + path], {
      cwd: this.store.mirror(), signal, maxOutputBytes: MAX_FILE_BYTES,
    })
    if (result.exitCode !== 0) return undefined
    return showText(result.stdout)
  }

  /** One commit as a backup, or nothing when it does not actually carry a readable manifest. */
  private async backup(row: CommitRow, subdir: string, signal?: AbortSignal): Promise<MnemonSyncBackup | undefined> {
    const bytes = await this.show(row.commit, subdir + MANIFEST, signal)
    if (bytes === undefined) return undefined
    let manifest: MnemonPackManifest
    let pushedAt: string | undefined
    try {
      const raw = record(parseJson(bytes, 'the backup manifest'))
      if (raw === undefined) return undefined
      // The manifest parser rebuilds its result and drops unknown top-level fields,
      // so the sync extension is read off the raw object, exactly as the tip is.
      const extension = record(raw[SYNC_EXTENSION])
      pushedAt = typeof extension?.pushedAt === 'string' ? extension.pushedAt : undefined
      manifest = parseManifestJson(raw)
    } catch {
      return undefined
    }
    return {
      commit: row.commit, message: row.message, committedAt: row.committedAt,
      ...(manifest.machine === undefined ? {} : { machine: manifest.machine }),
      ...(pushedAt === undefined ? {} : { pushedAt }),
      components: manifest.summary,
    }
  }

  /** The runtime byte budgets this installation enforces, so a remote payload is read by the same rules. */
  private runtimeLimits(): RuntimeMemoryLimits {
    return { memory: this.config.runtimeMemory.memoryLimitBytes, user: this.config.runtimeMemory.userLimitBytes }
  }

  /** Create or refresh the disposable mirror, and return the remote tip when the branch exists. */
  private async ensureMirror(settings: MnemonSyncSettings & { repoUrl: string }, signal?: AbortSignal): Promise<{ tip?: string }> {
    const credential = await this.credential(settings)
    const mirror = this.store.mirror()
    mkdirSync(this.store.directory(), { recursive: true, mode: 0o700 })
    if (!existsSync(join(mirror, '.git'))) {
      rmSync(mirror, { recursive: true, force: true })
      const initialized = await this.git(['init', '--quiet', '--initial-branch=' + settings.branch, mirror], { signal })
      if (initialized.exitCode !== 0) throw new Error('git init failed: ' + tail(initialized.stderr || initialized.stdout))
    }
    const current = await this.git(['symbolic-ref', '--quiet', 'HEAD'], { cwd: mirror, signal })
    if (current.exitCode !== 0 || current.stdout.trim() !== 'refs/heads/' + settings.branch) {
      const renamed = await this.git(['symbolic-ref', 'HEAD', 'refs/heads/' + settings.branch], { cwd: mirror, signal })
      if (renamed.exitCode !== 0) throw new Error('git symbolic-ref failed: ' + tail(renamed.stderr || renamed.stdout))
    }
    // The branch is the source of truth, so an unreachable remote fails here rather than at push time.
    const tip = await this.lsRemote(settings, credential, signal)
    if (tip === undefined) return {}
    const fetched = await this.git(
      ['fetch', '--no-tags', '--quiet', settings.repoUrl, 'refs/heads/' + settings.branch],
      { cwd: mirror, signal, token: credential.token, authenticated: true },
    )
    if (fetched.exitCode !== 0) throw new Error('git fetch failed: ' + this.mask(tail(fetched.stderr || fetched.stdout), credential))
    const reset = await this.git(['reset', '--hard', '--quiet', 'FETCH_HEAD'], { cwd: mirror, signal })
    if (reset.exitCode !== 0) throw new Error('git reset failed: ' + tail(reset.stderr || reset.stdout))
    return { tip }
  }

  private payloadRoot(subdir: string): string {
    return resolve(this.store.mirror(), subdir)
  }

  /** Replace the payload directory with exactly these entries. */
  private writePayload(subdir: string, entries: Record<string, Uint8Array>): void {
    const root = this.payloadRoot(subdir)
    const mirror = resolve(this.store.mirror())
    if (root === mirror || !root.startsWith(mirror + (process.platform === 'win32' ? '\\' : '/'))) {
      throw new Error('sync directory escapes the mirror')
    }
    rmSync(root, { recursive: true, force: true })
    for (const [path, bytes] of Object.entries(entries)) {
      const file = resolve(root, path)
      mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 })
      writeFileSync(file, bytes, { mode: 0o600 })
    }
  }

  private async publish(settings: MnemonSyncSettings & { repoUrl: string }, credential: SyncCredential, signal?: AbortSignal): Promise<{ pushed: boolean; reason?: string }> {
    const reference = 'refs/heads/' + settings.branch + ':refs/heads/' + settings.branch
    const result = await this.git(['push', '--porcelain', settings.repoUrl, reference], { cwd: this.store.mirror(), signal, token: credential.token, authenticated: true })
    if (result.exitCode === 0) return { pushed: true }
    const reason = this.mask(tail(result.stderr || result.stdout), credential)
    if (credential.token === undefined) {
      return { pushed: false, reason: 'the commit stays local because no token is available: ' + (reason || 'git push failed') }
    }
    return { pushed: false, reason: reason || 'git push failed' }
  }

  /** Validate the remote payload and rebuild the exact pack archive the ZIP path would have produced. */
  private async readRemote(settings: MnemonSyncSettings & { repoUrl: string }, signal?: AbortSignal): Promise<RemotePayload | undefined> {
    const prepared = await this.ensureMirror(settings, signal)
    if (prepared.tip === undefined) return undefined
    const files = readFiles(this.payloadRoot(settings.subdir))
    const manifestBytes = files[MANIFEST]
    const checksumBytes = files[CHECKSUMS]
    if (manifestBytes === undefined || checksumBytes === undefined) return undefined
    if (manifestBytes.byteLength > MAX_MANIFEST_BYTES) throw new Error('the remote Mnemon manifest exceeds the safety limit')
    for (const path of Object.keys(files)) {
      if (path !== MANIFEST && path !== CHECKSUMS && !path.startsWith('payload/')) {
        throw new Error('the remote Mnemon payload holds an unexpected file: ' + path)
      }
    }
    const parsed = record(parseJson(manifestBytes, 'the remote Mnemon manifest'))
    if (parsed === undefined) throw new Error('the remote Mnemon manifest is not a JSON object')
    if (parsed.format !== 'mnemonpack' || parsed.version !== 1) throw new Error('the remote Mnemon manifest is not a supported Mnemon Pack')
    const checksums = record(parseJson(checksumBytes, 'the remote Mnemon checksum inventory'))
    const inventory = record(checksums?.files)
    if (checksums?.algorithm !== 'sha256' || inventory === undefined) throw new Error('the remote Mnemon checksum inventory is invalid')
    for (const [path, bytes] of Object.entries(files)) {
      if (path === MANIFEST || path === CHECKSUMS) continue
      const expected = inventory[path]
      if (typeof expected !== 'string') throw new Error('the remote Mnemon payload holds an unchecksummed file: ' + path)
      if (expected !== sha256Hex(bytes)) throw new Error('the remote Mnemon payload failed its checksum: ' + path)
    }
    for (const path of Object.keys(inventory)) {
      if (files[path] === undefined) throw new Error('the remote Mnemon payload is missing a checksummed file: ' + path)
    }
    const extension = record(parsed[SYNC_EXTENSION])
    const pushedAt = typeof extension?.pushedAt === 'string' ? extension.pushedAt : undefined
    // The pin keeps the rebuilt archive byte-stable across timezones.
    const archive = zipSync(files, { level: 6, mtime: new Date(1980, 0, 1) })
    return {
      commit: prepared.tip, manifest: parsed as unknown as MnemonPackManifest,
      ...(pushedAt === undefined ? {} : { pushedAt }), files, archive,
    }
  }

  /** Remove the credential from anything a user will read. */
  private mask(text: string, credential: SyncCredential): string {
    const token = credential.token
    if (token === undefined || token === '') return text
    return text.replaceAll(token, '***')
  }

  private async lock<T>(operation: () => Promise<T>): Promise<T> {
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    mkdirSync(this.store.directory(), { recursive: true, mode: 0o700 })
    return withDirectoryLock(join(this.store.directory(), '.sync.lock'), operation)
  }

  private async git(args: string[], options: GitOptions): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    const prepared = this.credentials(args, options)
    try {
      const result = await this.run(GIT_LABEL, prepared.args, {
        timeoutMs: MNEMON_SYNC_GIT_TIMEOUT_MS,
        env: gitEnvironment(),
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
        label: GIT_LABEL,
      })
      return result
    } finally {
      prepared.cleanup()
    }
  }

  /**
   * Hand the token to Git through a `0600` credential store that lives for one
   * command. The token never reaches an argument, a URL, a log, or the mirror,
   * and it is removed before the caller sees the result.
   */
  private credentials(args: string[], options: GitOptions): { args: string[]; cleanup: () => void } {
    const token = options.token
    if (token === undefined || token === '' || options.authenticated !== true) return { args: [...NO_REWRITE, ...args], cleanup: () => {} }
    const url = args.find(argument => argument.startsWith('https://'))
    if (url === undefined) return { args: [...NO_REWRITE, ...args], cleanup: () => {} }
    this.sequence += 1
    const host = new URL(url).host
    const path = join(this.store.directory(), '.credentials.' + branchSlug(String(process.pid)) + '.' + String(this.sequence) + '.tmp')
    writeFileSync(path, 'https://x-access-token:' + token + '@' + host + '\n', { encoding: 'utf8', mode: 0o600 })
    return {
      args: [...NO_REWRITE, '-c', 'credential.helper=', '-c', 'credential.helper=store --file=' + shellQuote(path), ...args],
      cleanup: () => { rmSync(path, { force: true }) },
    }
  }
}

function compareFiles(published: Record<string, Uint8Array>, local: Record<string, Uint8Array>): MnemonSyncFileDelta {
  let changed = 0
  let added = 0
  let removed = 0
  for (const path of new Set([...Object.keys(published), ...Object.keys(local)])) {
    const remote = published[path]
    const mine = local[path]
    if (remote === undefined) added += 1
    else if (mine === undefined) removed += 1
    else if (sha256Hex(remote) !== sha256Hex(mine)) changed += 1
  }
  return { total: new Set([...Object.keys(published), ...Object.keys(local)]).size, changed, added, removed }
}

/** A single-writer lock for one storage root's sync work; the pack locks cover the shared data. */
async function withDirectoryLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  let held = false
  while (!held && Date.now() < deadline) {
    try {
      mkdirSync(path, { recursive: false, mode: 0o700 })
      held = true
    } catch {
      await new Promise<void>(resolveReady => setTimeout(resolveReady, 25))
    }
  }
  if (!held) throw new Error('another Mnemon sync operation is still running')
  try {
    return await operation()
  } finally {
    rmSync(path, { recursive: true, force: true })
  }
}

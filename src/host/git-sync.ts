import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { zipSync, unzipSync, type Unzipped } from 'fflate'
import type { ResolvedConfig } from './config.ts'
import { runProcess, type ProcessRunner } from './process.ts'
import { MnemonPackManager, MNEMON_PACK_MAX_EXPANDED_BYTES } from './pack.ts'
import type {
  MnemonPackComponent, MnemonPackImportMode, MnemonPackManifest, MnemonSyncComponentDelta, MnemonSyncConfigView,
  MnemonSyncFileDelta, MnemonSyncGitStatus, MnemonSyncPreview, MnemonSyncPullResult, MnemonSyncPushResult,
  MnemonSyncRemoteStatus, MnemonSyncStatus,
} from './protocol.ts'
import { MNEMON_PACK_COMPONENTS } from './protocol.ts'
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
/** Git on Windows would otherwise rewrite line endings and break every checksum. */
const NO_REWRITE = ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf']

interface GitOptions {
  cwd?: string | undefined
  signal?: AbortSignal | undefined
  token?: string | undefined
  authenticated?: boolean | undefined
}

interface MnemonSyncRemoteExtension {
  channel: 'git'
  branch: string
  subdir: string
  pushedAt: string
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
  return 'payload/data/'
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

function parseJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
  } catch {
    throw new Error(label + ' is not valid JSON')
  }
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
  private sequence = 0

  constructor(
    runner: StorageRoot,
    private readonly config: Pick<ResolvedConfig, 'storageScope' | 'runtimeMemory'>,
    private readonly packs: MnemonPackManager,
    private readonly run: ProcessRunner = runProcess,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.root = resolve(runner.effectiveDataDir())
    this.store = new MnemonSyncSettingsStore(runner)
  }

  /** Where the channel keeps its configuration and its disposable mirror. */
  settings(): MnemonSyncSettingsStore {
    return this.store
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
      config: this.store.view(settings),
      configPath: this.store.path(),
      mirrorPath: this.store.mirror(),
      git,
      remote,
      ...(commit === undefined ? {} : { lastCommit: commit }),
    }
  }

  configure(patch: unknown): MnemonSyncConfigView {
    const next = this.store.patch(patch)
    this.store.write(next)
    return this.store.view(next)
  }

  /** Collect the full pack, write it into the mirror when it changed, and publish the difference. */
  async push(input: { message?: unknown; signal?: AbortSignal } = {}): Promise<MnemonSyncPushResult> {
    const settings = this.requireRepository()
    await this.requireGit(input.signal)
    const message = commitMessage(input.message, this.now())
    const exported = await this.packs.exportPack('full')
    const entries = unpack(Buffer.from(exported.base64, 'base64'))
    const extension: MnemonSyncRemoteExtension = {
      channel: 'git', branch: settings.branch, subdir: settings.subdir, pushedAt: exported.manifest.exportedAt,
    }
    entries[MANIFEST] = new TextEncoder().encode(JSON.stringify({ ...exported.manifest, [SYNC_EXTENSION]: extension }, null, 2) + '\n')

    return this.lock(async () => {
      const prepared = await this.ensureMirror(settings, input.signal)
      const before = readFiles(this.payloadRoot(settings.subdir))
      // A payload the branch already holds is left untouched: the work tree
      // stays clean, so Git records no second commit for the same bytes.
      if (prepared.tip === undefined || !holdsPayload(before, entries)) this.writePayload(settings.subdir, entries)
      const staged = await this.git(['add', '--all', '--', settings.subdir], { cwd: this.store.mirror(), signal: input.signal })
      if (staged.exitCode !== 0) throw new Error('git add failed: ' + tail(staged.stderr || staged.stdout))
      const changed = await this.git(['status', '--porcelain', '--', settings.subdir], { cwd: this.store.mirror(), signal: input.signal })
      const committed = changed.stdout.trim() !== ''
      if (committed) {
        const result = await this.git(
          ['-c', 'user.name=' + settings.authorName, '-c', 'user.email=' + settings.authorEmail, 'commit', '--quiet', '-m', message, '--', settings.subdir],
          { cwd: this.store.mirror(), signal: input.signal },
        )
        if (result.exitCode !== 0) throw new Error('git commit failed: ' + tail(result.stderr || result.stdout))
      }
      const head = await this.head(input.signal)
      const published = committed
        ? await this.publish(settings, input.signal)
        : { pushed: false, reason: prepared.tip === undefined ? 'nothing to publish' : 'the branch already holds this payload' }
      const summary = exported.manifest.summary.map(entry => ({ ...entry, changed: componentChanged(before, entries, entry.component) }))
      return {
        repoUrl: settings.repoUrl, branch: settings.branch, subdir: settings.subdir,
        commit: head, committed, message,
        files: Object.keys(entries).length,
        bytes: Object.values(entries).reduce((total, bytes) => total + bytes.byteLength, 0),
        summary, pushed: published.pushed, ...(published.reason === undefined ? {} : { reason: published.reason }),
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

  /** Preview the remote payload, then merge it through the importer Import ZIP uses. */
  async pull(input: { mode?: MnemonPackImportMode; components?: MnemonPackComponent[]; signal?: AbortSignal } = {}): Promise<MnemonSyncPullResult> {
    const settings = this.requireRepository()
    await this.requireGit(input.signal)
    const mode = input.mode ?? 'merge'
    const options: { mode: MnemonPackImportMode; components?: MnemonPackComponent[] } = input.components === undefined
      ? { mode }
      : { mode, components: input.components }
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
    try {
      const tip = await this.lsRemote(settings, signal)
      return tip === undefined ? { reachable: true, branchExists: false } : { reachable: true, branchExists: true, commit: tip }
    } catch (error) {
      return { reachable: false, branchExists: false, error: this.mask(error instanceof Error ? error.message : String(error), settings) }
    }
  }

  private async lsRemote(settings: MnemonSyncSettings & { repoUrl: string }, signal?: AbortSignal): Promise<string | undefined> {
    const reference = 'refs/heads/' + settings.branch
    const result = await this.git(['ls-remote', '--heads', settings.repoUrl, reference], { signal, token: this.store.token(settings), authenticated: true })
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

  /** Create or refresh the disposable mirror, and return the remote tip when the branch exists. */
  private async ensureMirror(settings: MnemonSyncSettings & { repoUrl: string }, signal?: AbortSignal): Promise<{ tip?: string }> {
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
    const tip = await this.lsRemote(settings, signal)
    if (tip === undefined) return {}
    const fetched = await this.git(
      ['fetch', '--no-tags', '--quiet', settings.repoUrl, 'refs/heads/' + settings.branch],
      { cwd: mirror, signal, token: this.store.token(settings), authenticated: true },
    )
    if (fetched.exitCode !== 0) throw new Error('git fetch failed: ' + this.mask(tail(fetched.stderr || fetched.stdout), settings))
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

  private async publish(settings: MnemonSyncSettings & { repoUrl: string }, signal?: AbortSignal): Promise<{ pushed: boolean; reason?: string }> {
    const reference = 'refs/heads/' + settings.branch + ':refs/heads/' + settings.branch
    const result = await this.git(['push', '--porcelain', settings.repoUrl, reference], { cwd: this.store.mirror(), signal, token: this.store.token(settings), authenticated: true })
    if (result.exitCode === 0) return { pushed: true }
    const reason = this.mask(tail(result.stderr || result.stdout), settings)
    if (this.store.token(settings) === undefined) {
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

  private mask(text: string, settings: MnemonSyncSettings): string {
    const token = this.store.token(settings)
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
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
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

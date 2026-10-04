import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { MNEMON_SYNC_TOKEN_ENV, type MnemonSyncConfigView } from './protocol.ts'
import type { StorageRoot } from './storage-root.ts'

// The environment variable that overrides the stored token for one operation
// is declared with the other wire constants, because the settings form names it.
export { MNEMON_SYNC_TOKEN_ENV }
export const MNEMON_SYNC_DEFAULT_BRANCH = 'mnemon-sync'
export const MNEMON_SYNC_DEFAULT_SUBDIR = 'mnemon/'
export const MNEMON_SYNC_DEFAULT_AUTHOR_NAME = 'dsh-mnemon sync'
export const MNEMON_SYNC_DEFAULT_AUTHOR_EMAIL = 'mnemon@localhost'
export const MNEMON_SYNC_CONFIG_FILE = 'sync-git.json'

const STATE_DIRECTORY = 'state'
const SETTING_KEYS = ['repoUrl', 'branch', 'subdir', 'token', 'authorName', 'authorEmail'] as const
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u
const HTTPS = /^https:\/\/[^\s/]+(?::\d+)?\/[^\s]+$/u
const SSH = /^ssh:\/\/[^\s/]+(?::\d+)?\/[^\s]+$/u
const SCP = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:[^\s]+$/u
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u
const EMBEDDED_CREDENTIAL = /^https:\/\/[^/]*@/u
const EMAIL = /^[^\s<>@]+@[^\s<>@]+$/u
const REPOSITORY_HINT = 'sync repository must be an https:// or ssh:// URL, a git@host:path address, or an absolute local path'

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function known(key: string): boolean {
  return (SETTING_KEYS as readonly string[]).includes(key)
}

/** A Git branch name: no revision syntax, no empty path segment, no trailing dot or lock suffix. */
export function syncBranch(value: unknown): string {
  const name = String(value ?? '').trim()
  if (name === '' || name.length > 200 || !BRANCH.test(name) || name.includes('..') || name.includes('//')
    || name.includes('@{') || name.includes('\\') || name.startsWith('/') || name.endsWith('/')
    || name.endsWith('.') || name.endsWith('.lock') || name === '@') {
    throw new Error('sync branch must be a Git branch name')
  }
  return name
}

/** The directory inside the branch the payload lives in, always relative and slash terminated. */
export function syncSubdirectory(value: unknown): string {
  const raw = String(value ?? '').trim().replaceAll('\\', '/')
  if (raw === '' || raw.length > 400 || /^[A-Za-z]:/u.test(raw) || raw.includes('\0')) {
    throw new Error('sync directory must be a relative path inside the branch')
  }
  const parts = raw.split('/').filter(part => part !== '')
  if (parts.length === 0 || parts.some(part => part === '.' || part === '..' || part.includes(':'))) {
    throw new Error('sync directory must be a relative path inside the branch')
  }
  return parts.join('/') + '/'
}

/** A remote this Host can run Git against, never carrying credentials in its own text. */
export function syncRepositoryUrl(value: unknown): string {
  const url = String(value ?? '').trim()
  if (url === '' || url.length > 2000 || /\s/u.test(url) || url.includes('\0')) throw new Error(REPOSITORY_HINT)
  if (SCHEME.test(url)) {
    if (!HTTPS.test(url) && !SSH.test(url)) throw new Error(REPOSITORY_HINT)
    if (EMBEDDED_CREDENTIAL.test(url)) throw new Error('sync repository must not embed credentials; set the token instead')
  } else if (!SCP.test(url) && !isAbsolute(url)) {
    throw new Error(REPOSITORY_HINT)
  }
  return url
}

export function syncToken(value: unknown): string {
  const token = String(value ?? '').trim()
  if (token === '' || token.length > 1000 || /[\r\n\0]/u.test(token)) throw new Error('sync token must be a single-line value')
  return token
}

export function syncAuthorName(value: unknown): string {
  const name = String(value ?? '').trim()
  if (name === '' || name.length > 200 || /[\r\n\0<>]/u.test(name)) throw new Error('sync author name must be one line without angle brackets')
  return name
}

export function syncAuthorEmail(value: unknown): string {
  const email = String(value ?? '').trim()
  if (email.length > 320 || !EMAIL.test(email)) throw new Error('sync author email must be an email address')
  return email
}

export interface MnemonSyncSettings {
  repoUrl?: string
  branch: string
  subdir: string
  token?: string
  authorName: string
  authorEmail: string
}

/**
 * One storage root's Git sync configuration. It lives beside the root rather
 * than in `Config`: the values belong to that root, and the token must never
 * travel through a settings RPC or a profile patch. The file is written whole
 * through a temporary file at mode `0600`.
 */
export class MnemonSyncSettingsStore {
  private readonly root: string

  constructor(runner: StorageRoot) {
    this.root = resolve(runner.effectiveDataDir())
  }

  directory(): string {
    return join(this.root, STATE_DIRECTORY)
  }

  path(): string {
    return join(this.directory(), MNEMON_SYNC_CONFIG_FILE)
  }

  /** The disposable Git work tree the sync channel commits in, never the root itself. */
  mirror(): string {
    return join(this.directory(), 'sync', 'git')
  }

  defaults(): MnemonSyncSettings {
    return {
      branch: MNEMON_SYNC_DEFAULT_BRANCH,
      subdir: MNEMON_SYNC_DEFAULT_SUBDIR,
      authorName: MNEMON_SYNC_DEFAULT_AUTHOR_NAME,
      authorEmail: MNEMON_SYNC_DEFAULT_AUTHOR_EMAIL,
    }
  }

  read(): MnemonSyncSettings {
    const path = this.path()
    if (!existsSync(path)) return this.defaults()
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    } catch {
      throw new Error('sync configuration is not valid JSON')
    }
    const stored = record(parsed)
    if (stored === undefined) throw new Error('sync configuration is not a JSON object')
    for (const key of Object.keys(stored)) if (!known(key)) throw new Error('sync configuration has an unknown field: ' + key)
    const settings = this.defaults()
    if (stored.repoUrl !== undefined) settings.repoUrl = syncRepositoryUrl(stored.repoUrl)
    if (stored.branch !== undefined) settings.branch = syncBranch(stored.branch)
    if (stored.subdir !== undefined) settings.subdir = syncSubdirectory(stored.subdir)
    if (stored.token !== undefined) settings.token = syncToken(stored.token)
    if (stored.authorName !== undefined) settings.authorName = syncAuthorName(stored.authorName)
    if (stored.authorEmail !== undefined) settings.authorEmail = syncAuthorEmail(stored.authorEmail)
    return settings
  }

  write(settings: MnemonSyncSettings): void {
    const directory = this.directory()
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const temporary = join(directory, '.' + MNEMON_SYNC_CONFIG_FILE + '.' + String(process.pid) + '.tmp')
    const file: Record<string, string> = {
      branch: settings.branch,
      subdir: settings.subdir,
      authorName: settings.authorName,
      authorEmail: settings.authorEmail,
    }
    if (settings.repoUrl !== undefined) file.repoUrl = settings.repoUrl
    if (settings.token !== undefined) file.token = settings.token
    try {
      writeFileSync(temporary, JSON.stringify(file, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
      renameSync(temporary, this.path())
    } finally {
      rmSync(temporary, { force: true })
    }
  }

  /** Apply one browser patch; a null or empty value clears the field it names. */
  patch(patch: unknown): MnemonSyncSettings {
    const fields = record(patch)
    if (fields === undefined) throw new Error('sync configuration must be an object')
    for (const key of Object.keys(fields)) if (!known(key)) throw new Error('unknown sync setting: ' + key)
    const next: MnemonSyncSettings = { ...this.read() }
    if ('repoUrl' in fields) {
      if (fields.repoUrl === null || fields.repoUrl === '') delete next.repoUrl
      else next.repoUrl = syncRepositoryUrl(fields.repoUrl)
    }
    if ('branch' in fields) next.branch = syncBranch(fields.branch)
    if ('subdir' in fields) next.subdir = syncSubdirectory(fields.subdir)
    if ('token' in fields) {
      if (fields.token === null || fields.token === '') delete next.token
      else next.token = syncToken(fields.token)
    }
    if ('authorName' in fields) next.authorName = syncAuthorName(fields.authorName)
    if ('authorEmail' in fields) next.authorEmail = syncAuthorEmail(fields.authorEmail)
    return next
  }

  /** The token of one operation: the environment variable wins over the stored one. */
  token(settings: MnemonSyncSettings): string | undefined {
    const fromEnvironment = process.env[MNEMON_SYNC_TOKEN_ENV]?.trim()
    if (fromEnvironment !== undefined && fromEnvironment !== '') return fromEnvironment
    return settings.token
  }

  view(settings: MnemonSyncSettings): MnemonSyncConfigView {
    return {
      ...(settings.repoUrl === undefined ? {} : { repoUrl: settings.repoUrl }),
      branch: settings.branch,
      subdir: settings.subdir,
      hasToken: this.token(settings) !== undefined,
      authorName: settings.authorName,
      authorEmail: settings.authorEmail,
    }
  }

  clearMirror(): void {
    rmSync(this.mirror(), { recursive: true, force: true })
  }
}

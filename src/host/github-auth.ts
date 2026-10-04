/**
 * GitHub sign-in for the repository sync channel: the OAuth device flow, the
 * account query, and the repository list and creation the picker needs.
 *
 * The access token never leaves the Host. It is kept as one grant record in
 * DSH's credentials store, the same seam the Models page writes, so the plugin
 * owns no secret of its own and a Host without that store reports the login as
 * unavailable instead of failing.
 *
 * Requests use the ambient `fetch`, the seam the version check and the plugin
 * installer already use: a launcher that installed a proxy policy did so on the
 * process-wide dispatcher, so an explicit dispatcher here would override that
 * policy rather than honour it. Failures report GitHub's error code and the HTTP
 * status only, never a response body.
 */
import type { MnemonSyncGitHubPoll, MnemonSyncGitHubRepository, MnemonSyncGitHubRepositoryList, MnemonSyncGitHubStatus } from './protocol.ts'

export const MNEMON_GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code'
export const MNEMON_GITHUB_ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token'
export const MNEMON_GITHUB_API_BASE = 'https://api.github.com'
/** The public client the device flow needs; a GitHub App's own id overrides it. */
export const MNEMON_GITHUB_DEFAULT_CLIENT_ID = 'Ov23liq4i7n8UsylGRfb'
export const MNEMON_GITHUB_SCOPE = 'repo'
/**
 * The one record this plugin keeps in DSH's credentials store, as
 * `credentialKey('dsh-mnemon', 'github')` builds it. Both segments satisfy the
 * store's `^[a-z][a-z0-9-]*$` rule, and the key is spelled here rather than
 * imported so the plugin keeps no dependency on the credentials package.
 */
export const MNEMON_SYNC_GITHUB_CREDENTIAL_KEY = 'dsh-mnemon/github'
export const MNEMON_GITHUB_REQUEST_TIMEOUT_MS = 30_000
export const MNEMON_GITHUB_DEFAULT_INTERVAL_MS = 5_000
export const MNEMON_GITHUB_SLOW_DOWN_MS = 5_000
export const MNEMON_GITHUB_MAX_INTERVAL_MS = 60_000
export const MNEMON_GITHUB_FLOW_LIMIT_MS = 3_600_000
export const MNEMON_GITHUB_REPOSITORY_PAGE = 100
export const MNEMON_GITHUB_USER_AGENT = 'dsh-mnemon-sync'
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
const REPOSITORY_NAME = /^(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/u

/** What one stored grant holds. The token is the only field the channel needs. */
export interface MnemonGitHubGrant {
  version: 1
  accessToken: string
  login?: string
  scopes?: string[]
  savedAt: string
}

/**
 * The record half of DSH's credentials seam, as this plugin uses it: presence
 * of the record is the whole fact, and `write` is the only way in.
 */
export interface MnemonGitHubCredentialPort {
  /** Whether the Host exposes a store right now; the service may mount later. */
  available(): boolean
  describe(): Promise<{ configured: boolean; writable: boolean }>
  read(): Promise<MnemonGitHubGrant | undefined>
  write(grant: MnemonGitHubGrant): Promise<void>
  clear(): Promise<void>
}

interface DeviceFlow {
  deviceCode: string
  userCode: string
  verificationUri: string
  expiresAt: number
  intervalMs: number
  nextPollAt: number
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** GitHub answers a refused request with a `error` code or an API `message`. */
function codeOf(body: unknown): string | undefined {
  const fields = record(body)
  return text(fields?.error) ?? text(fields?.message)
}

function failure(action: string, status: number, body: unknown): Error {
  const code = codeOf(body)
  return new Error(code === undefined ? action + ' failed with HTTP ' + String(status) : action + ' failed: ' + code)
}

/** Read one grant out of a stored record, refusing anything else. */
export function githubGrantFromRecord(record_: unknown): MnemonGitHubGrant | undefined {
  const fields = record(record_)
  if (fields?.kind !== 'grant') return undefined
  const payload = record(fields.payload)
  if (payload?.version !== 1) return undefined
  const accessToken = text(payload.accessToken)
  if (accessToken === undefined) return undefined
  const scopes = Array.isArray(payload.scopes) ? payload.scopes.filter((scope): scope is string => typeof scope === 'string') : undefined
  return {
    version: 1,
    accessToken,
    ...(text(payload.login) === undefined ? {} : { login: text(payload.login)! }),
    ...(scopes === undefined || scopes.length === 0 ? {} : { scopes }),
    savedAt: text(payload.savedAt) ?? new Date(0).toISOString(),
  }
}

function repositoryOf(value: unknown): MnemonSyncGitHubRepository | undefined {
  const fields = record(value)
  const fullName = text(fields?.full_name)
  const url = text(fields?.clone_url)
  const name = text(fields?.name)
  if (fullName === undefined || url === undefined || name === undefined) return undefined
  const owner = record(fields?.owner)
  const permissions = record(fields?.permissions)
  return {
    name,
    fullName,
    url,
    private: fields?.private === true,
    defaultBranch: text(fields?.default_branch) ?? 'main',
    owner: text(owner?.login) ?? fullName.split('/')[0] ?? '',
    push: permissions?.push !== false,
  }
}

/**
 * The device flow, the account query, and the repository calls, over one
 * credentials port. Every method is safe to call when the port is absent: the
 * status reports the login as unavailable and the rest refuse by name.
 */
export class MnemonGitHubAuth {
  private flow: DeviceFlow | undefined

  constructor(
    private readonly port: MnemonGitHubCredentialPort | undefined,
    private readonly clientId: string = MNEMON_GITHUB_DEFAULT_CLIENT_ID,
    private readonly now: () => number = () => Date.now(),
    private readonly request: typeof fetch = fetch,
  ) {}

  /** Whether this Host exposes a store the grant can live in. */
  available(): boolean {
    return this.port !== undefined && this.port.available()
  }

  /** The store, or undefined while the Host mounts none. */
  private store(): MnemonGitHubCredentialPort | undefined {
    const port = this.port
    return port !== undefined && port.available() ? port : undefined
  }

  /** The token the sync channel may authenticate with, or undefined. */
  async token(): Promise<string | undefined> {
    return (await this.grant())?.accessToken
  }

  /** The stored grant, or undefined while none is stored or the read fails. */
  async grant(): Promise<MnemonGitHubGrant | undefined> {
    const port = this.store()
    if (port === undefined) return undefined
    try {
      return await port.read()
    } catch {
      return undefined
    }
  }

  private async writable(): Promise<boolean> {
    const port = this.store()
    if (port === undefined) return false
    try {
      return (await port.describe()).writable
    } catch {
      return false
    }
  }

  async status(): Promise<MnemonSyncGitHubStatus> {
    if (!this.available()) return { available: false, signedIn: false, writable: false }
    const grant = await this.grant()
    const writable = await this.writable()
    const flow = this.liveFlow()
    return {
      available: true,
      signedIn: grant !== undefined,
      writable,
      ...(grant?.login === undefined ? {} : { login: grant.login }),
      ...(grant?.scopes === undefined ? {} : { scopes: grant.scopes }),
      ...(flow === undefined ? {} : {
        flow: {
          userCode: flow.userCode,
          verificationUri: flow.verificationUri,
          expiresAt: new Date(flow.expiresAt).toISOString(),
          intervalMs: flow.intervalMs,
        },
      }),
    }
  }

  /** The flow the user may still finish; an expired one is forgotten here. */
  private liveFlow(): DeviceFlow | undefined {
    const flow = this.flow
    if (flow === undefined) return undefined
    if (this.now() >= flow.expiresAt) {
      this.flow = undefined
      return undefined
    }
    return flow
  }

  /** Ask GitHub for a code the user types into the browser. */
  async start(signal?: AbortSignal): Promise<MnemonSyncGitHubStatus> {
    if (!this.available()) throw new Error('this DSH Host provides no credentials store, so GitHub sign-in is unavailable')
    const current = this.liveFlow()
    if (current !== undefined) return this.status()
    if ((await this.grant()) !== undefined) return this.status()
    const { status, body } = await this.json(MNEMON_GITHUB_DEVICE_CODE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.clientId, scope: MNEMON_GITHUB_SCOPE }).toString(),
      ...(signal === undefined ? {} : { signal }),
    })
    if (status !== 200) throw failure('the GitHub device code request', status, body)
    const fields = record(body)
    const deviceCode = text(fields?.device_code)
    const userCode = text(fields?.user_code)
    const verificationUri = text(fields?.verification_uri)
    if (deviceCode === undefined || userCode === undefined || verificationUri === undefined) {
      throw new Error('the GitHub device code answer was incomplete')
    }
    const expiresIn = typeof fields?.expires_in === 'number' ? fields.expires_in : 900
    const interval = typeof fields?.interval === 'number' ? fields.interval : MNEMON_GITHUB_DEFAULT_INTERVAL_MS / 1000
    this.flow = {
      deviceCode,
      userCode,
      verificationUri,
      expiresAt: this.now() + Math.min(expiresIn * 1000, MNEMON_GITHUB_FLOW_LIMIT_MS),
      intervalMs: Math.max(interval * 1000, 1000),
      nextPollAt: this.now() + Math.max(interval * 1000, 1000),
    }
    return this.status()
  }

  /**
   * Ask once whether the browser step happened. The Host keeps the cadence
   * GitHub asked for, so a page that polls faster cannot trip `slow_down`.
   */
  async poll(signal?: AbortSignal): Promise<MnemonSyncGitHubPoll> {
    if (!this.available()) throw new Error('this DSH Host provides no credentials store, so GitHub sign-in is unavailable')
    const flow = this.liveFlow()
    if (flow === undefined) return { status: 'expired' }
    if (this.now() < flow.nextPollAt) return { status: 'pending', intervalMs: flow.intervalMs }
    let answer: { status: number; body: unknown }
    try {
      answer = await this.json(MNEMON_GITHUB_ACCESS_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: this.clientId, device_code: flow.deviceCode, grant_type: DEVICE_GRANT,
        }).toString(),
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (error) {
      // A dropped connection is not an answer: keep the flow and let the page retry.
      flow.nextPollAt = this.now() + flow.intervalMs
      return { status: 'pending', intervalMs: flow.intervalMs, message: error instanceof Error ? error.message : String(error) }
    }
    const fields = record(answer.body)
    const code = text(fields?.error)
    if (code === undefined) {
      const accessToken = text(fields?.access_token)
      if (accessToken === undefined || answer.status !== 200) {
        this.flow = undefined
        return { status: 'error', message: codeOf(answer.body) ?? 'HTTP ' + String(answer.status) }
      }
      const scopes = text(fields?.scope)?.split(/[\s,]+/u).filter(scope => scope !== '')
      const login = await this.account(accessToken, signal)
      const port = this.store()
      if (port === undefined) throw new Error('this DSH Host provides no credentials store, so GitHub sign-in is unavailable')
      await port.write({
        version: 1, accessToken,
        ...(login === undefined ? {} : { login }),
        ...(scopes === undefined || scopes.length === 0 ? {} : { scopes }),
        savedAt: new Date(this.now()).toISOString(),
      })
      this.flow = undefined
      return { status: 'success', ...(login === undefined ? {} : { login }) }
    }
    if (code === 'authorization_pending') {
      flow.nextPollAt = this.now() + flow.intervalMs
      return { status: 'pending', intervalMs: flow.intervalMs }
    }
    if (code === 'slow_down') {
      flow.intervalMs = Math.min(flow.intervalMs + MNEMON_GITHUB_SLOW_DOWN_MS, MNEMON_GITHUB_MAX_INTERVAL_MS)
      flow.nextPollAt = this.now() + flow.intervalMs
      return { status: 'pending', intervalMs: flow.intervalMs }
    }
    this.flow = undefined
    if (code === 'expired_token') return { status: 'expired' }
    if (code === 'access_denied') return { status: 'denied' }
    return { status: 'error', message: code }
  }

  /** Stop waiting for the browser step. The stored grant is untouched. */
  async cancel(): Promise<MnemonSyncGitHubStatus> {
    this.flow = undefined
    return this.status()
  }

  /** Forget the stored grant and any flow that was waiting for it. */
  async signOut(): Promise<MnemonSyncGitHubStatus> {
    this.flow = undefined
    const port = this.store()
    if (port !== undefined) await port.clear()
    return this.status()
  }

  /** The account the token belongs to, or undefined when the query fails. */
  private async account(token: string, signal?: AbortSignal): Promise<string | undefined> {
    try {
      const { status, body } = await this.json(MNEMON_GITHUB_API_BASE + '/user', { headers: this.authorization(token), ...(signal === undefined ? {} : { signal }) })
      if (status !== 200) return undefined
      return text(record(body)?.login)
    } catch {
      return undefined
    }
  }

  private authorization(token: string): Record<string, string> {
    return {
      authorization: 'Bearer ' + token,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    }
  }

  private async requireToken(): Promise<string> {
    const grant = await this.grant()
    if (grant === undefined) throw new Error('sign in to GitHub before choosing a repository')
    return grant.accessToken
  }

  /** The repositories the account may write to, most recently pushed first. */
  async repositories(signal?: AbortSignal): Promise<MnemonSyncGitHubRepositoryList> {
    const token = await this.requireToken()
    const url = MNEMON_GITHUB_API_BASE + '/user/repos?per_page=' + String(MNEMON_GITHUB_REPOSITORY_PAGE) + '&sort=updated&affiliation=owner%2Ccollaborator%2Corganization_member'
    const { status, body } = await this.json(url, { headers: this.authorization(token), ...(signal === undefined ? {} : { signal }) })
    if (status !== 200) throw failure('listing GitHub repositories', status, body)
    if (!Array.isArray(body)) throw new Error('the GitHub repository answer was not a list')
    const repositories: MnemonSyncGitHubRepository[] = []
    for (const entry of body) {
      const repository = repositoryOf(entry)
      if (repository !== undefined) repositories.push(repository)
    }
    const login = (await this.account(token, signal)) ?? ''
    return { login, repositories }
  }

  /** Create one public or private repository under the signed-in account. */
  async create(name: unknown, isPrivate: unknown, signal?: AbortSignal): Promise<MnemonSyncGitHubRepository> {
    const token = await this.requireToken()
    const value = typeof name === 'string' ? name.trim() : ''
    if (!REPOSITORY_NAME.test(value)) throw new Error('a GitHub repository name holds letters, digits, dots, dashes and underscores')
    const { status, body } = await this.json(MNEMON_GITHUB_API_BASE + '/user/repos', {
      method: 'POST',
      headers: { ...this.authorization(token), 'content-type': 'application/json' },
      body: JSON.stringify({ name: value, private: isPrivate === true, auto_init: true }),
      ...(signal === undefined ? {} : { signal }),
    })
    if (status !== 201) throw failure('creating the GitHub repository', status, body)
    const repository = repositoryOf(body)
    if (repository === undefined) throw new Error('the created GitHub repository could not be read back')
    return repository
  }

  private async json(url: string, options: {
    method?: string
    headers?: Record<string, string>
    body?: string
    signal?: AbortSignal
  }): Promise<{ status: number; body: unknown }> {
    const controller = new AbortController()
    const timeout = setTimeout(() => { controller.abort() }, MNEMON_GITHUB_REQUEST_TIMEOUT_MS)
    const signal = options.signal === undefined ? controller.signal : AbortSignal.any([options.signal, controller.signal])
    try {
      const response = await this.request(url, {
        method: options.method ?? 'GET',
        headers: { accept: 'application/json', 'user-agent': MNEMON_GITHUB_USER_AGENT, ...options.headers },
        ...(options.body === undefined ? {} : { body: options.body }),
        signal,
      })
      const raw = await response.text()
      let body: unknown
      try {
        body = raw === '' ? undefined : JSON.parse(raw)
      } catch {
        body = undefined
      }
      return { status: response.status, body }
    } finally {
      clearTimeout(timeout)
    }
  }
}

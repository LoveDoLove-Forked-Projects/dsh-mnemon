import { describe, expect, it, vi } from 'vitest'
import {
  githubGrantFromRecord, MNEMON_GITHUB_DEFAULT_CLIENT_ID, MNEMON_GITHUB_MAX_INTERVAL_MS,
  MNEMON_GITHUB_SLOW_DOWN_MS, MnemonGitHubAuth, type MnemonGitHubCredentialPort, type MnemonGitHubGrant,
} from '../src/host/github-auth.ts'

const NO_STORE = 'this DSH Host provides no credentials store, so GitHub sign-in is unavailable'

interface PortState {
  grant: MnemonGitHubGrant | undefined
  writes: MnemonGitHubGrant[]
  cleared: number
  writable: boolean
  failRead: boolean
}

function port(state: Partial<PortState> = {}): { state: PortState; port: MnemonGitHubCredentialPort } {
  const current: PortState = { grant: undefined, writes: [], cleared: 0, writable: true, failRead: false, ...state }
  return {
    state: current,
    port: {
      available: () => true,
      describe: async () => ({ configured: current.grant !== undefined, writable: current.writable }),
      read: async () => {
        if (current.failRead) throw new Error('the credentials store refused the read')
        return current.grant
      },
      write: async grant => { current.writes.push(grant); current.grant = grant },
      clear: async () => { current.cleared += 1; current.grant = undefined },
    },
  }
}

interface Answer { status: number; body: unknown }

function answering(...answers: Answer[]): { calls: { url: string; init: RequestInit }[]; request: typeof fetch } {
  const calls: { url: string; init: RequestInit }[] = []
  const queue = answers.slice()
  const request = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    const answer = queue.shift()
    if (answer === undefined) throw new Error('unexpected request: ' + String(input))
    return new Response(answer.body === undefined ? '' : JSON.stringify(answer.body), { status: answer.status })
  }) as unknown as typeof fetch
  return { calls, request }
}

const DEVICE_CODE = { device_code: 'device-1', user_code: '2654-9D74', verification_uri: 'https://github.com/login/device', expires_in: 899, interval: 5 }

function auth(options: {
  port?: MnemonGitHubCredentialPort
  answers?: Answer[]
  now?: () => number
} = {}): { auth: MnemonGitHubAuth; state: PortState | undefined; calls: { url: string; init: RequestInit }[] } {
  const built = options.answers === undefined ? undefined : answering(...options.answers)
  const fake = options.port === undefined ? port() : undefined
  const target = new MnemonGitHubAuth(
    options.port ?? fake!.port,
    MNEMON_GITHUB_DEFAULT_CLIENT_ID,
    options.now ?? (() => Date.now()),
    built?.request,
  )
  return { auth: target, state: fake?.state, calls: built?.calls ?? [] }
}

describe('GitHub sign-in for the sync channel', () => {
  it('reads only a grant record shaped the way the flow writes it', () => {
    const grant: MnemonGitHubGrant = { version: 1, accessToken: 'gho_token', login: 'octocat', scopes: ['repo'], savedAt: 'now' }
    expect(githubGrantFromRecord({ kind: 'grant', payload: grant })).toEqual(grant)
    expect(githubGrantFromRecord({ kind: 'grant', payload: { version: 1, accessToken: 'gho_token' } }))
      .toEqual({ version: 1, accessToken: 'gho_token', savedAt: new Date(0).toISOString() })
    expect(githubGrantFromRecord({ kind: 'api-key', payload: grant })).toBeUndefined()
    expect(githubGrantFromRecord({ kind: 'grant', payload: { version: 2, accessToken: 'gho_token' } })).toBeUndefined()
    expect(githubGrantFromRecord({ kind: 'grant', payload: { version: 1, accessToken: '' } })).toBeUndefined()
    expect(githubGrantFromRecord({ kind: 'grant' })).toBeUndefined()
    expect(githubGrantFromRecord(undefined)).toBeUndefined()
    expect(githubGrantFromRecord('grant')).toBeUndefined()
    expect(githubGrantFromRecord({ kind: 'grant', payload: { version: 1, accessToken: 'gho_token', scopes: ['repo', 7] } }))
      .toMatchObject({ scopes: ['repo'] })
  })

  it('reports the login as unavailable while the Host mounts no credentials store', async () => {
    const absent = new MnemonGitHubAuth(undefined)
    expect(absent.available()).toBe(false)
    expect(await absent.status()).toEqual({ available: false, signedIn: false, writable: false })
    expect(await absent.grant()).toBeUndefined()
    expect(await absent.token()).toBeUndefined()
    await expect(absent.start()).rejects.toThrow(NO_STORE)
    await expect(absent.poll()).rejects.toThrow(NO_STORE)
    await expect(absent.repositories()).rejects.toThrow('sign in to GitHub before choosing a repository')
    // Signing out of a Host with no store stays a no-op rather than a failure.
    expect(await absent.signOut()).toEqual({ available: false, signedIn: false, writable: false })
  })

  it('reports the Host that mounts the store later', async () => {
    let mounted = false
    const state = port()
    const late: MnemonGitHubCredentialPort = { ...state.port, available: () => mounted }
    const target = new MnemonGitHubAuth(late)
    expect(await target.status()).toEqual({ available: false, signedIn: false, writable: false })
    mounted = true
    expect(await target.status()).toEqual({ available: true, signedIn: false, writable: true })
  })

  it('keeps a failing read from breaking the status and the token lookup', async () => {
    const state = port({ failRead: true })
    const target = new MnemonGitHubAuth(state.port)
    expect(await target.grant()).toBeUndefined()
    expect(await target.token()).toBeUndefined()
    expect(await target.status()).toEqual({ available: true, signedIn: false, writable: true })
  })

  it('starts the device flow and reports the code the user types into GitHub', async () => {
    const { auth: target, calls } = auth({ answers: [{ status: 200, body: DEVICE_CODE }] })
    const status = await target.start()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://github.com/login/device/code')
    expect(calls[0]?.init.method).toBe('POST')
    expect(String(calls[0]?.init.body)).toBe('client_id=' + MNEMON_GITHUB_DEFAULT_CLIENT_ID + '&scope=repo')
    expect(status.flow?.userCode).toBe('2654-9D74')
    expect(status.flow?.verificationUri).toBe('https://github.com/login/device')
    expect(status.flow?.intervalMs).toBe(5_000)
    expect(Date.parse(String(status.flow?.expiresAt))).toBeGreaterThan(Date.now())
  })

  it('refuses an incomplete device code answer and an HTTP failure without echoing the body', async () => {
    const incomplete = auth({ answers: [{ status: 200, body: { device_code: 'device-1' } }] })
    await expect(incomplete.auth.start()).rejects.toThrow('the GitHub device code answer was incomplete')
    const refused = auth({ answers: [{ status: 403, body: { error: 'rate_limited' } }] })
    await expect(refused.auth.start()).rejects.toThrow('the GitHub device code request failed: rate_limited')
    const bare = auth({ answers: [{ status: 500, body: { secret: 'gho_leak' } }] })
    await expect(bare.auth.start()).rejects.toThrow('the GitHub device code request failed with HTTP 500')
  })

  it('does not start a second flow while one is pending or the account is signed in', async () => {
    const pending = auth({ answers: [{ status: 200, body: DEVICE_CODE }] })
    await pending.auth.start()
    const again = await pending.auth.start()
    expect(pending.calls).toHaveLength(1)
    expect(again.flow?.userCode).toBe('2654-9D74')

    const signed = auth({ port: port({ grant: { version: 1, accessToken: 'gho_token', savedAt: 'now' } }).port })
    const status = await signed.auth.start()
    expect(status.signedIn).toBe(true)
    expect(signed.calls).toHaveLength(0)
  })

  it('waits out the interval GitHub asked for before polling again', async () => {
    let clock = 0
    const { auth: target, calls } = auth({
      now: () => clock,
      answers: [{ status: 200, body: DEVICE_CODE }, { status: 200, body: { error: 'authorization_pending' } }],
    })
    await target.start()
    expect(await target.poll()).toEqual({ status: 'pending', intervalMs: 5_000 })
    expect(calls).toHaveLength(1)
    clock += 5_000
    expect(await target.poll()).toEqual({ status: 'pending', intervalMs: 5_000 })
    expect(calls).toHaveLength(2)
  })

  it('stores the grant and the account once GitHub answers the token request', async () => {
    let clock = 0
    const fake = port()
    const { auth: target, calls } = auth({
      port: fake.port,
      now: () => clock,
      answers: [
        { status: 200, body: DEVICE_CODE },
        { status: 200, body: { access_token: 'gho_token', token_type: 'bearer', scope: 'repo,gist' } },
        { status: 200, body: { login: 'octocat' } },
      ],
    })
    await target.start()
    clock += 5_000
    const answer = await target.poll()
    expect(answer).toEqual({ status: 'success', login: 'octocat' })
    expect(fake.state.writes).toEqual([{ version: 1, accessToken: 'gho_token', login: 'octocat', scopes: ['repo', 'gist'], savedAt: new Date(5_000).toISOString() }])
    expect(await target.token()).toBe('gho_token')
    expect(await target.status()).toMatchObject({ available: true, signedIn: true, writable: true, login: 'octocat', scopes: ['repo', 'gist'] })
    expect((await target.status()).flow).toBeUndefined()
    expect(calls.map(call => call.url)).toEqual([
      'https://github.com/login/device/code', 'https://github.com/login/oauth/access_token', 'https://api.github.com/user',
    ])
  })

  it('still stores the grant when the account query fails', async () => {
    let clock = 0
    const fake = port()
    const { auth: target } = auth({
      port: fake.port,
      now: () => clock,
      answers: [
        { status: 200, body: DEVICE_CODE },
        { status: 200, body: { access_token: 'gho_token' } },
        { status: 500, body: { message: 'server error' } },
      ],
    })
    await target.start()
    clock += 5_000
    expect(await target.poll()).toEqual({ status: 'success' })
    expect(fake.state.writes[0]).toMatchObject({ accessToken: 'gho_token' })
    expect(fake.state.writes[0]?.login).toBeUndefined()
  })

  it('backs off when GitHub asks for a slower poll and keeps the flow alive', async () => {
    let clock = 0
    const { auth: target } = auth({
      now: () => clock,
      answers: [
        { status: 200, body: DEVICE_CODE },
        { status: 200, body: { error: 'slow_down' } },
        { status: 200, body: { error: 'authorization_pending' } },
      ],
    })
    await target.start()
    clock += 5_000
    expect(await target.poll()).toEqual({ status: 'pending', intervalMs: 5_000 + MNEMON_GITHUB_SLOW_DOWN_MS })
    clock += 5_000 + MNEMON_GITHUB_SLOW_DOWN_MS
    expect(await target.poll()).toEqual({ status: 'pending', intervalMs: 5_000 + MNEMON_GITHUB_SLOW_DOWN_MS })
    expect(await target.poll()).toEqual({ status: 'pending', intervalMs: 5_000 + MNEMON_GITHUB_SLOW_DOWN_MS })
  })

  it('caps the backoff at the ceiling GitHub allows', async () => {
    let clock = 0
    const answers: Answer[] = [{ status: 200, body: DEVICE_CODE }]
    for (let index = 0; index < 20; index += 1) answers.push({ status: 200, body: { error: 'slow_down' } })
    const { auth: target } = auth({ now: () => clock, answers })
    await target.start()
    let interval = 5_000
    for (let index = 0; index < 20; index += 1) {
      clock += interval
      const answer = await target.poll()
      interval = answer.intervalMs ?? interval
    }
    expect(interval).toBe(MNEMON_GITHUB_MAX_INTERVAL_MS)
  })

  it('reports a dropped connection as pending so the page keeps polling', async () => {
    let clock = 0
    const { auth: target } = auth({ now: () => clock, answers: [{ status: 200, body: DEVICE_CODE }] })
    await target.start()
    clock += 5_000
    const answer = await target.poll()
    expect(answer.status).toBe('pending')
    expect(answer.message).toBe('unexpected request: https://github.com/login/oauth/access_token')
  })

  it('tells the page apart an expired flow, a refusal and an unknown error', async () => {
    let clock = 0
    const expired = auth({
      now: () => clock,
      answers: [{ status: 200, body: DEVICE_CODE }, { status: 200, body: { error: 'expired_token' } }],
    })
    await expired.auth.start()
    clock += 5_000
    expect(await expired.auth.poll()).toEqual({ status: 'expired' })
    expect((await expired.auth.status()).flow).toBeUndefined()

    const denied = auth({
      now: () => clock,
      answers: [{ status: 200, body: DEVICE_CODE }, { status: 200, body: { error: 'access_denied' } }],
    })
    await denied.auth.start()
    clock += 5_000
    expect(await denied.auth.poll()).toEqual({ status: 'denied' })

    const broken = auth({
      now: () => clock,
      answers: [{ status: 200, body: DEVICE_CODE }, { status: 200, body: { error: 'unsupported_grant_type' } }],
    })
    await broken.auth.start()
    clock += 5_000
    expect(await broken.auth.poll()).toEqual({ status: 'error', message: 'unsupported_grant_type' })
  })

  it('forgets a flow whose code expired before the browser step finished', async () => {
    let clock = 0
    const { auth: target } = auth({ now: () => clock, answers: [{ status: 200, body: { ...DEVICE_CODE, expires_in: 1 } }] })
    await target.start()
    clock += 1_000
    expect((await target.status()).flow).toBeUndefined()
    expect(await target.poll()).toEqual({ status: 'expired' })
  })

  it('cancels a flow without touching the stored grant and signs out with it', async () => {
    const fake = port()
    const { auth: target } = auth({ port: fake.port, answers: [{ status: 200, body: DEVICE_CODE }] })
    await target.start()
    expect((await target.cancel()).flow).toBeUndefined()

    fake.state.grant = { version: 1, accessToken: 'gho_token', login: 'octocat', savedAt: 'now' }
    const signedOut = await target.signOut()
    expect(signedOut).toEqual({ available: true, signedIn: false, writable: true })
    expect(fake.state.cleared).toBe(1)
    expect(fake.state.grant).toBeUndefined()
  })

  it('lists the repositories the account may write to', async () => {
    const fake = port({ grant: { version: 1, accessToken: 'gho_token', savedAt: 'now' } })
    const { auth: target, calls } = auth({
      port: fake.port,
      answers: [
        { status: 200, body: [
          { name: 'memory', full_name: 'octocat/memory', clone_url: 'https://github.com/octocat/memory.git', private: true, default_branch: 'main', owner: { login: 'octocat' }, permissions: { push: true } },
          { name: 'notes', full_name: 'octocat/notes', clone_url: 'https://github.com/octocat/notes.git', private: false, default_branch: 'trunk', owner: { login: 'octocat' }, permissions: { push: false } },
          { name: '', full_name: 'octocat/broken', clone_url: 'https://github.com/octocat/broken.git' },
        ] },
        { status: 200, body: { login: 'octocat' } },
      ],
    })
    const list = await target.repositories()
    expect(list.login).toBe('octocat')
    expect(list.repositories).toEqual([
      { name: 'memory', fullName: 'octocat/memory', url: 'https://github.com/octocat/memory.git', private: true, defaultBranch: 'main', owner: 'octocat', push: true },
      { name: 'notes', fullName: 'octocat/notes', url: 'https://github.com/octocat/notes.git', private: false, defaultBranch: 'trunk', owner: 'octocat', push: false },
    ])
    expect(calls[0]?.url).toBe('https://api.github.com/user/repos?per_page=100&sort=updated&affiliation=owner%2Ccollaborator%2Corganization_member')
    expect(calls[0]?.init.headers).toMatchObject({ authorization: 'Bearer gho_token', 'x-github-api-version': '2022-11-28' })
  })

  it('refuses to list repositories without a sign-in and reports what GitHub said', async () => {
    const anonymous = auth({ answers: [] })
    await expect(anonymous.auth.repositories()).rejects.toThrow('sign in to GitHub before choosing a repository')

    const refused = auth({
      port: port({ grant: { version: 1, accessToken: 'gho_token', savedAt: 'now' } }).port,
      answers: [{ status: 401, body: { message: 'Bad credentials' } }],
    })
    await expect(refused.auth.repositories()).rejects.toThrow('listing GitHub repositories failed: Bad credentials')

    const malformed = auth({
      port: port({ grant: { version: 1, accessToken: 'gho_token', savedAt: 'now' } }).port,
      answers: [{ status: 200, body: { repositories: [] } }],
    })
    await expect(malformed.auth.repositories()).rejects.toThrow('the GitHub repository answer was not a list')
  })

  it('creates one repository and reads it back', async () => {
    const fake = port({ grant: { version: 1, accessToken: 'gho_token', savedAt: 'now' } })
    const { auth: target, calls } = auth({
      port: fake.port,
      answers: [{
        status: 201,
        body: { name: 'mnemon-memory', full_name: 'octocat/mnemon-memory', clone_url: 'https://github.com/octocat/mnemon-memory.git', private: true, default_branch: 'main', owner: { login: 'octocat' }, permissions: { push: true } },
      }],
    })
    const repository = await target.create('mnemon-memory', true)
    expect(repository.fullName).toBe('octocat/mnemon-memory')
    expect(calls[0]?.init.method).toBe('POST')
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ name: 'mnemon-memory', private: true, auto_init: true })
  })

  it('refuses an unusable repository name and a creation GitHub declined', async () => {
    const named = auth({ port: port({ grant: { version: 1, accessToken: 'gho_token', savedAt: 'now' } }).port, answers: [] })
    for (const name of ['', '  ', '.', '..', 'a/b', 'has space', 'x'.repeat(101), 7]) {
      await expect(named.auth.create(name, false)).rejects.toThrow('a GitHub repository name holds letters, digits, dots, dashes and underscores')
    }

    const declined = auth({
      port: port({ grant: { version: 1, accessToken: 'gho_token', savedAt: 'now' } }).port,
      answers: [{ status: 422, body: { message: 'name already exists on this account' } }],
    })
    await expect(declined.auth.create('mnemon-memory', true)).rejects.toThrow('creating the GitHub repository failed: name already exists on this account')

    const unreadable = auth({
      port: port({ grant: { version: 1, accessToken: 'gho_token', savedAt: 'now' } }).port,
      answers: [{ status: 201, body: { id: 1 } }],
    })
    await expect(unreadable.auth.create('mnemon-memory', true)).rejects.toThrow('the created GitHub repository could not be read back')
  })
})

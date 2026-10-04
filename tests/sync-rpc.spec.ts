import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { HostRpcHandler } from '../src/host/dsh.ts'
import { runProcess } from '../src/host/process.ts'
import { createSyncHandler } from '../src/host/rpc.ts'
import { compositionFixture } from './fixtures/composition.ts'

const directories: string[] = []
const releases: Array<() => Promise<void>> = []
const TOKEN = 'ghp_secret_token_value'
const COMPONENTS = ['runtime', 'documents', 'memory-spaces']

async function git(args: string[], cwd?: string): Promise<string> {
  const result = await runProcess('git', args, { timeoutMs: 60_000, ...(cwd === undefined ? {} : { cwd }), label: 'git' })
  if (result.exitCode !== 0) throw new Error('git ' + args.join(' ') + ': ' + result.stderr)
  return result.stdout
}

const available = await git(['--version']).then(() => true, () => false)

function temporary(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-mnemon-' + label + '-'))
  directories.push(directory)
  return directory
}

/** One machine: the real runtime graph plus the sync channel registered over it. */
async function machine() {
  const fixture = await compositionFixture()
  releases.push(fixture.dispose)
  return { fixture, sync: createSyncHandler(fixture.live) as HostRpcHandler, data: join(fixture.root, 'data') }
}

async function origin(label: string): Promise<string> {
  const directory = join(temporary(label), 'sync.git')
  await git(['init', '--bare', '--quiet', directory])
  return directory
}

afterEach(async () => {
  for (const release of releases.splice(0)) await release()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

// The channel is driven through the real graph, so every case here runs real Git.
describe.skipIf(!available)('Mnemon Git sync over RPC', { timeout: 90_000 }, () => {
  it('pushes the whole pack and imports it on a second machine through the channel', async () => {
    const remote = await origin('sync-rpc-roundtrip')
    const first = await machine()

    const before = await first.sync('status', {})
    expect(before).toMatchObject({ ok: true, value: { configured: false, git: { available: true }, remote: { reachable: false, branchExists: false } } })

    const configured = await first.sync('configure', { repoUrl: remote, token: TOKEN })
    expect(configured).toMatchObject({
      ok: true,
      value: { repoUrl: remote, branch: 'mnemon-sync', subdir: 'mnemon/', hasToken: true, authorName: 'dsh-mnemon sync', authorEmail: 'mnemon@localhost' },
    })
    // The answer names the credential without ever carrying it.
    expect(JSON.stringify(configured)).not.toContain(TOKEN)

    await first.fixture.graph.source('runtime').mutate('mutate', { action: 'add', target: 'memory', content: 'RPC push payload' })
    const pushed = await first.sync('push', { message: 'Sync from RPC', confirmed: true })
    expect(pushed).toMatchObject({ ok: true, value: { repoUrl: remote, branch: 'mnemon-sync', subdir: 'mnemon/', committed: true, pushed: true, message: 'Sync from RPC' } })
    const push = (pushed as { value: { commit: string; summary: Array<{ component: string }>; files: number; bytes: number } }).value
    expect(push.commit).toMatch(/^[0-9a-f]{40}$/u)
    expect(push.summary.map(entry => entry.component)).toEqual(COMPONENTS)
    expect(push.files).toBeGreaterThan(0)
    expect(push.bytes).toBeGreaterThan(0)
    expect(JSON.stringify(pushed)).not.toContain(TOKEN)
    expect(await git(['show', 'mnemon-sync:mnemon/payload/runtime/MEMORY.md'], remote)).toContain('RPC push payload')

    const second = await machine()
    const localMemory = join(second.data, 'runtime', 'MEMORY.md')
    expect(await second.sync('configure', { repoUrl: remote })).toMatchObject({ ok: true, value: { hasToken: false } })

    const preview = await second.sync('preview', {})
    expect(preview).toMatchObject({ ok: true, value: { repoUrl: remote, branch: 'mnemon-sync', subdir: 'mnemon/', commit: push.commit } })
    const inspected = (preview as { value: { components: Array<{ component: string }>; files: { total: number }; manifest: { format: string; version: number; scope: string }; pushedAt: string } }).value
    expect(inspected.components.map(entry => entry.component)).toEqual(COMPONENTS)
    expect(inspected.files.total).toBeGreaterThan(0)
    expect(inspected.manifest).toMatchObject({ format: 'mnemonpack', version: 1, scope: 'full' })
    expect(inspected.pushedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u)
    // Checking the remote is a read: the payload is still not on this machine.
    expect(existsSync(localMemory) ? readFileSync(localMemory, 'utf8') : '').not.toContain('RPC push payload')

    const pulled = await second.sync('pull', { confirmed: true })
    expect(pulled).toMatchObject({ ok: true, value: { imported: true, mode: 'merge', repoUrl: remote, commit: push.commit, components: COMPONENTS, targetRoot: second.data } })
    expect(readFileSync(localMemory, 'utf8')).toContain('RPC push payload')
  })

  it('refuses to publish or import without confirmation and never echoes the token', async () => {
    const remote = await origin('sync-rpc-guards')
    const host = await machine()

    expect(await host.sync('push', {})).toMatchObject({ ok: false, error: { message: 'Publishing the sync branch requires confirmation' } })
    expect(await host.sync('pull', {})).toMatchObject({ ok: false, error: { message: 'Importing the remote Mnemon payload requires confirmation' } })
    // Nothing is configured yet, so the refusal is decided before any Git process starts.
    expect(await host.sync('push', { confirmed: true })).toMatchObject({ ok: false, error: { message: expect.stringContaining('no sync repository is configured') } })
    expect(await host.sync('preview', {})).toMatchObject({ ok: false, error: { message: expect.stringContaining('no sync repository is configured') } })

    expect(await host.sync('configure', { repoUrl: remote, token: TOKEN })).toMatchObject({ ok: true })
    const status = await host.sync('status', {})
    expect(status).toMatchObject({ ok: true, value: { configured: true, config: { hasToken: true }, remote: { reachable: true, branchExists: false } } })
    expect(JSON.stringify(status)).not.toContain(TOKEN)

    // An unreachable remote reports through the channel without leaking the credential.
    const unreachable = await machine()
    expect(await unreachable.sync('configure', { repoUrl: 'https://127.0.0.1:1/owner/repo.git', token: TOKEN })).toMatchObject({ ok: true })
    const offline = await unreachable.sync('status', {})
    expect(offline).toMatchObject({ ok: true, value: { configured: true, config: { hasToken: true }, remote: { reachable: false, branchExists: false } } })
    expect(typeof (offline as { value: { remote: { error?: string } } }).value.remote.error).toBe('string')
    expect(JSON.stringify(offline)).not.toContain(TOKEN)
    const refused = await unreachable.sync('push', { confirmed: true })
    expect(refused).toMatchObject({ ok: false, error: { code: 'internal' } })
    expect(JSON.stringify(refused)).not.toContain(TOKEN)

    expect(await host.sync('nope', {})).toMatchObject({ ok: false, error: { code: 'bad-request', message: 'unknown sync endpoint: nope' } })
  })

  it('accepts the scope keys the page sends and keeps them out of the stored configuration', async () => {
    const remote = await origin('sync-rpc-scope')
    const host = await machine()

    // The page scopes every call: the routing key travels beside the settings patch.
    // The real workspace registry rejects invented ids, so the scope here is the session only.
    const configured = await host.sync('configure', { repoUrl: remote, token: TOKEN, sessionId: 'session-1' })
    expect(configured).toMatchObject({ ok: true, value: { repoUrl: remote, hasToken: true } })

    const stored = JSON.parse(readFileSync(join(host.data, 'state', 'sync-git.json'), 'utf8')) as Record<string, unknown>
    expect(stored).toMatchObject({ repoUrl: remote, branch: 'mnemon-sync', subdir: 'mnemon/' })
    expect(Object.keys(stored)).not.toContain('sessionId')
    expect(Object.keys(stored)).not.toContain('workspaceId')

    // Routing keys are stripped, not waved through: a real typo is still refused.
    expect(await host.sync('configure', { repoUrl: remote, components: ['runtime'] }))
      .toMatchObject({ ok: false, error: { message: 'unknown sync setting: components' } })
  })

  it('keeps reads available and every write gated while the Host is read-only', async () => {
    const host = await compositionFixture({ writeEnabled: false })
    releases.push(host.dispose)
    const sync = createSyncHandler(host.live)
    const readOnly = { ok: false, error: { message: expect.stringContaining('read-only') } }

    expect(await sync('configure', { repoUrl: 'https://example.test/owner/repo.git' })).toMatchObject(readOnly)
    expect(await sync('push', { confirmed: true })).toMatchObject(readOnly)
    expect(await sync('pull', { confirmed: true })).toMatchObject(readOnly)
    expect(await sync('status', {})).toMatchObject({ ok: true, value: { configured: false } })
  })
})

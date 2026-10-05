import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { unzipSync } from 'fflate'
import { resolveConfig } from '../src/host/config.ts'
import { MnemonPackManager, type MnemonSettingsBridge } from '../src/host/pack.ts'
import { createStorageRoot } from '../src/host/storage-root.ts'
import { MnemonGitSync, gitEnvironment } from '../src/host/git-sync.ts'
import { runProcess } from '../src/host/process.ts'
import { sourceFixture } from './fixtures/sources.ts'

const directories: string[] = []
const releases: Array<() => Promise<void>> = []
const now = () => new Date('2026-08-14T12:00:00.000Z')

/**
 * Git takes the repository location from the environment, and the harness shell
 * shims export `GIT_DIR` for their own PATH bookkeeping, so every Git process
 * this suite starts runs with those variables removed.
 */
async function git(args: string[], cwd?: string): Promise<string> {
  const result = await runProcess('git', args, { timeoutMs: 60_000, env: gitEnvironment(), ...(cwd === undefined ? {} : { cwd }), label: 'git' })
  if (result.exitCode !== 0) throw new Error('git ' + args.join(' ') + ': ' + result.stderr)
  return result.stdout
}

const available = await git(['--version']).then(() => true, () => false)

function temporary(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-mnemon-' + label + '-'))
  directories.push(directory)
  return directory
}

/**
 * A clock that advances on every read. A real machine re-stamps the manifest on
 * every export, so a repeated push always carries a new `exportedAt`; a pinned
 * clock hides that, which is how a repeat once slipped through as a new commit.
 */
function tickingClock(): { now: () => Date; reads: () => number } {
  let elapsed = 0
  return {
    now: () => new Date(Date.parse('2026-08-14T12:00:00.000Z') + (elapsed += 1_000)),
    reads: () => elapsed,
  }
}

/** One machine: a storage root, its pack manager and the sync channel over it. */
async function machine(label: string, repository?: string, clock: () => Date = now, bridge?: MnemonSettingsBridge) {
  const root = temporary(label)
  const workspace = temporary(label + '-workspace')
  const config = resolveConfig({ storageScope: 'custom', dataDir: root, cliPath: '/fake/mnemon' })
  const runner = createStorageRoot(config)
  const sources = await sourceFixture({ dataDir: root, workspace })
  releases.push(sources.dispose)
  const packs = new MnemonPackManager(runner, config, undefined, clock, bridge)
  const sync = new MnemonGitSync(runner, config, packs, undefined, clock)
  if (repository !== undefined) sync.configure({ repoUrl: repository })
  return { root, workspace, runner, config, packs, sync, sources }
}

async function repository(label: string): Promise<string> {
  const directory = join(temporary(label), 'sync.git')
  await git(['init', '--bare', '--quiet', directory])
  return directory
}

afterEach(async () => {
  for (const release of releases.splice(0)) await release()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

// Every case drives real Git processes against a real bare repository.
describe.skipIf(!available)('Mnemon Git sync', { timeout: 90_000 }, () => {
  it('reports Git, the configuration and the remote before anything is pushed', async () => {
    const origin = await repository('sync-status-remote')
    const machineA = await machine('sync-status', origin)
    const status = await machineA.sync.status()
    expect(status.git).toMatchObject({ available: true })
    expect(status.configured).toBe(true)
    expect(status.remote).toEqual({ reachable: true, branchExists: false })
    expect(status.config.hasToken).toBe(false)
    expect(JSON.stringify(status)).not.toContain('ghp_')
    expect((await machineA.sync.status()).lastCommit).toBeUndefined()
  })

  it('refuses every direction while no repository is configured', async () => {
    const machineA = await machine('sync-unconfigured')
    await expect(machineA.sync.push()).rejects.toThrow('no sync repository is configured')
    await expect(machineA.sync.preview()).rejects.toThrow('no sync repository is configured')
    await expect(machineA.sync.pull()).rejects.toThrow('no sync repository is configured')
    await expect(machineA.sync.status()).resolves.toMatchObject({ configured: false, remote: { reachable: false, branchExists: false } })
  })

  it('publishes the full pack as readable files on the configured branch', async () => {
    const origin = await repository('sync-push-remote')
    const machineA = await machine('sync-push', origin)
    await machineA.sources.runtime.mutate('mutate', { action: 'add', target: 'user', content: 'Prefer concise answers', importance: 'normal' }, { confirmed: true })

    const pushed = await machineA.sync.push({ message: 'Sync memory' })
    expect(pushed).toMatchObject({ branch: 'mnemon-sync', subdir: 'mnemon/', committed: true, pushed: true, message: 'Sync memory' })
    expect(pushed.commit).toMatch(/^[0-9a-f]{40}$/u)
    expect(pushed.summary.map(entry => entry.component)).toEqual(['runtime', 'documents', 'memory-spaces', 'settings'])
    expect(await git(['show', 'mnemon-sync:mnemon/manifest.json'], origin)).toContain('"mnemonpack"')
    expect(await git(['show', 'mnemon-sync:mnemon/payload/runtime/USER.md'], origin)).toContain('Prefer concise answers')
    expect(await git(['show', 'mnemon-sync:mnemon/checksums.json'], origin)).toContain('"sha256"')

    // The mirror is a disposable work tree, never the storage root.
    expect(existsSync(join(machineA.root, '.git'))).toBe(false)
    expect(existsSync(join(machineA.root, 'state', 'sync', 'git', '.git'))).toBe(true)
    expect(await git(['status', '--porcelain'], join(machineA.root, 'state', 'sync', 'git'))).toBe('')
  })

  it('commits under the identity of this machine when the author is blank', async () => {
    // The identity Git would use on its own, as Git itself reports it.
    const identity = (await git(['var', 'GIT_AUTHOR_IDENT'])).trim()
    const expected = identity.slice(0, identity.indexOf('>') + 1)
    const origin = await repository('sync-author-remote')
    const machineA = await machine('sync-author', origin)
    const cleared = await machineA.sync.configure({ authorName: '', authorEmail: '' })
    expect(cleared).toMatchObject({ authorName: '', authorEmail: '', branch: 'mnemon-sync', subdir: 'mnemon/' })

    const pushed = await machineA.sync.push({ message: 'Sync without an author' })
    expect(pushed).toMatchObject({ committed: true, pushed: true })
    expect(await git(['log', '-1', '--format=%an <%ae>', 'mnemon-sync'], origin)).toBe(expected + '\n')
  })

  it('records the channel on the manifest without breaking the Mnemon Pack reader', async () => {
    const origin = await repository('sync-manifest-remote')
    const machineA = await machine('sync-manifest', origin)
    await machineA.sync.push({ message: 'First' })
    const manifest = JSON.parse(await git(['show', 'mnemon-sync:mnemon/manifest.json'], origin))
    expect(manifest).toMatchObject({ format: 'mnemonpack', version: 1, scope: 'full', sync: { channel: 'git', branch: 'mnemon-sync', subdir: 'mnemon/' } })
    expect(manifest.sync.pushedAt).toBe('2026-08-14T12:00:00.000Z')
    expect(manifest.components).toEqual(['runtime', 'documents', 'memory-spaces', 'settings'])
  })

  it('does not commit a second time when the payload has not changed', async () => {
    const origin = await repository('sync-idempotent-remote')
    const clock = tickingClock()
    const machineA = await machine('sync-idempotent', origin, clock.now)
    const first = await machineA.sync.push({ message: 'First' })
    const published = await git(['show', 'mnemon-sync:mnemon/manifest.json'], origin)
    const readsBeforeSecond = clock.reads()
    const second = await machineA.sync.push({ message: 'Second' })
    expect(first).toMatchObject({ committed: true, pushed: true })
    expect(second).toMatchObject({ committed: false, pushed: false, commit: first.commit, reason: 'the branch already holds this payload' })
    expect((await git(['rev-list', '--count', 'mnemon-sync'], origin)).trim()).toBe('1')
    // The second export really carried a later exportedAt and pushedAt; only
    // those two fields differ, and a timestamp alone is not a payload change.
    expect(clock.reads()).toBeGreaterThan(readsBeforeSecond)
    expect(await git(['show', 'mnemon-sync:mnemon/manifest.json'], origin)).toBe(published)
    expect(await git(['status', '--porcelain'], join(machineA.root, 'state', 'sync', 'git'))).toBe('')
  })

  it('does not commit a second time when this machine really holds an entry', async () => {
    // The first export stamps every entry this machine wrote with its origin, and a stamp taken
    // from the export clock would rewrite the payload on the next run. The entry is what makes
    // that path reachable, so the empty-root case above cannot catch it.
    const origin = await repository('sync-idempotent-entry-remote')
    const clock = tickingClock()
    const machineA = await machine('sync-idempotent-entry', origin, clock.now)
    await machineA.sources.runtime.mutate('mutate', { action: 'add', target: 'user', content: 'Prefer concise answers', importance: 'normal' }, { confirmed: true })
    const first = await machineA.sync.push({ message: 'First' })
    const published = await git(['show', 'mnemon-sync:mnemon/payload/runtime/memories.json'], origin)
    const second = await machineA.sync.push({ message: 'Second' })

    expect(first).toMatchObject({ committed: true, pushed: true })
    expect(published).toContain('Prefer concise answers')
    expect(second).toMatchObject({ committed: false, pushed: false, commit: first.commit, reason: 'the branch already holds this payload' })
    expect((await git(['rev-list', '--count', 'mnemon-sync'], origin)).trim()).toBe('1')
    expect(await git(['show', 'mnemon-sync:mnemon/payload/runtime/memories.json'], origin)).toBe(published)
  })

  it('still publishes nothing new when this installation also carries settings', async () => {
    // The settings component is staged into the data directory on every export, so
    // an unchanged profile must not restamp the payload and fake a change.
    const origin = await repository('sync-settings-idempotent-remote')
    const clock = tickingClock()
    // The bridge stamps every collection with the current time, exactly as the
    // profile-backed bridge does, so only the restamping keeps the bytes stable.
    const bridge: MnemonSettingsBridge = {
      collect: async () => ({
        version: 1,
        exportedAt: clock.now().toISOString(),
        namespaces: [{ ns: 'mnemon-ui', user: { displayMode: 'sidebar' }, updatedAt: clock.now().toISOString() }],
      }),
      apply: async () => {},
    }
    const machineA = await machine('sync-settings-idempotent', origin, clock.now, bridge)
    const first = await machineA.sync.push({ message: 'First' })
    const published = await git(['show', 'mnemon-sync:mnemon/payload/settings/mnemon.json'], origin)
    const second = await machineA.sync.push({ message: 'Second' })

    expect(first).toMatchObject({ committed: true, pushed: true })
    expect(second).toMatchObject({ committed: false, pushed: false, reason: 'the branch already holds this payload' })
    expect((await git(['rev-list', '--count', 'mnemon-sync'], origin)).trim()).toBe('1')
    expect(await git(['show', 'mnemon-sync:mnemon/payload/settings/mnemon.json'], origin)).toBe(published)
  })

  it('pulls the branch into a second machine as the second machine would', async () => {
    const origin = await repository('sync-pull-remote')
    const machineA = await machine('sync-pull-a', origin)
    await machineA.sources.runtime.mutate('mutate', { action: 'add', target: 'user', content: 'Prefers table output', importance: 'normal' }, { confirmed: true })
    await machineA.sync.push({ message: 'Publish' })

    const machineB = await machine('sync-pull-b', origin)
    const preview = await machineB.sync.preview()
    expect(preview).toMatchObject({ branch: 'mnemon-sync', subdir: 'mnemon/', pushedAt: '2026-08-14T12:00:00.000Z' })
    expect(preview.manifest.scope).toBe('full')
    expect(preview.components.map(entry => entry.component)).toEqual(['runtime', 'documents', 'memory-spaces', 'settings'])
    // The published profile differs from the empty one this machine holds.
    expect(preview.components.find(entry => entry.component === 'runtime')).toMatchObject({ changed: true, items: 1 })
    expect(preview.files.changed).toBeGreaterThan(0)
    expect(preview.expandedBytes).toBeGreaterThan(0)

    const pulled = await machineB.sync.pull({ mode: 'merge' })
    expect(pulled).toMatchObject({ imported: true, mode: 'merge', components: ['runtime', 'documents', 'memory-spaces', 'settings'] })
    expect(readFileSync(join(machineB.root, 'runtime', 'USER.md'), 'utf8')).toContain('Prefers table output')

    // The pulled payload is the same pack the ZIP path would have produced.
    const exported = await machineB.packs.exportPack('full')
    expect(unzipSync(Buffer.from(exported.base64, 'base64'))['payload/runtime/USER.md']).toBeDefined()
  })

  it('reports what differs without importing anything on preview', async () => {
    const origin = await repository('sync-preview-remote')
    const machineA = await machine('sync-preview-a', origin)
    await machineA.sources.runtime.mutate('mutate', { action: 'add', target: 'user', content: 'Published profile', importance: 'normal' }, { confirmed: true })
    await machineA.sync.push({ message: 'Publish' })

    const machineB = await machine('sync-preview-b', origin)
    await machineB.sources.runtime.mutate('mutate', { action: 'add', target: 'memory', content: 'Local only note', importance: 'normal' }, { confirmed: true })
    const preview = await machineB.sync.preview()
    expect(preview.files.total).toBeGreaterThan(0)
    expect(preview.files.changed).toBeGreaterThan(0)
    expect(preview.components.find(entry => entry.component === 'runtime')?.changed).toBe(true)
    // A preview never touches the local payload.
    expect(readFileSync(join(machineB.root, 'runtime', 'USER.md'), 'utf8')).not.toContain('Published profile')
  })

  it('fails hard and imports nothing when a payload file does not match its checksum', async () => {
    const origin = await repository('sync-tamper-remote')
    const machineA = await machine('sync-tamper-a', origin)
    await machineA.sources.runtime.mutate('mutate', { action: 'add', target: 'user', content: 'Published profile', importance: 'normal' }, { confirmed: true })
    await machineA.sync.push({ message: 'Publish' })

    const clone = join(temporary('sync-tamper-clone'), 'work')
    await git(['clone', '--quiet', '--branch', 'mnemon-sync', origin, clone])
    const profile = join(clone, 'mnemon', 'payload', 'runtime', 'USER.md')
    writeFileSync(profile, readFileSync(profile, 'utf8') + '\nTampered\n')
    await git(['-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '--quiet', '-am', 'Tamper'], clone)
    await git(['push', '--quiet', 'origin', 'mnemon-sync'], clone)

    const machineB = await machine('sync-tamper-b', origin)
    await expect(machineB.sync.preview()).rejects.toThrow('failed its checksum: payload/runtime/USER.md')
    await expect(machineB.sync.pull({ mode: 'merge' })).rejects.toThrow('failed its checksum: payload/runtime/USER.md')
    // The remote payload never reaches the local payload: the fixture's own
    // profile survives and the published entry is absent.
    expect(readFileSync(join(machineB.root, 'runtime', 'USER.md'), 'utf8')).not.toContain('Published profile')
    expect(readFileSync(join(machineB.root, 'runtime', 'memories.json'), 'utf8')).not.toContain('Published profile')
  })

  it('reports an empty remote instead of importing an empty payload', async () => {
    const origin = await repository('sync-empty-remote')
    const machineA = await machine('sync-empty', origin)
    await git(['commit', '--quiet', '--allow-empty', '-m', 'Unrelated'], await unrelatedCommit(origin))
    await expect(machineA.sync.preview()).rejects.toThrow('holds no Mnemon payload')
    await expect(machineA.sync.pull({ mode: 'merge' })).rejects.toThrow('holds no Mnemon payload')
  })

  it('folds the branch into this machine before publishing, so no machine overwrites another', async () => {
    const origin = await repository('sync-merge-remote')
    const machineA = await machine('sync-merge-a', origin)
    await machineA.sources.runtime.mutate('mutate', { action: 'add', target: 'user', content: 'Prefer concise answers', importance: 'normal' }, { confirmed: true })
    await machineA.sync.push({ message: 'Publish from A' })

    const machineB = await machine('sync-merge-b', origin)
    await machineB.sources.runtime.mutate('mutate', { action: 'add', target: 'user', content: 'Prefers table output', importance: 'normal' }, { confirmed: true })
    const pushed = await machineB.sync.push({ message: 'Publish from B' })

    expect(pushed.merged).toMatchObject({ components: ['runtime', 'documents', 'memory-spaces', 'settings'] })
    expect(pushed.merged?.commit).toMatch(/^[0-9a-f]{40}$/u)
    // The merge lands locally first, so the machine that pushes keeps both entries too.
    expect(readFileSync(join(machineB.root, 'runtime', 'USER.md'), 'utf8')).toContain('Prefer concise answers')
    // And the published payload holds both machines' entries, not only the newest push.
    const published = await git(['show', 'mnemon-sync:mnemon/payload/runtime/USER.md'], origin)
    expect(published).toContain('Prefer concise answers')
    expect(published).toContain('Prefers table output')
  })

  it('reports the identity of this machine on every status', async () => {
    const machineA = await machine('sync-machine-identity')
    const status = await machineA.sync.status()
    const stored = JSON.parse(readFileSync(join(machineA.root, 'state', 'machine.json'), 'utf8')) as { version: number; id: string; label: string; createdAt: string }

    expect(stored.version).toBe(1)
    expect(status.machine).toEqual({ id: stored.id, label: stored.label, createdAt: stored.createdAt })
    expect(stored.id).toMatch(/^[0-9a-f-]{36}$/u)
    expect(stored.label.length).toBeGreaterThan(0)
  })

  it('drives Git with an environment that cannot relocate the repository', async () => {
    // The harness shims export GIT_DIR for their own PATH bookkeeping; Git reads
    // the same variable as the repository location, so a push launched from such
    // a shell would fail with "fatal: Invalid path" before writing anything.
    const sanitized = gitEnvironment({
      PATH: 'C:\\Windows',
      GIT_DIR: 'C:\\tools\\git\\cmd',
      git_work_tree: 'C:\\elsewhere',
      GIT_INDEX_FILE: 'C:\\tmp\\index',
      SystemRoot: 'C:\\Windows',
    })
    expect(sanitized).toEqual({ PATH: 'C:\\Windows', SystemRoot: 'C:\\Windows' })

    const origin = await repository('sync-environment-remote')
    const machineA = await machine('sync-environment', origin)
    await machineA.sources.runtime.mutate('mutate', { action: 'add', target: 'user', content: 'Survives a polluted environment', importance: 'normal' }, { confirmed: true })
    const pushed = await machineA.sync.push({ message: 'Sanitized environment' })
    expect(pushed).toMatchObject({ committed: true, pushed: true })
    expect(await git(['show', 'mnemon-sync:mnemon/payload/runtime/USER.md'], origin)).toContain('Survives a polluted environment')
  })

  it('creates the branch on the first push and honours a nested directory', async () => {
    const origin = await repository('sync-branch-remote')
    const machineA = await machine('sync-branch', origin)
    machineA.sync.configure({ branch: 'memory/user', subdir: '/nested/mnemon' })
    const pushed = await machineA.sync.push({ message: 'Nested' })
    expect(pushed).toMatchObject({ branch: 'memory/user', subdir: 'nested/mnemon/' })
    expect(await git(['show', 'memory/user:nested/mnemon/manifest.json'], origin)).toContain('"mnemonpack"')
    expect((await git(['branch', '--list'], origin)).trim()).toBe('memory/user')
  })
})

/** A branch holding a commit but no Mnemon payload. */
async function unrelatedCommit(origin: string): Promise<string> {
  const work = join(temporary('sync-unrelated'), 'work')
  await git(['clone', '--quiet', origin, work])
  writeFileSync(join(work, 'README.md'), '# Unrelated\n')
  await git(['add', 'README.md'], work)
  await git(['-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '--quiet', '-m', 'Unrelated'], work)
  await git(['push', '--quiet', 'origin', 'HEAD:refs/heads/mnemon-sync'], work)
  return work
}

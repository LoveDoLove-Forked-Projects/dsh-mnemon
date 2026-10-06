#!/usr/bin/env node
// Real end-to-end verification for the Mnemon Git sync channel.
//
// It launches two independent DSH Web instances over disposable DSH_HOME and
// storage roots, drives /dsh-mnemon-sync, /dsh-mnemon-settings, /dsh-mnemon-review
// and /dsh-mnemon-pack over real loopback HTTP with the same envelopes the browser
// sends, and publishes to a real bare repository. The only stand-in is the model
// endpoint, which never answers a memory request.
//
// Run after 'pnpm run build && pnpm --workspace-concurrency=4 -r build'.
// Set MNEMON_SYNC_E2E_KEEP=1 to keep the fixture for inspection.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dshBin = join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
const keep = process.env.MNEMON_SYNC_E2E_KEEP === '1'
const MARKER = 'Sync e2e: the maintainer keeps acceptance notes in the project wiki.'
const PROFILE = 'Sync e2e profile entry.'
const TOKEN = 'ghp_sync_e2e_placeholder_token'
const RECONCILE_MARKER = 'Sync e2e: the reviewed reconciliation kept this entry.'

const failures = []
const children = []
let fixture

function check(label, condition, detail) {
  if (condition) console.log('  ok   ' + label)
  else {
    failures.push(label)
    console.log('  FAIL ' + label + (detail === undefined ? '' : ': ' + detail))
  }
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('exit', code => resolveRun({ code, stdout, stderr }))
  })
}

/**
 * Git takes the repository location from the environment, so a launcher that
 * exports `GIT_DIR` for its own PATH bookkeeping (the harness shims do) hijacks
 * every command below. The harness runs under exactly such a shell, so its own
 * Git processes are given a copy of the environment with those variables removed.
 */
function gitEnvironment(environment = process.env) {
  const sanitized = {}
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined || name.toUpperCase().startsWith('GIT_')) continue
    sanitized[name] = value
  }
  return sanitized
}

async function git(args, cwd) {
  const result = await run('git', args, { cwd, env: gitEnvironment() })
  if (result.code !== 0) throw new Error('git ' + args.join(' ') + ' failed: ' + (result.stderr || result.stdout).trim())
  return result.stdout.trim()
}

/** One POST with the browser's envelope and cookie; no Origin, so the fence passes. */
function post(port, path, body, cookie) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8')
  return new Promise((resolvePost, reject) => {
    const headers = { 'content-type': 'application/json', 'content-length': String(payload.byteLength) }
    if (cookie !== undefined) headers.cookie = cookie
    const request = httpRequest({ host: '127.0.0.1', port, path, method: 'POST', headers }, response => {
      const chunks = []
      response.on('data', chunk => { chunks.push(chunk) })
      response.on('end', () => resolvePost({ status: response.statusCode, text: Buffer.concat(chunks).toString('utf8') }))
    })
    request.once('error', reject)
    request.end(payload)
  })
}

let sequence = 0
async function call(instance, channel, endpoint, payload) {
  const envelope = { type: 'client-request', rpcId: 'sync-e2e-' + String(++sequence), method: endpoint, payload }
  const response = await post(instance.port, channel + '/' + endpoint, envelope, instance.cookie)
  if (response.status !== 200) throw new Error(channel + '/' + endpoint + ' answered HTTP ' + String(response.status) + ': ' + response.text.trim())
  const parsed = JSON.parse(response.text)
  if (parsed.type !== 'server-response' || parsed.rpcId !== envelope.rpcId) throw new Error('unexpected envelope: ' + response.text.slice(0, 200))
  return parsed.result
}

function sync(instance, endpoint, payload = {}) {
  return call(instance, '/dsh-mnemon-sync', endpoint, payload)
}

function expectOk(result, label) {
  if (result?.ok !== true) throw new Error(label + ' failed: ' + JSON.stringify(result?.error ?? result))
  return result.value
}

function expectFailure(result, pattern, label) {
  if (result?.ok !== false) throw new Error(label + ' unexpectedly succeeded: ' + JSON.stringify(result))
  if (!pattern.test(result.error.message)) throw new Error(label + ' reported ' + JSON.stringify(result.error.message))
  return result.error.message
}

/**
 * The one stand-in. Every delegated run but reconciliation gets a plain-text
 * answer, so no memory is ever written by the model. A reconciliation is asked
 * through the completion protocol, and the Host only accepts a structured
 * result, so the stub answers that one protocol exactly as a model would: the
 * review, the decision and the applied operations below stay real.
 */
function modelStub() {
  let calls = 0
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    const wire = body === '' ? {} : JSON.parse(body)
    const system = Array.isArray(wire.system)
      ? wire.system.map(block => typeof block?.text === 'string' ? block.text : '').join('\n')
      : typeof wire.system === 'string' ? wire.system : ''
    const instructions = /Completion protocol: call `([^`]+)` exactly once with requestId `([^`]+)` and result matching this JSON schema:\n([^\n]+)/u.exec(system)
    const call = instructions === undefined ? undefined : reconcileReply(instructions)
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const event = value => response.write('event: ' + value.type + '\ndata: ' + JSON.stringify(value) + '\n\n')
    event({ type: 'message_start', message: { id: 'sync-e2e-' + String(++calls), type: 'message', role: 'assistant', model: 'stub', content: [], usage: { input_tokens: 1, output_tokens: 0 } } })
    event({ type: 'content_block_start', index: 0, content_block: call === undefined ? { type: 'text', text: '' } : { type: 'tool_use', id: 'sync-e2e-call-' + String(calls), name: call.name, input: {} } })
    event({ type: 'content_block_delta', index: 0, delta: call === undefined ? { type: 'text_delta', text: 'Sync e2e has no conversation.' } : { type: 'input_json_delta', partial_json: JSON.stringify(call.input) } })
    event({ type: 'content_block_stop', index: 0 })
    event({ type: 'message_delta', delta: { stop_reason: call === undefined ? 'end_turn' : 'tool_use' }, usage: { output_tokens: 1 } })
    event({ type: 'message_stop' })
    response.end()
  })
  return server
}

/** Answer the completion protocol only for a reconciliation schema; nothing else is scripted. */
function reconcileReply(instructions) {
  const schema = JSON.parse(instructions[3])
  const actions = schema?.properties?.action?.enum
  if (!Array.isArray(actions) || !actions.includes('planned')) return undefined
  return {
    name: instructions[1],
    input: {
      requestId: instructions[2],
      result: {
        title: 'Reconcile the memory the acceptance run wrote',
        summary: 'This installation holds one entry the acceptance run added. Keeping it beside the merged memory leaves the installation coherent.',
        action: 'planned',
        operations: [{
          kind: 'runtime-add',
          target: 'memory',
          content: RECONCILE_MARKER,
          importance: 'normal',
          reason: 'The merged memory should carry the entry the acceptance run reviewed.',
        }],
      },
    },
  }
}

async function install(home, workspace, env) {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const selfRegistering = new Set(['dsh-mnemon-strategy-scoped', 'dsh-mnemon-strategy-light-context', 'dsh-mnemon-strategy-auto-capture', 'dsh-mnemon-strategy-general'])
  const plugins = Object.keys(manifest.dependencies).filter(name => name.startsWith('dsh-mnemon-') && !selfRegistering.has(name))
  const result = await run(process.execPath, [dshBin, 'plugin', '--profile', 'web', 'add',
    'link:' + root, ...plugins.map(name => 'link:' + join(root, 'plugins', name)),
  ], { cwd: workspace, env })
  if (result.code !== 0) throw new Error('DSH installation failed (' + String(result.code) + '): ' + (result.stderr || result.stdout).slice(-2000))
}

/** Launch one real Web instance and exchange the launch token for a cookie. */
async function launch(label, home, dataDir, workspace, env) {
  const child = spawn(process.execPath, [dshBin, 'web', '--no-open', '--host', '127.0.0.1', '--port', '0'], {
    cwd: workspace, env: { ...env, DSH_HOME: home, MNEMON_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const url = await new Promise((resolveUrl, reject) => {
    const deadline = setTimeout(() => reject(new Error(label + ' did not print a URL in 120s. stdout: ' + stdout.slice(-2000) + ' stderr: ' + stderr.slice(-2000))), 120_000)
    const inspect = () => {
      const match = /dsh web: (http:\/\/\S+)/u.exec(stdout)
      if (match === undefined) return
      clearTimeout(deadline)
      resolveUrl(match[1])
    }
    child.stdout.on('data', inspect)
    child.once('exit', code => { clearTimeout(deadline); reject(new Error(label + ' exited with ' + String(code) + ': ' + stderr.slice(-2000))) })
  })
  const token = new URL(url).searchParams.get('token')
  const exchange = await fetch(url, { redirect: 'manual' })
  const setCookie = exchange.headers.getSetCookie()[0]
  if (exchange.status !== 303 || setCookie === undefined) throw new Error(label + ' token exchange answered ' + String(exchange.status))
  const cookie = setCookie.split(';')[0]
  console.log(label + ' ready at ' + new URL(url).origin + ' (cookie ' + cookie.split('=')[0] + ')')
  return { label, child, port: Number(new URL(url).port), cookie, home, dataDir, stdout: () => stdout, stderr: () => stderr }
}

/** Ask one instance to stop and remember whether it needed the hard kill. */
async function stop(instance) {
  if (instance === undefined || instance.stopped !== undefined) return
  const exited = new Promise(resolveExit => instance.child.once('exit', resolveExit))
  instance.child.kill('SIGTERM')
  const settled = await Promise.race([exited.then(() => true), new Promise(resolveWait => setTimeout(() => resolveWait(false), 15_000))])
  if (!settled) instance.child.kill('SIGKILL')
  instance.stopped = settled ? 'SIGTERM' : 'SIGKILL'
}

const { request: httpRequest } = await import('node:http')

let a
let b
let model

try {
  fixture = await mkdtemp(join(tmpdir(), 'mnemon-sync-e2e-'))
  const homes = { a: join(fixture, 'home-a'), b: join(fixture, 'home-b') }
  const data = { a: join(fixture, 'data-a'), b: join(fixture, 'data-b') }
  const workspaces = { a: join(fixture, 'workspace-a'), b: join(fixture, 'workspace-b') }
  const origin = join(fixture, 'origin.git')
  const clone = join(fixture, 'tamper')
  await Promise.all([...Object.values(homes), ...Object.values(data), ...Object.values(workspaces)].map(path => mkdir(path)))
  await git(['init', '--bare', '--quiet', '--initial-branch=mnemon-sync', origin])
  console.log('Fixture: ' + fixture)
  console.log('Origin:  ' + origin)

  model = modelStub()
  await new Promise((resolveListen, reject) => { model.once('error', reject); model.listen(0, '127.0.0.1', resolveListen) })
  const env = {
    ...process.env,
    DSH_TELEMETRY_DISABLED: '1',
    DEEPSEEK_API_KEY: 'sync-e2e-stub-key',
    DEEPSEEK_BASE_URL: 'http://127.0.0.1:' + String(model.address().port),
  }
  await install(homes.a, workspaces.a, { ...env, DSH_HOME: homes.a })
  await install(homes.b, workspaces.b, { ...env, DSH_HOME: homes.b })

  // A blank author falls back to the identity Git already has. These variables
  // stand in for the machine's own user.name/user.email, so the run can assert
  // the fallback without reading or writing the runner's Git configuration.
  const localIdentity = {
    GIT_AUTHOR_NAME: 'Mnemon Local', GIT_AUTHOR_EMAIL: 'local@localhost',
    GIT_COMMITTER_NAME: 'Mnemon Local', GIT_COMMITTER_EMAIL: 'local@localhost',
  }

  console.log('\n1. One instance publishes the whole pack to a real repository')
  a = await launch('instance A', homes.a, data.a, workspaces.a, { ...env, ...localIdentity })
  const fresh = expectOk(await sync(a, 'status'), 'status')
  check('a fresh storage root reports Git and an unconfigured remote',
    fresh.configured === false && fresh.git.available === true && fresh.git.required === '2.20'
    && fresh.remote.reachable === false && fresh.remote.branchExists === false, JSON.stringify(fresh))
  check('the configuration path lives inside the storage root', fresh.configPath === join(data.a, 'state', 'sync-git.json'), fresh.configPath)
  const defaults = expectOk(await sync(a, 'configure', { repoUrl: origin }), 'configure')
  check('a repository alone is enough: branch, directory and author keep their defaults',
    defaults.repoUrl === origin && defaults.branch === 'mnemon-sync' && defaults.subdir === 'mnemon/'
    && defaults.authorName === 'dsh-mnemon sync' && defaults.authorEmail === 'mnemon@localhost'
    && defaults.hasToken === false && defaults.credentialSource === 'none', JSON.stringify(defaults))
  const configured = expectOk(await sync(a, 'configure', { authorName: '', authorEmail: '' }), 'configure')
  check('an empty author clears the identity so Git uses the one on this machine',
    configured.authorName === '' && configured.authorEmail === '' && configured.repoUrl === origin
    && configured.branch === 'mnemon-sync' && configured.subdir === 'mnemon/', JSON.stringify(configured))
  const reset = expectOk(await sync(a, 'configure', { branch: '', subdir: '' }), 'configure')
  check('an empty branch and directory fall back to the defaults',
    reset.branch === 'mnemon-sync' && reset.subdir === 'mnemon/', JSON.stringify(reset))
  const added = expectOk(await call(a, '/dsh-mnemon-write', 'runtime-memory', { action: 'add', target: 'memory', content: MARKER }), 'runtime-memory')
  check('the working memory accepted one entry through the write channel', added.success === true && added.entryCount === 1, JSON.stringify(added))
  expectOk(await call(a, '/dsh-mnemon-write', 'runtime-memory', { action: 'add', target: 'user', content: PROFILE }), 'runtime-memory user')
  const beforePush = expectOk(await sync(a, 'status'), 'status')
  check('the configured remote is reachable and still has no branch',
    beforePush.configured === true && beforePush.remote.reachable === true && beforePush.remote.branchExists === false, JSON.stringify(beforePush.remote))

  const unconfirmedPush = await sync(a, 'push', { message: 'Sync from the acceptance run' })
  expectFailure(unconfirmedPush, /requires confirmation/u, 'an unconfirmed push')
  check('an unconfirmed push is refused', unconfirmedPush.ok === false)

  const pushed = expectOk(await sync(a, 'push', { message: 'Sync from the acceptance run', confirmed: true }), 'push')
  check('push committed and published one pack', pushed.committed === true && pushed.pushed === true
    && /^[0-9a-f]{40}$/u.test(pushed.commit) && pushed.branch === 'mnemon-sync' && pushed.subdir === 'mnemon/', JSON.stringify(pushed))
  check('the pack holds every component, settings included',
    JSON.stringify(pushed.summary.map(entry => entry.component)) === '["runtime","documents","memory-spaces","settings"]', JSON.stringify(pushed.summary))
  const authored = await git(['log', '-1', '--format=%an <%ae>|%cn <%ce>', 'mnemon-sync'], origin)
  check('the commit carries the identity Git was left with',
    authored === 'Mnemon Local <local@localhost>|Mnemon Local <local@localhost>', authored)
  const tree = await git(['ls-tree', '-r', '--name-only', 'mnemon-sync'], origin)
  check('the branch holds the manifest, the checksums and the payload',
    tree.includes('mnemon/manifest.json') && tree.includes('mnemon/checksums.json')
    && tree.includes('mnemon/payload/runtime/memories.json') && tree.includes('mnemon/payload/runtime/USER.md')
    && tree.includes('mnemon/payload/runtime/MEMORY.md')
    && tree.includes('mnemon/payload/settings/mnemon.json'), tree.split('\n').slice(0, 10).join(', '))
  const settingsEntry = pushed.summary.find(entry => entry.component === 'settings')
  check('the settings component carries its own payload file',
    settingsEntry !== undefined && settingsEntry.files >= 1 && settingsEntry.bytes > 0, JSON.stringify(settingsEntry))
  const publishedSettings = JSON.parse(await git(['show', 'mnemon-sync:mnemon/payload/settings/mnemon.json'], origin))
  check('the published settings payload is a readable namespace snapshot',
    publishedSettings.version === 1 && typeof publishedSettings.exportedAt === 'string'
    && Array.isArray(publishedSettings.namespaces), JSON.stringify(publishedSettings))
  const publishedMemory = await git(['show', 'mnemon-sync:mnemon/payload/runtime/MEMORY.md'], origin)
  check('the published working memory carries the entry', publishedMemory.includes(MARKER))
  const manifest = JSON.parse(await git(['show', 'mnemon-sync:mnemon/manifest.json'], origin))
  check('the manifest declares the pack and its channel',
    manifest.format === 'mnemonpack' && manifest.version === 1 && manifest.scope === 'full'
    && manifest.sync.channel === 'git' && manifest.sync.branch === 'mnemon-sync' && manifest.sync.subdir === 'mnemon/'
    && manifest.sync.pushedAt === manifest.exportedAt, JSON.stringify(manifest.sync))
  check('the mirror lives under the storage root and not at its top level',
    existsSync(join(data.a, 'state', 'sync', 'git', '.git')) === true && existsSync(join(data.a, '.git')) === false)
  const repeat = expectOk(await sync(a, 'push', { message: 'Sync from the acceptance run', confirmed: true }), 'push')
  check('a repeated push publishes nothing new',
    repeat.committed === false && repeat.pushed === false && repeat.commit === pushed.commit
    && repeat.reason === 'the branch already holds this payload', JSON.stringify(repeat))
  check('the branch holds exactly one commit', (await git(['rev-list', '--count', 'mnemon-sync'], origin)) === '1')

  console.log('\n2. A second instance previews and imports the same branch')
  b = await launch('instance B', homes.b, data.b, workspaces.b, env)
  const defaultsB = expectOk(await sync(b, 'configure', { repoUrl: origin }), 'configure')
  check('the second instance reaches the same defaults from a repository alone',
    defaultsB.branch === 'mnemon-sync' && defaultsB.subdir === 'mnemon/', JSON.stringify(defaultsB))
  const preview = expectOk(await sync(b, 'preview'), 'preview')
  check('preview reports the published commit and its manifest',
    preview.commit === pushed.commit && preview.branch === 'mnemon-sync' && preview.subdir === 'mnemon/'
    && preview.manifest.scope === 'full' && preview.pushedAt === manifest.sync.pushedAt, JSON.stringify({ commit: preview.commit, pushedAt: preview.pushedAt }))
  // An empty root still has byte-identical empty documents and body indexes, so
  // only the component that really carries the entry has to report a change.
  const runtimeDelta = preview.components.find(entry => entry.component === 'runtime')
  check('preview reports the working memory as changed against an empty root',
    preview.components.length === 4 && runtimeDelta?.changed === true
    && preview.files.changed > 0 && preview.expandedBytes > 0, JSON.stringify(preview.components))
  const unconfirmedPull = await sync(b, 'pull', {})
  expectFailure(unconfirmedPull, /requires confirmation/u, 'an unconfirmed pull')
  const untouchedMemory = join(data.b, 'runtime', 'MEMORY.md')
  check('preview imported nothing',
    (existsSync(untouchedMemory) ? await readFile(untouchedMemory, 'utf8') : '').includes(MARKER) === false)
  const pulled = expectOk(await sync(b, 'pull', { confirmed: true }), 'pull')
  check('pull imported the published commit through the pack importer',
    pulled.imported === true && pulled.mode === 'merge' && pulled.commit === pushed.commit
    && JSON.stringify(pulled.components) === '["runtime","documents","memory-spaces","settings"]', JSON.stringify({ mode: pulled.mode, components: pulled.components }))
  const secondMemory = await readFile(join(data.b, 'runtime', 'MEMORY.md'), 'utf8')
  const secondProfile = await readFile(join(data.b, 'runtime', 'USER.md'), 'utf8')
  check('the second machine now holds the working memory and the profile',
    secondMemory.includes(MARKER) && secondProfile.includes(PROFILE))

  console.log('\n3. Settings travel in the pack without the keys that belong to one machine')
  const settingsA = expectOk(await call(a, '/dsh-mnemon-settings', 'get', {}), 'settings get')
  check('the settings channel reports the profile value, revision and writer',
    settingsA.mode === 'host' && settingsA.writable === true && typeof settingsA.revision === 'number'
    && settingsA.value.defaultRecallLimit === 10, JSON.stringify({ revision: settingsA.revision, limit: settingsA.value.defaultRecallLimit }))
  const refusedField = await call(a, '/dsh-mnemon-settings', 'mutate', { ops: [{ op: 'set', path: ['remoteAccess'], value: 'trusted-host' }] })
  expectFailure(refusedField, /unsupported mnemon settings field: remoteAccess/u, 'an unsupported settings field')
  check('a refused settings edit reports its own error code', refusedField.error.code === 'settings-rejected', JSON.stringify(refusedField.error))
  const edited = expectOk(await call(a, '/dsh-mnemon-settings', 'mutate', { ops: [
    { op: 'set', path: ['defaultRecallLimit'], value: 7 },
    { op: 'set', path: ['cliPath'], value: join(data.a, 'bin', 'mnemon') },
  ] }), 'settings mutate')
  check('the edit is committed and answered from the committed profile',
    edited.value.defaultRecallLimit === 7 && edited.value.cliPath === join(data.a, 'bin', 'mnemon')
    && edited.revision > settingsA.revision, JSON.stringify({ revision: edited.revision, limit: edited.value.defaultRecallLimit }))
  const settingsPush = expectOk(await sync(a, 'push', { message: 'Carry the settings edit', confirmed: true }), 'push')
  check('the settings edit publishes a second commit',
    settingsPush.committed === true && settingsPush.pushed === true && settingsPush.commit !== pushed.commit, JSON.stringify(settingsPush.commit))
  const carriedSettings = JSON.parse(await git(['show', 'mnemon-sync:mnemon/payload/settings/mnemon.json'], origin))
  const carriedMnemon = carriedSettings.namespaces.find(snapshot => snapshot.ns === 'mnemon')
  check('the payload carries the edited namespace and drops the machine-local key',
    carriedMnemon !== undefined && carriedMnemon.user.defaultRecallLimit === 7
    && JSON.stringify(carriedSettings).includes('cliPath') === false, JSON.stringify(carriedSettings))
  const settingsPull = expectOk(await sync(b, 'pull', { confirmed: true }), 'pull')
  check('the second machine imports the settings commit',
    settingsPull.imported === true && settingsPull.commit === settingsPush.commit, JSON.stringify(settingsPull.commit))
  const settingsB = expectOk(await call(b, '/dsh-mnemon-settings', 'get', {}), 'settings get')
  check('the second machine applies the imported settings to its own profile',
    settingsB.value.defaultRecallLimit === 7, JSON.stringify(settingsB.value.defaultRecallLimit))
  check('the key that only describes machine A never crossed to machine B',
    settingsB.value.cliPath !== join(data.a, 'bin', 'mnemon'), JSON.stringify(settingsB.value.cliPath))

  console.log('\n4. A tampered payload fails hard and imports nothing')
  await git(['-c', 'core.autocrlf=false', 'clone', '--quiet', '--branch', 'mnemon-sync', origin, clone])
  await writeFile(join(clone, 'mnemon', 'payload', 'runtime', 'MEMORY.md'), publishedMemory + '\ntampered\n')
  await git(['add', '--all'], clone)
  await git(['-c', 'user.name=Tamper', '-c', 'user.email=tamper@localhost', 'commit', '--quiet', '-m', 'Tamper with the payload'], clone)
  await git(['push', '--quiet', 'origin', 'HEAD:refs/heads/mnemon-sync'], clone)
  const tamperedPreview = await sync(b, 'preview')
  expectFailure(tamperedPreview, /failed its checksum: payload\/runtime\/MEMORY\.md/u, 'preview of a tampered payload')
  check('the checksum failure names the changed file', /failed its checksum: payload\/runtime\/MEMORY\.md/u.test(tamperedPreview.error.message))
  const tamperedPull = await sync(b, 'pull', { confirmed: true })
  expectFailure(tamperedPull, /failed its checksum/u, 'pull of a tampered payload')
  check('the tampered payload was not imported', (await readFile(join(data.b, 'runtime', 'MEMORY.md'), 'utf8')) === secondMemory)

  console.log('\n5. A token never reaches a response, a file, or the mirror')
  const withToken = expectOk(await sync(a, 'configure', { token: TOKEN }), 'configure')
  check('configure names the credential without carrying it',
    withToken.hasToken === true && withToken.credentialSource === 'token'
    && JSON.stringify(withToken).includes(TOKEN) === false, JSON.stringify(withToken))
  const tokenStatus = expectOk(await sync(a, 'status'), 'status')
  check('status names the credential without carrying it',
    tokenStatus.config.hasToken === true && tokenStatus.config.credentialSource === 'token'
    && JSON.stringify(tokenStatus).includes(TOKEN) === false)
  const stateFile = await readFile(join(data.a, 'state', 'sync-git.json'), 'utf8')
  check('the token is stored in the 0600 state file', stateFile.includes(TOKEN))
  const masked = await sync(a, 'configure', { repoUrl: 'https://127.0.0.1:1/owner/repo.git' })
  expectOk(masked, 'configure')
  const unreachable = expectOk(await sync(a, 'status'), 'status')
  check('an unreachable remote is reported without leaking the token',
    unreachable.remote.reachable === false && typeof unreachable.remote.error === 'string'
    && unreachable.remote.error.includes(TOKEN) === false, unreachable.remote.error)
  const failedPush = await sync(a, 'push', { confirmed: true })
  expectFailure(failedPush, /./u, 'push to an unreachable remote')
  check('a failed push never echoes the token', failedPush.error.message.includes(TOKEN) === false, failedPush.error.message)
  check('the token never reaches the mirror',
    (await readFile(join(data.a, 'state', 'sync', 'git', '.git', 'config'), 'utf8')).includes(TOKEN) === false)

  console.log('\n6. Moving the data directory is planned, confirmed and completed')
  const moveTarget = join(fixture, 'data-a-moved')
  const emptyPlan = await call(a, '/dsh-mnemon-pack', 'storage-plan', { dataDir: '' })
  expectFailure(emptyPlan, /dataDir must be a non-empty directory/u, 'a plan without a directory')
  const samePlan = expectOk(await call(a, '/dsh-mnemon-pack', 'storage-plan', { dataDir: data.a }), 'storage-plan')
  check('planning a move onto the current directory is refused by name',
    samePlan.from === data.a && samePlan.to === data.a
    && samePlan.blocked === 'the data directory is already this directory', JSON.stringify(samePlan.blocked))
  const nestedPlan = expectOk(await call(a, '/dsh-mnemon-pack', 'storage-plan', { dataDir: join(data.a, 'nested') }), 'storage-plan')
  check('planning a move into the data directory is refused as nested',
    nestedPlan.blocked === 'one directory is inside the other', JSON.stringify(nestedPlan.blocked))
  // A genuinely separate, already occupied directory is the one case the plan
  // refuses before touching anything: the current directory cannot be used for
  // this, because after a completed move the Host itself follows the new root.
  const occupiedTarget = join(fixture, 'data-a-occupied')
  await mkdir(occupiedTarget)
  await writeFile(join(occupiedTarget, 'keep.txt'), 'not a Mnemon root\n')
  const occupiedPlan = expectOk(await call(a, '/dsh-mnemon-pack', 'storage-plan', { dataDir: occupiedTarget }), 'storage-plan')
  check('a directory that already holds data is refused as a target',
    occupiedPlan.targetOccupied === true && occupiedPlan.blocked === 'the target directory already holds data', JSON.stringify(occupiedPlan.blocked))
  const occupiedMove = await call(a, '/dsh-mnemon-pack', 'storage-migrate', { dataDir: occupiedTarget, confirmed: true })
  expectFailure(occupiedMove, /cannot move the Mnemon data directory: the target directory already holds data/u, 'a move onto occupied data')
  const movePlan = expectOk(await call(a, '/dsh-mnemon-pack', 'storage-plan', { dataDir: moveTarget }), 'storage-plan')
  check('a usable target is planned with its size and no blocker',
    movePlan.from === data.a && movePlan.to === moveTarget && movePlan.blocked === undefined
    && movePlan.targetOccupied === false && movePlan.sameDevice === true
    && movePlan.source.files > 0 && movePlan.source.bytes > 0, JSON.stringify(movePlan))
  const unconfirmedMove = await call(a, '/dsh-mnemon-pack', 'storage-migrate', { dataDir: moveTarget })
  expectFailure(unconfirmedMove, /Moving the Mnemon data directory requires confirmation/u, 'an unconfirmed move')
  check('an unconfirmed move leaves the data directory in place',
    existsSync(join(data.a, 'runtime', 'MEMORY.md')) === true && existsSync(moveTarget) === false)
  const migrated = expectOk(await call(a, '/dsh-mnemon-pack', 'storage-migrate', { dataDir: moveTarget, confirmed: true }), 'storage-migrate')
  check('the move reports what it carried and that it removed the old root',
    migrated.from === data.a && migrated.to === moveTarget && migrated.files >= movePlan.source.files
    && migrated.bytes > 0 && migrated.removed === true, JSON.stringify(migrated))
  check('the memory and the sync state arrived at the new directory',
    existsSync(join(moveTarget, 'runtime', 'MEMORY.md')) === true && existsSync(join(moveTarget, 'state', 'sync-git.json')) === true)
  // The Host records the new location itself, so the profile already follows
  // the move; planning the move again must report the directory it now uses.
  const followedPlan = expectOk(await call(a, '/dsh-mnemon-pack', 'storage-plan', { dataDir: moveTarget }), 'storage-plan')
  check('the moved directory is now the current one, so it is refused by name',
    followedPlan.from === moveTarget && followedPlan.to === moveTarget && followedPlan.targetOccupied === false
    && followedPlan.blocked === 'the data directory is already this directory', JSON.stringify(followedPlan.blocked))
  const repointed = expectOk(await call(a, '/dsh-mnemon-settings', 'get', {}), 'settings get')
  check('the profile now points at the directory the data moved to',
    repointed.value.storageScope === 'custom' && repointed.value.dataDir === moveTarget, JSON.stringify(repointed.value.dataDir))
  const movedTarget = expectOk(await call(a, '/dsh-mnemon-pack', 'target', {}), 'pack target')
  check('the running Host reads and writes the moved directory',
    movedTarget.root === moveTarget && movedTarget.scope === 'custom', JSON.stringify(movedTarget))
  check('the memory survived the move and the recorded location',
    (await readFile(join(moveTarget, 'runtime', 'MEMORY.md'), 'utf8')).includes(MARKER))

  console.log('\n7. A reconciliation is proposed, reviewed with opinions, and only then applied')
  const idleReview = expectOk(await call(a, '/dsh-mnemon-review', 'view', {}), 'review view')
  check('an installation that never reconciled has an empty ledger',
    idleReview.pending === 0 && idleReview.entries.length === 0
    && idleReview.path === join(moveTarget, 'state', 'review-ledger.json'), JSON.stringify(idleReview.path))
  const emptyOpinion = await call(a, '/dsh-mnemon-review', 'opinion', { id: 'missing-entry', text: '   ' })
  expectFailure(emptyOpinion, /a review opinion must not be empty/u, 'an empty opinion')
  const unknownReview = await call(a, '/dsh-mnemon-review', 'nope', {})
  expectFailure(unknownReview, /unknown review endpoint: nope/u, 'an unknown review endpoint')
  check('an unknown review endpoint is a bad request', unknownReview.error.code === 'bad-request', JSON.stringify(unknownReview.error))
  const phantomApply = await call(a, '/dsh-mnemon-review', 'apply', { id: 'missing-entry' })
  expectFailure(phantomApply, /unknown review entry: missing-entry/u, 'applying an entry that does not exist')
  // No workspace is named: the review channel must run on its own, the way the
  // settings page does when a session has no workbench directory yet.
  const reconciled = expectOk(await call(a, '/dsh-mnemon-review', 'reconcile', {}), 'review reconcile')
  check('a reconciliation stages one pending review and writes nothing',
    reconciled.action === 'planned' && reconciled.operations === 1
    && reconciled.entry?.status === 'pending' && reconciled.entry?.opinions.length === 0, JSON.stringify(reconciled))
  const staged = expectOk(await call(a, '/dsh-mnemon-review', 'view', {}), 'review view')
  check('the staged review waits in the ledger with its proposal',
    staged.pending === 1 && staged.entries.length === 1 && staged.entries[0]?.id === reconciled.entry.id
    && staged.entries[0]?.operations.length === 1, JSON.stringify({ pending: staged.pending, entries: staged.entries.length }))
  const untouched = await readFile(join(moveTarget, 'runtime', 'MEMORY.md'), 'utf8')
  check('a pending review changes no memory', untouched.includes(RECONCILE_MARKER) === false)
  const opinion = expectOk(await call(a, '/dsh-mnemon-review', 'opinion', { id: reconciled.entry.id, text: 'Keep it, the entry is still useful.' }), 'review opinion')
  check('an opinion is recorded against the review',
    opinion.status === 'pending' && opinion.opinions.length === 1 && opinion.opinions[0]?.author === 'user'
    && opinion.opinions[0]?.text === 'Keep it, the entry is still useful.', JSON.stringify(opinion.opinions))
  const refusedApply = await call(a, '/dsh-mnemon-review', 'apply', { id: reconciled.entry.id })
  expectFailure(refusedApply, /accept the review before applying it/u, 'applying a review that is still pending')
  const decided = expectOk(await call(a, '/dsh-mnemon-review', 'decide', { id: reconciled.entry.id, status: 'accepted' }), 'review decide')
  check('accepting the review leaves its opinions in place',
    decided.status === 'accepted' && decided.opinions.length === 1 && typeof decided.decidedAt === 'string', JSON.stringify({ status: decided.status, decidedAt: decided.decidedAt }))
  const applied = expectOk(await call(a, '/dsh-mnemon-review', 'apply', { id: reconciled.entry.id }), 'review apply')
  check('the accepted review applied every operation',
    applied.applied === 1 && applied.failures.length === 0 && applied.entry.status === 'accepted'
    && typeof applied.entry.appliedAt === 'string', JSON.stringify({ applied: applied.applied, failures: applied.failures }))
  const written = await readFile(join(moveTarget, 'runtime', 'MEMORY.md'), 'utf8')
  check('the applied operation reached the working memory', written.includes(RECONCILE_MARKER))
  const reopened = expectOk(await call(a, '/dsh-mnemon-review', 'reopen', { id: reconciled.entry.id }), 'review reopen')
  check('reopening clears the decision and the application',
    reopened.status === 'pending' && reopened.decidedAt === undefined && reopened.appliedAt === undefined, JSON.stringify({ status: reopened.status }))

  console.log('\n8. GitHub sign-in answers over the channel without a browser')
  const signIn = expectOk(await sync(a, 'github-status'), 'github-status')
  check('the sign-in surface reports what this Host can do',
    typeof signIn.available === 'boolean' && typeof signIn.signedIn === 'boolean' && typeof signIn.writable === 'boolean'
    && signIn.flow === undefined, JSON.stringify(signIn))
  if (signIn.available === true) {
    // No browser step runs here, so the account stays signed out; the picker
    // must refuse by name instead of reaching GitHub with no token.
    check('the store is mounted and the account is still signed out', signIn.signedIn === false, JSON.stringify(signIn))
    const anonymous = await sync(a, 'github-repositories')
    expectFailure(anonymous, /sign in to GitHub before choosing a repository/u, 'listing repositories while signed out')
    const cancelled = expectOk(await sync(a, 'github-cancel'), 'github-cancel')
    check('cancelling a flow that never started leaves the account signed out',
      cancelled.available === true && cancelled.signedIn === false && cancelled.flow === undefined, JSON.stringify(cancelled))
  } else {
    check('a Host without the store reports the login as unavailable', signIn.writable === false, JSON.stringify(signIn))
    const refused = await sync(a, 'github-start')
    expectFailure(refused, /no credentials store/u, 'starting a sign-in without a store')
  }
  const unknownGitHub = await sync(a, 'github-nope')
  expectFailure(unknownGitHub, /unknown sync endpoint: github-nope/u, 'an unknown GitHub endpoint')

  await stop(a)
  await stop(b)
  check('both instances shut down on the polite signal',
    a.stopped === 'SIGTERM' && b.stopped === 'SIGTERM', JSON.stringify({ a: a.stopped, b: b.stopped }))
} catch (error) {
  failures.push('harness')
  console.error(error)
} finally {
  // Stop the instances before the fixture goes away, even after a failure, so
  // nothing holds a lock on a directory that is about to be removed.
  for (const instance of [a, b]) {
    if (instance !== undefined) await stop(instance).catch(() => undefined)
  }
  // The model stand-in is the only handle this process still owns; without
  // closing it the loop would stay alive after the report is printed.
  if (model !== undefined) {
    model.closeAllConnections()
    await new Promise(resolveClose => model.close(resolveClose))
  }
  if (fixture !== undefined) {
    if (keep) console.log('Kept fixture: ' + fixture)
    else await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

if (failures.length > 0) {
  console.error('\nFAILED (' + String(failures.length) + '): ' + failures.join('; '))
  process.exitCode = 1
} else {
  console.log('\nGit sync end-to-end verification passed.')
}

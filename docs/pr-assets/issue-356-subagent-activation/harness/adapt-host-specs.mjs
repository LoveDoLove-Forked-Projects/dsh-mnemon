// Issue #356: copy the repository's real-DSH host specs into a directory outside the repository,
// rewritten to run against an installed DSH instead of the pinned development baseline. Run the
// copies with installed-dsh.vitest.config.mjs, as the record's README describes.
//   node adapt-host-specs.mjs <output directory>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

if (process.argv[2] === undefined) throw new Error('usage: node adapt-host-specs.mjs <output directory>')
const root = resolve(import.meta.dirname, '../../../..')
const out = resolve(process.argv[2])
mkdirSync(out, { recursive: true })
const specs = ['runtime-compaction-host', 'review-user-turn-host', 'review-evidence-host', 'agent-team-review-host', 'async-subagent-host', 'subagent-token-usage-host']

function replace(source, from, to, spec) {
  if (!source.includes(from)) throw new Error(`${spec}: expected text not found: ${from.slice(0, 80)}`)
  return source.replace(from, to)
}

// 1. DSH 0.2.1-alpha.2's subagent runtime injects workingDirectory, which needs fs. A DSH profile
//    loads both; these hand-wired compositions load them before the subagent runtime.
const workingDirectory = `await (async (ctx: { get(name: string): unknown; plugin(plugin: unknown, config?: unknown): Promise<unknown> }) => {
  const { createRequire } = await import('node:module')
  const { tmpdir } = await import('node:os')
  const requireHost = createRequire(process.env.DSH_HOST_ROOT + '/package.json')
  let workingDirectory: { default: unknown }
  try { workingDirectory = await import(requireHost.resolve('@deepseek-ai/dsh-working-directory')) } catch { return }
  if (ctx.get('fs') === undefined) await ctx.plugin((await import(requireHost.resolve('@deepseek-ai/dsh-fs-local'))).default, { cwd: tmpdir() })
  await ctx.plugin(workingDirectory.default)
})(ctx as never)`

// 4. The tests' own calls to the removed APIs: review-evidence-host wraps the start call to hold the
//    child back until its first tool attempt, and async-subagent-host starts a continuable child.
const evidenceService = `    const service = {
      list: () => host.subagents.list(), getProvider: (name: string) => host.subagents.getProvider(name),
      // A fast child can call tools before the caller receives its run handle.
      ...(typeof host.subagents.start === 'function' ? { async start(...args: Parameters<NonNullable<typeof host.subagents.start>>) {
        const run = await host.subagents.start!(...args)
        try {
          await Promise.race([attempted.promise, run.result.then(() => { throw new Error('child completed before its foreign tool attempt') })])
        } catch (error) {
          await run.dispose()
          throw error
        }
        providerReturned = true
        return run
      } } : {}),
      ...(typeof host.subagents.startActivation === 'function' ? { async startActivation(spec: Parameters<NonNullable<typeof host.subagents.startActivation>>[0]) {
        const activation = await host.subagents.startActivation!(spec)
        try {
          await Promise.race([attempted.promise, activation.result.then(() => { throw new Error('child completed before its foreign tool attempt') })])
        } catch (error) {
          await activation.dispose()
          throw error
        }
        providerReturned = true
        return activation
      } } : {}),
    }
`
const continuableStart = `      const subagents = ctx.subagents as unknown as { startContinuable?: (spec: unknown) => Promise<unknown>; startActivation?: (spec: unknown) => Promise<{ childId: string; messageId?: string }> }
      const spec = { provider: 'spawn', label: 'Recall task', request: { parent: execution.agent, prompt: [{ type: 'text', text: 'Recall release history.' }] }, signal: execution.signal }
      if (typeof subagents.startContinuable === 'function') return subagents.startContinuable(spec)
      const activation = await subagents.startActivation!({ ...spec, delivery: 'parent' })
      return { childId: activation.childId, messageId: activation.messageId }`
const alpha = "String(process.env.DSH_VERSION).startsWith('0.2.1')"

for (const spec of specs) {
  let s = readFileSync(join(root, 'tests', `${spec}.spec.ts`), 'utf8')
  // The copies live outside the repository, so repository imports become absolute paths.
  s = s.replaceAll("from '../src/", `from '${root}/src/`).replaceAll('from "../src/', `from "${root}/src/`)
  s = s.replaceAll("from './fixtures/", `from '${root}/tests/fixtures/`).replaceAll("from './helpers/", `from '${root}/tests/helpers/`)
  s = s.replaceAll("new URL('../node_modules/@deepseek-ai/dsh/package.json', import.meta.url)", "(process.env.DSH_HOST_ROOT + '/package.json')")
  s = s.replaceAll("new URL('../package.json', import.meta.url)", `'${root}/package.json'`)
  for (const anchor of ['await ctx.plugin(SubagentRuntime)', 'await ctx.plugin(subagent.default)']) {
    const at = s.indexOf(anchor)
    if (at < 0) continue
    const indent = s.slice(s.lastIndexOf('\n', at) + 1, at)
    s = s.slice(0, at) + workingDirectory.split('\n').join('\n' + indent) + '\n' + indent + s.slice(at)
  }
  // 2. Tools mode `both` is gone in DSH 0.2.1-alpha.2: the root stays native, and the Code Mode
  //    cases still present each child as Code Mode.
  s = s.replaceAll("{ mode: mode === 'ptc' ? 'both' : 'native' }", `{ mode: mode === 'ptc' && !${alpha} ? 'both' : 'native' }`)
  if (spec === 'agent-team-review-host') {
    s = replace(s, 'expect(version).toBe(pinned)', 'expect(version).toBe(process.env.DSH_VERSION)', spec)
    // 3. In Code Mode DSH 0.2.1-alpha.2 refuses a filtered tool inside run_code before dispatch, so
    //    the failed attempt is the run_code call; the Team tool still never runs.
    s = replace(s, "          if (teams === 'tools') expect(receipts).toContainEqual({ name: 'spawn_teammate', isError: true })",
      `          if (teams === 'tools') expect(receipts).toContainEqual(mode === 'ptc' && ${alpha} ? { name: 'run_code', isError: true } : { name: 'spawn_teammate', isError: true })`, spec)
  }
  if (spec === 'review-evidence-host') {
    const from = s.indexOf('    const service = {')
    const to = s.indexOf('    const coordinator = new MnemonSubagentCoordinator(service')
    if (from < 0 || to < from) throw new Error(`${spec}: service block not found`)
    s = s.slice(0, from) + evidenceService + s.slice(to)
  }
  if (spec === 'async-subagent-host') {
    s = replace(s, `      return ctx.subagents.startContinuable({
        provider: 'spawn', label: 'Recall task',
        request: { parent: execution.agent, prompt: [{ type: 'text', text: 'Recall release history.' }] },
        signal: execution.signal,
      })`, continuableStart, spec)
  }
  if (/from ['"]\.\.?\//u.test(s)) throw new Error(`${spec}: a relative import is left`)
  writeFileSync(join(out, `${spec}.spec.ts`), s)
}
console.log(`Wrote ${specs.length} specs to ${out}`)

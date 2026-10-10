// Run with installed-dsh-all.vitest.config.mjs, DSH_HOST_ROOT, DSH_VERSION and MNEMON_TEST_DIR=docs/pr-assets/dsh-021-alpha2/harness:
// a background task Agent for a workspace whose folder is gone, against an installed DSH.
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { expect, it, vi } from 'vitest'
import type { HostContextShape } from '../../../../src/host/dsh.ts'
import { MnemonLifecycle } from '../../../../src/host/lifecycle.ts'
import { MnemonSubagentCoordinator } from '../../../../src/host/subagent.ts'
import { registerTools } from '../../../../src/host/tools.ts'
import { compositionFixture } from '../../../../tests/fixtures/composition.ts'
import { startSubagent } from '../../../../src/host/subagent-start.ts'

const requireDsh = createRequire(realpathSync((process.env.DSH_HOST_ROOT + '/package.json')))
const spawn = await import(requireDsh.resolve('@deepseek-ai/dsh-subagent-spawn-in-process'))

type Reply = string | { name: string; args: Record<string, unknown> }

/** Only the model is scripted: the subagent runtime, tools and storage are real. */
class ScriptedAdapter extends LlmAdapter {
  private calls = 0
  constructor(private readonly respond: (options: GenerateOptions) => Reply) { super() }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const reply = this.respond(options)
    const id = `compaction-${++this.calls}` as Extract<StreamChunk, { type: 'tool-call-delta' }>['id']
    if (typeof reply === 'string') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: reply }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    } else {
      const args = JSON.stringify(reply.args)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: reply.name, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: reply.name, arguments: args } }
    }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
    yield { type: 'finish', reason: { kind: typeof reply === 'string' ? 'stop' : 'tool-calls' } }
  }
}


// A task Agent whose workspace folder was deleted: DSH 0.2.1 checks the directory before each step.
it('runs a background task Agent step for a workspace whose folder is gone', async () => {
  const f = await compositionFixture()
  const ctx = new Context()
  let stop: (() => void) | undefined
  try {
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root: join(f.root, 'sessions'), compression: 'none' })
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime, { mode: 'native' })
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await (async (ctx: { get(name: string): unknown; plugin(plugin: unknown, config?: unknown): Promise<unknown> }) => {
      const { createRequire } = await import('node:module')
      const { tmpdir } = await import('node:os')
      const requireHost = createRequire(process.env.DSH_HOST_ROOT + '/package.json')
      let workingDirectory: { default: unknown }
      try { workingDirectory = await import(requireHost.resolve('@deepseek-ai/dsh-working-directory')) } catch { return }
      if (ctx.get('fs') === undefined) await ctx.plugin((await import(requireHost.resolve('@deepseek-ai/dsh-fs-local'))).default, { cwd: tmpdir() })
      await ctx.plugin(workingDirectory.default)
    })(ctx as never)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(spawn, { providerName: 'spawn' })
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter(() => 'Maintenance step done.'))
    const host = ctx as unknown as HostContextShape
    const coordinator = new MnemonSubagentCoordinator(host.subagents, f.live, host)
    const lifecycle = new MnemonLifecycle(host, coordinator, f.config, f.live)
    registerTools(host, f.live, coordinator)
    stop = lifecycle.start()
    // An ordinary conversation supplies the task Agent's model route.
    const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' }, { cwd: f.workspace })
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Hello.' }], source: { kind: 'user' } }))
    await parent.whenIdle()
    const gone = join(f.root, 'deleted-project')
    const outcome = await lifecycle.runRuntimeMaintenanceTask({ storage: 'workspace', workspaceId: gone }, new AbortController().signal, async agent => {
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Run the maintenance step.' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      const events = JSON.stringify(agent.session.snapshotEvents?.() ?? [])
      const workingDirectory = (ctx as unknown as { workingDirectory?: { get(session: unknown): string } }).workingDirectory?.get(agent.session)
      // A maintenance child, as Mnemon starts one under the task Agent.
      const children: Array<{ id: string; session: { header: { cwd?: string } } }> = []
      const stopWatching = ctx.on('agent/created', ({ agent: created }: { agent: { id: string; session: { header: { cwd?: string; origin?: string } } } }) => {
        if (created.session.header.origin === 'subagent') children.push(created)
      })
      let child: Record<string, unknown> = {}
      try {
        const run = await startSubagent(host.subagents as never, host.agents as never, 'spawn', {
          label: 'Mnemon probe child', prompt: [{ type: 'text', text: 'Run the child step.' }], parent: agent as never, signal: new AbortController().signal,
        })
        const result = await run.result.then(value => ({ ok: true, value }), error => ({ ok: false, error: String(error?.message ?? error).slice(0, 200) }))
        const created = children.find(candidate => candidate.id === run.id)
        child = { cwd: created?.session.header.cwd, gone: created?.session.header.cwd === gone, settled: result.ok, ...(result.ok ? {} : { error: (result as { error: string }).error }) }
      } catch (error) {
        child = { thrown: String((error as Error)?.message ?? error).slice(0, 200) }
      } finally { stopWatching() }
      return { cwd: agent.session.header.cwd, gone: agent.session.header.cwd === gone, workingDirectory, error: events.match(/working-directory: [^"\\]+/u)?.[0], replied: events.includes('Maintenance step done.'), child }
    }).catch(error => ({ thrown: String(error?.message ?? error).slice(0, 200) }))
    console.log('TASK-AGENT-CWD ' + JSON.stringify({ dsh: process.env.DSH_VERSION, ...outcome }))
    // The task keeps the workspace whose memory it works on, and still runs its step.
    expect(outcome).toMatchObject({ gone: true, replied: true, child: { gone: true, settled: true } })
  } finally {
    stop?.()
    await ctx.fiber.dispose()
    await f.dispose()
  }
}, 20_000)

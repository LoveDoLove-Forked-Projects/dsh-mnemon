import type { HostAgent, HostSubagentRun, HostSubagentStartRequest, HostSubagentsService } from './dsh.ts'

/** The Agent registry lookups that find an activation's local child. */
export interface SubagentStartAgents {
  get?(id: string): HostAgent | undefined
  isOwnedBy?(id: string, parent: HostAgent): boolean
}

/**
 * Start one delegated child through the subagent API the running DSH offers.
 * DSH 0.2.1-alpha.2 replaced the one-shot `start` with managed activations
 * (#356); 0.2.0 has only `start`. An activation keeps a run's contract:
 * - caller delivery returns the result to Mnemon, so the parent conversation
 *   gets no completion notice;
 * - its signal covers only startup, so a later abort disposes the child, which
 *   is how an aborted run stopped;
 * - the live child in the Agent registry stands in for `localAgent`.
 */
export async function startSubagent(
  subagents: HostSubagentsService,
  agents: SubagentStartAgents | undefined,
  provider: string,
  request: HostSubagentStartRequest & { label: string },
): Promise<HostSubagentRun> {
  if (typeof subagents.startActivation === 'function') {
    const { label, signal, ...task } = request
    const activation = await subagents.startActivation({ provider, label, request: task, signal, delivery: 'caller' })
    // A second dispose from the caller reports any failure of this one.
    const stop = () => { activation.dispose().catch(() => {}) }
    const release = () => signal.removeEventListener('abort', stop)
    signal.addEventListener('abort', stop, { once: true })
    void activation.result.then(release, release)
    if (signal.aborted) stop()
    const child = agents?.get?.(activation.childId)
    const localAgent = child !== undefined && (typeof agents?.isOwnedBy !== 'function' || agents.isOwnedBy(child.id, request.parent)) ? child : undefined
    return {
      id: activation.childId,
      ...(localAgent === undefined ? {} : { localAgent }),
      result: activation.result,
      dispose: () => activation.dispose(),
    }
  }
  if (typeof subagents.start === 'function') return subagents.start(provider, request)
  throw new Error('This DSH has neither subagents.startActivation nor subagents.start, so dsh-mnemon cannot start its memory subagent; install a dsh-mnemon release that supports this DSH version')
}

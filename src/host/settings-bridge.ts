import { canonicalMemoryJson } from '../core/definitions.ts'
import type { HostSettingsService } from './dsh.ts'
import type { MnemonSettingsBridge } from './pack.ts'
import type { JsonValue, MnemonSettingsNamespaceSnapshot, MnemonSettingsPayload, SettingsOperation } from './protocol.ts'

/**
 * Settings live in the DSH profile, not in the Mnemon data directory, so a Pack carries
 * only the user layer the profile itself would replay. Machine-local keys describe where
 * this installation keeps its files; copying them to another machine would repoint that
 * machine's storage, so they never leave the machine that wrote them.
 */
export const MNEMON_MACHINE_LOCAL_KEYS: readonly string[] = ['storageScope', 'cliPath', 'dataDir', 'customPackId', 'customPacks']

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const own = (value: Record<string, unknown>, key: string): boolean => Object.hasOwn(value, key)

/**
 * Collect the user layer of every Mnemon namespace and write it back as profile edits.
 * The Pack is the transport; DSH stays the only writer of the profile document.
 */
export class MnemonProfileSettingsBridge implements MnemonSettingsBridge {
  constructor(
    private readonly settings: HostSettingsService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async collect(): Promise<MnemonSettingsPayload> {
    const exportedAt = this.now().toISOString()
    const namespaces: MnemonSettingsNamespaceSnapshot[] = []
    for (const descriptor of this.settings.describe({ redactSecrets: true })) {
      const user = this.portable(descriptor.ns, descriptor.user)
      if (Object.keys(user).length === 0) continue
      namespaces.push({ ns: descriptor.ns, user, updatedAt: exportedAt })
    }
    return { version: 1, exportedAt, namespaces }
  }

  async apply(payload: MnemonSettingsPayload): Promise<void> {
    if (!this.settings.writable) throw new Error('DSH settings are read-only; the Pack settings were not applied')
    const known = new Map(this.settings.describe({ redactSecrets: true }).map(descriptor => [descriptor.ns, descriptor]))
    for (const snapshot of payload.namespaces) {
      const descriptor = known.get(snapshot.ns)
      // A Pack from another installation may name namespaces this Host never registered.
      if (descriptor === undefined) continue
      const incoming = this.portable(snapshot.ns, snapshot.user)
      const current = this.portable(snapshot.ns, descriptor.user)
      const operations: SettingsOperation[] = []
      diffSettings([], current, incoming, operations)
      if (operations.length === 0) continue
      try {
        await this.settings.mutate(snapshot.ns, operations, descriptor.revision)
      } catch (error) {
        throw new Error(`Mnemon Pack settings could not be applied to ${snapshot.ns}: ${(error as Error).message}`)
      }
    }
  }

  /** Drop the keys that only describe this installation's own files. */
  private portable(namespace: string, value: unknown): Record<string, JsonValue> {
    if (!isPlainObject(value)) return {}
    const source = structuredClone(value) as Record<string, JsonValue>
    if (namespace !== 'mnemon') return source
    const kept: Record<string, JsonValue> = {}
    for (const [key, item] of Object.entries(source)) {
      if (MNEMON_MACHINE_LOCAL_KEYS.includes(key)) continue
      kept[key] = item
    }
    return kept
  }
}

/** Objects are diffed key by key so one edited field never rewrites a whole namespace. */
function diffSettings(prefix: string[], current: unknown, incoming: unknown, operations: SettingsOperation[]): void {
  if (isPlainObject(current) && isPlainObject(incoming)) {
    for (const key of new Set([...Object.keys(current), ...Object.keys(incoming)])) {
      const path = [...prefix, key]
      if (!own(incoming, key)) {
        operations.push({ op: 'unset', path })
        continue
      }
      if (!own(current, key)) {
        operations.push({ op: 'set', path, value: incoming[key] })
        continue
      }
      diffSettings(path, current[key], incoming[key], operations)
    }
    return
  }
  if (canonicalMemoryJson(current) === canonicalMemoryJson(incoming)) return
  operations.push({ op: 'set', path: prefix, value: incoming })
}

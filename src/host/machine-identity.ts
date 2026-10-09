/**
 * One installation's identity, kept in the data directory's state area.
 *
 * state/ is deliberately not a Pack component: the identity describes *this*
 * machine and must never travel in a backup, or two machines would sign their
 * entries with the same id and a merge could no longer tell them apart. What
 * does travel is the provenance stamped onto entries and the manifest.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join, resolve } from 'node:path'
import type { MnemonMachineIdentity } from './protocol.ts'
import type { StorageRoot } from './storage-root.ts'

export const MNEMON_MACHINE_DIRECTORY = 'state'
export const MNEMON_MACHINE_FILE = 'machine.json'
const MNEMON_MACHINE_VERSION = 1
const MAX_LABEL_CHARACTERS = 120

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** The name a fresh identity carries: the host name, or a neutral fallback. */
export function defaultMachineLabel(): string {
  const name = hostname().trim()
  const label = name === '' ? 'this machine' : name
  return label.length > MAX_LABEL_CHARACTERS ? label.slice(0, MAX_LABEL_CHARACTERS) : label
}

/**
 * The machine identity store. One file, one identity, created on first read and
 * then stable for the life of the data directory: an id that changed would
 * make every earlier entry look like it came from another machine.
 */
export class MnemonMachineStore {
  private readonly root: string
  private cached: MnemonMachineIdentity | undefined

  constructor(runner: Pick<StorageRoot, 'effectiveDataDir'>) {
    this.root = resolve(runner.effectiveDataDir())
  }

  directory(): string {
    return join(this.root, MNEMON_MACHINE_DIRECTORY)
  }

  path(): string {
    return join(this.directory(), MNEMON_MACHINE_FILE)
  }

  /** This installation's identity, creating and persisting one when none exists yet. */
  read(): MnemonMachineIdentity {
    if (this.cached !== undefined) return this.cached
    const stored = this.stored()
    this.cached = stored ?? this.create()
    return this.cached
  }

  private stored(): MnemonMachineIdentity | undefined {
    let value: unknown
    try {
      value = JSON.parse(readFileSync(this.path(), 'utf8')) as unknown
    } catch {
      return undefined
    }
    const parsed = record(value)
    if (parsed?.version !== MNEMON_MACHINE_VERSION) return undefined
    if (typeof parsed.id !== 'string' || parsed.id.trim() === '') return undefined
    if (typeof parsed.label !== 'string' || parsed.label.trim() === '') return undefined
    if (typeof parsed.createdAt !== 'string') return undefined
    return { id: parsed.id, label: parsed.label, createdAt: parsed.createdAt }
  }

  private create(): MnemonMachineIdentity {
    const identity: MnemonMachineIdentity = { id: randomUUID(), label: defaultMachineLabel(), createdAt: new Date().toISOString() }
    mkdirSync(this.directory(), { recursive: true, mode: 0o700 })
    const temporary = `${this.path()}.${randomUUID()}.tmp`
    writeFileSync(temporary, `${JSON.stringify({ version: MNEMON_MACHINE_VERSION, ...identity }, null, 2)}\n`, { mode: 0o600 })
    renameSync(temporary, this.path())
    return identity
  }
}

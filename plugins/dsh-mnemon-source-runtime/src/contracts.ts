export type RuntimeMemoryTarget = 'memory' | 'user'
export type RuntimeMemoryImportance = 'critical' | 'normal' | 'low'
export type RuntimeMemoryAction = 'add' | 'replace' | 'remove'

/** Provenance a DSH Host stamps when an entry crosses machines; absent for local writes. */
export interface RuntimeMemoryEntryOrigin {
  machine: string
  label: string
  at: string
}

export interface RuntimeMemoryEntry {
  content: string
  created_at: string
  updated_at: string
  target: RuntimeMemoryTarget
  importance: RuntimeMemoryImportance
  /** Optional git branch names that limit where this entry is projected. Absent means every branch. */
  branches?: string[]
  /** Which installation wrote this entry, so a merge can tell two machines apart. */
  origin?: RuntimeMemoryEntryOrigin
}

export interface RuntimeMemoryUsage {
  used: number
  limit: number
}

export interface RuntimeMemoryTargetView extends RuntimeMemoryUsage {
  target: RuntimeMemoryTarget
  entryCount: number
  markdownPath: string
}

export interface RuntimeMemorySnapshot {
  directory: string
  sourcePath: string
  revision: string
  generatedAt: string
  entries: RuntimeMemoryEntry[]
  targets: Record<RuntimeMemoryTarget, RuntimeMemoryTargetView>
}

export interface RuntimeMemoryCompactedEntry {
  content: string
  importance: RuntimeMemoryImportance
  /** Branch scope carried through compaction; absent means the entry is visible on every branch. */
  branches?: string[]
}

export interface RuntimeMemoryMutation {
  action: RuntimeMemoryAction
  target: RuntimeMemoryTarget
  content?: string
  oldText?: string
  importance?: RuntimeMemoryImportance
  /** Git branch names limiting where a target=memory entry is projected. Absent keeps the current scope on replace; an empty list clears it. */
  branches?: string[]
}

export type RuntimeMemoryMutationResult = {
  success: true
  message: string
  target: RuntimeMemoryTarget
  entryCount: number
  usage: RuntimeMemoryUsage
  added?: string
  replaced?: { from: string; to: string }
  removed?: string
  /** MEMORY.md entries a compaction moved to the local archive, when it ran with `archive: 'local'`. */
  archived?: { entries: number; path: string }
  maintenance?: {
    kind: 'local-compaction' | 'mnemon-archive' | 'local-archive'
    runId: string
    provider: string
    summary: string
    memoryBodyIds: string[]
  }
}

export interface RuntimeMemoryMaintenancePlan {
  revision: string
  action: RuntimeMemoryAction
  target: RuntimeMemoryTarget
  entries: RuntimeMemoryEntry[]
  pending?: RuntimeMemoryCompactedEntry
  excluded?: RuntimeMemoryEntry
  used: number
  projected: number
  limit: number
  requiresMaintenance: boolean
  /** This Runtime Source moves the entries compaction leaves out to its local archive when asked (#336). */
  localArchive?: true
}

import { DEFAULT_RUNTIME_MEMORY_LIMIT_BYTES, DEFAULT_RUNTIME_USER_LIMIT_BYTES } from './defaults.ts'
export const RUNTIME_MEMORY_VERSION = 1
export const RUNTIME_ENTRY_DELIMITER = '\n§\n'
export interface RuntimeMemoryLimits {
  readonly memory: number
  readonly user: number
}
export const RUNTIME_MEMORY_LIMITS: RuntimeMemoryLimits = {
  memory: DEFAULT_RUNTIME_MEMORY_LIMIT_BYTES,
  user: DEFAULT_RUNTIME_USER_LIMIT_BYTES,
}

/** The longest git branch name a scope may hold. */
export const RUNTIME_BRANCH_NAME_MAX = 128
/** The characters a git branch name in a scope may use. */
export const RUNTIME_BRANCH_NAME_PATTERN = /^[A-Za-z0-9._/-]+$/u

/**
 * Read a stored branch scope. Absent or malformed data reads as no scope, so an entry that
 * a hand edit or another installation left malformed is projected on every branch instead
 * of breaking the projection that reads it.
 */
export function parseRuntimeBranches(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const branches: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item === '' || item.length > RUNTIME_BRANCH_NAME_MAX || !RUNTIME_BRANCH_NAME_PATTERN.test(item)) return undefined
    branches.push(item)
  }
  return branches
}

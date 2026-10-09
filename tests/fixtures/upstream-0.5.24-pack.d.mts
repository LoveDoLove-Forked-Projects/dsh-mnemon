// Types for the vendored 0.5.24 Pack fixture. They describe only what the
// compatibility spec touches; the fixture itself is plain JavaScript on purpose, so the
// published bytes are never rewritten to satisfy this repository's compiler.
import type { ResolvedConfig } from '../../src/host/config.ts'
import type { StorageRoot } from '../../src/host/storage-root.ts'

export type UpstreamPackComponent = 'runtime' | 'documents' | 'memory-spaces'
export type UpstreamPackScope = 'full' | UpstreamPackComponent

export interface UpstreamPackComponentSummary {
  component: UpstreamPackComponent
  files: number
  bytes: number
  items: number
}

export interface UpstreamPackManifest {
  format: 'mnemonpack'
  version: 1
  scope: UpstreamPackScope
  exportedAt: string
  source: { plugin: 'dsh-mnemon'; pluginVersion: string }
  components: UpstreamPackComponent[]
  summary: UpstreamPackComponentSummary[]
}

export interface UpstreamPackExport {
  fileName: string
  mimeType: string
  bytes: number
  base64: string
  targetRoot: string
  manifest: UpstreamPackManifest
}

export interface UpstreamPackPreview {
  fileName?: string
  archiveBytes: number
  expandedBytes: number
  targetRoot: string
  targetScope: string
  manifest: UpstreamPackManifest
  occupied: Record<string, boolean>
}

export interface UpstreamPackImportResult {
  imported: true
  mode: 'merge' | 'replace'
  targetRoot: string
  components: UpstreamPackComponent[]
  summary: UpstreamPackComponentSummary[]
}

/** The released 0.5.24 MnemonPackManager, with its own component list. */
export declare class UpstreamPackManager {
  constructor(
    runner: StorageRoot,
    config: Pick<ResolvedConfig, 'storageScope' | 'runtimeMemory'>,
    afterImport?: (components: UpstreamPackComponent[]) => void,
    now?: () => Date,
  )
  target(): { root: string; scope: string; defaultRoot: string }
  exportPack(scope: UpstreamPackScope): Promise<UpstreamPackExport>
  inspectPack(base64: string, fileName?: string): UpstreamPackPreview
  importPack(base64: string, options: { mode: 'merge' | 'replace'; components?: UpstreamPackComponent[] }): Promise<UpstreamPackImportResult>
}

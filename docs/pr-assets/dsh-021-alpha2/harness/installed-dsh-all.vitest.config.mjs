// Run every root test against an installed DSH instead of the pinned development baseline.
// Each @deepseek-ai/* import, subpaths included, resolves as if imported from that installation.
// The installation's packages are inlined, so a bare import they make that the installation
// lacks (zustand and clsx: DSH ships its client prebuilt) falls back to this repository's copy.
//   DSH_HOST_ROOT=<prefix>/lib/node_modules/@deepseek-ai/dsh DSH_VERSION=<version> \
//     MNEMON_BUNDLE_TEST_PROFILE=<prefix>/lib/node_modules/@deepseek-ai/dsh \
//     MNEMON_TEST_EXCLUDE=<spec names, comma-separated> \
//     pnpm exec vitest run --config docs/pr-assets/dsh-021-alpha2/harness/installed-dsh-all.vitest.config.mjs
// Set MNEMON_TEST_DIR to run specs outside the repository, such as the copies that
// ../../issue-356-subagent-activation/harness/adapt-host-specs.mjs writes for the real-host specs.
import { join, resolve } from 'node:path'
import base from '../../../../vitest.config.ts'

const root = resolve(import.meta.dirname, '../../../..')
const host = process.env.DSH_HOST_ROOT
if (!host) throw new Error('Set DSH_HOST_ROOT to an installed @deepseek-ai/dsh')
const hostAnchor = join(host, 'package.json')
const repoAnchor = join(root, 'package.json')
const bare = id => !id.startsWith('.') && !id.startsWith('/') && !id.startsWith('\0') && !/^[a-z]+:/u.test(id)

const installedDsh = {
  name: 'installed-dsh',
  enforce: 'pre',
  async resolveId(id, importer, options) {
    if (!bare(id)) return null
    const inside = importer !== undefined && importer.startsWith(host)
    if (id.startsWith('@deepseek-ai/')) return this.resolve(id, inside ? importer : hostAnchor, { ...options, skipSelf: true })
    if (!inside) return null
    return await this.resolve(id, importer, { ...options, skipSelf: true }) ?? this.resolve(id, repoAnchor, { ...options, skipSelf: true })
  },
}

export default {
  ...base,
  plugins: [installedDsh, ...(base.plugins ?? [])],
  resolve: {
    ...base.resolve,
    // Specs outside the repository reach vitest through the repository's install.
    alias: [{ find: /^vitest$/, replacement: join(root, 'node_modules/vitest/dist/index.js') }, ...base.resolve.alias],
  },
  test: {
    ...base.test,
    dir: resolve(process.env.MNEMON_TEST_DIR ?? join(root, 'tests')),
    // A probe here is named *.probe.ts, so a plain `vitest run` in the repository never collects it.
    include: ['**/*.spec.ts', '**/*.spec.tsx', '**/*.spec.mjs', '**/*.probe.ts'],
    exclude: [...(base.test.exclude ?? []), ...(process.env.MNEMON_TEST_EXCLUDE ?? '').split(',').filter(Boolean).map(name => `**/${name}.spec.?(m)[jt]s`)],
    testTimeout: 60_000,
    server: { deps: { inline: [/@deepseek-ai\//u, ...(base.test.server?.deps?.inline ?? [])] } },
  },
}

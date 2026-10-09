// Issue #356: run specs written by adapt-host-specs.mjs against an installed DSH's published
// packages instead of the pinned development baseline. Every @deepseek-ai/* import, the DSH
// packages' own included, resolves inside that installation.
//   DSH_HOST_ROOT=<prefix>/lib/node_modules/@deepseek-ai/dsh DSH_VERSION=<version> MNEMON_HOST_SPECS=<specs> \
//     pnpm exec vitest run --config docs/pr-assets/issue-356-subagent-activation/harness/installed-dsh.vitest.config.mjs
import { readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import base from '../../../../vitest.config.ts'

const root = resolve(import.meta.dirname, '../../../..')
const host = process.env.DSH_HOST_ROOT
const specs = process.env.MNEMON_HOST_SPECS
if (!host || !specs) throw new Error('Set DSH_HOST_ROOT to an installed @deepseek-ai/dsh and MNEMON_HOST_SPECS to the adapted specs')
const require = createRequire(join(host, 'package.json'))
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const dsh = []
for (const name of ['dsh', ...readdirSync(join(host, 'node_modules/@deepseek-ai'))]) {
  let entry
  try { entry = require.resolve(`@deepseek-ai/${name}`) } catch { continue }
  dsh.push({ find: new RegExp(`^@deepseek-ai/${escape(name)}$`), replacement: entry })
}

export default {
  ...base,
  resolve: {
    ...base.resolve,
    // The specs live outside the repository, so they reach vitest through the repository's install.
    alias: [...dsh, { find: /^vitest$/, replacement: join(root, 'node_modules/vitest/dist/index.js') }, ...base.resolve.alias],
  },
  test: { ...base.test, dir: resolve(specs), include: ['**/*.spec.ts'], testTimeout: 60_000 },
}

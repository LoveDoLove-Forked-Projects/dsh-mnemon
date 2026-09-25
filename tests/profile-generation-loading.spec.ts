import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(import.meta.url)
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/** Replay Desktop's real package layout, without substituting any module exports. */
function generation(cosmokit: string) {
  const directory = mkdtempSync(join(tmpdir(), 'mnemon-generation-import-'))
  const profile = join(directory, 'profiles/web')
  const installed = join(directory, 'profiles/.generations/live/mnemon/node_modules')
  const packageRoot = join(installed, 'dsh-mnemon')
  mkdirSync(packageRoot, { recursive: true })
  cpSync(join(root, 'lib'), join(packageRoot, 'lib'), { recursive: true })
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify(manifest))

  // The published installer removes @deepseek-ai singletons from generations.
  // Keep the aliased live schema physically inside the generation so its own
  // Cosmokit import also resolves through the host, as it does in Desktop.
  const dependencies = { ...manifest.dependencies, ...manifest.peerDependencies }
  for (const name of Object.keys(dependencies)) {
    if (name.startsWith('@deepseek-ai/')) continue
    const target = join(installed, name)
    mkdirSync(dirname(target), { recursive: true })
    const source = join(root, 'node_modules', name)
    if (name === 'schemastery-live') cpSync(source, target, { recursive: true, dereference: true })
    else symlinkSync(source, target, 'junction')
  }
  const hostModules = join(directory, 'profiles/node_modules')
  for (const name of Object.keys(dependencies).filter(name => name.startsWith('@deepseek-ai/'))) {
    const target = join(hostModules, name)
    mkdirSync(dirname(target), { recursive: true })
    symlinkSync(name === '@deepseek-ai/cosmokit'
      ? dirname(require.resolve(`${cosmokit}/package.json`))
      : join(root, 'node_modules', name), target, 'junction')
  }
  mkdirSync(join(profile, 'node_modules'), { recursive: true })
  symlinkSync(packageRoot, join(profile, 'node_modules/dsh-mnemon'), 'junction')
  return { directory, profile }
}

describe('profile generation imports against host-owned framework packages', () => {
  it.each([
    ['cosmokit-legacy', '1.8.3', false],
    ['@deepseek-ai/cosmokit', '1.8.4', true],
  ] as const)('loads the complete built Starter with public Cosmokit %s', (specifier, version, live) => {
    const fixture = generation(specifier)
    try {
      expect(JSON.parse(readFileSync(require.resolve(`${specifier}/package.json`), 'utf8')).version).toBe(version)
      const entry = join(fixture.profile, 'check.mjs')
      writeFileSync(entry, `
        import assert from 'node:assert/strict'
        import * as mnemon from 'dsh-mnemon'
        const config = mnemon.Config({ displayMode: 'builtin', remoteAccess: 'read-only' })
        const live = typeof config.displayMode?.get === 'function'
        assert.equal(live, ${live})
        assert.equal(live ? config.displayMode.get() : config.displayMode, 'builtin')
        assert.equal(config.remoteAccess, 'read-only')
        assert.equal(typeof mnemon.apply, 'function')
        assert.equal(mnemon.name, 'dsh-mnemon')
        console.log(JSON.stringify({ loaded: true, live }))
      `)
      const result = spawnSync(process.execPath, [entry], { encoding: 'utf8', timeout: 20_000 })
      expect(result.error).toBeUndefined()
      expect(result.status, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({ loaded: true, live })
    } finally { rmSync(fixture.directory, { recursive: true, force: true }) }
  })
})

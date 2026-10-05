import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MNEMON_MACHINE_DIRECTORY, MNEMON_MACHINE_FILE, MnemonMachineStore, defaultMachineLabel } from "../src/host/machine-identity.ts"

const directories: string[] = []

function temporary(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-mnemon-identity-'))
  directories.push(directory)
  return directory
}

function store(root: string): MnemonMachineStore {
  return new MnemonMachineStore({ effectiveDataDir: () => root })
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('Mnemon machine identity', () => {
  it('mints one identity on first use and keeps it across later reads and instances', () => {
    const root = temporary()
    const first = store(root).read()
    expect(first.id).toMatch(/^[0-9a-f-]{36}$/u)
    expect(first.label.length).toBeGreaterThan(0)
    expect(Number.isNaN(Date.parse(first.createdAt))).toBe(false)

    const path = join(root, MNEMON_MACHINE_DIRECTORY, MNEMON_MACHINE_FILE)
    expect(existsSync(path)).toBe(true)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ version: 1, ...first })

    expect(store(root).read()).toEqual(first)
    expect(store(root).read().id).toBe(first.id)
  })

  it('labels the machine with its host name and never leaves the label empty', () => {
    expect(defaultMachineLabel().trim()).toBe(defaultMachineLabel())
    expect(defaultMachineLabel().length).toBeGreaterThan(0)
  })

  it('replaces a damaged record instead of failing', () => {
    const root = temporary()
    const path = join(root, MNEMON_MACHINE_DIRECTORY, MNEMON_MACHINE_FILE)
    mkdirSync(dirname(path), { recursive: true })
    for (const damaged of ['not json at all', JSON.stringify({ version: 2, id: 'a', label: 'b', createdAt: 'c' }), JSON.stringify({ version: 1, id: '', label: 'b', createdAt: 'c' }), JSON.stringify({ version: 1, id: 'a', label: 'b' })]) {
      rmSync(path, { force: true })
      writeFileSync(path, damaged)
      const identity = store(root).read()
      expect(identity.id).not.toBe('a')
      expect(identity.label.length).toBeGreaterThan(0)
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ version: 1, ...identity })
    }
  })

  it('reads the identity from the effective data directory the runner reports', () => {
    const root = temporary()
    const identity = new MnemonMachineStore({ effectiveDataDir: () => join(root, 'nested', 'deeper') }).read()
    expect(existsSync(join(root, 'nested', 'deeper', MNEMON_MACHINE_DIRECTORY, MNEMON_MACHINE_FILE))).toBe(true)
    expect(identity.id.length).toBeGreaterThan(0)
  })
})

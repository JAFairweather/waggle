#!/usr/bin/env node
// Publish only the public, secret-free setup receipt to a separately hosted console.
// The browser never reads ~/.waggle directly; the operator explicitly copies this projection.

import { constants, existsSync, lstatSync, mkdirSync, openSync, closeSync, renameSync, writeFileSync, chmodSync, fsyncSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { read, summary } from './setup-state.mjs'

function publish(statePath, out) {
  if (existsSync(out)) {
    const st = lstatSync(out)
    if (!st.isFile() || st.isSymbolicLink()) throw new Error('setup-state-publish: output must be a regular non-symlink file')
  }
  const receipt = summary(read(statePath))
  const tmp = `${out}.${process.pid}.tmp`
  mkdirSync(dirname(out), { recursive: true, mode: 0o755 })
  // Do not follow a pre-existing attacker-controlled temp path. The rename is atomic,
  // but only after the temporary file itself was created exclusively.
  writeFileSync(tmp, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o644, flag: 'wx' })
  chmodSync(tmp, 0o644)
  const fd = openSync(tmp, constants.O_RDONLY); try { fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(tmp, out)
  const dir = openSync(dirname(out), constants.O_RDONLY | constants.O_DIRECTORY); try { fsyncSync(dir) } finally { closeSync(dir) }
  return receipt
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const value = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1] }
  const statePath = resolve(value('--state') || process.env.WAGGLE_SETUP_STATE || `${process.env.HOME || '.'}/.waggle/setup-state.json`)
  const outputPath = value('--out')
  if (!outputPath) {
    console.error('usage: setup-state-publish.mjs --state FILE --out PUBLIC_RECEIPT.json')
    process.exit(2)
  }
  try {
    const out = resolve(outputPath)
    const receipt = publish(statePath, out)
    console.log(`published ${out} (${receipt.installation_id})`)
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}

export { publish }

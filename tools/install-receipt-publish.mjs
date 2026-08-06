#!/usr/bin/env node
// Publish the explicit, secret-free projection of owner installation state.
//
// The private mode-0600 state never belongs on the separately hosted Console. This tool reads
// and validates that state, rebuilds the public receipt through the shared schema, and atomically
// writes only that receipt. It accepts no credential flags and never follows an output symlink.

import { constants, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, renameSync,
  unlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildInstallReceipt, loadInstallState } from '../src/install_state.mjs'

export function publishInstallReceipt(statePath, outputPath) {
  const source = resolve(String(statePath || ''))
  const output = resolve(String(outputPath || ''))
  if (!statePath || !outputPath) throw new Error('install-receipt: state and output paths are required')
  if (existsSync(output)) {
    const st = lstatSync(output)
    if (!st.isFile() || st.isSymbolicLink()) throw new Error('install-receipt: output must be a regular non-symlink file')
  }
  const receipt = buildInstallReceipt(loadInstallState(source))
  const body = `${JSON.stringify(receipt, null, 2)}\n`
  if (/(?:\bnsec1|\bbunker:\/\/|private_?key|client_?nsec)/i.test(body)) {
    throw new Error('install-receipt: credential material reached the public projection')
  }
  mkdirSync(dirname(output), { recursive: true, mode: 0o755 })
  const temp = `${output}.tmp-${process.pid}`
  const fd = openSync(temp, 'wx', 0o644)
  try {
    writeFileSync(fd, body); fsyncSync(fd); closeSync(fd)
    renameSync(temp, output)
    const dirFd = openSync(dirname(output), constants.O_RDONLY | constants.O_DIRECTORY)
    try { fsyncSync(dirFd) } finally { closeSync(dirFd) }
  } catch (error) {
    try { closeSync(fd) } catch { /* already closed */ }
    try { unlinkSync(temp) } catch { /* renamed or absent */ }
    throw error
  }
  return receipt
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const value = name => { const i = process.argv.indexOf(name); return i < 0 ? '' : process.argv[i + 1] || '' }
  try {
    const receipt = publishInstallReceipt(value('--state'), value('--out'))
    console.log(`published ${receipt.installation_id} to ${resolve(value('--out'))}`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}

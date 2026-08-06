// Crash-consistent bridge-side debt for remote-only policy work.
//
// One file per source event keeps the exact canonical request independent of scan windows and
// retry counts. A request is removed only after a verified terminal policy response and all local
// completion records are durable. There is deliberately no dead-letter limit: an unavailable
// policy service is a hold, never permission to fall back to the bridge's local poster key.
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync,
  renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'

const HEX64 = /^[0-9a-f]{64}$/
const fail = message => { throw new Error(`policy-request-queue: ${message}`) }

function syncDirectory(path) {
  const fd = openSync(path, 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

export class PolicyRequestQueue {
  constructor(directory) {
    if (typeof directory !== 'string' || !directory.startsWith('/')) fail('directory must be absolute')
    this.directory = directory
    this.mem = new Map()
  }

  path(key) {
    if (!HEX64.test(String(key || ''))) fail('key must be a lowercase 64-hex event id')
    return resolve(this.directory, `${key}.request`)
  }

  entries() { return [...this.mem.entries()].map(([key, requestRaw]) => ({ key, requestRaw })) }
  get(key) { return this.mem.get(key) || null }
  has(key) { return this.mem.has(key) }

  load() {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    this.mem.clear()
    for (const name of readdirSync(this.directory)) {
      const match = /^([0-9a-f]{64})\.request$/.exec(name)
      if (!match) continue
      const path = resolve(this.directory, name)
      const stat = lstatSync(path)
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) fail(`${name} is not a private regular file`)
      const raw = readFileSync(path, 'utf8')
      if (!raw || Buffer.byteLength(raw) > 128 * 1024) fail(`${name} is empty or oversized`)
      this.mem.set(match[1], raw)
    }
    return this.mem.size
  }

  enqueue(key, requestRaw) {
    const path = this.path(key)
    if (typeof requestRaw !== 'string' || !requestRaw || Buffer.byteLength(requestRaw) > 128 * 1024) fail('request is empty or oversized')
    const existing = this.mem.get(key)
    if (existing != null) {
      if (existing !== requestRaw) fail('the source event is already bound to different request bytes')
      return false
    }
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    if (existsSync(path)) {
      const disk = readFileSync(path, 'utf8')
      if (disk !== requestRaw) fail('the durable source event is bound to different request bytes')
      this.mem.set(key, disk)
      return false
    }
    const temporary = resolve(this.directory, `.${basename(path)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`)
    let fd = null
    try {
      fd = openSync(temporary, 'wx', 0o600)
      writeFileSync(fd, requestRaw)
      fsyncSync(fd)
      closeSync(fd); fd = null
      renameSync(temporary, path)
      syncDirectory(this.directory)
      this.mem.set(key, requestRaw)
      return true
    } catch (error) {
      if (fd !== null) { try { closeSync(fd) } catch {} }
      try { unlinkSync(temporary) } catch {}
      throw error
    }
  }

  remove(key) {
    const path = this.path(key)
    if (!this.mem.has(key) && !existsSync(path)) return false
    // A prior attempt may have unlinked the file and then failed while syncing the directory.
    // Retrying must be able to finish that durability barrier instead of wedging forever on ENOENT.
    if (existsSync(path)) unlinkSync(path)
    syncDirectory(dirname(path))
    this.mem.delete(key)
    return true
  }
}

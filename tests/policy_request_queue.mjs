import { chmodSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PolicyRequestQueue } from '../src/policy_request_queue.mjs'

let fails = 0
const ok = (name, pass) => { console.log(`${pass ? 'ok  ' : 'FAIL'} — ${name}`); if (!pass) fails++ }
const refuses = (name, fn, pattern) => { try { fn(); ok(name, false) } catch (error) { ok(name, pattern.test(String(error?.message || ''))) } }
const directory = mkdtempSync(join(tmpdir(), 'waggle-policy-queue-'))
const key = 'a'.repeat(64), raw = '{"exact":"request"}'
const first = new PolicyRequestQueue(directory)
ok('an exact request is durably enqueued before dispatch', first.enqueue(key, raw) && first.get(key) === raw && readFileSync(join(directory, `${key}.request`), 'utf8') === raw)
ok('re-enqueue of the same exact bytes is idempotent', first.enqueue(key, raw) === false && first.entries().length === 1)
refuses('one source id cannot be rebound to different bytes', () => first.enqueue(key, '{"different":true}'), /different request bytes/)

const restarted = new PolicyRequestQueue(directory)
ok('restart reloads the exact request without a scan window', restarted.load() === 1 && restarted.get(key) === raw)
ok('terminal completion durably removes the debt', restarted.remove(key) && new PolicyRequestQueue(directory).load() === 0)

const interrupted = new PolicyRequestQueue(directory), interruptedKey = 'c'.repeat(64)
interrupted.enqueue(interruptedKey, raw); unlinkSync(join(directory, `${interruptedKey}.request`))
ok('a retry finishes removal after unlink won but the prior directory sync failed', interrupted.remove(interruptedKey) && !interrupted.has(interruptedKey))

const bad = 'b'.repeat(64), badPath = join(directory, `${bad}.request`)
writeFileSync(badPath, raw, { mode: 0o644 }); chmodSync(badPath, 0o644)
refuses('a group-readable queued request fails closed at boot', () => new PolicyRequestQueue(directory).load(), /private regular file/)
refuses('relative queue directories are refused', () => new PolicyRequestQueue('relative'), /absolute/)

console.log(fails ? `\npolicy_request_queue: ${fails} FAILED` : '\npolicy_request_queue: all checks passed')
process.exit(fails ? 1 : 0)

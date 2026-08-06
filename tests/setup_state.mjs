import { mkdtempSync, statSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { create, read, record, summary } from '../tools/setup-state.mjs'

const root = mkdtempSync(join(tmpdir(), 'waggle-setup-state-')), path = join(root, 'state.json')
const first = create(path)
assert.match(first.installation_id, /^[0-9a-f-]{36}$/i)
assert.equal(summary(first).complete, false)
assert.equal(statSync(path).mode & 0o777, 0o600)
assert.equal(create(path).installation_id, first.installation_id)
record(path, 'prepare-local', 'pass', 'node and dependency preflight passed')
record(path, 'bootstrap-host', 'deferred', 'awaiting owner host approval')
assert.equal(read(path).steps['prepare-local'].status, 'pass')
assert.equal(read(path).steps['bootstrap-host'].status, 'deferred')
assert.throws(() => record(path, 'prepare-local', 'pass', 'nsec1secret'), /credential-like/)
const cli = spawnSync(process.execPath, ['tools/setup-state.mjs', 'report', '--path', path], { encoding: 'utf8' })
assert.equal(cli.status, 0); assert.equal(JSON.parse(cli.stdout).installation_id, first.installation_id)
const checkPath = join(root, 'check-only.json')
const check = spawnSync(process.execPath, ['tools/waggle-init.mjs', '--check'], { encoding: 'utf8', env: { ...process.env, CONFIG_PATH: join(root, 'missing-config.json'), WAGGLE_SETUP_STATE: checkPath } })
assert.equal(check.status, 1); assert.equal(existsSync(checkPath), false)
const publicPath = join(root, 'public', 'setup-state.json')
const published = spawnSync(process.execPath, ['tools/setup-state-publish.mjs', '--state', path, '--out', publicPath], { encoding: 'utf8' })
assert.equal(published.status, 0)
assert.equal(statSync(publicPath).mode & 0o777, 0o644)
const receipt = JSON.parse(readFileSync(publicPath, 'utf8'))
assert.equal(receipt.installation_id, first.installation_id)
assert.equal('public' in receipt, false)
assert.equal(/nsec|bunker|secret|private/i.test(readFileSync(publicPath, 'utf8')), false)
const bad = join(root, 'bad.json'); writeFileSync(bad, '{}'); chmodSync(bad, 0o644)
assert.throws(() => read(bad), /mode 0600/)
console.log('setup_state: all checks passed')

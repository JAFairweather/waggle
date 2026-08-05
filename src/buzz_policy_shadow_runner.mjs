// Structurally credential-free forced-command adapter for shadow comparison. It deliberately
// imports neither the live artifact/submission service nor the signer/journal modules.
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs'
import { TextDecoder } from 'node:util'
import { createProjectionPolicy } from './buzz_policy_projection.mjs'
import { encodeBuzzPolicyShadow } from './buzz_policy_shadow.mjs'

const HEX64 = /^[0-9a-f]{64}$/, UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const fail = message => { throw new Error(`buzz-policy-shadow-runner: ${message}`) }
function privateText(path, maxBytes = 64 * 1024) {
  let fd
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW) } catch { fail('config cannot be read as a regular non-symlink file') }
  try {
    const st = fstatSync(fd)
    if (!st.isFile() || (st.mode & 0o077) || st.size < 2 || st.size > maxBytes) fail('private input must be a bounded private regular file')
    return readFileSync(fd)
  } finally { closeSync(fd) }
}

export function loadBuzzPolicyShadowConfig(path) {
  let config
  try { config = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(privateText(path))) }
  catch (error) {
    if (String(error?.message || '').startsWith('buzz-policy-shadow-runner:')) throw error
    fail('config is not valid UTF-8 JSON')
  }
  const keys = ['version', 'policy_instance', 'catalogue_version', 'staging_channel', 'watched_event_ids',
    'approver_mention', 'poster_pubkey', 'auth_tag']
  if (Object.keys(config).sort().join(',') !== keys.sort().join(',')) fail('config has an invalid shape')
  if (config.version !== 1 || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(config.policy_instance) ||
      !HEX64.test(config.catalogue_version) || !UUID.test(config.staging_channel)) fail('config identity, catalogue, or channel is invalid')
  if (!Array.isArray(config.watched_event_ids) || !config.watched_event_ids.every(id => HEX64.test(id)) ||
      new Set(config.watched_event_ids).size !== config.watched_event_ids.length) fail('watched_event_ids are invalid')
  if (typeof config.approver_mention !== 'string' || Buffer.byteLength(config.approver_mention) > 128) fail('approver_mention is invalid')
  const projectionPolicy = createProjectionPolicy({ posterPubkey: config.poster_pubkey, authTag: config.auth_tag })
  return Object.freeze({ ...config, watched_event_ids: Object.freeze([...config.watched_event_ids]), projectionPolicy })
}

export async function readBoundedShadowRequest(stream, maxBytes = 128 * 1024) {
  const chunks = []; let total = 0
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk); total += bytes.length
    if (total > maxBytes) fail(`request exceeds ${maxBytes} bytes`)
    chunks.push(bytes)
  }
  if (!total) fail('request is empty')
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) }
  catch { fail('request is not valid UTF-8') }
}

export function runBuzzPolicyShadow(raw, config, { now } = {}) {
  if (!config?.projectionPolicy) fail('verified shadow config is required')
  return encodeBuzzPolicyShadow(raw, { policyInstance: config.policy_instance,
    catalogueVersion: config.catalogue_version, stagingChannel: config.staging_channel,
    watchedEventIds: config.watched_event_ids, approverMention: config.approver_mention,
    projectionPolicy: config.projectionPolicy, now })
}

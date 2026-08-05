// Forced-command adapter for the off-box policy service.  Deployment fixes the
// config path and executable; stdin is the request's only caller-controlled input.
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { TextDecoder } from 'node:util'
import { createArtifactPolicy } from './buzz_policy_artifacts.mjs'
import { canonicalJson } from './buzz_policy_core.mjs'
import { PolicyJournal } from './policy_journal.mjs'
import { processBuzzPolicyRequest } from './buzz_policy_service.mjs'

const HEX64 = /^[0-9a-f]{64}$/, UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const fail = message => { throw new Error(`buzz-policy-runner: ${message}`) }
const exactKeys = (value, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) fail('config has an invalid shape')
}

function privateText(path) {
  let fd
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW) } catch { fail('config cannot be read as a regular non-symlink file') }
  try {
    const st = fstatSync(fd)
    if (!st.isFile() || (st.mode & 0o077) || st.size < 2 || st.size > 64 * 1024) fail('config must be a private regular file of at most 65536 bytes')
    return readFileSync(fd)
  } finally { closeSync(fd) }
}

export function loadBuzzPolicyConfig(path) {
  let config
  try { config = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(privateText(path))) } catch (error) {
    if (String(error?.message || '').startsWith('buzz-policy-runner:')) throw error
    fail('config is not valid UTF-8 JSON')
  }
  exactKeys(config, ['version', 'policy_instance', 'catalogue_version', 'staging_channel', 'watched_event_ids',
    'approver_mention', 'poster_pubkey', 'auth_tag', 'endpoint', 'journal_path'])
  if (config.version !== 1 || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(config.policy_instance)) fail('config version or policy_instance is invalid')
  if (!HEX64.test(config.catalogue_version) || !UUID.test(config.staging_channel)) fail('config catalogue or channel is invalid')
  if (!Array.isArray(config.watched_event_ids) || !config.watched_event_ids.every(id => HEX64.test(id)) || new Set(config.watched_event_ids).size !== config.watched_event_ids.length) fail('watched_event_ids are invalid')
  if (typeof config.approver_mention !== 'string' || Buffer.byteLength(config.approver_mention) > 128) fail('approver_mention is invalid')
  if (!isAbsolute(config.journal_path)) fail('journal_path must be absolute')
  const artifactPolicy = createArtifactPolicy({ posterPubkey: config.poster_pubkey, authTag: config.auth_tag, endpoint: config.endpoint })
  return Object.freeze({ ...config, watched_event_ids: Object.freeze([...config.watched_event_ids]), artifactPolicy })
}

export async function readBoundedPolicyRequest(stream, maxBytes = 128 * 1024) {
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

export async function runBuzzPolicyRequest(raw, config, signer, deps = {}) {
  if (!config?.artifactPolicy) fail('verified config is required')
  if (!signer || signer.pubkey !== config.poster_pubkey) fail('Bunker signer identity does not match poster_pubkey')
  const journal = deps.journal || new PolicyJournal(config.journal_path)
  const result = await processBuzzPolicyRequest(raw, { policyInstance: config.policy_instance,
    catalogueVersion: config.catalogue_version, stagingChannel: config.staging_channel,
    watchedEventIds: config.watched_event_ids, approverMention: config.approver_mention,
    artifactPolicy: config.artifactPolicy, journal, signer, fetchImpl: deps.fetchImpl,
    now: deps.now, nonce: deps.nonce, timeoutMs: deps.timeoutMs })
  return `${canonicalJson(result)}\n`
}

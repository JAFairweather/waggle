import { createHash } from 'node:crypto'
import { generateSecretKey, finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import { schnorr } from '@noble/curves/secp256k1'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils'
import { canonicalJson } from '../src/buzz_policy_core.mjs'
import { createProjectionPolicy } from '../src/buzz_policy_projection.mjs'
import { deriveBuzzPolicyShadow } from '../src/buzz_policy_shadow.mjs'
import { compareQuarantineShadow, parseShadowResponse } from '../src/buzz_policy_shadow_client.mjs'
import { runPolicyShadowSsh } from '../src/egress.mjs'

let fails = 0
const ok = (name, pass) => { console.log(`${pass ? 'ok  ' : 'FAIL'} — ${name}`); if (!pass) fails++ }
const refuses = async (name, fn, pattern) => { try { await fn(); ok(name, false) } catch (e) { ok(name, pattern.test(e.message)) } }
const now = 2_000_000_000, policyInstance = 'jaf-hive', catalogueVersion = 'c'.repeat(64)
const watched = 'd'.repeat(64), stagingChannel = 'a8186b53-537d-46ad-a7e7-b6486c58970e'
const source = JSON.parse(JSON.stringify(finalizeEvent({ kind: 1, created_at: now - 1,
  tags: [['e', watched]], content: 'outside words' }, generateSecretKey())))
const requestRaw = canonicalJson({ version: 1, policy_instance: policyInstance, operation: 'quarantine_header',
  catalogue_version: catalogueVersion, observed_at: now, evidence: { source_event: source } })
const posterSk = generateSecretKey(), posterPubkey = getPublicKey(posterSk)
const ownerSk = generateSecretKey(), owner = getPublicKey(ownerSk), conditions = ''
const signature = bytesToHex(schnorr.sign(sha256(utf8ToBytes(`nostr:agent-auth:${posterPubkey}:${conditions}`)), ownerSk))
const authTag = ['auth', owner, conditions, signature]
const projectionPolicy = createProjectionPolicy({ posterPubkey, authTag })
const remote = deriveBuzzPolicyShadow(requestRaw, { policyInstance, catalogueVersion, stagingChannel,
  watchedEventIds: [watched], approverMention: 'jafairweather', projectionPolicy, now: now + 7 })
const remoteRaw = `${canonicalJson(remote)}\n`
const config = { policyInstance, catalogueVersion, stagingChannel, watchedEventIds: [watched],
  approverMention: 'jafairweather', posterPubkey, authTag }

const match = compareQuarantineShadow(requestRaw, remoteRaw, config)
ok('the local projection matches the remote-owned evaluation time and unsigned digest',
  match.match && match.reason === 'match' && match.evaluationTime === now + 7 && match.localDigest === match.remoteDigest)
const changedDigest = `${canonicalJson({ ...remote, unsigned_event_sha256: 'f'.repeat(64) })}\n`
const mismatch = compareQuarantineShadow(requestRaw, changedDigest, config)
ok('a canonical but different remote digest is a loud mismatch', !mismatch.match && mismatch.reason === 'digest-mismatch')
const denied = deriveBuzzPolicyShadow(requestRaw, { policyInstance, catalogueVersion, stagingChannel,
  watchedEventIds: ['e'.repeat(64)], approverMention: 'jafairweather', projectionPolicy, now: now + 7 })
ok('decision disagreement is distinguished from a byte disagreement',
  compareQuarantineShadow(requestRaw, `${canonicalJson(denied)}\n`, config).reason === 'decision-mismatch')
await refuses('a response for another exact request is refused', () => parseShadowResponse(remoteRaw,
  { requestRaw: `${requestRaw} `, policyInstance, catalogueVersion }), /binding/)
await refuses('non-canonical or multi-line output is refused', () => parseShadowResponse(`${JSON.stringify(remote, null, 2)}\n`,
  { requestRaw, policyInstance, catalogueVersion }), /canonical/)
await refuses('a denied response cannot smuggle an event digest', () => parseShadowResponse(`${canonicalJson({ ...denied, unsigned_event_sha256: 'a'.repeat(64) })}\n`,
  { requestRaw, policyInstance, catalogueVersion }), /decision\/digest/)
await refuses('the shadow cannot choose a far-future comparison clock', () => parseShadowResponse(`${canonicalJson({ ...remote, evaluation_time: now + 301 })}\n`,
  { requestRaw, policyInstance, catalogueVersion }), /freshness window/)

let invocation, stdin = ''
const exec = (file, args, options, callback) => {
  invocation = { file, args, options }
  Promise.resolve().then(() => callback(null, remoteRaw, ''))
  return { stdin: { on: () => {}, end: value => { stdin = value } } }
}
const inspect = path => ({ mode: path.includes('known') ? 0o100444 : 0o100600,
  isFile: () => true, isSymbolicLink: () => false })
const carried = await runPolicyShadowSsh(requestRaw, { host: 'policy.example', identityFile: '/etc/waggle/policy-client/shadow_ed25519',
  knownHostsFile: '/etc/waggle/policy-client/known_hosts' }, exec, inspect)
ok('SSH sends the exact canonical request to the forced identity and returns its bytes', stdin === requestRaw && carried === remoteRaw)
ok('SSH pins host identity and disables ambient identities, commands, TTY, and forwarding',
  invocation.file === '/usr/bin/ssh' && invocation.args.includes('BatchMode=yes') && invocation.args.includes('IdentitiesOnly=yes') &&
  invocation.args.includes('StrictHostKeyChecking=yes') && invocation.args.includes('GlobalKnownHostsFile=/dev/null') &&
  invocation.args.includes('ClearAllForwardings=yes') && invocation.args[0] === '-F' && invocation.args[1] === '/dev/null' &&
  invocation.args.at(-1) === 'waggle-policy-shadow-ingress@policy.example' && !invocation.args.includes('--'))
await refuses('relative credential paths are refused before process creation', () => runPolicyShadowSsh(requestRaw,
  { host: 'policy.example', identityFile: 'shadow', knownHostsFile: '/known' }, exec, inspect), /configuration/)
await refuses('host strings cannot become SSH options', () => runPolicyShadowSsh(requestRaw,
  { host: '-oProxyCommand=evil', identityFile: '/shadow', knownHostsFile: '/known' }, exec, inspect), /configuration/)
await refuses('a group-readable forced-command key is refused before SSH', () => runPolicyShadowSsh(requestRaw,
  { host: 'policy.example', identityFile: '/shadow', knownHostsFile: '/known' }, exec,
  path => ({ mode: path === '/shadow' ? 0o100640 : 0o100444, isFile: () => true, isSymbolicLink: () => false })), /private regular/)
ok('request digest fixture is stable', remote.request_digest === createHash('sha256').update(requestRaw).digest('hex'))

console.log(fails ? `\nbuzz_policy_shadow_client: ${fails} FAILED` : '\nbuzz_policy_shadow_client: all checks passed')
process.exit(fails ? 1 : 0)

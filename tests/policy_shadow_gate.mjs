import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { generateSecretKey, finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import { schnorr } from '@noble/curves/secp256k1'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils'
import { canonicalJson } from '../src/buzz_policy_core.mjs'
import { createProjectionPolicy } from '../src/buzz_policy_projection.mjs'
import { deriveBuzzPolicyShadow } from '../src/buzz_policy_shadow.mjs'

if (!process.env.SHADOW_GATE_CASE) {
  let failed = false
  for (const mode of ['observe', 'enforce-shadow']) {
    const run = spawnSync(process.execPath, [new URL(import.meta.url).pathname], {
      encoding: 'utf8', env: { ...process.env, SHADOW_GATE_CASE: mode },
    })
    process.stdout.write(run.stdout); process.stderr.write(run.stderr)
    if (run.status !== 0) failed = true
  }
  process.exit(failed ? 1 : 0)
}

let fails = 0
const ok = (name, pass) => { console.log(`${pass ? 'ok  ' : 'FAIL'} — ${name}`); if (!pass) fails++ }
const mode = process.env.SHADOW_GATE_CASE
const tmp = mkdtempSync(join(tmpdir(), `waggle-shadow-${mode}-`))
const watched = 'd'.repeat(64), staging = 'a8186b53-537d-46ad-a7e7-b6486c58970e'
const inbox = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', catalogue = 'c'.repeat(64)
const posterSk = generateSecretKey(), poster = getPublicKey(posterSk)
const ownerSk = generateSecretKey(), owner = getPublicKey(ownerSk), conditions = ''
const authSig = bytesToHex(schnorr.sign(sha256(utf8ToBytes(`nostr:agent-auth:${poster}:${conditions}`)), ownerSk))
const authTag = ['auth', owner, conditions, authSig]
const policy = createProjectionPolicy({ posterPubkey: poster, authTag })
const config = { relays: [], recipients: [], public: {
  relays: [], inbox, staging_inbox: staging, watch_authors: [], watch_events: [watched],
  approver_mention: 'jafairweather', approvers: [], policy_shadow: {
    mode, policy_instance: 'jaf-hive', catalogue_version: catalogue, poster_pubkey: poster,
    auth_tag: authTag, ssh_host: 'policy.example', ssh_user: 'waggle-policy-shadow-ingress',
    ssh_identity_file: '/etc/waggle/policy-client/shadow_ed25519',
    ssh_known_hosts_file: '/etc/waggle/policy-client/known_hosts',
  },
} }
writeFileSync(join(tmp, 'config.json'), JSON.stringify(config))
process.env.WB_NO_BOOT = '1'
process.env.WB_STUB_SEND = '1'
process.env.FORWARD_MODE = 'buzz'
process.env.CONFIG_PATH = join(tmp, 'config.json')
process.env.SEEN_PATH = join(tmp, 'seen.log')
process.env.PUB_WATERMARK_PATH = join(tmp, 'watermark')
process.env.UNDELIVERED_PATH = join(tmp, 'undelivered.log')
process.env.BUZZ_PRIVATE_KEY = Buffer.from(generateSecretKey()).toString('hex')

const { routePublic, seen, postedMap, shadowInFlight, __setShadowRunnerForTests } = await import('../src/bridge.mjs')
const note = content => JSON.parse(JSON.stringify(finalizeEvent({ kind: 1, created_at: Math.floor(Date.now() / 1000),
  tags: [['e', watched]], content }, generateSecretKey())))
const wait = async () => { for (let i = 0; i < 100 && shadowInFlight.size; i++) await new Promise(resolve => setTimeout(resolve, 5)) }
let calls = 0
__setShadowRunnerForTests(async raw => {
  calls++
  await new Promise(resolve => setTimeout(resolve, 10))
  const derived = deriveBuzzPolicyShadow(raw, { policyInstance: 'jaf-hive', catalogueVersion: catalogue,
    stagingChannel: staging, watchedEventIds: [watched], approverMention: 'jafairweather', projectionPolicy: policy })
  return `${canonicalJson({ ...derived, unsigned_event_sha256: 'f'.repeat(64) })}\n`
})
const mismatch = note(`mismatch-${mode}`)
routePublic(mismatch); routePublic(mismatch)
await wait()
ok(`${mode}: one in-flight claim collapses duplicate relay delivery`, calls === 1)
if (mode === 'observe') {
  ok('observe: mismatch is loud but preserves local quarantine delivery', seen.has(mismatch.id) && postedMap.has(mismatch.id))
} else {
  ok('enforce-shadow: mismatch remains owed and never reaches local delivery', !seen.has(mismatch.id) && !postedMap.has(mismatch.id))
  __setShadowRunnerForTests(async raw => `${canonicalJson(deriveBuzzPolicyShadow(raw, { policyInstance: 'jaf-hive',
    catalogueVersion: catalogue, stagingChannel: staging, watchedEventIds: [watched],
    approverMention: 'jafairweather', projectionPolicy: policy }))}\n`)
  const matching = note('matching-enforce')
  routePublic(matching); await wait()
  ok('enforce-shadow: exact decision+digest match crosses commit-before-dispatch once', seen.has(matching.id) && postedMap.has(matching.id))
}

console.log(fails ? `\npolicy_shadow_gate[${mode}]: ${fails} FAILED` : `\npolicy_shadow_gate[${mode}]: all checks passed`)
process.exit(fails ? 1 : 0)

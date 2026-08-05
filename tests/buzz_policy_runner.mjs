import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateSecretKey, finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import { schnorr } from '@noble/curves/secp256k1'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { canonicalJson } from '../src/buzz_policy_core.mjs'
import { PolicyJournal } from '../src/policy_journal.mjs'
import { loadBuzzPolicyConfig, readBoundedPolicyRequest, runBuzzPolicyOrphanResolution, runBuzzPolicyRequest } from '../src/buzz_policy_runner.mjs'

let fails = 0
const t = (name, ok) => { console.log(`${ok ? 'ok  ' : 'FAIL'} — ${name}`); if (!ok) fails++ }
const rejects = async (name, fn, pattern) => { try { await fn(); t(name, false) } catch (e) { t(name, pattern.test(e.message)) } }
const root = mkdtempSync(join(tmpdir(), 'waggle-policy-runner-')), now = 2_000_000_000
const posterSk = generateSecretKey(), poster = getPublicKey(posterSk), ownerSk = generateSecretKey(), owner = getPublicKey(ownerSk)
const signature = bytesToHex(schnorr.sign(sha256(utf8ToBytes(`nostr:agent-auth:${poster}:`)), ownerSk))
const recoveryPath = join(root, 'recovery.secret')
writeFileSync(recoveryPath, 'recovery_secret_0123456789abcdef\n', { mode: 0o600 })
const configValue = { version: 1, policy_instance: 'jaf-hive', catalogue_version: 'c'.repeat(64),
  staging_channel: 'a8186b53-537d-46ad-a7e7-b6486c58970e', watched_event_ids: ['d'.repeat(64)], approver_mention: '',
  poster_pubkey: poster, auth_tag: ['auth', owner, '', signature], endpoint: 'https://hive.example/events',
  journal_path: join(root, 'journal'), recovery_secret_file: recoveryPath }
const configPath = join(root, 'policy.json')
writeFileSync(configPath, `${JSON.stringify(configValue)}\n`, { mode: 0o600 })
const config = loadBuzzPolicyConfig(configPath)
t('a mode-0600 fixed config creates an internal artifact policy', config.policy_instance === 'jaf-hive' && config.artifactPolicy.posterPubkey === poster)
t('the policy-host recovery secret is loaded only from its private file', config.recoverySecret === 'recovery_secret_0123456789abcdef')

const source = JSON.parse(JSON.stringify(finalizeEvent({ kind: 1, created_at: now - 1, tags: [['e', 'd'.repeat(64)]], content: 'wisdom' }, generateSecretKey())))
const raw = canonicalJson({ version: 1, policy_instance: 'jaf-hive', operation: 'quarantine_header', catalogue_version: 'c'.repeat(64), observed_at: now, evidence: { source_event: source } })
const signer = { pubkey: poster, signEvent: async event => finalizeEvent(event, posterSk) }
const output = await runBuzzPolicyRequest(raw, config, signer, { now, nonce: () => 'nonce_0123456789',
  fetchImpl: async (_url, request) => { const bytes = Buffer.from(JSON.stringify({ event_id: JSON.parse(request.body).id, accepted: true, message: '' })); return {
    status: 200, headers: { get: () => String(bytes.length) }, body: null,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } } })
const result = JSON.parse(output)
t('the forced-command adapter emits one canonical receipt result', output === `${canonicalJson(result)}\n` && result.status === 'terminal' && JSON.parse(result.receipt).kind === 30078)
t('the forced-command result never exposes the recovery secret', !output.includes(config.recoverySecret))
await rejects('the configured poster cannot differ from the Bunker identity', () => runBuzzPolicyRequest(raw, config, { ...signer, pubkey: 'f'.repeat(64) }), /does not match/)

const orphanSource = JSON.parse(JSON.stringify(finalizeEvent({ kind: 1, created_at: now - 2, tags: [['e', 'd'.repeat(64)]], content: 'other wisdom' }, generateSecretKey())))
const orphanRaw = canonicalJson({ version: 1, policy_instance: 'jaf-hive', operation: 'quarantine_header', catalogue_version: 'c'.repeat(64), observed_at: now, evidence: { source_event: orphanSource } })
const orphanKey = createHash('sha256').update(canonicalJson([1, 'jaf-hive', 'c'.repeat(64), 'quarantine_header', [orphanSource.id], config.staging_channel])).digest('hex')
const orphanJournal = new PolicyJournal(join(root, 'orphan-journal'), { recoverySecret: config.recoverySecret })
orphanJournal.claim(orphanKey, createHash('sha256').update(orphanRaw).digest('hex'), now)
const orphanOutput = await runBuzzPolicyOrphanResolution(orphanRaw, now, config, signer, { journal: orphanJournal, now: now + 3600 })
const orphanResult = JSON.parse(orphanOutput)
t('the local operator adapter emits only a signed ambiguous receipt', orphanResult.result === 'ambiguous' && JSON.parse(orphanResult.receipt).kind === 30078 && !orphanOutput.includes(config.recoverySecret))

const world = join(root, 'world.json'); writeFileSync(world, '{}\n', { mode: 0o600 }); chmodSync(world, 0o644)
await rejects('group/world-readable config is refused', () => loadBuzzPolicyConfig(world), /private regular file/)
const link = join(root, 'link.json'); symlinkSync(configPath, link)
await rejects('a symlinked config is refused', () => loadBuzzPolicyConfig(link), /non-symlink/)
await rejects('unknown config fields are refused', () => { const p = join(root, 'wide.json'); writeFileSync(p, JSON.stringify({ ...configValue, command: 'anything' }), { mode: 0o600 }); return loadBuzzPolicyConfig(p) }, /invalid shape/)
const openSecret = join(root, 'open.secret'); writeFileSync(openSecret, 'recovery_secret_0123456789abcdef\n', { mode: 0o644 })
await rejects('a world-readable recovery secret is refused', () => { const p = join(root, 'open-secret.json'); writeFileSync(p, JSON.stringify({ ...configValue, recovery_secret_file: openSecret }), { mode: 0o600 }); return loadBuzzPolicyConfig(p) }, /bounded private regular file/)

const stream = async function * () { yield Buffer.from(raw.slice(0, 20)); yield Buffer.from(raw.slice(20)) }
t('bounded stdin preserves exact canonical bytes', await readBoundedPolicyRequest(stream()) === raw)
const tooLarge = async function * () { yield Buffer.alloc(128 * 1024); yield Buffer.from('x') }
await rejects('stdin is refused immediately above the hard cap', () => readBoundedPolicyRequest(tooLarge()), /exceeds/)
const invalidUtf8 = async function * () { yield Buffer.from([0xc3, 0x28]) }
await rejects('invalid UTF-8 cannot cross the canonical boundary', () => readBoundedPolicyRequest(invalidUtf8()), /UTF-8/)
const widened = spawnSync(process.execPath, ['tools/buzz-policy-service.mjs', '--endpoint', 'https://evil.example/events'], { cwd: process.cwd(), encoding: 'utf8' })
t('the forced command rejects every caller-selected argument before configuration', widened.status === 2 && /arguments are not accepted/.test(widened.stderr))

rmSync(root, { recursive: true, force: true })
console.log(fails ? `\nbuzz_policy_runner: ${fails} FAILED` : '\nbuzz_policy_runner: all checks passed')
process.exit(fails ? 1 : 0)

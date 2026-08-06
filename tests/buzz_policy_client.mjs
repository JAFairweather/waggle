import { createHash } from 'node:crypto'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { canonicalJson } from '../src/buzz_policy_core.mjs'
import { buildQuarantinePolicyRequest, verifyPolicyResponse, validatePolicyWriterConfig } from '../src/buzz_policy_client.mjs'

let fails = 0
const ok = (name, cond) => { console.log(`${cond ? 'ok  ' : 'FAIL'} — ${name}`); if (!cond) fails++ }
const refuses = (name, fn) => { let rejected = false; try { fn() } catch { rejected = true }; ok(name, rejected) }
const wire = value => JSON.parse(JSON.stringify(value))
const signer = generateSecretKey(), poster = getPublicKey(signer)
const source = wire(finalizeEvent({ kind: 1, created_at: 1000, tags: [['e', 'e'.repeat(64)]], content: 'public source' }, generateSecretKey()))
const policy = 'jaf-hive', catalogue = 'c'.repeat(64), channel = 'a8186b53-537d-46ad-a7e7-b6486c58970e', endpoint = 'buzz.example'
const requestRaw = buildQuarantinePolicyRequest(source, { policyInstance: policy, catalogueVersion: catalogue, observedAt: 1010 })
const requestDigest = createHash('sha256').update(requestRaw).digest('hex')
const key = createHash('sha256').update(canonicalJson([1, policy, catalogue, 'quarantine_header', [source.id], channel])).digest('hex')
const fields = Object.freeze({ version: 1, policy_instance: policy, operation: 'quarantine_header', catalogue_version: catalogue,
  request_digest: requestDigest, idempotency_key: key, source_ids: [source.id], buzz_channel: channel,
  endpoint_authority: endpoint, buzz_event_id: 'b'.repeat(64), result: 'accepted', reason_code: 'accepted',
  response_digest: 'd'.repeat(64), completed_at: 1020 })
const receipt = wire(finalizeEvent({ kind: 30078, created_at: 1020, tags: [['d', `waggle-policy:${key}`]], content: canonicalJson(fields) }, signer))
const response = canonicalJson({ status: 'terminal', result: 'accepted', receipt: canonicalJson(receipt) })
const expected = { requestRaw, posterPubkey: poster, expectedChannel: channel, endpointAuthority: endpoint }
const writerConfig = { mode: 'remote-only', policyInstance: policy, catalogueVersion: catalogue,
  posterPubkey: poster, endpointAuthority: endpoint, host: 'policy.example', user: 'waggle-policy-ingress',
  identityFile: '/etc/waggle/writer', knownHostsFile: '/etc/waggle/known_hosts' }
ok('a closed remote-only writer configuration is accepted', validatePolicyWriterConfig(writerConfig) === writerConfig)
refuses('a relative writer identity path is refused at startup', () => validatePolicyWriterConfig({ ...writerConfig, identityFile: 'writer' }))
refuses('an SSH-option-shaped writer host is refused at startup', () => validatePolicyWriterConfig({ ...writerConfig, host: '-oProxyCommand=evil' }))

const accepted = verifyPolicyResponse(response, expected)
ok('an exact signed receipt closes the exact request', accepted.terminal && accepted.result === 'accepted' && accepted.buzzEventId === 'b'.repeat(64))
ok('a held response remains owed and carries no authority claim', !verifyPolicyResponse(canonicalJson({ status: 'held', result: null, receipt: null }), expected).terminal)
refuses('the bridge cannot construct a request around tampered source evidence', () => buildQuarantinePolicyRequest({ ...source, content: 'changed after signing' }, { policyInstance: policy, catalogueVersion: catalogue, observedAt: 1010 }))
refuses('a response cannot bless a request with caller-added authority', () => verifyPolicyResponse(response, { ...expected,
  requestRaw: canonicalJson({ ...JSON.parse(requestRaw), approved: true }),
}))
refuses('a response cannot bless malformed source evidence', () => verifyPolicyResponse(response, { ...expected,
  requestRaw: canonicalJson({ ...JSON.parse(requestRaw), evidence: { source_event: { ...source, content: 'changed after signing' } } }),
}))
refuses('non-canonical response bytes are refused', () => verifyPolicyResponse(JSON.stringify(JSON.parse(response), null, 2), expected))
refuses('unknown response fields are refused', () => verifyPolicyResponse(canonicalJson({ ...JSON.parse(response), event: receipt }), expected))
refuses('a non-terminal response cannot smuggle a receipt', () => verifyPolicyResponse(canonicalJson({ status: 'held', result: null, receipt: canonicalJson(receipt) }), expected))
const mutateFields = change => {
  const next = { ...fields, ...change }
  const signed = wire(finalizeEvent({ kind: 30078, created_at: next.completed_at, tags: [['d', `waggle-policy:${next.idempotency_key}`]], content: canonicalJson(next) }, signer))
  return canonicalJson({ status: 'terminal', result: next.result, receipt: canonicalJson(signed) })
}
refuses('a validly signed receipt for another request digest is refused', () => verifyPolicyResponse(mutateFields({ request_digest: '0'.repeat(64) }), expected))
refuses('a validly signed receipt for another destination is refused', () => verifyPolicyResponse(mutateFields({ buzz_channel: 'ffffffff-ffff-ffff-ffff-ffffffffffff' }), expected))
refuses('a validly signed receipt for another source is refused', () => verifyPolicyResponse(mutateFields({ source_ids: ['f'.repeat(64)] }), expected))
refuses('a validly signed receipt with another idempotency key is refused', () => verifyPolicyResponse(mutateFields({ idempotency_key: '1'.repeat(64) }), expected))
refuses('a receipt from another valid signer is refused', () => {
  const foreign = wire(finalizeEvent({ kind: 30078, created_at: 1020, tags: receipt.tags, content: receipt.content }, generateSecretKey()))
  verifyPolicyResponse(canonicalJson({ status: 'terminal', result: 'accepted', receipt: canonicalJson(foreign) }), expected)
})
refuses('a forged receipt signature is refused', () => {
  const forged = { ...receipt, sig: `${receipt.sig[0] === '0' ? '1' : '0'}${receipt.sig.slice(1)}` }
  verifyPolicyResponse(canonicalJson({ status: 'terminal', result: 'accepted', receipt: canonicalJson(forged) }), expected)
})
refuses('an accepted result cannot carry an ambiguous reason', () => verifyPolicyResponse(mutateFields({ reason_code: 'signing_outcome_unknown' }), expected))
refuses('the receipt d-tag cannot point at another transaction', () => {
  const shifted = wire(finalizeEvent({ kind: 30078, created_at: 1020, tags: [['d', `waggle-policy:${'2'.repeat(64)}`]], content: receipt.content }, signer))
  verifyPolicyResponse(canonicalJson({ status: 'terminal', result: 'accepted', receipt: canonicalJson(shifted) }), expected)
})

console.log(fails ? `\nbuzz_policy_client: ${fails} FAILED` : '\nbuzz_policy_client: all checks passed')
process.exit(fails ? 1 : 0)

#!/usr/bin/env node
// mint-auth-tag.mjs — compute a NIP-OA owner auth tag locally (the JS port of buzz-sdk's
// nip_oa::compute_auth_tag). Runs entirely on your machine; your nsec never leaves it.
//
// The auth tag is ["auth", <owner_pubkey>, <conditions>, <sig>] where
//   sig = BIP-340 schnorr( owner_key , sha256("nostr:agent-auth:" + agent_pubkey + ":" + conditions) )
// It's the OWNER vouching for an agent. The output is PUBLIC (it rides on every event the
// agent signs); only the signing here needs the owner's private key.
//
//   OWNER_NSEC=nsec1…|hex  AGENT_PUBKEY=<agent npub|hex>  [CONDITIONS=""]  node tools/mint-auth-tag.mjs
//
// AGENT_PUBKEY defaults to waggle's pubkey. CONDITIONS defaults to "" (no kind restriction —
// matches how buzz-relay itself mints them, and lets the bridge post kind:9 sends, kind:5
// deletes, and edits under one tag). Prints ONLY the tag JSON to stdout.

import { schnorr } from '@noble/curves/secp256k1'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils'
import * as nip19 from 'nostr-tools/nip19'

const die = (m) => { console.error(`mint-auth-tag: ${m}`); process.exit(1) }
const toHex = (s) => s.startsWith('npub1') || s.startsWith('nsec1') ? nip19.decode(s).data : s.toLowerCase()

const rawOwner = process.env.OWNER_NSEC || die('set OWNER_NSEC (the owner identity nsec — signs the attestation)')
const ownerSk = rawOwner.startsWith('nsec1') ? nip19.decode(rawOwner).data : hexToBytes(rawOwner)
const ownerPk = bytesToHex(schnorr.getPublicKey(ownerSk)) // x-only, matches nostr pubkey

const agentRaw = process.env.AGENT_PUBKEY || 'npub1s36nypljc6h88tey0kshf688eyd8myu636ctfs4e3d2w54nhsmnqfhaent' // waggle
let agentHex
try { agentHex = typeof toHex(agentRaw) === 'string' ? toHex(agentRaw) : bytesToHex(toHex(agentRaw)) } catch { die('bad AGENT_PUBKEY') }
if (typeof agentHex !== 'string') agentHex = bytesToHex(agentHex)

const conditions = process.env.CONDITIONS ?? ''
if (ownerPk === agentHex) die('owner and agent pubkeys must differ (self-attestation rejected)')

const preimage = `nostr:agent-auth:${agentHex}:${conditions}`
const msg = sha256(utf8ToBytes(preimage))
const sig = bytesToHex(schnorr.sign(msg, ownerSk))

// Self-verify before emitting — never hand out a tag that doesn't check out.
if (!schnorr.verify(sig, msg, ownerPk)) die('internal error: produced signature failed self-verify')

console.log(JSON.stringify(['auth', ownerPk, conditions, sig]))

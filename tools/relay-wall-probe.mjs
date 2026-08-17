#!/usr/bin/env node
// relay-wall-probe — is the community relay still refusing keys it does not know? (#447)
//
// waggle's routing model rests on one relay-side refusal: an external key cannot pass NIP-42 AUTH,
// so it cannot read the community. That refusal is `BUZZ_REQUIRE_RELAY_MEMBERSHIP` — an env var on
// infrastructure waggle does not own, defaulting to false, compared with an exact case-sensitive
// string match. `TRUE` yields an OPEN relay whose configuration reads closed, and the boot
// interlock that catches a half-configured closed relay never fires, because the bool already
// parsed false. Nothing in waggle observes this. If it goes off, every gate still reports healthy.
//
// This watches the BEHAVIOUR, not the configuration — the config is the string that can lie, and
// reading it needs host access we do not have off-box.
//
//   BUZZ_RELAY_URL=wss://… WALL_CONTROL_NSEC_FILE=/path node tools/relay-wall-probe.mjs
//
// Exit codes, matching tripwire.mjs and deploy/verify-firewall.sh:
//   0  intact       — the no-grant key was refused AND the control key was admitted
//   2  BREACH       — a key with no grant authenticated. The wall is not enforcing.
//   3  INCONCLUSIVE — could not see enough to judge. NOT the same as fine.
//   1  usage/config error
//
// WHY THE CONTROL KEY IS MANDATORY. "The relay refused me" is the same observation whether the wall
// is up, the relay is down, the URL is wrong, or the probe never ran. Without a key that SHOULD be
// admitted proving the relay can still say yes, a refusal proves nothing — and this becomes an
// alarm that has only ever passed, which is indistinguishable from one that never fires. Running
// without it is exit 3, never exit 0.

import WebSocket from '../src/ws_runtime.mjs'
import { appendFileSync, mkdirSync, readFileSync, lstatSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure'
import * as nip19 from 'nostr-tools/nip19'
import { credentialModeIsPrivate } from '../src/credential_file.mjs'
import { buildAuthEvent, classifyAuthReply, wallVerdict, OBSERVED } from '../src/relay_wall.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const arg = (n, d) => { const i = process.argv.indexOf(n); return i === -1 ? d : process.argv[i + 1] }
const die = (m) => { console.error(`relay-wall-probe: ${m}`); process.exit(1) }
const TIMEOUT_MS = Number(arg('--timeout-ms', 8000))

// --- the relay under test -----------------------------------------------------------------------
// Validated before any credential is read. A malformed target must not be able to trigger secret
// access, and a URL carrying userinfo or a query string is not something we should be dialling.
const RELAY = (() => {
  const raw = String(arg('--relay', process.env.BUZZ_RELAY_URL) || '').trim()
  if (!raw) die('BUZZ_RELAY_URL (or --relay) is required — the community relay to probe')
  let u
  try { u = new URL(raw) } catch { die('BUZZ_RELAY_URL is not a URL') }
  if (!['ws:', 'wss:'].includes(u.protocol)) die('BUZZ_RELAY_URL must be ws:// or wss://')
  if (u.username || u.password || u.search || u.hash) die('BUZZ_RELAY_URL must be credential-free')
  return u.toString()
})()

// --- credentials ----------------------------------------------------------------------------
// Mirrors tools/tripwire.mjs deliberately, including the both-set migration guard. NOTE: that makes
// two copies of this loader in tools/; extracting it is a follow-up, not a silent widening here.
function credential (name) {
  const direct = String(process.env[name] || '').trim()
  const path = String(process.env[`${name}_FILE`] || '').trim()
  if (direct && path) die(`${name} and ${name}_FILE are both set — remove the legacy environment secret`)
  if (!path) return direct
  let st
  try { st = lstatSync(path) } catch (e) { die(`${name}_FILE cannot be read: ${e.message}`) }
  if (!st.isFile() || st.isSymbolicLink()) die(`${name}_FILE must be a regular non-symlink file`)
  if (!credentialModeIsPrivate(path, st)) die(`${name}_FILE must not be group/world accessible outside systemd's protected credential mount`)
  if (st.size < 1 || st.size > 512) die(`${name}_FILE has an invalid size`)
  try { return readFileSync(path, 'utf8').trim() } catch (e) { die(`${name}_FILE cannot be read: ${e.message}`) }
}

const toSecret = (raw, label) => {
  const s = String(raw || '').trim()
  if (!s) return null
  try {
    if (s.startsWith('nsec1')) {
      const d = nip19.decode(s)
      if (d.type !== 'nsec') throw new Error('not an nsec')
      return d.data
    }
    if (/^[0-9a-f]{64}$/i.test(s)) return Uint8Array.from(Buffer.from(s, 'hex'))
  } catch { /* fall through to the single message below */ }
  die(`${label} is not a valid nsec or 64-hex secret key`)
}

// The control key. Its only job is to prove the relay can still say yes.
const CONTROL = toSecret(credential('WALL_CONTROL_NSEC'), 'WALL_CONTROL_NSEC')

// The key that MUST be refused. Generated here and discarded when the process exits — it is never
// written, never seated, never granted. This answers the "who mints it and how does it avoid
// accumulating a grant" question by construction: a key that exists for the length of one probe
// cannot acquire a relay_members row, and there is no file for anyone to seat one against later.
const STRANGER = generateSecretKey()

// --- one NIP-42 attempt on its own connection ----------------------------------------------------
// AUTH is per-connection, so each key gets its own socket. Sharing one would let the first key's
// authentication state answer for the second.
function attemptAuth (secret, label) {
  return new Promise((resolve_) => {
    const frames = []
    let sawChallenge = false, authEventId = null, settled = false
    let ws
    const finish = (observed, detail) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { ws && ws.close() } catch { /* closing a dead socket is not a finding */ }
      resolve_({ observed, detail, label })
    }
    const timer = setTimeout(() => finish(OBSERVED.timedOut, `no verdict within ${TIMEOUT_MS}ms`), TIMEOUT_MS)

    try { ws = new WebSocket(RELAY) } catch (e) { return finish(OBSERVED.unreachable, e.message) }
    ws.on('error', (e) => finish(OBSERVED.unreachable, e.message))
    ws.on('close', () => {
      // A socket that closes before answering is not a refusal. Reporting it as one is exactly how
      // this alarm would start passing forever.
      if (!sawChallenge) return finish(OBSERVED.noChallenge, 'connection closed before any AUTH challenge')
      const r = classifyAuthReply({ frames, eventId: authEventId, sawChallenge })
      finish(r.observed, r.detail)
    })
    ws.on('message', (data) => {
      let m
      try { m = JSON.parse(data.toString()) } catch { return }
      frames.push(m)
      if (m[0] === 'AUTH' && typeof m[1] === 'string') {
        sawChallenge = true
        try {
          const signed = finalizeEvent(buildAuthEvent({
            relayUrl: RELAY, challenge: m[1], created_at: Math.floor(Date.now() / 1000),
          }), secret)
          authEventId = signed.id
          ws.send(JSON.stringify(['AUTH', signed]))
        } catch (e) { return finish(OBSERVED.error, `could not sign the AUTH response: ${e.message}`) }
        return
      }
      if (m[0] === 'OK' && m[1] === authEventId) {
        const r = classifyAuthReply({ frames, eventId: authEventId, sawChallenge })
        return finish(r.observed, r.detail)
      }
    })
  })
}

// --- run both probes ------------------------------------------------------------------------
const strangerPub = getPublicKey(STRANGER)
console.error(`relay-wall-probe: probing ${RELAY}`)
console.error(`relay-wall-probe: must-be-refused key ${strangerPub.slice(0, 12)}… (ephemeral, never seated)`)

const mustBeRefused = await attemptAuth(STRANGER, 'must-be-refused')
let mustBeAdmitted = null
if (CONTROL) {
  console.error(`relay-wall-probe: control key ${getPublicKey(CONTROL).slice(0, 12)}… (must be admitted)`)
  mustBeAdmitted = await attemptAuth(CONTROL, 'control')
} else {
  console.error('relay-wall-probe: ⚠ no WALL_CONTROL_NSEC configured — this run cannot reach a verdict of intact')
}

const verdict = wallVerdict({ mustBeRefused, mustBeAdmitted })

// --- report -----------------------------------------------------------------------------------
const line = JSON.stringify({
  at: new Date().toISOString(),
  relay: RELAY,
  state: verdict.state,
  exitCode: verdict.exitCode,
  mustBeRefused: { observed: mustBeRefused.observed, detail: mustBeRefused.detail || '' },
  mustBeAdmitted: mustBeAdmitted ? { observed: mustBeAdmitted.observed, detail: mustBeAdmitted.detail || '' } : null,
  reason: verdict.reason,
})
try {
  mkdirSync(join(ROOT, 'data'), { recursive: true })
  appendFileSync(join(ROOT, 'data', 'relay-wall.log'), line + '\n')
} catch (e) { console.error(`relay-wall-probe: could not append the log: ${e.message}`) }

if (verdict.state === 'breach') {
  console.error('')
  console.error('🚨 RELAY MEMBERSHIP WALL IS NOT ENFORCING')
  console.error(`   ${verdict.reason}`)
  console.error('   Check BUZZ_REQUIRE_RELAY_MEMBERSHIP on the community relay. The comparison is')
  console.error('   case-sensitive: TRUE, True, yes and on all parse as false.')
} else if (verdict.state === 'inconclusive') {
  console.error(`relay-wall-probe: INCONCLUSIVE — ${verdict.reason}`)
  if (verdict.needsHuman) console.error('relay-wall-probe: ⚠ this one needs a human, not a retry.')
} else {
  console.log(`relay-wall-probe: OK — ${verdict.reason}`)
}

process.exit(verdict.exitCode)

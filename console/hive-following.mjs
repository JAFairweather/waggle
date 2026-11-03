// hive-following.mjs — the public writers whose posts enter the hive (#649).
//
// The owner chooses them and nothing else gates them: no consent, no lanes, no quarantine. A change
// is one signed command to the waggle bridge, the same narrow watchlist command the old Following
// page sent (`d` waggle-watchlist, `p` the bridge, content {v, action, target}). The bridge checks the
// signer is an approver, saves the list, and republishes its state.
//
// "Done" is the bridge's next published state showing the change, read back cold. A relay's OK is
// only "sent".

import { controlStateFresh, requireFreshControlState } from './control-state-freshness.mjs'
import { sameAsDrafted, publishTo, relayHost } from './hive-change.mjs'

export const WATCHLIST_D = 'waggle-watchlist'
const HEX64 = /^[0-9a-f]{64}$/
const BECH32 = /\b(npub1[02-9ac-hj-np-z]{58}|nprofile1[02-9ac-hj-np-z]+)\b/i

// Who the bridge's state says the hive follows, in a stable order.
export const followsOf = state => [...new Set((state?.follows || []).map(f => String(f?.pubkey || '')).filter(pk => HEX64.test(pk)))].sort()

// A writer from what the owner pasted: an npub, an nprofile, a 64-character key, or a profile link
// that contains one of those. `decode` is nip19.decode.
export function writerKey(text, decode) {
  const raw = String(text || '').trim()
  if (/nsec1|ncryptsec1|bunker:/i.test(raw)) throw new Error('That is a private key or a Bunker link, not a writer. Nothing was sent. Paste their npub or profile link.')
  if (HEX64.test(raw.toLowerCase())) return raw.toLowerCase()
  const found = raw.match(BECH32)?.[1]
  if (!found) throw new Error('Paste their npub, or a link to their profile.')
  let out
  try { out = decode(found.toLowerCase()) } catch { throw new Error('That npub does not decode. Check it was copied in full.') }
  const pk = out?.type === 'npub' ? out.data : out?.type === 'nprofile' ? out.data?.pubkey : null
  if (!HEX64.test(pk || '')) throw new Error('That is not a writer\'s public key.')
  return pk
}

export function draftFollow({ bridge, target, follow, now = Math.floor(Date.now() / 1000) }) {
  if (!HEX64.test(bridge || '')) throw new Error('The waggle bridge key is not set in this browser.')
  if (!HEX64.test(target || '')) throw new Error('That is not a writer\'s public key.')
  return { kind: 30078, created_at: now, tags: [['d', WATCHLIST_D], ['p', bridge]],
    content: JSON.stringify({ v: 1, action: follow ? 'mirror' : 'unmirror', target }) }
}

// Done when a state newer than the one the change was drafted against shows it.
// Only a fresh state counts: one dated far ahead could otherwise read as "done" before the bridge has seen the change.
export function followVerdict(template, before, after, now = Math.floor(Date.now() / 1000)) {
  const { action, target } = JSON.parse(template.content)
  const want = action === 'mirror'
  const newer = after.filter(s => controlStateFresh(s?.observed_at, now) && s.observed_at > before.observed_at)
  const done = newer.some(s => followsOf(s).includes(target) === want)
  return { done, text: done ? (want ? 'Done. The hive now follows them.' : 'Done. The hive no longer follows them.')
    : newer.length ? 'Not done. The bridge published its state after the change, and it does not show it. It may have refused it.'
      : 'Not shown yet. The bridge has not published a newer state. Read the hive again in a minute.' }
}

// Sign, check it is the command drafted, publish, then wait for the bridge's next state.
export async function applyFollow(template, { sign, owner, verify, connect, before, readStates, relays, timeoutMs, waitMs = 45000, pollMs = 3000, sleep = ms => new Promise(r => setTimeout(r, ms)), onStep = () => {} }) {
  requireFreshControlState(before)
  onStep('waiting for your signer')
  const signed = await sign(template)
  let valid = false
  try { valid = verify(signed) } catch {}
  if (!valid || !sameAsDrafted(signed, template)) throw new Error('The signer returned an event that is not the one shown. Nothing was published.')
  if (signed.pubkey !== owner) throw new Error('Your signer signed with a different key from the one this page read the hive as. Nothing was published.')
  onStep('publishing')
  const published = await publishTo(signed, { relays, connect, timeoutMs })
  const accepted = published.filter(p => p.outcome === 'accepted')
  if (!accepted.length) throw new Error('No relay accepted the change. Nothing changed.')
  onStep("waiting for the bridge to confirm")
  let verdict = followVerdict(template, before, [])
  for (let waited = 0; waited < waitMs; waited += pollMs) {
    await sleep(pollMs)
    verdict = followVerdict(template, before, await readStates())
    if (verdict.done) break
  }
  return { signed, verdict, text: `${verdict.text} ${accepted.length} of ${relays.length} relays accepted it (${accepted.map(p => relayHost(p.url)).join(', ')}).` }
}

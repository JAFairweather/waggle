// Pure quarantine catalogue projection shared by the local egress catalogue and the off-box
// policy shadow. No transport, credential, signer, journal, endpoint, or ambient configuration.
import { renderQuarantined } from './render.mjs'

import { WHY_VALUES } from './lanes.mjs'   // the trust gradient's one source (#282)
const REASONS = new Set(WHY_VALUES)
const fail = message => { throw new Error(`quarantine-projection: ${message}`) }
const handle = value => {
  if (!value) return ''
  const out = String(value).replace(/[`\r\n]/g, '').replace(/[@[\]()*~]/g, '').trim().slice(0, 64)
  if (!out) fail('approver is empty after sanitising')
  return out
}
const displayName = value => String(value || '').replace(/[`@[\]()\n\r*_~]/g, '').trim().slice(0, 32)
const iso = value => {
  const seconds = Number(value)
  if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > 8_640_000_000_000) fail('timestamp is outside the renderable range')
  return new Date(seconds * 1000).toISOString()
}

export function renderQuarantineHeader({ body, approver, name, npub, ts, claimedTs, why, id } = {}) {
  if (typeof body !== 'string' || !/^(npub1[0-9a-z]{20,90}|[0-9a-f]{64})$/i.test(String(npub || '')) ||
      !/^[0-9a-f]{64}$/.test(String(id || '')) || !REASONS.has(why)) fail('slots are invalid')
  const mention = handle(approver)
  return renderQuarantined({ body, mention: mention ? `@${mention} ` : '', name: displayName(name), npub,
    when: iso(ts), claim: claimedTs ? `  ·  ⚠︎ author-claimed \`${iso(claimedTs)}\` (clamped)` : '', why, id })
}

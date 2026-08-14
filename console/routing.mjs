// The trust gradient, rendered from the bridge's own signed state.
//
// "Why didn't this person's reply show up?" was answerable only by reading `routePublic`.
// The bridge names five outcomes and publishes a public-safe summary of the config that
// decides them, so the question is answerable in a browser without host access.
//
// TWO RULES GOVERN THIS FILE.
//
// 1. THE LANE VOCABULARY IS NOT RESTATED HERE — it is a copy of `src/lanes.mjs`, and
//    `tests/lanes.mjs` fails if the two disagree. `src/` is Node and this page is served
//    from `console/` only, so a runtime import across that boundary is impossible; the
//    agreement is therefore pinned in CI rather than trusted to discipline. A routing view
//    that drifted from the classifier would drift in the worst direction: claiming the
//    bridge is safer than it is.
//
// 2. NEVER PRINT A NUMBER THE SIGNED STATE DID NOT CARRY. `no match` leaves no record by
//    design, so its count renders `—`. A zero there would claim knowledge of an unrecorded
//    event, which is the same defect as an inbox filing a receipt under "rejected".
//    Where membership is unpublished, the lane says so instead of showing an empty list.

import { verifyEvent, nip19 } from 'nostr-tools'
import { consoleSigner } from './signer-session.mjs'
import { stableControlSigner } from './stable-control-signer.mjs'
import { newestFreshControlState, requireFreshControlState } from './control-state-freshness.mjs'
import { loadBridgeKey, rememberBridgeKey } from './bridge-key-store.mjs'
import { CONSENT_STATES } from './consent-vocabulary.mjs'   // the one list, checked against src/ (#389)

const RELAYS = ['wss://nos.lol', 'wss://relay.primal.net', 'wss://relay.ditto.pub', 'wss://jskitty.com/nostr']
const $ = id => document.getElementById(id)
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const npub = h => nip19.npubEncode(h)
const hex = v => {
  const s = String(v || '').trim()
  if (/^npub1/i.test(s)) return nip19.decode(s).data
  if (/^[0-9a-f]{64}$/i.test(s)) return s.toLowerCase()
  throw Error('Enter one npub or a 64-character hex bridge key.')
}
const eventId = v => {
  const s = String(v || '').trim()
  if (/^note1/i.test(s)) {
    const decoded = nip19.decode(s)
    if (decoded.type === 'note' && /^[0-9a-f]{64}$/.test(decoded.data)) return decoded.data
  }
  if (/^[0-9a-f]{64}$/i.test(s)) return s.toLowerCase()
  throw Error('Enter one note1… or 64-character Nostr event ID.')
}
let activeBridge = null, activeState = null
const setModeration = enabled => { for (const button of document.querySelectorAll('.moderation')) button.disabled = !enabled }

import { LANE_VIEW, DROP_VIEW, laneModel, laneLabel } from './routing-model.mjs'

// ── relay read ────────────────────────────────────────────────────────────────
function query(url, filter, ms = 8000) {
  return new Promise(res => {
    let ws, done = false, answered = false; const out = []
    const fin = () => { if (done) return; done = true; try { ws.close() } catch {}; res({ out, answered }) }
    try { ws = new WebSocket(url) } catch { return fin() }
    const t = setTimeout(fin, ms)
    ws.onopen = () => ws.send(JSON.stringify(['REQ', 'routing', filter]))
    ws.onmessage = e => { try {
      const m = JSON.parse(e.data)
      if (m[0] === 'EVENT') out.push(m[2])
      if (m[0] === 'EOSE') { answered = true; clearTimeout(t); fin() }
      if (m[0] === 'CLOSED') { clearTimeout(t); fin() }
    } catch {} }
    ws.onerror = () => { clearTimeout(t); fin() }
  })
}

// Same validation shape the other console readers use, plus the forward-skew clamp: a
// future-dated event must not read as fresh (the other two pages omit this — waggle#285).
function validState(ev, bridge) {
  try {
    if (!verifyEvent(ev) || ev.kind !== 30078 || ev.pubkey !== bridge ||
        !ev.tags.some(t => t[0] === 'd' && t[1] === 'waggle-control-state')) return null
    const s = JSON.parse(ev.content)
    if (s.v !== 1 || s.bridge !== bridge || !s.hive || !Array.isArray(s.follows) ||
        !Number.isFinite(s.observed_at)) return null
    const now = Math.floor(Date.now() / 1000)
    if (s.observed_at > now + 60) return null
    for (const f of s.follows) {
      if (!/^[0-9a-f]{64}$/.test(f.pubkey) || !CONSENT_STATES.includes(f.consent)) return null
    }
    return s
  } catch { return null }
}

// ── render ────────────────────────────────────────────────────────────────────
const CONSENT_CLASS = { active: 'good', asked: 'warn', pending: 'unk', revoked: 'crit' }

function laneHtml(view, tier, { count, chips = [], rows = [], inert = null }) {
  const shown = count === null ? '—' : `(${count})`
  const title = count === null ? 'not published in the signed state' : ''
  return `<div class="lane t${tier}${inert ? ' off' : ''}">
    <div class="top"><span class="fill">${view.fill}</span>
      <span class="name">${esc(laneLabel(view))}</span>
      <span class="dest">${esc(view.dest)}</span>
      <span class="count" title="${esc(title)}">${shown}</span></div>
    <p class="why">${esc(view.why)}</p>
    ${inert ? `<p class="why"><b>${esc(inert)}</b></p>` : ''}
    <div class="from">from ${esc(view.from)}</div>
    ${chips.length ? `<div>${chips.join('')}</div>` : ''}
    ${rows.length ? `<div class="rows">${rows.join('')}</div>` : ''}
  </div>`
}

function draw(state) {
  const m = laneModel(state)
  const out = []
  const gateChip = () => m.consentOn === null ? []
    : [m.consentOn ? '<span class="k warn">consent required</span>'
                   : '<span class="k unk">consent gate off</span>']
  const inertText = 'Unreachable right now: no notes of ours are being watched, so no reply can enter this lane.'

  // Lane 1 — the only lane whose membership is published, so the only one listed by name.
  out.push(laneHtml(LANE_VIEW[0], 1, {
    count: m.lanes[0].count,
    chips: gateChip(),
    rows: m.follows.slice().sort((a, b) => a.pubkey.localeCompare(b.pubkey)).map(f =>
      `<div class="row"><span>${esc(npub(f.pubkey))}</span>` +
      `<span class="k ${CONSENT_CLASS[f.consent] || 'unk'}" style="margin-left:auto">${esc(f.consent)}</span></div>`),
  }))

  // Lane 2 — knowable, but not from this record. Point at the surface that does know.
  out.push(laneHtml(LANE_VIEW[1], 2, {
    count: m.lanes[1].count,
    chips: ['<span class="k unk">membership not published</span>',
            '<span class="k good">already consensual — holds a key</span>'],
    rows: ['<div class="row"><span class="note">Admissions are public 440s signed by you. This record does not list them; the <a href="/console/">Access</a> tab reads them from the relays.</span></div>'],
  }))

  // Lane 3 — count only.
  out.push(laneHtml(LANE_VIEW[2], 3, {
    count: m.lanes[2].count,
    inert: m.lanes[2].inert ? inertText : null,
    chips: ['<span class="k unk">count only — membership not published</span>',
            '<span class="k good">already consensual — vouched by you</span>'],
  }))

  // Lane 4 — count only, and it cannot say whether quarantine DELIVERS or merely HOLDS:
  // with no staging channel configured, routePublic logs and drops. Not published.
  const gate4 = ['<span class="k unk">membership and traffic count not published</span>', ...gateChip()]
  if (m.watchedNotes !== null) gate4.push(`<span class="k unk">${m.watchedNotes} watched note(s) make reply lanes reachable — not a reply count</span>`)
  if (m.lanes[3].muted) gate4.push(`<span class="k crit">${m.lanes[3].muted} muted author(s) dropped before this lane</span>`)
  gate4.push('<span class="k unk">delivers or holds: not published</span>')
  out.push(laneHtml(LANE_VIEW[3], 4, { count: null, inert: m.lanes[3].inert ? inertText : null, chips: gate4 }))

  // Lane 5 — the residual. Always `—`, never `(0)`.
  out.push(laneHtml(DROP_VIEW, 5, { count: m.drop.count }))
  $('lanes').innerHTML = out.join('')

  const ops = state.operations || null
  const consentOn = m.consentOn
  const limits = []
  if (!ops) limits.push('This bridge publishes no <code>operations</code> summary, so every count above is unavailable — only the follow list is present.')
  limits.push('<b>Membership</b> for <i>granted participant</i>, <i>standing follow</i> and <i>quarantine</i> is not in the signed state. Only the follow list names keys.')
  limits.push('<b>Whether quarantine delivers or holds</b> is not published. With no staging channel configured the bridge logs a held reply and does not deliver it, and this record cannot distinguish the two.')
  if (consentOn === null) limits.push('<b>The consent gate</b> state is not published by this bridge.')
  else if (!consentOn) limits.push('<b>The consent gate is off.</b> Mirrored feeds and stranger replies are not consent-checked. Turning it on changes which notes forward.')
  limits.push('<b>A silent drop leaves no record</b>, by design. The last lane can never carry a count — <code>—</code> there means unrecorded, not zero.')
  limits.push('<b>Individual moderation decisions are separate signed events.</b> This aggregate state publishes only their resulting counts, not a list of strangers or quarantined content.')
  $('limits').innerHTML = `<ul style="margin:0;padding-left:20px">${limits.map(l => `<li style="margin:0 0 6px">${l}</li>`).join('')}</ul>`
}

async function load() {
  const st = $('status'); st.className = 'status'
  activeBridge = null; activeState = null; setModeration(false)
  try {
    const bridge = hex($('bridge').value)
    st.textContent = 'Reading signed state from relays…'
    const rs = await Promise.all(RELAYS.map(u => query(u, { kinds: [30078], authors: [bridge], '#d': ['waggle-control-state'], limit: 2 })))
    const answered = rs.filter(r => r.answered).length
    if (!answered) throw Error('No relay answered, so nothing could be verified. This is not the same as "nothing is routed."')
    const states = []
    for (const r of rs) for (const e of r.out) {
      const s = validState(e, bridge)
      if (s) states.push(s)
    }
    const winner = newestFreshControlState(states)
    if (!winner) throw Error('No fresh valid signed state was found. The owner may have left control-state publishing off.')
    activeBridge = bridge; activeState = winner; setModeration(true)
    rememberBridgeKey(bridge, winner)
    draw(winner)
    st.className = 'status ok'
    st.textContent = `Verified signed state from ${new Date(winner.observed_at * 1000).toLocaleString()} · ${answered}/${RELAYS.length} relays answered.`
  } catch (e) {
    st.className = 'status err'; st.textContent = e.message
    $('lanes').innerHTML = '<div class="note">Disconnected — routing unavailable.</div>'
  }
}

function publish(event) {
  return Promise.all(RELAYS.map(url => new Promise(resolve => {
    let ws, done = false
    const finish = accepted => { if (done) return; done = true; try { ws.close() } catch {}; resolve(accepted) }
    try { ws = new WebSocket(url) } catch { return finish(false) }
    const timer = setTimeout(() => finish(false), 10000)
    ws.onopen = () => ws.send(JSON.stringify(['EVENT', event]))
    ws.onmessage = message => { try {
      const frame = JSON.parse(message.data)
      if (frame[0] === 'OK' && frame[1] === event.id) { clearTimeout(timer); finish(!!frame[2]) }
    } catch {} }
    ws.onerror = () => { clearTimeout(timer); finish(false) }
  }))).then(results => results.filter(Boolean).length)
}

async function moderate(action) {
  const status = $('moderation-status')
  try {
    const bridge = activeBridge, state = activeState
    if (!bridge || !state) throw Error('Load fresh verified routing state first.')
    try { requireFreshControlState(state) } catch (error) {
      activeBridge = null; activeState = null; setModeration(false); throw error
    }
    const target = eventId($('moderation-target').value)
    const opened = await stableControlSigner(bridge, state, () => ({ bridge: activeBridge, state: activeState }), { signerFactory: consoleSigner })
    const { signer, signerKey } = opened
    status.className = 'status'
    status.textContent = `Requesting ${action} signature from ${npub(signerKey)}…`
    const signed = await signer.signEvent({
      kind: 30078, created_at: Math.floor(Date.now() / 1000),
      tags: [['d', 'waggle-moderation'], ['p', opened.bridge]],
      content: JSON.stringify({ v: 1, action, target }),
    })
    const accepted = await publish(signed)
    if (!accepted) throw Error('No relay accepted the signed moderation command. Nothing changed.')
    status.className = 'status ok'
    status.textContent = `${accepted}/${RELAYS.length} relay(s) accepted the signed ${action} decision. Waiting for the bridge to refresh its state…`
    setTimeout(load, 2500)
  } catch (error) {
    status.className = 'status err'; status.textContent = error.message
  }
}

$('load').onclick = load
for (const button of document.querySelectorAll('.moderation')) button.onclick = () => moderate(button.dataset.action)
const saved = loadBridgeKey()
if (saved) { $('bridge').value = saved; load() }

// config-operations.mjs — independently verified, public-safe #67 operations view.
// It deliberately reads the bridge's signed control state from relays, never bridge config.
import { verifyEvent } from 'nostr-tools'
import { newestFreshControlState } from './control-state-freshness.mjs'

const RELAYS = ['wss://nos.lol', 'wss://relay.primal.net', 'wss://relay.ditto.pub', 'wss://jskitty.com/nostr']
const $ = id => document.getElementById(id)
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]))

function query(url, bridge, timeout = 8000) {
  return new Promise(resolve => {
    let socket, done = false; const events = []
    const finish = () => { if (done) return; done = true; try { socket.close() } catch {}; resolve(events) }
    try { socket = new WebSocket(url) } catch { return finish() }
    const timer = setTimeout(finish, timeout)
    socket.onopen = () => socket.send(JSON.stringify(['REQ', 'waggle-operations', { kinds:[30078], authors:[bridge], '#d':['waggle-control-state'], limit:2 }]))
    socket.onmessage = message => { try {
      const frame = JSON.parse(message.data)
      if (frame[0] === 'EVENT') events.push(frame[2])
      if (frame[0] === 'EOSE' || frame[0] === 'CLOSED') { clearTimeout(timer); finish() }
    } catch {} }
    socket.onerror = () => { clearTimeout(timer); finish() }
  })
}
function stateFrom(event, bridge) {
  try {
    if (!verifyEvent(event) || event.kind !== 30078 || event.pubkey !== bridge || !event.tags.some(tag => tag[0] === 'd' && tag[1] === 'waggle-control-state')) return null
    const state = JSON.parse(event.content), operations = state.operations
    const exact = (object, keys) => object && typeof object === 'object' && Object.keys(object).sort().join(',') === keys.sort().join(',')
    if (!exact(state, ['v', 'observed_at', 'hive', 'bridge', 'publishing', 'follows', 'operations']) || state.v !== 1 || state.bridge !== bridge || typeof state.publishing !== 'boolean' || !Number.isInteger(state.observed_at) || state.observed_at <= 0 || !exact(state.hive, ['id', 'name', 'handle']) || !Array.isArray(state.follows) || !exact(operations, ['trust', 'lanes', 'gates', 'drops'])) return null
    if (!state.follows.every(follow => exact(follow, ['pubkey', 'consent']) && /^[0-9a-f]{64}$/.test(follow.pubkey) && ['pending', 'asked', 'active', 'revoked'].includes(follow.consent))) return null
    if (!exact(operations.trust, ['trusted_repliers', 'muted_authors', 'watched_notes']) || !exact(operations.lanes, ['public_read', 'sealed', 'return_watch', 'relay_ingress']) || !exact(operations.gates, ['consent_required', 'ask_per_hour', 'public_content_bytes', 'public_replier_per_min', 'public_channel_per_min', 'public_lane_per_hour']) || !exact(operations.drops, ['relay_preauth', 'relay_not_relay'])) return null
    const counts = [...Object.values(operations.trust), operations.gates.ask_per_hour, operations.gates.public_content_bytes, operations.gates.public_replier_per_min, operations.gates.public_channel_per_min, operations.gates.public_lane_per_hour, ...Object.values(operations.drops)]
    if (!counts.every(value => Number.isInteger(value) && value >= 0 && value <= 1000000) || typeof operations.gates.consent_required !== 'boolean' || !Object.values(operations.lanes).every(value => typeof value === 'boolean')) return null
    return state
  } catch { return null }
}
function render(state) {
  let panel = $('operations')
  if (!panel) {
    panel = document.createElement('section'); panel.id = 'operations'; panel.className = 'panel'
    panel.innerHTML = '<h2>Operational state</h2><div class="note">Reading signed state…</div>'
    $('config').closest('.panel').after(panel)
  }
  const { trust, lanes, gates, drops } = state.operations
  const lane = Object.entries(lanes).map(([name, enabled]) => `${name.replace('_', ' ')} ${enabled ? 'on' : 'off'}`).join(' · ')
  panel.innerHTML = `<h2>Operational state</h2><p class="note">Verified signed state from ${escapeHtml(new Date(state.observed_at * 1000).toLocaleString())}.</p>
    <div class="entry"><div class="key">Lanes</div><div class="value">${escapeHtml(lane)}</div></div>
    <div class="entry"><div class="key">Trust tiers</div><div class="value">${trust.trusted_repliers} trusted replier(s) · ${trust.watched_notes} watched note(s) · ${trust.muted_authors} muted author(s)</div></div>
    <div class="entry"><div class="key">Public gates</div><div class="value">Consent ${gates.consent_required ? 'required' : 'not required'} · consent asks ${gates.ask_per_hour}/hour</div><div class="detail">Content cap ${gates.public_content_bytes} bytes · replier ${gates.public_replier_per_min}/min · channel ${gates.public_channel_per_min}/min · lane ${gates.public_lane_per_hour}/hour</div></div>
    <div class="entry"><div class="key">Relay safety counters</div><div class="value">${drops.relay_preauth} pre-authorization drop(s) · ${drops.relay_not_relay} non-relay drop(s)</div><div class="detail">Aggregate counts only — no senders, messages, channels, relay targets, or logs are published.</div></div>`
}
async function refresh() {
  const bridge = String($('bridge')?.value || '').trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(bridge)) return
  const events = (await Promise.all(RELAYS.map(relay => query(relay, bridge)))).flat()
  const states = events.map(event => stateFrom(event, bridge)).filter(Boolean)
  const newest = newestFreshControlState(states)
  if (newest) render(newest)
}

$('load').addEventListener('click', () => setTimeout(refresh, 80))
if ($('bridge').value) setTimeout(refresh, 80)

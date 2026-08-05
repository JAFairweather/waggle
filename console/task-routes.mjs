// Owner-signed task-route control. This page never receives bridge-host access. It verifies fresh
// public state, asks the owner's signer for an encrypted NIP-17 seal, then publishes an ephemeral
// NIP-59 wrap. Relays never learn the channel, participant, sender, or mention inside the command.
import { nip19, verifyEvent } from 'nostr-tools'
import { sealedTaskRouteCommand } from './task-route-envelope.mjs'
import { consoleSigner } from './signer-session.mjs'
import { newestFreshControlState } from './control-state-freshness.mjs'

const RELAYS = ['wss://nos.lol', 'wss://relay.primal.net', 'wss://relay.ditto.pub', 'wss://jskitty.com/nostr']
const $ = id => document.getElementById(id)
const npub = hex => nip19.npubEncode(hex)
function hex(value) {
  const text = String(value || '').trim()
  if (/^npub1/i.test(text)) {
    const decoded = nip19.decode(text)
    if (decoded.type === 'npub' && typeof decoded.data === 'string') return decoded.data.toLowerCase()
  }
  if (/^[0-9a-f]{64}$/i.test(text)) return text.toLowerCase()
  throw new Error('Use one npub or 64-character hex public key.')
}
function query(relay, bridge, timeout = 8000) {
  return new Promise(resolve => {
    let socket, done = false; const events = []
    const finish = () => { if (done) return; done = true; try { socket.close() } catch {}; resolve(events) }
    try { socket = new WebSocket(relay) } catch { return finish() }
    const timer = setTimeout(finish, timeout)
    socket.onopen = () => socket.send(JSON.stringify(['REQ', 'task-route-state', { kinds:[30078], authors:[bridge], '#d':['waggle-control-state'], limit:2 }]))
    socket.onmessage = message => { try {
      const frame = JSON.parse(message.data)
      if (frame[0] === 'EVENT') events.push(frame[2])
      if (frame[0] === 'EOSE' || frame[0] === 'CLOSED') { clearTimeout(timer); finish() }
    } catch {} }
    socket.onerror = () => { clearTimeout(timer); finish() }
  })
}
async function freshBridge() {
  const bridge = hex($('bridge').value)
  const events = (await Promise.all(RELAYS.map(relay => query(relay, bridge)))).flat()
  const states = []
  for (const event of events) {
    try {
      if (!verifyEvent(event) || event.kind !== 30078 || event.pubkey !== bridge || !event.tags.some(tag => tag[0] === 'd' && tag[1] === 'waggle-control-state')) continue
      const state = JSON.parse(event.content)
      if (state.v === 1 && state.bridge === bridge && Number.isInteger(state.observed_at)) states.push(state)
    } catch {}
  }
  if (!newestFreshControlState(states)) throw new Error('Load a fresh verified bridge state before changing a route.')
  return bridge
}
function publish(event) {
  return Promise.all(RELAYS.map(relay => new Promise(resolve => {
    let socket, done = false
    const finish = accepted => { if (done) return; done = true; try { socket.close() } catch {}; resolve(accepted) }
    try { socket = new WebSocket(relay) } catch { return finish(false) }
    const timer = setTimeout(() => finish(false), 10000)
    socket.onopen = () => socket.send(JSON.stringify(['EVENT', event]))
    socket.onmessage = message => { try { const frame = JSON.parse(message.data); if (frame[0] === 'OK' && frame[1] === event.id) { clearTimeout(timer); finish(frame[2] === true) } } catch {} }
    socket.onerror = () => { clearTimeout(timer); finish(false) }
  }))).then(results => results.filter(Boolean).length)
}

const panel = document.createElement('section')
panel.className = 'panel'
panel.innerHTML = `<h2>Agent channel route</h2>
  <p class="note" style="margin-top:0">Wake one admitted Claude or Codex identity when an authorized person mentions it in a Buzz channel. Your browser signs this narrow route; Waggle activates it without a shell or restart. Nvoy still requires live task and task-relay grants before channel text can become an instruction.</p>
  <label for="route-channel">Buzz channel UUID</label><input id="route-channel" placeholder="a8186b53-…" spellcheck="false">
  <label for="route-participant" style="margin-top:10px">Agent identity</label><input id="route-participant" placeholder="npub1… or 64-character hex" spellcheck="false">
  <label for="route-sender" style="margin-top:10px">Authorized sender</label><input id="route-sender" placeholder="Leave blank to use the signing identity" spellcheck="false">
  <label for="route-mention" style="margin-top:10px">Mention handle</label><input id="route-mention" value="codex" placeholder="codex" spellcheck="false">
  <button id="route-add">Activate route</button> <button id="route-remove">Remove route</button><div class="status" id="routest"></div>`
document.querySelector('section.panel.note').before(panel)

async function manage(action) {
  const status = $('routest')
  try {
    const bridge = await freshBridge()
    const participant = hex($('route-participant').value)
    const channel = String($('route-channel').value || '').trim().toLowerCase()
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(channel)) throw new Error('Use the Buzz channel UUID, not its display name.')
    const mention = String($('route-mention').value || '').trim().replace(/^@/, '').toLowerCase()
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(mention)) throw new Error('Mention must be 1–32 letters, numbers, underscores, or hyphens.')
    const signer = await consoleSigner(), signingIdentity = (await signer.getPublicKey()).toLowerCase()
    const sender = $('route-sender').value.trim() ? hex($('route-sender').value) : signingIdentity
    const verb = action === 'upsert' ? 'activate' : 'remove'
    if (!confirm(`${verb[0].toUpperCase() + verb.slice(1)} @${mention} for ${npub(participant)} in channel ${channel}?\n\nOnly messages signed by ${npub(sender)} can use this route.`)) return
    status.className = 'status'; status.textContent = `Requesting signature from ${npub(signingIdentity)}…`
    const body = { v:1, type:'waggle-task-route', action, channel, sender, participant, mention, protocol:'nvoy-task-carry-v1' }
    const event = await sealedTaskRouteCommand(signer, bridge, body)
    status.textContent = 'Publishing encrypted owner route…'
    const accepted = await publish(event)
    if (!accepted) throw new Error('No relay accepted the route command. Nothing changed.')
    status.className = 'status ok'
    status.textContent = `${accepted}/${RELAYS.length} relay(s) accepted the encrypted command. Waggle will verify its owner signature and admission, then activate it without a restart.`
  } catch (error) { status.className = 'status err'; status.textContent = error.message }
}
$('route-add').onclick = () => manage('upsert')
$('route-remove').onclick = () => manage('remove')

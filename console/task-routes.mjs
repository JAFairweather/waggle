// Owner-signed task-route control. This page never receives bridge-host access. It verifies fresh
// public state, asks the owner's signer for an encrypted NIP-17 seal, then publishes an ephemeral
// NIP-59 wrap. Relays never learn the channel, participant, sender, or mention inside the command.
import { nip19, verifyEvent } from 'nostr-tools'
import { sealedTaskRouteCommand } from './task-route-envelope.mjs'
import { consoleSigner } from './signer-session.mjs'
import { newestFreshControlState } from './control-state-freshness.mjs'
import { taskRouteMentionProblem } from './task-route-mention.mjs'   // #404 — one grammar, shared with the bridge
import { rosterAgents, agentOptionText } from './agent-roster.mjs'   // #413 — pick from the roster, do not paste

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
  const state = newestFreshControlState(states)
  if (!state) throw new Error('Load a fresh verified bridge state before changing a route.')
  // #413: the state was always parsed here and then thrown away. Returning it is what makes a
  // roster picker free — same event, same signature check, same freshness rule, no second fetch.
  return { bridge, state }
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
  <label for="route-participant-pick" style="margin-top:10px">Agent identity</label>
  <select id="route-participant-pick"><option value="">Load the roster to choose an admitted agent</option></select>
  <button id="route-roster" type="button" style="margin-top:6px">Load roster</button>
  <p class="note" style="margin:6px 0 0">The list shows lifecycle status, and admission is decided separately by the key's live grant (#440). A key marked removed can still hold one; an unmarked key may have had its grant withdrawn. Read the marks as advisory, not as a verdict on whether the route will activate.</p>
  <label for="route-participant" style="margin-top:10px">…or a key that is not on the roster yet</label><input id="route-participant" placeholder="npub1… or 64-character hex" spellcheck="false">
  <label for="route-sender-pick" style="margin-top:10px">Authorized sender</label>
  <select id="route-sender-pick"><option value="">The signing identity</option></select>
  <label for="route-sender" style="margin-top:10px">…or another key</label><input id="route-sender" placeholder="Leave blank to use the signing identity" spellcheck="false">
  <label for="route-mention" style="margin-top:10px">Mention handle</label><input id="route-mention" placeholder="My Dude" spellcheck="false">
  <p class="note" style="margin:6px 0 0">The agent's Buzz display name exactly as it appears in channel — spaces and capitals included. Matching ignores case. Picking an agent suggests its label here; correct it if Buzz shows something else, because a label is owner-set ASCII and a display name is not (#404).</p>
  <button id="route-add">Activate route</button> <button id="route-remove">Remove route</button><div class="status" id="routest"></div>`
document.querySelector('section.panel.note').before(panel)

// The picker fills the text field rather than replacing it. Two reasons, both load-bearing: the
// free-text path stays the single source `manage()` reads, so a key that is not on the roster yet
// still works and is not a second code path; and the operator can see the value that was chosen
// instead of trusting a select whose option text is not the value.
function fillPicker(select, agents, blank) {
  select.textContent = ''
  const first = document.createElement('option')
  first.value = ''; first.textContent = blank
  select.appendChild(first)
  for (const agent of agents) {
    const option = document.createElement('option')
    option.value = agent.pubkey
    option.textContent = agentOptionText(agent)
    select.appendChild(option)
  }
}

// Which bridge the loaded options describe, and what the picker last wrote into each field (#440).
// `freshBridge()` re-reads `$('bridge')` on every call, so the signature and freshness checks follow
// the operator to another bridge — the roster in front of them does not, and nothing in the console
// listened to that field. Recording provenance is what lets a later change tell the picker's own
// guess from something the operator typed, and clear only the first.
let roster = null
const picked = { participant: null, sender: null, mention: null }

function clearIfOurs(id, key) {
  const field = $(id)
  if (picked[key] != null && field.value.trim() === picked[key]) field.value = ''
  picked[key] = null
}
function forgetPicked() {
  clearIfOurs('route-participant', 'participant')
  clearIfOurs('route-sender', 'sender')
  clearIfOurs('route-mention', 'mention')
}
// On an edit to the bridge field. Cosmetic on its own, because a programmatic write to that field
// fires no `input`/`change` event at all — which is why the refusal in `manage()` is the guard and
// this is the courtesy. Both are needed: without the clearing the select still SHOWS the old agent,
// and the select is the operator's only evidence of what they chose.
//
// The mechanism used to be attributed to `routing.mjs`. That is the wrong file: `routing.mjs` is
// loaded by `routing.html`, while this module is loaded only by `config.html`. The programmatic
// writer that ships on THIS page is config.html's own `if(saved){$('bridge').value=saved}`, and it
// runs at page init — before these listeners attach and before any pick exists, so it cannot strand
// one. Form restore, autofill and any future writer still justify the guard (#440 review).
function forgetRoster() {
  roster = null
  fillPicker($('route-participant-pick'), [], 'Load the roster to choose an admitted agent')
  fillPicker($('route-sender-pick'), [], 'The signing identity')
  forgetPicked()
}

async function loadRoster() {
  const status = $('routest')
  try {
    status.className = 'status'; status.textContent = 'Verifying the bridge state…'
    const { bridge, state } = await freshBridge()
    // Reloading is the operator's own remedy for the stale pick, so it has to actually clear one.
    // It did not: the roster refilled and the picked key from the previous bridge stayed put.
    if (roster && roster.bridge !== bridge) forgetPicked()
    roster = { bridge }
    const agents = rosterAgents(state)
    fillPicker($('route-participant-pick'), agents, agents.length ? 'Choose an admitted agent' : 'The roster is empty')
    fillPicker($('route-sender-pick'), agents, 'The signing identity')
    status.className = 'status ok'
    // Said as a count, because "the roster loaded" and "the roster loaded and was empty" are the
    // two outcomes an operator would otherwise have to tell apart by looking at a dropdown.
    status.textContent = agents.length
      ? `${agents.length} agent(s) on the verified roster. A grant alone does not put a key here (#321) — paste one below if it is missing.`
      : 'The verified roster lists no agents. A grant alone does not put a key here (#321) — paste one below.'
  } catch (error) { status.className = 'status err'; status.textContent = error.message }
}

async function manage(action) {
  const status = $('routest')
  try {
    // Before the round trip and before anything is signed. The options in the picker describe ONE
    // bridge; move the bridge field and they describe the wrong one, silently. The off-roster case
    // fails closed at `applyTaskRouteCommand` — `participant is not admitted` — but the case that
    // does not is ordinary for a crew running more than one hive: a key holding a live grant on
    // both. The route then activates against the new bridge pointing at the agent chosen for the
    // old one, which is the exact mis-routing this picker exists to prevent.
    const target = hex($('bridge').value)
    if (roster && roster.bridge !== target) {
      throw new Error('The agent list was loaded for a different bridge, so the agent shown may not be the one this route would wake. Load the roster again for this bridge.')
    }
    const { bridge } = await freshBridge()
    const participant = hex($('route-participant').value)
    const channel = String($('route-channel').value || '').trim().toLowerCase()
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(channel)) throw new Error('Use the Buzz channel UUID, not its display name.')
    // #404: the bridge matches this against the raw channel body, which holds the member's Buzz
    // display_name — "@My Dude", space and capitals included. Type the name, not a slug, and keep
    // the case: the stored value is what you typed.
    const mention = String($('route-mention').value || '').replace(/^@/, '')
    const mentionProblem = taskRouteMentionProblem(mention)
    if (mentionProblem) throw new Error(`${mentionProblem[0].toUpperCase()}${mentionProblem.slice(1)}.`)
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
$('route-roster').onclick = () => loadRoster()
$('bridge').addEventListener('input', forgetRoster)
$('bridge').addEventListener('change', forgetRoster)
// Choosing writes the key into the field `manage()` reads. The mention is only SUGGESTED — never
// overwrite something the operator typed, because a label is printable ASCII and the display name
// it has to match is not (#404), so the label is a guess and the typed value is an answer.
$('route-participant-pick').onchange = event => {
  const option = event.target.selectedOptions[0]
  // Back to the placeholder row. One rule for both pickers, and it is the file's existing one:
  // clear what WE guessed, keep what the operator typed. Returning here left the previous key in
  // the field while the select read "Choose an admitted agent".
  if (!event.target.value) {
    clearIfOurs('route-participant', 'participant')
    clearIfOurs('route-mention', 'mention')
    return
  }
  $('route-participant').value = event.target.value
  picked.participant = event.target.value
  const label = (option.textContent || '').split(' — ')[0].trim()
  // An unnamed agent has no suggestion to make, and RETURNING here was the same bug one level down:
  // the key had already been written and the mention had not, so the previous pick's label stayed
  // beside the new agent's key — a route reading `@Dennis for npub1…` while waking someone else,
  // which is the exact failure this picker exists to prevent (#440 review). Clear our own guess
  // instead of leaving it; an answer the operator typed still survives.
  if (label === 'unnamed agent') {
    const current = $('route-mention').value.trim()
    if (!current || current === picked.mention) $('route-mention').value = ''
    picked.mention = null
    return
  }
  // Suggest UNLESS the operator has typed something — which is only the same rule as "suggest when
  // empty" on the FIRST pick (#440). Changing your mind in a dropdown is the most ordinary thing an
  // operator does, and the empty-only rule left the first agent's label sitting beside the second
  // agent's key: a route whose mention names one agent and wakes another, reading as correct.
  // Overwrite our own guess; never an answer.
  //
  // Both sides of the comparison are trimmed. `LABEL` permits a trailing space, so an untrimmed
  // guess never round-trips equal to `field.value.trim()` and the picker reads its own suggestion
  // back as the operator's answer — the same "assumes the field returns the guess byte-identical"
  // root cause as the blocker above.
  const current = $('route-mention').value.trim()
  if (current && current !== picked.mention) return
  $('route-mention').value = label
  picked.mention = label
}
// Blank clears, on BOTH pickers. The participant picker used to return on blank, leaving the
// previous key in the field while the select read "Choose an admitted agent" — which contradicts
// the rule the rest of this file is built on, that the select is the operator's only evidence of
// what they chose (#440 review).
$('route-sender-pick').onchange = event => {
  if (!event.target.value) { clearIfOurs('route-sender', 'sender'); return }
  $('route-sender').value = event.target.value
  picked.sender = event.target.value
}
$('route-add').onclick = () => manage('upsert')
$('route-remove').onclick = () => manage('remove')

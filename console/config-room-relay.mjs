// config-room-relay.mjs — the room relay the hive page reads who is in each room from (#698).
//
// docs/DESIGN_HIVE_CONSOLE.md, "Who is in each room": the address comes from the owner's Config and
// is never written into this repository. It is kept in this browser only. The key is optional: the
// page takes the relay's signing key from its NIP-11 document, and uses this one only when that
// document doesn't state it.

import { loadRoomRelay, saveRoomRelay, forgetRoomRelay } from './room-lists.mjs'

const main = document.querySelector('main')
if (main) {
  const box = document.createElement('section'); box.className = 'panel'; box.id = 'room-relay'
  const h = document.createElement('h2'); h.textContent = 'Buzz relay'
  const note = document.createElement('p'); note.className = 'note'; note.style.marginTop = '0'
  note.textContent = "The address your Buzz app connects to: your rooms and their member lists live there. The hive page reads who is in each room from it, with one Bunker prompt when you ask. It's kept in this browser only."
  const mk = (id, label, ph) => {
    const l = document.createElement('label'); l.htmlFor = id; l.textContent = label
    const i = document.createElement('input'); i.id = id; i.placeholder = ph; i.spellcheck = false; i.autocomplete = 'off'
    return [l, i]
  }
  const [lu, url] = mk('room-relay-url', 'Address', 'wss://…')
  const [lk, key] = mk('room-relay-key', "Its signing key (only if it doesn't publish one)", '64-character hex, optional')
  lk.style.display = 'block'; lk.style.marginTop = '12px'
  const save = document.createElement('button'); save.type = 'button'; save.textContent = 'Keep it'
  const drop = document.createElement('button'); drop.type = 'button'; drop.textContent = 'Forget it'; drop.style.marginLeft = '8px'
  const st = document.createElement('div'); st.className = 'status'; st.setAttribute('role', 'status')
  const now = loadRoomRelay()
  if (now) { url.value = now.url; key.value = now.key || '' }
  save.onclick = () => {
    const ok = saveRoomRelay({ url: url.value.trim(), key: key.value.trim() || null })
    st.textContent = ok ? 'Kept. Back on your hive, Needs you offers to read who is in each room.' : 'Not kept: the address must start wss://, and the key, if given, must be 64 hex characters.'
  }
  drop.onclick = () => { forgetRoomRelay(); url.value = key.value = ''; st.textContent = 'Forgotten in this browser.' }
  box.append(h, note, lu, url, lk, key, save, drop, st)
  const tail = main.querySelector('section.panel.note')
  tail ? main.insertBefore(box, tail) : main.appendChild(box)
  if (location.hash === '#room-relay') box.scrollIntoView()
}

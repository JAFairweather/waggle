#!/usr/bin/env node
// Copy Buzz Desktop's allow-lists to the hive page (#672).
//
// A Buzz agent acts on a mention only from the senders its respond-to setting allows. Buzz Desktop
// keeps that setting on the owner's machine, and no Buzz API reads it, so the hive grid cannot see
// whom the Buzz agents take work from. This reads it from Buzz Desktop's agent settings and prints
// a link to the hive page carrying it; the page names the change in plain words and the owner signs
// one copy, read back cold like the Active list.
//
// Only public keys leave the file: each running agent's key and the keys it answers. Every other
// field (prompts, tokens, commands) is left unread. Run it on the machine that runs Buzz Desktop.
//
//   node tools/buzz-allow.mjs [--open] [path/to/managed-agents.json]

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export const BUZZ_AGENTS = join(homedir(), 'Library', 'Application Support', 'xyz.block.buzz.app', 'agents', 'managed-agents.json')
export const HIVE_PAGE = 'https://waggle.nave.pub/console/hive.html'
const KEY = /^[0-9a-f]{64}$/

// One `agent:senders` part per agent that has a key; a setting this does not know is left out and
// named, never guessed.
export function buzzLists(agents) {
  const parts = [], skipped = []
  for (const a of Array.isArray(agents) ? agents : []) {
    const pk = String(a?.pubkey || '').toLowerCase()
    if (!KEY.test(pk)) continue
    const senders = a.respond_to === 'anyone' ? ['*'] : a.respond_to === 'owner-only' ? ['owner']
      : a.respond_to === 'allowlist' ? (a.respond_to_allowlist || []).map(s => String(s).toLowerCase()).filter(s => KEY.test(s)) : null
    if (!senders) { skipped.push(String(a.name || pk.slice(0, 8))); continue }
    parts.push(`${pk}:${[...new Set(senders)].sort().join(',')}`)
  }
  return { parts: parts.sort(), skipped }
}
export const buzzLink = (parts, page = HIVE_PAGE) => `${page}#buzz=${parts.join(';')}`

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const args = process.argv.slice(2), open = args.includes('--open')
  const file = args.find(a => a !== '--open') || BUZZ_AGENTS
  const { parts, skipped } = buzzLists(JSON.parse(readFileSync(file, 'utf8')))
  for (const name of skipped) console.error(`left out ${name}: its respond-to setting is not one this tool knows`)
  if (!parts.length) { console.error('no Buzz agent with a key was found'); process.exit(1) }
  const link = buzzLink(parts)
  console.log(`${parts.length} Buzz agent${parts.length === 1 ? '' : 's'} read.`)
  if (open) { execFileSync('open', [link]); console.log('Opened the hive page: press Read the hive, then sign the copy.') }
  else console.log(link)
}

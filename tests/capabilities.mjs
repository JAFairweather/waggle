// What the two signing surfaces may issue, and who actually checks it.
//
// Before this, the console INFERRED the capability from the shape of the subject field —
// an npub yielded `task`, anything else `admit`. Consequences, all real:
//   · `task+act` had a human label it could never produce
//   · `task-relay` had neither a label nor any path, though the docs require it and the
//     agent runtime enforces it
//   · `admit+read` had no label either, though the bridge honours it
// So three of the estate's documented capabilities were unreachable from the one surface
// an operator actually uses, and one was advertised but unbuildable.
//
// The second thing this pins is the honesty claim. The operator signs every capability
// here, but THIS BRIDGE consumes only two of them — processGrantEvent returns early on
// anything that is not `admit`/`admit+read`. The task family is enforced on the agent side.
// A surface that let you sign without saying who checks it would be recording intent while
// implying enforcement, which is the same defect as a routing board showing a lane nothing
// delivers to. So the enforcement map is asserted against the bridge's real behaviour
// rather than trusted as prose.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'
import { finalizeEvent, generateSecretKey, verifyEvent } from 'nostr-tools'
import { verifyNvoyVisibility } from '../console/nvoy-visibility.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0, fail = 0
const ok = (name, value, detail = '') => { console.log(`${value ? 'ok  ' : 'FAIL'} — ${name}${value ? '' : detail ? ` (${detail})` : ''}`); value ? pass++ : fail++ }

const consoleSrc = readFileSync(join(ROOT, 'console/index.html'), 'utf8')
const grantSrc = readFileSync(join(ROOT, 'tools/grant.mjs'), 'utf8')
const bridgeSrc = readFileSync(join(ROOT, 'src/bridge.mjs'), 'utf8')

// Pull the declarations out of the console page. It is a browser page with a DOM at load,
// so evaluating the block is the practical way to read its real values.
// Returns {} for a declaration that is absent, so a missing map reports as failed
// assertions naming what is missing rather than as a stack trace. A test whose output is
// a crash tells you it broke but not what it wanted.
const grab = (name) => {
  const i = consoleSrc.indexOf(`const ${name} = {`)
  if (i < 0) return {}
  const open = consoleSrc.indexOf('{', i)
  let depth = 0, j = open
  for (; j < consoleSrc.length; j++) {
    if (consoleSrc[j] === '{') depth++
    else if (consoleSrc[j] === '}') { depth--; if (!depth) break }
  }
  try { return new Function(`return ${consoleSrc.slice(open, j + 1)}`)() } catch { return {} }
}
const CAP_LABEL = grab('CAP_LABEL')
const CAP_ENFORCER = grab('CAP_ENFORCER')
const ISSUABLE = grab('ISSUABLE')
const issuable = (kind) => Array.isArray(ISSUABLE[kind]) ? ISSUABLE[kind] : []

ok('the console declares a capability label map', Object.keys(CAP_LABEL).length > 0)
ok('the console declares who enforces each capability', Object.keys(CAP_ENFORCER).length > 0)
ok('the console declares which capabilities it may issue, per subject shape',
  issuable('agent').length > 0 && issuable('channel').length > 0)

// ── every capability the estate uses has a human label ────────────────────────
// The label map is what an administrator reads while deciding whether to click Revoke.
// A cap with no entry renders as raw protocol vocabulary.
const ESTATE_CAPS = ['admit', 'admit+read', 'task', 'task+act', 'task-relay', 'mirror']
for (const cap of ESTATE_CAPS) {
  ok(`${cap} has a human label`, typeof CAP_LABEL[cap] === 'string' && CAP_LABEL[cap] !== cap)
  ok(`${cap} names who enforces it`, typeof CAP_ENFORCER[cap] === 'string' && CAP_ENFORCER[cap].length > 0)
}

// ── the capability is chosen, not inferred ────────────────────────────────────
ok('the console no longer derives the cap from the subject\'s shape',
  !/const cap = isAgent \? 'task' : 'admit'/.test(consoleSrc))
ok('the console reads the cap from an explicit control', /\$\('g-cap'\)\.value/.test(consoleSrc))
ok('the console re-validates the chosen cap against the subject shape before signing',
  /allowed\.includes\(cap\)/.test(consoleSrc))

// ── the two signing surfaces agree ────────────────────────────────────────────
// One operator, two ways to sign the same grant. If they disagree, one of them is wrong
// and nothing tells you which.
const consoleAgent = issuable('agent').filter(o => o.ok).map(o => o.cap).sort()
const consoleChannel = issuable('channel').filter(o => o.ok).map(o => o.cap).sort()
const cliAgent = (grantSrc.match(/agentRaw \? \[([^\]]+)\]/) || [, ''])[1]
  .split(',').map(s => s.trim().replace(/'/g, '')).filter(Boolean).sort()
const cliChannel = (grantSrc.match(/agentRaw \? \[[^\]]+\] : \[([^\]]+)\]/) || [, ''])[1]
  .split(',').map(s => s.trim().replace(/'/g, '')).filter(Boolean).sort()

ok('console and CLI offer the same caps over an agent',
  consoleAgent.join() === cliAgent.join(), `console ${consoleAgent} vs cli ${cliAgent}`)
ok('console and CLI offer the same caps over a channel',
  consoleChannel.join() === cliChannel.join(), `console ${consoleChannel} vs cli ${cliChannel}`)
ok('task-relay is issuable over an agent — the docs require it and the runtime enforces it',
  consoleAgent.includes('task-relay') && cliAgent.includes('task-relay'))
ok('task+act is issuable, so its label is no longer a promise nothing can keep',
  consoleAgent.includes('task+act'))

// ── the deliberate exclusions, with their reasons on screen ───────────────────
const readOpt = issuable('channel').find(o => o.cap === 'admit+read')
ok('admit+read is offered but disabled, rather than silently missing',
  !!readOpt && readOpt.ok === false)
ok('…and its reason is stated, because a greyed option with a reason teaches',
  typeof readOpt?.reason === 'string' && readOpt.reason.length > 20)
ok('mirror is not offered at all — it is authored by the participant, not the operator',
  ![...issuable('agent'), ...issuable('channel')].some(o => o.cap === 'mirror'))

// ── the enforcement claims match the bridge ───────────────────────────────────
// processGrantEvent returns early on anything else, so exactly these two are the bridge's.
const bridgeHonours = [...bridgeSrc.matchAll(/cap !== '([^']+)' && cap !== '([^']+)'/g)]
  .flatMap(m => [m[1], m[2]])
ok('the bridge honours exactly admit and admit+read',
  bridgeHonours.sort().join() === ['admit', 'admit+read'].sort().join(),
  bridgeHonours.join())
for (const cap of bridgeHonours) {
  ok(`${cap} is credited to this bridge`, /this bridge/.test(CAP_ENFORCER[cap]))
}
for (const cap of ['task', 'task+act', 'task-relay']) {
  ok(`${cap} is NOT credited to this bridge — it is checked by the agent's runtime`,
    !bridgeHonours.includes(cap) && /runtime/.test(CAP_ENFORCER[cap]))
}

// ── Nvoy universal-plane visibility is a cold read, not a second fake data index ─────────────
const visibilityEvent = JSON.parse(JSON.stringify(finalizeEvent({
  kind: 440, created_at: 1, tags: [['p', 'a'.repeat(64)], ['da-cap', 'admit']], content: '',
}, generateSecretKey())))
const visibilityRelays = ['one', 'two', 'three']
const visible = await verifyNvoyVisibility({ relays: visibilityRelays, event: visibilityEvent, verify: verifyEvent,
  query: async url => ({ answered: true, out: url === 'two' ? [] : [visibilityEvent] }) })
ok('an exact signed 440 cold-read from relays is honestly reported visible in Nvoy',
  visible.visible === 2 && visible.answered === 3 && visible.total === 3)
const forged = JSON.parse(JSON.stringify(visibilityEvent)); forged.content = 'changed'
const absent = await verifyNvoyVisibility({ relays: visibilityRelays, event: visibilityEvent, verify: verifyEvent,
  query: async url => ({ answered: url !== 'three', out: url === 'one' ? [forged] : [] }) })
ok('absent, forged, and partial cold reads never claim Nvoy visibility',
  absent.visible === 0 && absent.answered === 2 && absent.total === 3)

console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail ? 1 : 0)

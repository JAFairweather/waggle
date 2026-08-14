// agent_manifest_transfer — carrying a manifest to a machine with no agent on it (#470).
//
// The gap this closes was found by walking the Pi path with the real tool: a fresh root refuses,
// correctly, and the only remedy it offered was `--from <instance>`, which resolves to a sibling
// directory on the same filesystem. A Pi has no sibling. So the first step of the goal had no path
// through the tool, and what happened instead was somebody copying JSON by hand.
//
// Three properties carry this suite, and each is asserted in BOTH directions, because a transfer
// that refuses everything is as useless as one that carries everything:
//
//   1. Authorisation travels. grantors, task_carriers and relays are what this repo cannot derive,
//      and a template without them must be refused rather than defaulted.
//   2. Identity does NOT travel. An export that carried `pubkey` would let one file seat two agents
//      as the same key — the impersonation the whole design exists to prevent.
//   3. Host facts do NOT travel. uid 1001 on a laptop is not uid 1001 on a Pi, and a mirrored uid
//      declares a privilege separation the new host may not have, silently.
import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HOST_ONLY, IDENTITY_ONLY, exportTemplate, importTemplate } from '../src/agent_manifest_transfer.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0, fail = 0
const check = (cond, what) => { if (cond) { pass++; console.log(`  ok   ${what}`) } else { fail++; console.log(`  FAIL ${what}`) } }
const threw = fn => { try { fn(); return '' } catch (e) { return e.message } }

console.log('\nagent_manifest_transfer\n')

const K = n => String(n).repeat(64).slice(0, 64)
const GRANTOR = K('a'), CARRIER = K('b'), SRC_PUB = K('c'), NEW_PUB = K('d')

// A manifest in the shape the real ones are in, uids and all.
const working = {
  version: 1, id: 'seated', pubkey: SRC_PUB,
  grantors: [GRANTOR], task_carriers: [CARRIER],
  relays: ['wss://nos.lol', 'wss://relay.primal.net'],
  state_dir: '/home/jaf/.nvoy/desktop/seated/state',
  runtime_dir: '/home/jaf/.nvoy/desktop/seated/runtime',
  spool_dir: '/home/jaf/.nvoy/desktop/seated/spool',
  bunker_uri_ref: '/home/jaf/.nvoy/desktop/seated/credentials/bunker-uri',
  bunker_client_ref: '/home/jaf/.nvoy/desktop/seated/credentials/bunker-client',
  watcher_uid: 1001, broker_uid: 1002, adapter_uid: 1003, worker_uid: 1004,
  broker_adapter_gid: 2001, worker_handoff_gid: 2002,
  broker_mode: 'local', delivery_mode: 'notify_only', worker_enabled: false,
}

// ── 1. What crosses, and what does not ──────────────────────────────────────────────────────
console.log('1. export — authorisation travels, identity and host do not')
const { template, dropped } = exportTemplate(working)
check(template.grantors?.[0] === GRANTOR && template.task_carriers?.[0] === CARRIER,
  'grantors and task carriers travel — they are the thing this repo cannot derive')
check(Array.isArray(template.relays) && template.relays.length === 2,
  'the relay list travels: an agent seated without it listens nowhere')
check(template.delivery_mode === 'notify_only' && template.broker_mode === 'local' && template.worker_enabled === false,
  'and the policy fields travel, including a FALSE one — a falsy value must not be dropped as absent')

for (const k of IDENTITY_ONLY) check(template[k] === undefined, `${k} does NOT travel — one template must not seat two agents as one key`)
for (const k of HOST_ONLY) check(template[k] === undefined, `${k} does NOT travel`)
check(dropped.includes('watcher_uid') && dropped.includes('pubkey') && dropped.includes('bunker_uri_ref'),
  'and every dropped field is NAMED, not counted — a count cannot show you that no key is in the file')

// The other direction. A serialiser that emitted an empty object would pass every assertion above.
check(Object.keys(template).length >= 6,
  'NEGATIVE CONTROL — the template is not simply empty; it carries what it is for')
check(JSON.stringify(template).includes('nos.lol'),
  'NEGATIVE CONTROL — a real relay URL survives serialisation')

console.log('\n2. export refuses what it cannot honestly carry')
const noRelays = { ...working }; delete noRelays.relays
check(/no relays/.test(threw(() => exportTemplate(noRelays))),
  'a manifest with no relays is refused, and the message names relays rather than saying "invalid"')
const noGrantors = { ...working }; delete noGrantors.grantors
check(/no grantors/.test(threw(() => exportTemplate(noGrantors))), 'same for grantors')
check(threw(() => exportTemplate(working)) === '',
  'NEGATIVE CONTROL — a complete manifest is NOT refused, so this is not a guard that rejects everything')
check(/needs a manifest object/.test(threw(() => exportTemplate('a string'))), 'and a non-object is refused plainly')

// A credential in a portable field. Nothing puts one there today; the sweep is what makes that a
// property rather than an observation about today's code.
const leaky = { ...working, relays: ['wss://nos.lol'], grantors: [GRANTOR], task_carriers: [CARRIER], broker_mode: 'bunker://leaked?relay=wss://x' }
check(/refusing to write/.test(threw(() => exportTemplate(leaky))) && /bunker/.test(threw(() => exportTemplate(leaky))),
  'a credential smuggled into a portable field is refused, and the reason names it')

// ── 3. Import ───────────────────────────────────────────────────────────────────────────────
console.log('\n3. import — the new host supplies exactly what the template refused to carry')
const host = {
  name: 'pi-agent', pubkey: NEW_PUB,
  stateDir: '/home/pi/agent/state', runtimeDir: '/home/pi/agent/runtime', spoolDir: '/home/pi/agent/spool',
  uriPath: '/home/pi/agent/credentials/bunker-uri', clientPath: '/home/pi/agent/credentials/bunker-client',
}
const { manifest, warnings } = importTemplate(template, host)
check(manifest.id === 'pi-agent' && manifest.pubkey === NEW_PUB,
  'the seated manifest carries the NEW agent identity, not the exporting one')
check(manifest.pubkey !== SRC_PUB, 'and specifically NOT the source key — this is the impersonation guard')
check(manifest.grantors[0] === GRANTOR && manifest.relays.length === 2, 'while the authorisation is the one that was carried')
check(manifest.state_dir === '/home/pi/agent/state' && manifest.bunker_uri_ref.startsWith('/home/pi/'),
  'paths are this host\'s, not the exporting host\'s')
for (const k of ['watcher_uid', 'broker_uid', 'adapter_uid', 'broker_adapter_gid']) {
  check(manifest[k] === undefined, `${k} is absent: a uid from another machine declares a privilege separation this one may not have`)
}
check(warnings.some(w => /uids or gids were imported/.test(w)),
  'and that absence is SAID, not silent — an operator who cannot see it does not know to set them')
check(warnings.some(w => /nos\.lol/.test(w)), 'the relays are read back to the operator at the moment they are copied')

console.log('\n4. import refuses rather than defaults')
const bare = { version: 1, relays: ['wss://nos.lol'] }
const bareMsg = threw(() => importTemplate(bare, host))
check(/grantors/.test(bareMsg) && /task_carriers/.test(bareMsg),
  `a template missing authorisation is refused and names WHICH fields — ${bareMsg.slice(0, 58)}`)
check(!/undefined|invalid/.test(bareMsg), 'and does not hide behind "invalid": the operator acts on the reason')

check(/must not travel/.test(threw(() => importTemplate({ ...template, pubkey: SRC_PUB }, host))),
  'a template that carries a pubkey is refused — that is a hand-copied manifest, not an export')
check(/must not travel/.test(threw(() => importTemplate({ ...template, watcher_uid: 1001 }, host))),
  'and one that carries a uid is refused for the same reason')
check(/64-hex pubkey/.test(threw(() => importTemplate(template, { ...host, pubkey: 'nope' }))),
  'seating needs a real key for the new agent')
check(/needs the agent name/.test(threw(() => importTemplate(template, { ...host, name: '' }))), 'and a name')
check(/relays must be a non-empty list of wss/.test(threw(() => importTemplate({ ...template, relays: ['http://nope'] }, host))),
  'a non-wss relay is refused: an agent pointed at a plaintext relay is not the agent that was authorised')
check(/grantors must be a non-empty list/.test(threw(() => importTemplate({ ...template, grantors: [] }, host))),
  'an EMPTY grantors list is refused — present-but-empty is how an agent ends up answering to nobody')
check(/refusing to read/.test(threw(() => importTemplate({ ...template, relays: ['wss://x?k=nsec1qqqqqqqqqq'] }, host))),
  'and a credential in an incoming template is refused before it is read')

// The direction that keeps the guards honest.
check(threw(() => importTemplate(template, host)) === '',
  'NEGATIVE CONTROL — the legitimate template still imports, so none of the above rejects everything')

// ── 5. Round trip ───────────────────────────────────────────────────────────────────────────
console.log('\n5. round trip — the authorisation that arrives is the authorisation that left')
const rt = importTemplate(exportTemplate(working).template, host).manifest
for (const k of ['grantors', 'task_carriers', 'relays', 'broker_mode', 'delivery_mode', 'worker_enabled']) {
  check(JSON.stringify(rt[k]) === JSON.stringify(working[k]), `${k} survives export → JSON → import unchanged`)
}
check(JSON.stringify(rt) !== JSON.stringify(working), 'NEGATIVE CONTROL — and the manifest is NOT identical: identity and host differ, which is the point')

// ── 6. The tool, on a host with no sibling to mirror ─────────────────────────────────────────
console.log('\n6. the tool — a root with no agent in it, which is the whole issue')
const probe = mkdtempSync(join(tmpdir(), 'wb-transfer-'))
// The two streams stay apart. `--export` writes the template to stdout and its dropped-field report
// to stderr, so a helper that merged them would hand JSON.parse a diagnostic. Refusals are on stderr
// alone, and a first cut of this helper read stdout only — which reported a real refusal as an empty
// string and failed an assertion the tool actually satisfies.
const run = args => {
  const argv = [join(ROOT, 'tools', 'connect-agent.mjs'), ...args]
  const opts = { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] }
  try {
    return { out: execFileSync(process.execPath, argv, opts), err: '', rc: 0 }
  } catch (e) {
    return { out: typeof e?.stdout === 'string' ? e.stdout : null, err: typeof e?.stderr === 'string' ? e.stderr : '', rc: e?.status ?? null }
  }
}
// The exporting machine.
mkdirSync(join(probe, 'mac', 'seated', 'instances'), { recursive: true })
writeFileSync(join(probe, 'mac', 'seated', 'instances', 'seated.json'), JSON.stringify(working, null, 2) + '\n')
const exported = run(['--root', join(probe, 'mac'), '--name', 'seated', '--export'])
if (exported.out === null || exported.out.length < 40) {
  console.error(`agent_manifest_transfer: INCONCLUSIVE — --export produced ${exported.out === null ? 'no output' : `${exported.out.length} bytes`}`)
  console.error('  This is NOT an all-clear: the tool was never observed exporting anything.')
  rmSync(probe, { recursive: true, force: true })
  process.exit(3)
}
const carried = JSON.parse(exported.out)
check(carried.grantors?.[0] === GRANTOR, 'the tool exports a template an operator can actually copy')
check(!exported.out.includes(SRC_PUB) && !exported.out.includes('/home/jaf'),
  'and the bytes on stdout carry no key and no path from the exporting host')

// The Pi: a root that has never held an agent, so --from has nothing to point at.
const templateFile = join(probe, 'carried.json')
writeFileSync(templateFile, exported.out)
const piRoot = join(probe, 'pi')
const refused = run(['--root', piRoot, '--name', 'pi-agent', '--pubkey', NEW_PUB])
check(refused.rc === 1, 'with nothing to mirror the tool still refuses, and exits non-zero doing it')
check(/--from-file/.test(refused.err), 'and the refusal NAMES --from-file: a dead end and a dead end with a way out are not the same message')
check(!existsSync(join(piRoot, 'pi-agent')), 'and it created nothing on the way to refusing')

const seated = run(['--root', piRoot, '--name', 'pi-agent', '--pubkey', NEW_PUB, '--from-file', templateFile])
const landed = join(piRoot, 'pi-agent', 'instances', 'pi-agent.json')
check(existsSync(landed), 'and --from-file seats an agent on a host with no sibling — the thing #470 is about')
if (existsSync(landed)) {
  const m = JSON.parse(readFileSync(landed, 'utf8'))
  check(m.pubkey === NEW_PUB && m.id === 'pi-agent', 'the seated manifest is this agent, not the exporting one')
  check(m.grantors[0] === GRANTOR && m.relays.length === 2, 'carrying the authorisation it was given')
  check(m.watcher_uid === undefined, 'and no uid from the other machine')
  check(m.state_dir.startsWith(piRoot), 'with paths under THIS root')
}
check(/imported relays/.test(String(seated.out) + ''), 'the operator is told what was copied, at the moment it is copied')
rmSync(probe, { recursive: true, force: true })

console.log(`\n${pass} passed, ${fail} failed`)
assert.equal(fail, 0, `${fail} assertion(s) failed`)

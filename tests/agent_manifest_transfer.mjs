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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HOST_ONLY, IDENTITY_ONLY, exportTemplate, importTemplate, relayFault } from '../src/agent_manifest_transfer.mjs'
import { channelCommand, credentialPaths } from '../src/channel_registration.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0, fail = 0
const check = (cond, what) => { if (cond) { pass++; console.log(`  ok   ${what}`) } else { fail++; console.log(`  FAIL ${what}`) } }
const threw = fn => { try { fn(); return '' } catch (e) { return e.message } }

console.log('\nagent_manifest_transfer\n')

const K = n => String(n).repeat(64).slice(0, 64)
const GRANTOR = K('a'), CARRIER_KEY = K('b'), SRC_PUB = K('c'), NEW_PUB = K('d')

// The shape a real manifest holds: a key AND the channels it carries for. This was a bare 64-hex
// string, and that one wrong fixture was enough — `--export` from a working agent produced a
// template that `--from-file` refused as "not a list of 64-hex keys". The tool could not consume
// its own output, which is the entire point of the pair, and 62 assertions were green over it
// because every one of them was true about a manifest shape that exists on no machine.
const CARRIER = { pubkey: CARRIER_KEY, channels: ['a8186b53-537d-46ad-a7e7-b6486c58970e'] }

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

// "Every field left behind" has to mean every field, not every field on the two lists this module
// already knows about. A newer nvoy, or a hand-edited manifest, carries keys this repo has never
// seen; those were discarded and never reported, which is the one thing `dropped` exists to stop.
const withUnknown = exportTemplate({ ...working, some_future_field: 'x', another_one: { a: 1 } })
check(withUnknown.dropped.includes('some_future_field') && withUnknown.dropped.includes('another_one'),
  'a manifest key this module has never heard of is named in `dropped`, not silently discarded')
check(withUnknown.template.some_future_field === undefined,
  'and it does not travel — an unknown field is not portable by default')
// Both directions: `dropped` must not name a field that DID travel, or the report is noise.
check(!withUnknown.dropped.includes('relays') && !withUnknown.dropped.includes('grantors'),
  'NEGATIVE CONTROL — a field that travelled is not reported as dropped')

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
// Guarded, and the guard is load-bearing. With the production-shaped fixture above, a regression in
// the carrier validator throws HERE — at module scope, killing the suite before any summary prints.
// A dead suite greps as zero failures and reads like a pass; `npm test` catches it only because the
// chain stops on a non-zero exit, which is the alarm working by accident rather than by design.
let imported = null
try { imported = importTemplate(template, host) } catch (e) { imported = { error: e.message } }
check(!imported.error, `the exported template imports at all${imported.error ? ` — ${imported.error.slice(0, 70)}` : ''}`)
const { manifest = {}, warnings = [] } = imported
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

// ── 4b. The carrier shape, in both directions ───────────────────────────────────────────────
// The round trip is the property, not either half. `--export` and `--from-file` agreeing on paper
// is what was already asserted; that they agree on a REAL manifest is what was not.
console.log('\n4b. the round trip actually closes on a production-shaped manifest')
check(threw(() => importTemplate(exportTemplate(working).template, host)) === '',
  'export → import round-trips a manifest whose carriers are {pubkey, channels} — the case that was broken')
check(threw(() => importTemplate({ ...template, task_carriers: [CARRIER_KEY] }, host)) === '',
  'NEGATIVE CONTROL — a bare 64-hex carrier is still accepted, so this widened the shape rather than swapping it')
// Guarded. An unguarded call here throws at module scope when the round trip is broken, and a
// suite that dies prints no summary at all — which greps as zero failures and reads exactly like a
// pass. The mutation run that proved this section works surfaced as a crash, not as a named FAIL.
let roundTripped = null
try { roundTripped = importTemplate(exportTemplate(working).template, host).manifest } catch { roundTripped = null }
check(roundTripped?.task_carriers?.[0]?.pubkey === CARRIER_KEY && roundTripped?.task_carriers?.[0]?.channels?.length === 1,
  'and the carrier arrives intact — key and channels both, not flattened to a key')

// Widened is not "anything goes". Each of these is a carrier that would look seated and carry
// nothing, which at runtime is indistinguishable from having no carrier at all.
const badCarrier = v => threw(() => importTemplate({ ...template, task_carriers: v }, host))
check(badCarrier([{ pubkey: CARRIER_KEY }]) !== '', 'a carrier with no channels field is refused')
check(badCarrier([{ pubkey: CARRIER_KEY, channels: [] }]) !== '', 'and one with an empty channel list is refused')
check(badCarrier([{ pubkey: CARRIER_KEY, channels: [''] }]) !== '', 'and one whose channel is an empty string is refused')
check(badCarrier([{ channels: ['a8186b53'] }]) !== '', 'and one with channels but no key is refused')
check(badCarrier([{ pubkey: 'not-hex', channels: ['a8186b53'] }]) !== '', 'and one whose key is not 64-hex is refused')
check(badCarrier([]) !== '', 'and an empty carrier list is refused — seated with nothing to carry is not seated')
check(/pubkey/.test(badCarrier([{ pubkey: CARRIER_KEY }])) && /channels/.test(badCarrier([{ pubkey: CARRIER_KEY }])),
  'and the refusal describes the shape it wants, rather than repeating "64-hex keys" at an object')
check(/64-hex pubkey/.test(threw(() => importTemplate(template, { ...host, pubkey: 'nope' }))),
  'seating needs a real key for the new agent')
check(/needs the agent name/.test(threw(() => importTemplate(template, { ...host, name: '' }))), 'and a name')
check(/is not a wss:\/\/ URL/.test(threw(() => importTemplate({ ...template, relays: ['http://nope'] }, host))),
  'a non-wss relay is refused: an agent pointed at a plaintext relay is not the agent that was authorised')
check(/non-empty list/.test(threw(() => importTemplate({ ...template, relays: [] }, host))),
  'and an empty relay list is refused as empty, not as malformed')

// A template is a PUBLIC artifact — the tool tells the operator to paste it. Two shapes of relay
// URL carry a credential inside one, and neither is a typo an operator spots on review.
// Userinfo is caught twice over: `secretInText` has a shape for it and the relay allowlist has no
// place for it. Assert the shape check names it, and that the whole path refuses either way — a
// guard that only holds because a DIFFERENT guard fires first is not the guard being tested.
// `String(null)` deliberately: a loosened allowlist makes `relayFault` return null for a URL it
// should have faulted, and the assertion must SAY that rather than throw a TypeError out of the
// message it was building. A crash and a failure are not the same signal.
const userinfoFault = String(relayFault(['wss://user:hunter2@relay.example']))
check(/carries userinfo/.test(userinfoFault),
  `a relay URL with userinfo is named as userinfo, not as "not a wss:// URL" — ${userinfoFault.slice(0, 60)}`)
check(!/hunter2/.test(userinfoFault),
  'and the reason does not reprint the credential — an error message goes to a terminal and a log')
const withUserinfo = threw(() => importTemplate({ ...template, relays: ['wss://user:hunter2@relay.example'] }, host))
check(withUserinfo !== '' && !/hunter2/.test(withUserinfo),
  'and the template is refused on import, without the credential in the message')
const withQuery = threw(() => importTemplate({ ...template, relays: ['wss://relay.example/x?token=s3cret'] }, host))
check(/carries a query string/.test(withQuery),
  'a relay URL with a query string is refused — that is where a relay auth token goes')
check(!/s3cret/.test(withQuery), 'and that refusal does not reprint it either')
// Checked on the way OUT too: `secretInText` has a shape for userinfo and none for a query string,
// so without this the token would be written into the file the operator is told to paste.
check(/refusing to export relays/.test(threw(() => exportTemplate({ ...working, relays: ['wss://relay.example/x?token=s3cret'] }))),
  'and the same URL cannot be EXPORTED into a template either')
// Both directions. A relay check that refuses everything refuses every real install.
check(threw(() => importTemplate({ ...template, relays: ['wss://relay.example', 'wss://nos.lol/', 'wss://a.b.c/req'] }, host)) === '',
  'NEGATIVE CONTROL — ordinary relay URLs, with and without a path, still seat an agent')

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

// The channel key, at the path the stanza names (#474). This is the end of the Pi path, and it is
// asserted here rather than in a unit test because the defect was precisely that two correct halves
// disagreed: the tool minted `mcp-channel/id_ed25519` and the stanza named
// `credentials/claude-channel-ssh`. Each half passed when tested alone. Only running both catches it.
const { keyPath: mintedAt } = credentialPaths(join(piRoot, 'pi-agent'))
check(existsSync(mintedAt), 'the channel key is minted at the path the registration names, not beside it')
check(existsSync(`${mintedAt}.pub`), 'with its public half — the part that has to reach the broker')
check(existsSync(mintedAt) && (statSync(mintedAt).mode & 0o777) === 0o600, 'and mode 600')
check(!existsSync(join(piRoot, 'pi-agent', 'mcp-channel', 'id_ed25519')),
  'NEGATIVE CONTROL — and nothing is minted at the retired location, so this moved the key rather than adding a second')
// Asserted as an equality, not as two existsSync calls. Two checks that each pass against a
// different path is exactly the shape of the original defect.
const stanzaNames = channelCommand({ instanceRoot: join(piRoot, 'pi-agent'), host: 'nave.pub' }).keyPath
check(stanzaNames === mintedAt, 'and the stanza names that exact file — the two halves agree, which is the whole of #474')

rmSync(probe, { recursive: true, force: true })

console.log(`\n${pass} passed, ${fail} failed`)
assert.equal(fail, 0, `${fail} assertion(s) failed`)

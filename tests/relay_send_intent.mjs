// relay_send_intent — the agent's outbound lane, before any socket is involved (#507).
//
// Three properties, each of which has a production incident behind it:
//
//   1. A body with no @name is carried and routed to nobody. Silent. Twice.
//   2. A name with a SPACE is a real recipient. A slot validator that only ever saw `A`, `B` and
//      `Dennis` shipped and dropped every message to `My Dude` (#168). So the fixtures here have
//      spaces in them, and the positive control is the point of the test.
//   3. A send cannot claim delivery. The agent cannot read the community channel back, so "the
//      relay stored it" is the most it may ever say.
import { spawnSync } from 'node:child_process'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { buildIntent, envelopeTemplates, FUZZ_SECS, mentionVerdict, sendVerdict } from '../src/relay_send_intent.mjs'

let pass = 0, fail = 0
const ok = (cond, what) => { if (cond) { pass++; console.log(`  ok   ${what}`) } else { fail++; console.log(`  FAIL ${what}`) } }
const section = t => console.log(`\n${t}`)

const SELF = 'a'.repeat(64)
const CHANNEL = 'a8186b53-537d-46ad-a7e7-b6486c58970e'

section('1. the mention guard — the failure that is silent end to end')
{
  const empty = mentionVerdict('   ')
  ok(empty.ok === false, 'an empty body is refused')

  const none = mentionVerdict('the build is green')
  ok(none.ok === false, 'a body with no at-word is refused by default')
  // Assert the REASON, not just the refusal. This message is the thing the operator acts on, and a
  // correct refusal with a misleading explanation sends them hunting in the wrong place.
  ok(/route.*nobody|nobody/i.test(none.reason), '…and the reason says it would be routed to nobody')
  ok(/relay OK/i.test(none.reason), '…and says a relay OK still happens, because that is what makes it silent')
  ok(/--broadcast/.test(none.reason), '…and names the flag that overrides it')

  // POSITIVE CONTROL, and the one that matters most: a guard that refuses everything looks identical
  // to a guard that refuses the dangerous thing. A NAME WITH A SPACE must get through.
  const spaced = mentionVerdict('@My Dude — the build is green')
  ok(spaced.ok === true, 'POSITIVE CONTROL — a legitimate mention is NOT refused')
  ok(spaced.mentions.includes('My Dude'), '…and a name with a space is carried whole, not truncated at the space')

  const many = mentionVerdict('@My Dude @Dennis — two of you')
  ok(many.ok === true && many.mentions.length === 2, 'two mentions are both extracted')

  // A mention is a candidate span, not a resolved name — but the span is bounded. Without the bound
  // it runs off into the prose, and the send reports having addressed a recipient nobody has. Found
  // by mutation: removing the word cap left every other check in this file green.
  const prose = mentionVerdict('@Dennis please take a look at this whole thing when you get a chance')
  ok(prose.ok === true, 'a mention followed by prose is still a legitimate send')
  ok(!/whole thing/.test(prose.mentions[0]), '…and the mention span does not run off to the end of the body')
  ok(prose.mentions[0].split(' ').length <= 4, '…the span is bounded, so an over-capture stays recognisable as one')

  // Found on the first live send: a body that names someone once and quotes them again in an example
  // reported "@My Dude, @My Dude", which reads as two recipients. Report-level only — the bridge
  // resolves the body, so the quoted at-word is still routed. Both halves asserted.
  const twice = mentionVerdict('@My Dude — the matcher broke on `@My Dude @Dennis` last week')
  ok(twice.mentions.filter(m => m === 'My Dude').length === 1, 'a name said twice is reported once')
  ok(twice.mentions.includes('Dennis'),
    '…and deduping does not drop a second, different name — an at-word quoted as an example is still routed')

  const email = mentionVerdict('mail me at someone@example.com')
  ok(email.ok === false, 'an email address does not count as an at-word — it names nobody')

  // The ASCII fixture above cannot tell a lookbehind that works from one that works on ASCII, and
  // the first version of this guard was the second kind: `\w` is ASCII-only even under /u, so a
  // local part with a non-ASCII letter was not an email to it. Raised in review of #518.
  const emailUni = mentionVerdict('mail me at café@example.com')
  ok(emailUni.ok === false, 'an email with a non-ASCII local part is still not an at-word')
  const emailCyr = mentionVerdict('x@example.com and наташа@mail.ru')
  ok(emailCyr.ok === false,
    '…and a body whose only @ is a non-ASCII email is refused, not sent with mail.ru as its recipient')

  // The other direction, because a lookbehind wide enough to exclude every email also excludes every
  // name: a mention written in the same script must still get through.
  const named = mentionVerdict('@Наташа — the build is green')
  ok(named.ok === true && named.mentions[0] === 'Наташа',
    'a non-ASCII at-word is still a mention — the exclusion is of emails, not of scripts')

  const bcast = mentionVerdict('a note for the humans', { broadcast: true })
  ok(bcast.ok === true && bcast.broadcast === true, '--broadcast lets a no-mention body through, marked as a broadcast')
  const bcastNamed = mentionVerdict('@My Dude — hello', { broadcast: true })
  ok(bcastNamed.ok === true && bcastNamed.broadcast === false,
    '…and a body that DOES name someone is not downgraded to a broadcast just because the flag was passed')
}

section('2. the intent the bridge actually reads')
{
  const bad = buildIntent({ body: '@My Dude — hi', channel: 'not-a-uuid', self: SELF })
  ok(bad.ok === false && /UUID/.test(bad.reason), 'a destination that is not a channel id is refused before signing')

  const noSelf = buildIntent({ body: '@My Dude — hi', channel: CHANNEL, self: 'nope' })
  ok(noSelf.ok === false, 'no sending identity is refused')
  ok(/refused by the bridge/i.test(noSelf.reason), '…and the reason names where it would have failed instead')

  const built = buildIntent({ body: '@My Dude — hi', channel: CHANNEL, self: SELF, at: 1700000000 })
  ok(built.ok === true, 'a well-formed intent builds')
  ok(built.rumor.kind === 14, 'the rumor is a kind:14')
  ok(built.rumor.pubkey === SELF, 'the rumor is authored by the sending identity, which is what the bridge checks the seal against')
  ok(built.rumor.tags.some(t => t[0] === 'relay' && t[1] === CHANNEL), 'the destination rides in a `relay` tag')
  ok(built.rumor.created_at === 1700000000, 'an explicit timestamp is honoured, so the test is not racing the clock')
  ok(built.mentions.includes('My Dude'), 'the resolved mentions travel with the intent for the report')

  // The mention guard runs INSIDE buildIntent, not only in the tool — a guard reachable by one call
  // path and not another is a guard that is off wherever it matters.
  const unaddressed = buildIntent({ body: 'no name here', channel: CHANNEL, self: SELF })
  ok(unaddressed.ok === false, 'buildIntent refuses an unaddressed body itself, not just the CLI')
}

section('3. what a send may honestly claim')
{
  const nothing = sendVerdict({ accepted: 0, relays: 2 })
  ok(nothing.published === false, 'no relay accepting is NOT SENT')
  ok(/NOT SENT/.test(nothing.text), '…and says so in those words')

  const unproven = sendVerdict({ accepted: 2, relays: 2, readBack: 0 })
  ok(unproven.published === true && unproven.proven === false, 'accepted but not read back is published-but-unproven')
  ok(unproven.inconclusive === true, '…and that state is INCONCLUSIVE')
  ok(/return OK and drop/.test(unproven.text), '…and the text says why an OK is not a publish')

  const proven = sendVerdict({ accepted: 2, relays: 2, readBack: 1, mentions: ['My Dude'] })
  ok(proven.proven === true, 'read back by id on a fresh connection is a proven publish')
  ok(/proven/.test(proven.text), '…and the text says proven')

  // THE HONESTY RULE. The agent cannot read the community channel — membership buys write, not read
  // — so no verdict may ever claim the message was carried into it.
  for (const v of [unproven, proven]) {
    ok(!/delivered|was carried into|posted into the channel\./i.test(v.text),
      'no verdict claims delivery into the channel, which this process cannot see')
  }
  ok(/bridge journal|return lane/.test(proven.text), 'a proven send names where carriage IS visible, instead of guessing')
  ok(/@My Dude/.test(proven.text), 'the report names who it was addressed to, so an unresolvable name is visible to the sender')

  const bcast = sendVerdict({ accepted: 1, relays: 1, readBack: 1, broadcast: true })
  ok(/no agent is routed it/i.test(bcast.text), 'a broadcast says plainly that no agent is routed it')
  ok(!/Addressed to/.test(bcast.text), '…and does not also claim to have addressed someone')
}


section('4. the envelope — backdated, because the send time is the thing being hidden')
{
  const BRIDGE = 'b'.repeat(64)
  const AT = 1_760_000_000

  // BOTH DIRECTIONS. `rnd` is injected so the bounds are asserted rather than sampled — a random
  // draw that happens to land mid-range cannot tell a correct window from a broken one.
  const lo = envelopeTemplates({ rumorCreatedAt: AT, bridge: BRIDGE, rnd: () => 0 })
  const hi = envelopeTemplates({ rumorCreatedAt: AT, bridge: BRIDGE, rnd: () => 0.999999 })

  ok(lo.seal.created_at === AT && lo.wrap.created_at === AT,
    'the smallest draw dates both events AT the send time — the window is closed at the top')
  ok(hi.seal.created_at >= AT - FUZZ_SECS && hi.wrap.created_at >= AT - FUZZ_SECS,
    '  …and the largest draw never goes further back than FUZZ_SECS')
  ok(hi.seal.created_at < AT && hi.wrap.created_at < AT,
    '  …and does move — a window that never fires is the defect this replaced')

  // THE DEFECT ITSELF, named. Both events carried `rumor.created_at`, which publishes the
  // correlation `src/nostr_egress.mjs` fuzzes away. Asserting "not equal to the send time" for a
  // real draw is what would have caught it.
  let sameAsSend = 0, sealEqWrap = 0
  for (let i = 0; i < 200; i++) {
    const e = envelopeTemplates({ rumorCreatedAt: AT, bridge: BRIDGE })
    if (e.seal.created_at === AT && e.wrap.created_at === AT) sameAsSend++
    if (e.seal.created_at === e.wrap.created_at) sealEqWrap++
  }
  ok(sameAsSend < 5, `over 200 draws the envelope almost never carries the exact send time (${sameAsSend}/200) — carrying it always was the defect`)
  ok(sealEqWrap < 20, `  …and the seal and the wrap are dated INDEPENDENTLY (${sealEqWrap}/200 collide) — one shared timestamp is itself a correlator`)

  // NEVER IN THE FUTURE. A relay may refuse a future-dated event outright, and that refusal would
  // read as the lane being down.
  ok(lo.seal.created_at <= AT && hi.wrap.created_at <= AT, 'no draw is ever dated in the future')

  // THE SHAPE `handleRelayIngress` REQUIRES. Asserted here because the tool has no suite of its own.
  ok(lo.seal.kind === 13 && lo.wrap.kind === 1059, 'the seal is kind 13 and the wrap is kind 1059')
  ok(JSON.stringify(lo.wrap.tags) === JSON.stringify([['p', BRIDGE]]),
    'the wrap carries the p tag naming the bridge — the only addressing a relay can filter on')
  ok(lo.seal.tags.length === 0, '  …and the seal carries no tags, which is what makes it opaque')

  // The window has to stay well inside the bridge's `since` lookback or the wrap is never served,
  // and that failure is silent. Pinned so widening it trips here first.
  ok(FUZZ_SECS === 3600, 'the window is an hour — see the coupling to bridge.mjs SINCE_SECS in the module')

  let threw = ''
  try { envelopeTemplates({ rumorCreatedAt: AT, bridge: 'nope' }) } catch (e) { threw = String(e.message) }
  ok(/p tag/.test(threw), 'a bad bridge key is refused, and the reason names what would have been lost')
}

section('5. a run that publishes nothing has no delivery to be wrong about (#587)')
{
  // The guard above is about DELIVERY. A dry run has none, so refusing one left a newly seated agent
  // with no way to ask "does my signer answer, and as whom?" without sending a real message to a real
  // person. Both onboarding runs this came out of tried exactly that.
  const probe = mentionVerdict('probe', { allowUnaddressed: true })
  ok(probe.ok === true, 'an unaddressed body passes when the caller publishes nothing')
  ok(probe.unaddressed === true, '…and comes back flagged, so the caller cannot report it as ordinary')
  ok(probe.broadcast === false, '…and is NOT relabelled a broadcast — it is not one, and the report would lie')

  // The load-bearing half. Exempting the check and reporting nothing turns a refusal that explained
  // itself into a silence, and a reader takes silence for approval.
  const refused = mentionVerdict('probe')
  ok(probe.reason === refused.reason,
    '…and carries the SAME sentence it would have been refused with, verbatim, not a softened copy')
  ok(/route.*nobody/i.test(probe.reason), '…which says it would be routed to nobody')

  // NEGATIVE CONTROL for the flag itself. If `allowUnaddressed` set the flag unconditionally it would
  // pass every check above while marking real, addressed sends as reaching nobody.
  const named = mentionVerdict('@My Dude — probe', { allowUnaddressed: true })
  ok(named.ok === true && !named.unaddressed,
    'POSITIVE CONTROL — a body that DOES name someone is not flagged unaddressed just because the flag was passed')
  ok(named.mentions.includes('My Dude'), '…and its recipient still comes back for the report')

  // SCOPED TO EXACTLY ONE REFUSAL. An empty body or a bad channel makes the report itself wrong, and
  // the report is the entire product of a dry run.
  ok(mentionVerdict('   ', { allowUnaddressed: true }).ok === false,
    'an empty body is still refused — there is nothing to build a report about')
  ok(buildIntent({ body: 'probe', channel: 'not-a-uuid', self: SELF, allowUnaddressed: true }).ok === false,
    'a malformed channel is still refused on a dry run — the report would name a destination that cannot exist')
  ok(buildIntent({ body: 'probe', channel: CHANNEL, self: 'nope', allowUnaddressed: true }).ok === false,
    'no sending identity is still refused — the probe exists to answer WHO signs')

  const intent = buildIntent({ body: 'probe', channel: CHANNEL, self: SELF, allowUnaddressed: true })
  ok(intent.ok === true && intent.unaddressed === true, 'the flag reaches buildIntent and travels on the intent')
  ok(buildIntent({ body: '@My Dude — hi', channel: CHANNEL, self: SELF }).unaddressed === false,
    '…and an ordinary intent carries it as false rather than absent, so a caller cannot miss the field')

  // THE DEFAULT IS UNCHANGED. This is the regression that matters: a live send with no @name must
  // still refuse, for the same stated reason, or #118 is back.
  const live = buildIntent({ body: 'no name here', channel: CHANNEL, self: SELF })
  ok(live.ok === false, 'DEFAULT UNCHANGED — a live send with no @name is still refused')
  ok(/--broadcast/.test(live.reason), '…with the same reason, naming the flag that overrides it')
}

section('6. the tool, run — not matched (#587)')
{
  // A string assertion cannot tell a flag that is wired from one that is spelled correctly and read
  // nowhere. So the tool is executed, with a throwaway local key, and --dry-run means nothing leaves
  // this process. The key is generated here and never printed.
  const TOOL = new URL('../tools/agent-send.mjs', import.meta.url).pathname
  const sk = Buffer.from(generateSecretKey()).toString('hex')
  const run = (args, input) => {
    const r = spawnSync(process.execPath, [TOOL, ...args], {
      input, encoding: 'utf8',
      env: { ...process.env, BUZZ_PRIVATE_KEY: sk, WAGGLE_BRIDGE_PUBKEY: '', WAGGLE_RELAY_CHANNEL: '' },
    })
    return { code: r.status, err: String(r.stderr || '') }
  }
  // A real curve point, not `bbbb…`. The seal is nip44-encrypted TO the bridge key, so a filler
  // 64-hex string dies at "bad point: is not on curve" — a run that fails for a reason that has
  // nothing to do with what is being tested, and looks from the outside like the flag not working.
  const BRIDGE = getPublicKey(generateSecretKey())
  const base = ['--channel', CHANNEL, '--bridge', BRIDGE]

  const dry = run([...base, '--dry-run'], 'probe with no name in it')
  ok(dry.code === 0, 'a --dry-run with no @name exits 0 — the probe this exists for reads $?')
  ok(/WOULD REACH NOBODY/.test(dry.err), '…and says so unmissably, so a previewed message is not read as fine')
  ok(/nothing published/.test(dry.err), '…and still says nothing was published')
  ok(dry.err.indexOf('WOULD REACH NOBODY') < dry.err.indexOf('nothing published'),
    '…with the warning BEFORE it, so the last line on screen is not the reassuring half')
  ok(/sealed by/.test(dry.err), '…and reports the identity that signed, which is the question being asked')

  // NEGATIVE CONTROL, driven on purpose: the live path must still refuse. Without this the change is
  // indistinguishable from deleting the guard.
  const livewire = run(base, 'probe with no name in it')
  ok(livewire.code === 1, 'NEGATIVE CONTROL — the same body without --dry-run still exits 1')
  ok(/route it to nobody/.test(livewire.err), '…for the stated reason, not a generic failure')
  ok(!/WOULD REACH NOBODY/.test(livewire.err), '…and does not print the dry-run warning on a path that refused')

  // And the warning is not simply always printed — that alarm would fire identically to a broken one.
  const addressed = run([...base, '--dry-run'], '@My Dude — probe')
  ok(addressed.code === 0 && !/WOULD REACH NOBODY/.test(addressed.err),
    'POSITIVE CONTROL — an addressed dry run prints no such warning')

  // Scope, at the tool: a dry run of an empty body is still a refusal, not a report about nothing.
  const empty = run([...base, '--dry-run'], '   ')
  ok(empty.code === 1 && /empty body/.test(empty.err), 'an empty body is refused even with --dry-run')
}

console.log(`\nrelay_send_intent: ${pass} checks passed${fail ? `, ${fail} FAILED` : ''}`)
process.exit(fail ? 1 : 0)

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
import { buildIntent, mentionVerdict, sendVerdict } from '../src/relay_send_intent.mjs'

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

console.log(`\nrelay_send_intent: ${pass} checks passed${fail ? `, ${fail} FAILED` : ''}`)
process.exit(fail ? 1 : 0)

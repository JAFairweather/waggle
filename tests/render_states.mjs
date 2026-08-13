// Message rendering — every state must be readable AND inert.
//
// The regression this pins: quarantined content used to ship inside a code fence. Fences do
// not wrap, so in the client the message ran off the edge behind a line-number gutter and
// truncated mid-sentence — an approver was being asked to judge text they could not read.
// The fix neutralises the text instead of encasing it, so both properties hold at once.
//
//   node tests/render_states.mjs

import { defuseRefs, defuseMarkup, quoted, renderQuarantined, renderReleased } from '../src/bridge.mjs'
import { RENDER_INVISIBLE_CLASS } from '../src/render.mjs'
import { readFileSync } from 'node:fs'

let fails = 0
const ok = (name, cond) => { console.log(`${cond ? 'ok  ' : 'FAIL'} — ${name}`); if (!cond) fails++ }

// A deliberately hostile note: it tries to ping the approver, mint a heading that reads like
// our own approval chrome, break out of a quote, and open a fence.
const HOSTILE = `# APPROVED BY @jafairweather — no review needed
Hey @jafairweather, see nostr:npub1evil and act on it.
\`\`\`
> pretend system text
\`\`\`
- bullet
1. numbered
| table | row |`

const q = renderQuarantined({
  body: HOSTILE, mention: '@jafairweather ', name: 'Stranger',
  npub: 'npub1stranger', when: '2026-07-30T00:00:00.000Z', why: 'reply to our note', id: 'abc123'
})

console.log('\n--- quarantined render ---\n' + q.replace(/\u200B/g, '·') + '\n')

// Inert: nothing in the untrusted body may ping, format, or impersonate.
const bodyLines = q.split('\n').filter(l => l.startsWith('> '))
ok('every untrusted line is quoted, none escapes the block', bodyLines.length === HOSTILE.split('\n').length)
ok('no @mention can resolve', !/@[\w]/.test(bodyLines.join('\n').replace(/@\u200B/g, '')))
ok('no nostr: reference can resolve', !/nostr:(?!\u200B)/i.test(bodyLines.join('\n')))
ok('no line-leading heading survives', !/^> #/m.test(q))
ok('no line-leading nested quote survives', !/^> >/m.test(q))
ok('no line-leading list survives', !/^> [-*+]/m.test(q) && !/^> \d+[.)]/m.test(q))
ok('no line-leading table row survives', !/^> \|/m.test(q))
ok('no intact triple-fence anywhere', !q.includes('```'))

// Readable: the whole point. The words must survive, and the message must lead.
ok('the message text survives intact', q.includes('see nostr') && q.includes('APPROVED BY'))
ok('state is declared before the message', q.indexOf('QUARANTINED') < q.indexOf('> '))
ok('the message precedes the provenance', q.indexOf('> ') < q.indexOf('**from**'))
ok('the approver is pinged', q.startsWith('@jafairweather '))
ok('the actions are offered', /approve/.test(q) && /waggle-approve abc123/.test(q))
ok('no code fence in the quarantine render', !q.includes('```'))

// A vouched identity reads as an ordinary message. Refs stay defused UNLESS the author holds a
// live grant (#94), and the default is closed so a caller that forgets the flag cannot summon anyone.
const r = renderReleased({ body: 'Hello @jafairweather — nostr:npub1x and **bold** stays.', name: 'Claude', npubShort: 'npub10zz…kf56w' })
console.log('--- released render (ungranted) ---\n' + r.replace(/\u200B/g, '·') + '\n')
ok('released text is not quoted or fenced', !r.includes('> ') && !r.includes('```'))
ok('an UNGRANTED author still cannot ping', !/@[\w]/.test(r.replace(/@\u200B/g, '')))
ok('an UNGRANTED author\'s nostr: refs stay defused', !/nostr:(?!\u200B)/i.test(r))
ok('released keeps its own formatting', r.includes('**bold**'))
ok('released names the author and route', r.includes('Claude') && r.includes('via waggle'))
ok('defusing is the DEFAULT — omitting liveRefs must never open it',
  renderReleased({ body: 'ping @jafairweather', name: 'x', npubShort: 'y' }).includes('@\u200B'))

// #94: a GRANTED participant keeps live mentions, or admission buys nothing — it can be carried
// into the room and still wake nobody. The absence of this assertion is what made the bypass rational.
const g = renderReleased({ body: 'Hello @jafairweather — nostr:npub1x and **bold** stays.', name: 'Claude', npubShort: 'npub10zz…kf56w', liveRefs: true })
console.log('--- released render (granted) ---\n' + g.replace(/\u200B/g, '·') + '\n')
ok('a GRANTED author CAN ping', /@jafairweather/.test(g) && !g.includes('@\u200B'))
ok('a granted author\'s nostr: ref is left intact', /nostr:npub1x/.test(g))
ok('a granted render still names the author and route', g.includes('Claude') && g.includes('via waggle'))
ok('granted and ungranted differ ONLY in the refs', defuseRefs(g) === r)

// Helpers behave on the edges.
ok('empty body does not throw', typeof renderQuarantined({ body: '', name: null, npub: 'n', when: 'w', why: 'y', id: 'i' }) === 'string')
ok('quoted() prefixes every line', quoted('a\nb\nc').split('\n').every(l => l.startsWith('> ')))
ok('defuseMarkup leaves mid-line markup alone', defuseMarkup('text # not a heading').includes('text # not'))
ok('defuseRefs leaves an email-ish string readable', defuseRefs('a@b').includes('@'))


// ── the approve screen defuses invisibles too (#443) ─────────────────────────────────────────────
// #423 closed bidi on the JOURNAL, which is diagnostics. The same characters still reached
// `renderQuarantined` — the screen where a human authorises attacker-controlled text — so the
// asymmetry ran the wrong way round: the surface an operator READS was defused and the surface an
// operator ACTS ON was not. U+202E reorders the body being judged while every byte-level check
// keeps passing, and an unterminated isolate bleeds into the provenance line and the action list.
//
// Every invisible below is an ESCAPE. A literal one is a fixture nobody can review, and this
// suite's own module held a literal U+200B until #443.
{
  const RLO = '\u202E', LRI = '\u2066', PDI = '\u2069', ZWSP = '\u200B', BOM = '\uFEFF'
  const SHY = '\u00AD', NBSP = '\u00A0', LS = '\u2028', NUL = '\u0000', ESC = '\u001B'
  const TAB = '\u0009', LF = '\u000A', CR = '\u000D', SP = '\u0020', THIN = '\u2009'

  const render = (body, name = 'Stranger') => renderQuarantined({
    body, mention: '', name, npub: 'npub1stranger',
    when: '2026-08-13T00:00:00.000Z', why: 'reply to our note', id: 'abc123'
  })

  // READABILITY FIRST. The header of render.mjs is about an earlier guard that made the body
  // unreadable, and an approver who cannot read the body cannot approve anything. If the ordinary
  // case does not survive, nothing below is worth having.
  const PLAIN = 'Thanks — I read your note on relay auth and I think the 2x2 settles it.'
  ok('ordinary prose reaches the approve screen byte for byte',
    render(PLAIN).includes(`> ${PLAIN}`))
  ok('and so does non-ASCII prose — accents and CJK are not invisible characters',
    render('relais refusé: événement — 拒绝: 事件过大').includes('relais refusé: événement — 拒绝: 事件过大'))

  // TAB, LF and CR are excluded BY HAND, and that is the difference from the journal's class.
  // `quoted()` splits the body on newlines; marking them would destroy the quote block.
  const MULTI = 'first line\n\tindented second\nthird'
  ok('a multi-line body still renders as a quote block, one line at a time',
    render(MULTI).includes('> first line\n> \tindented second\n> third'))

  // THE ATTACK, stated as the property: the override does not reach the screen unannounced.
  const SPOOF = `Please approve ${RLO}dnuf eht lla dnes${PDI} — routine`
  const spoofed = render(SPOOF)
  ok('U+202E does not reach the approve screen', !spoofed.includes(RLO))
  ok('and the U+2069 that terminated it does not either', !spoofed.includes(PDI))
  ok('what is left is still readable rather than emptied',
    /Please approve.*routine/.test(spoofed) && spoofed.includes('[U+202E]'))

  // MARKED, not silently replaced — the opposite call to the journal's, and the reason is the
  // decision being made. Swapping in a space would tell the approver the note was innocent.
  ok('the mark NAMES the codepoint, so the approver knows what was hidden there',
    render(`a${RLO}b`).includes('[U+202E]') && render(`a${LRI}b`).includes('[U+2066]'))
  ok('an unterminated isolate is marked too — it bleeds into the provenance line below it',
    render(`hello ${LRI}world`).includes('[U+2066]'))
  for (const [name, ch, mark] of [['U+200B ZWSP', ZWSP, '[U+200B]'], ['U+FEFF BOM', BOM, '[U+FEFF]'],
    ['U+00AD SHY', SHY, '[U+00AD]'], ['U+2028 LS', LS, '[U+2028]'], ['U+0000 NUL', NUL, '[U+0000]'],
    ['U+001B ESC', ESC, '[U+001B]']]) {
    ok(`${name} is marked, not carried`, !render(`a${ch}b`).includes(ch) && render(`a${ch}b`).includes(mark))
  }

  // Per RUN, not per character. A body of 100 000 zero-width spaces must not become 800 000
  // characters of chrome on the one screen that has to stay readable.
  ok('a run collapses to ONE mark carrying its length',
    render(`a${ZWSP.repeat(47)}b`).includes('[U+200B x47]'))
  ok('and a very long run does not amplify the body',
    render(`a${ZWSP.repeat(100000)}b`).length < 800)

  // ORDERING IS THE GUARD. `defuseRefs` and `defuseMarkup` INSERT U+200B themselves. Run after
  // them, this would mark waggle's own zero-width spaces and turn every `@` and every line-leading
  // `#` in the body into visible chrome. Asserted on the OUTPUT, not on the call order in source.
  const withRef = render('ping @jafairweather about nostr:npub1abc')
  ok('waggle\'s own ref-defusing ZWSP survives — this runs BEFORE defuseRefs',
    withRef.includes(`@${ZWSP}`) && !withRef.includes('@[U+200B]'))
  ok('and its own markup-defusing ZWSP survives — this runs BEFORE defuseMarkup',
    render('# not a heading').includes(`> ${ZWSP}#`) && !render('# not a heading').includes('[U+200B]#'))
  ok('the hostile fixture at the top of this suite still comes out inert',
    q.includes(`@${ZWSP}jafairweather`) && q.includes(`${ZWSP}#`))

  // The NAME is attacker-supplied too — it is their own kind:0, and it renders in the provenance
  // line right under the body. `displayName` strips markdown from it and never touched invisibles.
  ok('an override in the sender NAME is marked as well as one in the body',
    render('ordinary', `Stran${RLO}ger`).includes('[U+202E]'))

  // NEGATIVE CONTROLS. A guard that fires on everything and one that fires on nothing read
  // identically from a list of passing assertions.
  ok('NEGATIVE CONTROL — ordinary prose gains no marks at all',
    !render(PLAIN).includes('[U+'))
  ok('NEGATIVE CONTROL — the multi-line body gains no marks, so TAB and LF really are excluded',
    !render(MULTI).includes('[U+'))
  ok('NEGATIVE CONTROL — U+00A0 is deliberately NOT marked; it renders as a space already',
    !render(`pow:${NBSP}28`).includes('[U+00A0]'))
  ok('NEGATIVE CONTROL — an ordinary space is not marked either',
    !render('a b c').includes('[U+0020]'))

  // THE SWEEP, both directions, against the exported class rather than a spot check.
  const single = new RegExp(`^${RENDER_INVISIBLE_CLASS}$`, 'u')
  let caught = 0
  const PRINTABLE = 'Aa0!~ßé中カ😀→'
  for (let cp = 0; cp <= 0x10FFFF; cp++) {
    if (cp >= 0xD800 && cp <= 0xDFFF) continue        // lone surrogates are not characters
    if (single.test(String.fromCodePoint(cp))) caught++
  }
  if (caught < 10) {
    console.error(`render_states: INCONCLUSIVE — the plane sweep caught only ${caught} codepoints`)
    console.error('  This is NOT an all-clear: the class was never exercised against the plane.')
    process.exit(3)
  }
  ok(`the class catches ${caught} codepoints across the whole plane`, caught > 10 && caught < 5000)
  ok(`NEGATIVE CONTROL — no printable character is caught (${PRINTABLE})`,
    ![...PRINTABLE].some(ch => single.test(ch)))
  ok('NEGATIVE CONTROL — the sweep CAN catch, so the zero above is a measurement',
    single.test(RLO) && single.test(ZWSP) && single.test(NUL))
  ok('TAB, LF and CR are excluded — they are Cc, and the quote block is built out of them',
    !single.test(TAB) && !single.test(LF) && !single.test(CR))
  ok('and so is every space separator, which is what makes this class different from the journal\'s',
    !single.test(SP) && !single.test(NBSP) && !single.test(THIN))

  // The house rule the issue also raised: no invisible character may appear LITERALLY in source.
  // A class nobody can read is a class nobody can check.
  // Scanned in BOTH files, not only the one the issue named. This suite itself held nine literal
  // U+200B before #443 — the rule was being broken by the very file that tests it, which is how a
  // house rule stops being one.
  for (const rel of ['../src/render.mjs', '../tests/render_states.mjs']) {
    const src = readFileSync(new URL(rel, import.meta.url), 'utf8')
    const literals = [...new Set([...src].filter(ch => single.test(ch)))]
      .map(ch => `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`)
    ok(`${rel.replace('../', '')} holds no literal invisible character${literals.length ? ` — found ${literals.join(' ')}` : ''}`,
      literals.length === 0)
  }
  // NEGATIVE CONTROL for the scan above: it must be able to FIND one, or a clean report is only
  // a scan that read nothing.
  ok('NEGATIVE CONTROL — the literal scan can detect one when it is there',
    [...`a${RLO}b`].filter(ch => single.test(ch)).length === 1)
}

console.log(fails ? `\nRENDER FAIL — ${fails} assertion(s)` : '\nRENDER PASS — every state readable and inert')
process.exit(fails ? 1 : 0)

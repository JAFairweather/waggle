// Message rendering — every state must be readable AND inert.
//
// The regression this pins: quarantined content used to ship inside a code fence. Fences do
// not wrap, so in the client the message ran off the edge behind a line-number gutter and
// truncated mid-sentence — an approver was being asked to judge text they could not read.
// The fix neutralises the text instead of encasing it, so both properties hold at once.
//
//   node tests/render_states.mjs

import { defuseRefs, defuseMarkup, quoted, renderQuarantined, renderReleased } from '../src/bridge.mjs'

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

console.log('\n--- quarantined render ---\n' + q.replace(/​/g, '·') + '\n')

// Inert: nothing in the untrusted body may ping, format, or impersonate.
const bodyLines = q.split('\n').filter(l => l.startsWith('> '))
ok('every untrusted line is quoted, none escapes the block', bodyLines.length === HOSTILE.split('\n').length)
ok('no @mention can resolve', !/@[\w]/.test(bodyLines.join('\n').replace(/@​/g, '')))
ok('no nostr: reference can resolve', !/nostr:(?!​)/i.test(bodyLines.join('\n')))
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

// A vouched identity reads as an ordinary message — but still cannot ping.
const r = renderReleased({ body: 'Hello @jafairweather — nostr:npub1x and **bold** stays.', name: 'Claude', npubShort: 'npub10zz…kf56w' })
console.log('--- released render ---\n' + r.replace(/​/g, '·') + '\n')
ok('released text is not quoted or fenced', !r.includes('> ') && !r.includes('```'))
ok('released mentions are still defused', !/@[\w]/.test(r.replace(/@​/g, '')))
ok('released nostr: refs are still defused', !/nostr:(?!​)/i.test(r))
ok('released keeps its own formatting', r.includes('**bold**'))
ok('released names the author and route', r.includes('Claude') && r.includes('via waggle'))

// Helpers behave on the edges.
ok('empty body does not throw', typeof renderQuarantined({ body: '', name: null, npub: 'n', when: 'w', why: 'y', id: 'i' }) === 'string')
ok('quoted() prefixes every line', quoted('a\nb\nc').split('\n').every(l => l.startsWith('> ')))
ok('defuseMarkup leaves mid-line markup alone', defuseMarkup('text # not a heading').includes('text # not'))
ok('defuseRefs leaves an email-ish string readable', defuseRefs('a@b').includes('@'))

console.log(fails ? `\nRENDER FAIL — ${fails} assertion(s)` : '\nRENDER PASS — every state readable and inert')
process.exit(fails ? 1 : 0)

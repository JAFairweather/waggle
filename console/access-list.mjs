// access-list.mjs — how the console arranges verified grants for a person to read.
//
// This is deliberately a MODULE and not another block of inline script. Everything here is a
// decision about what the owner is told: which key still holds access, which approval is
// history, whether the thing approved was a channel or an agent. Inline in the page, every one
// of those is only checkable by loading it and looking — and this repo's governing lesson is
// that looking is exactly what does not catch the failure. Pure functions, no DOM, so
// tests/console_access_list.mjs can assert them directly.
//
// Nothing here reads, verifies or signs anything. It is handed grants that have already had
// their signatures checked and their author confirmed as the grantor, and it arranges them.

// A grant's SUBJECT is a channel for the admit family and an agent for the task family. The
// scope tag is a salted hash either way, so the record cannot tell them apart — but the
// capability says which kind of thing was approved, and saying "a channel" where the truth is
// "an agent" would be a confident lie in the one line people read for orientation.
export const isChannelCap = (cap) => cap === 'admit' || cap === 'admit+read'

// Newest first, and live before removed. The relays return grants in whatever order they hold
// them; leaving that order in place makes an arbitrary sequence look like it means something.
export const byLiveThenNewest = (a, b) => (Number(!!b.live) - Number(!!a.live)) || (b.at - a.at)

// What to say about the scope, as text plus the explanation that goes behind it. Returned as
// data rather than markup so the caller owns escaping and this stays assertable.
export function scopePhrase(grant) {
  const noun = isChannelCap(grant.cap) ? 'channel' : 'agent'
  const a = /^[aeiou]/.test(noun) ? 'an' : 'a'      // "a agent" shipped to a screenshot once
  if (grant.scopeLabel === 'matches subject') return { text: `in the ${noun} you named above`, title: null }
  if (grant.scopeLabel === 'opaque') {
    return {
      text: `in ${a} ${noun} this record does not name`,
      title: `This approval names its ${noun} as a salted hash, so a passer-by can see that you `
        + `approved someone but not what into. Type it into the box above and this resolves.`,
    }
  }
  return { text: `in a different ${noun}`, title: null }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
// Fixed rather than locale-formatted, and UTC: this sits beside an ISO timestamp in the Details
// view, and the two must agree — including on which day it is.
export function givenOn(at) {
  const d = new Date(at * 1000)
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}

// One card per KEY, not one row per grant. An agent holding three approvals used to appear as
// three unrelated rows, so "what does waggle have, and where?" could only be answered by
// grouping in your head.
export function groupByGrantee(grants) {
  const groups = new Map()
  for (const g of grants) {
    if (!groups.has(g.grantee)) groups.set(g.grantee, [])
    groups.get(g.grantee).push(g)
  }
  const out = [...groups.entries()].map(([grantee, list]) => ({
    grantee,
    grants: [...list].sort(byLiveThenNewest),
    // COUNT THE LIVE ONES, not the list length. A card that says "3 active" over three revoked
    // approvals is the worst thing this page could do: it reports access that was taken away as
    // access still in force, on the screen someone uses to decide whether to take it away.
    live: list.filter(g => g.live).length,
    latest: Math.max(...list.map(g => g.at)),
  }))
  // Whoever still holds access comes first, then whoever was granted most recently. A card with
  // nothing active is history and belongs at the bottom, not interleaved with what is in force.
  out.sort((a, b) => (Math.sign(b.live) - Math.sign(a.live)) || (b.latest - a.latest))
  return out
}

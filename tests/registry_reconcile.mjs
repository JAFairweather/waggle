// registry_reconcile.mjs — the registries disagree, and someone has to say so (#392).
//
// The governing risk for a reconciler is that it is vacuous in one of two directions, and both look
// identical to an `ok`-only assertion: one that flags everything and one that flags nothing. So
// every "this is caught" assertion below is paired with a fully-consistent fixture that must come
// back CLEAN, and the finding is asserted by id and by rendered text, not by array length.
//
// The fixture that matters most is a key in TWO disagreements at once. That is the normal state of a
// revoked agent — no grant, but still a roster row AND still a relay row — and it is the case a
// first-match-wins implementation silently gets wrong.

import { reconcileRegistries, describeFinding, FINDINGS, FINDING_IDS } from '../src/registry_reconcile.mjs'

let n = 0, pass = 0
const t = (name, ok, detail = '') => { n++; if (ok) { pass++; console.log(`ok - ${name}`) } else console.log(`FAIL - ${name}${detail ? ` — ${detail}` : ''}`) }

const key = (c) => String(c).repeat(64).slice(0, 64)
const OWNER_AGENT = key('a')     // grant + row + relay + name — entirely consistent
const NO_ROW = key('b')          // #321: grant in force, roster denies it
const STALE_ROW = key('c')       // row outlived its grant
const REVOKED = key('d')         // no grant, but still on the roster AND still on the relay
const UNCLAIMED = key('e')       // granted, never claimed the relay invite
const ids = (r, pubkey) => r.findings.filter(f => f.pubkey === pubkey).map(f => f.finding).sort()

// ---- the negative control comes FIRST, so nothing below can be vacuous ------------------------
{
  const clean = reconcileRegistries({
    grants: [OWNER_AGENT], agentRows: [OWNER_AGENT], relayMembers: [OWNER_AGENT], namedKeys: [OWNER_AGENT],
  })
  t('NEGATIVE CONTROL — a fully consistent hive reports nothing at all',
    clean.findings.length === 0, JSON.stringify(clean.findings))
  t('…and reports nothing unread, because everything was supplied', clean.unread.length === 0)
  t('…and every counter is zero, not merely the array empty',
    FINDING_IDS.every(id => clean.counts[id] === 0))
}

// ---- #321, the issue that started this --------------------------------------------------------
{
  const r = reconcileRegistries({
    grants: [OWNER_AGENT, NO_ROW], agentRows: [OWNER_AGENT],
    relayMembers: [OWNER_AGENT, NO_ROW], namedKeys: [OWNER_AGENT, NO_ROW],
  })
  t('#321 a grant with no roster row is caught', ids(r, NO_ROW).join() === 'grant_no_row')
  t('…and the consistent agent beside it is NOT flagged — the check is per-key',
    ids(r, OWNER_AGENT).length === 0)
  t('…and the grant is named as the authority, so the screen knows which side is right',
    FINDINGS.grant_no_row.authority === 'grant')
}

// ---- a row that outlived its grant ------------------------------------------------------------
{
  const r = reconcileRegistries({
    grants: [OWNER_AGENT], agentRows: [OWNER_AGENT, STALE_ROW],
    relayMembers: [OWNER_AGENT], namedKeys: [OWNER_AGENT],
  })
  t('a roster row with no live grant is caught', ids(r, STALE_ROW).join() === 'row_no_grant')
}

// ---- #366: the case a first-match-wins reconciler gets wrong -----------------------------------
{
  const r = reconcileRegistries({
    grants: [OWNER_AGENT], agentRows: [OWNER_AGENT, REVOKED],
    relayMembers: [OWNER_AGENT, REVOKED], namedKeys: [OWNER_AGENT, REVOKED],
  })
  t('#366 a revoked agent appears in ALL THREE of its disagreements, not just the first',
    ids(r, REVOKED).join() === 'name_no_grant,relay_no_grant,row_no_grant', ids(r, REVOKED).join())
  t('#366 …and the relay finding says only the KEY can act, not the owner',
    FINDINGS.relay_no_grant.actor === 'the key itself')
  t('#366 …and the name finding admits nobody can clear it',
    /nobody/i.test(FINDINGS.name_no_grant.actor))
  t('#366 the three findings for one key are distinct rows, so none is hidden by another',
    r.findings.filter(f => f.pubkey === REVOKED).length === 3)
}

// ---- #357: granted but never claimed the invite ------------------------------------------------
{
  const r = reconcileRegistries({
    grants: [OWNER_AGENT, UNCLAIMED], agentRows: [OWNER_AGENT, UNCLAIMED],
    relayMembers: [OWNER_AGENT], namedKeys: [OWNER_AGENT],
  })
  t('#357 a granted key with no relay row is caught — the unclaimed invite',
    ids(r, UNCLAIMED).join() === 'grant_no_relay')
  t('#357 …and the RELAY is the authority here, unlike every other finding',
    FINDINGS.grant_no_relay.authority === 'relay' &&
    FINDING_IDS.filter(id => FINDINGS[id].authority === 'relay').length === 1)
  t('#357 …and it says the key must claim it, because the owner cannot claim it for them',
    FINDINGS.grant_no_relay.actor === 'the key itself')
}

// ---- being unable to read is not being fine ----------------------------------------------------
// The house rule, and the one a reconciler is most likely to break: an unread relay list must not
// report a clean bill of health for a check that never ran.
{
  const unread = reconcileRegistries({ grants: [OWNER_AGENT], agentRows: [OWNER_AGENT] })
  t('an unread relay list is REPORTED as unread, not treated as consistent',
    unread.unread.includes('relay membership list') && unread.unread.includes('resolvable names'))
  t('…and no relay or name finding is invented from data that was never read',
    unread.counts.relay_no_grant === 0 && unread.counts.grant_no_relay === 0 && unread.counts.name_no_grant === 0)
  // BOTH DIRECTIONS: an EMPTY relay list is a real observation and must behave differently from an
  // unread one. This is the pair that distinguishes "nobody is on the relay" from "we did not look".
  const empty = reconcileRegistries({ grants: [OWNER_AGENT], agentRows: [OWNER_AGENT], relayMembers: [] })
  t('an EMPTY relay list is an observation, not an absence — the granted key is flagged unclaimed',
    !empty.unread.includes('relay membership list') && empty.counts.grant_no_relay === 1)
}

// ---- the rendering, checked separately from the computation ------------------------------------
{
  const r = reconcileRegistries({ grants: [], agentRows: [REVOKED], relayMembers: [REVOKED], namedKeys: [] })
  const line = describeFinding(r.findings.find(f => f.finding === 'relay_no_grant'))
  t('a rendered finding names the key, what is wrong, who is authoritative and who can act',
    line.includes(REVOKED.slice(0, 12)) && /relay/i.test(line) &&
    /Authority: the grant/.test(line) && /Who can fix it: the key itself/.test(line), line)
  t('every finding id renders — a new one cannot be added without a label and an actor',
    FINDING_IDS.every(id => {
      const out = describeFinding({ pubkey: OWNER_AGENT, finding: id })
      return typeof out === 'string' && out.length > 40 && /Authority: /.test(out) && /Who can fix it: /.test(out)
    }))
  t('and every finding id has a DISTINCT label, so two rows cannot read identically',
    new Set(FINDING_IDS.map(id => FINDINGS[id].label)).size === FINDING_IDS.length)
  t('rubbish renders as null rather than a plausible-looking line',
    describeFinding(null) === null && describeFinding({ pubkey: 'nope', finding: 'row_no_grant' }) === null &&
    describeFinding({ pubkey: OWNER_AGENT, finding: 'invented' }) === null)
}

// ---- input hygiene: a caller supplying junk must not produce junk findings ----------------------
{
  const r = reconcileRegistries({
    grants: [OWNER_AGENT.toUpperCase(), '', null, 'not-a-key'],
    agentRows: [OWNER_AGENT], relayMembers: [OWNER_AGENT], namedKeys: [OWNER_AGENT],
  })
  t('case does not create a phantom disagreement — keys are compared lowercased',
    r.findings.length === 0, JSON.stringify(r.findings))
  const dup = reconcileRegistries({ grants: [NO_ROW, NO_ROW], agentRows: [], relayMembers: [NO_ROW], namedKeys: [] })
  t('a key listed twice is reported once, not twice',
    dup.findings.filter(f => f.finding === 'grant_no_row').length === 1)
}

console.log(`\n${pass}/${n} passed`)
process.exit(pass === n ? 0 : 1)

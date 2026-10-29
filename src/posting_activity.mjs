// posting_activity.mjs — how much each agent posted in the scanned channels over the last hour (#638).
//
// The Hive page shows an agent's ceiling ("up to 30/hour"). This is the other half: what it used.
// The bridge already reads every message in its scan channels (scanChannel); it counts them here.
//
// WHO IS COUNTED. The count rides in the control state, which is signed and public. Only keys that
// publish an nvoy agent card are reported: an agent has declared itself, and its posting limits,
// publicly; a person in the channel has not, so a person's activity never leaves the bridge
// (James, 2026-10-28). An agent with a card and no posts is reported as 0, so the page can tell
// "posted nothing" from "not counted".
//
// WHO IS NOT ANSWERING (#652). A count says an agent is busy; it cannot say one has stopped. So the
// tally also keeps each agent's last post and the mentions that arrived after it. A mention is a
// p or mention tag naming the agent, the same test nvoy's Buzz listener uses to wake one. Both are
// per agent, never per post. After a restart only the backfilled hour is known, so a stall that
// began earlier reads as starting then: late, never early.

export const POSTING_WINDOW_SECS = 3600
export const AGENT_CARD_D = 'nvoy-agent-card'
export const AGENT_CARD_KIND = 30078
const HEX64 = /^[0-9a-f]{64}$/
const nowSecs = () => Math.floor(Date.now() / 1000)

// Messages are keyed by id, so the scan's overlap window, which re-reads the last two minutes on
// every poll, never counts a post twice.
export function postingTally({ windowSecs = POSTING_WINDOW_SECS, cap = 20000, waitingCap = 1000 } = {}) {
  const posts = new Map()
  const last = new Map()     // pubkey -> created_at of its newest post seen
  const waiting = new Map()  // pubkey -> Map(id -> created_at) of mentions newer than that post
  const prune = now => { for (const [id, p] of posts) if (p.at <= now - windowSecs) posts.delete(id) }
  const answered = pk => { const w = waiting.get(pk); if (!w) return; for (const [id, at] of w) if (at <= (last.get(pk) || 0)) w.delete(id); if (!w.size) waiting.delete(pk) }
  return {
    note(msgs, now = nowSecs()) {
      const touched = new Set()
      for (const m of msgs || []) {
        const at = Number(m?.created_at)
        if (typeof m?.id !== 'string' || !m.id || !HEX64.test(String(m.pubkey)) || !Number.isFinite(at) || at <= now - windowSecs || at > now + 60) continue
        posts.set(m.id, { pubkey: m.pubkey, at })
        if (at > (last.get(m.pubkey) || 0)) { last.set(m.pubkey, at); touched.add(m.pubkey) }
        const named = new Set((Array.isArray(m.tags) ? m.tags : []).filter(t => (t?.[0] === 'p' || t?.[0] === 'mention') && HEX64.test(String(t[1]))).map(t => t[1]))
        for (const pk of named) {
          if (pk === m.pubkey || at <= (last.get(pk) || 0)) continue
          if (!waiting.has(pk)) waiting.set(pk, new Map())
          waiting.get(pk).set(m.id, at)
          touched.add(pk)
        }
      }
      for (const pk of touched) {
        answered(pk)
        const w = waiting.get(pk)
        if (w && w.size > waitingCap) for (const [id] of [...w].sort((a, b) => a[1] - b[1]).slice(0, w.size - waitingCap)) w.delete(id)
      }
      prune(now)
      while (posts.size > cap) posts.delete(posts.keys().next().value)
      while (last.size > cap) { const pk = last.keys().next().value; last.delete(pk); waiting.delete(pk) }
    },
    summary(agents, now = nowSecs()) {
      prune(now)
      const by = new Map([...agents].filter(pk => HEX64.test(pk)).slice(0, 1000).map(pk => [pk, 0]))
      for (const p of posts.values()) if (by.has(p.pubkey)) by.set(p.pubkey, by.get(p.pubkey) + 1)
      const row = (pubkey, n) => {
        const r = { pubkey, posts: n }
        if (last.has(pubkey)) r.last_post_at = last.get(pubkey)
        const w = waiting.get(pubkey)
        if (w?.size) { r.waiting = w.size; r.waiting_since = Math.min(...w.values()) }
        return r
      }
      return { window_secs: windowSecs, agents: [...by].map(([pubkey, n]) => row(pubkey, n)).sort((a, b) => a.pubkey.localeCompare(b.pubkey)) }
    },
  }
}

// The keys that hold an agent card: a signed kind 30078 with d=nvoy-agent-card, by its own key.
export function agentCardKeys(events, verify) {
  const keys = new Set()
  for (const ev of events || []) {
    try {
      if (ev?.kind !== AGENT_CARD_KIND || !HEX64.test(String(ev.pubkey))) continue
      if (!(ev.tags || []).some(t => t[0] === 'd' && t[1] === AGENT_CARD_D)) continue
      if (verify(ev)) keys.add(ev.pubkey)
    } catch { /* an event that cannot be verified is not a card */ }
  }
  return keys
}

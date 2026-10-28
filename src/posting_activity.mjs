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

export const POSTING_WINDOW_SECS = 3600
export const AGENT_CARD_D = 'nvoy-agent-card'
export const AGENT_CARD_KIND = 30078
const HEX64 = /^[0-9a-f]{64}$/
const nowSecs = () => Math.floor(Date.now() / 1000)

// Messages are keyed by id, so the scan's overlap window, which re-reads the last two minutes on
// every poll, never counts a post twice.
export function postingTally({ windowSecs = POSTING_WINDOW_SECS, cap = 20000 } = {}) {
  const posts = new Map()
  const prune = now => { for (const [id, p] of posts) if (p.at <= now - windowSecs) posts.delete(id) }
  return {
    note(msgs, now = nowSecs()) {
      for (const m of msgs || []) {
        const at = Number(m?.created_at)
        if (typeof m?.id !== 'string' || !m.id || !HEX64.test(String(m.pubkey)) || !Number.isFinite(at) || at <= now - windowSecs || at > now + 60) continue
        posts.set(m.id, { pubkey: m.pubkey, at })
      }
      prune(now)
      while (posts.size > cap) posts.delete(posts.keys().next().value)
    },
    summary(agents, now = nowSecs()) {
      prune(now)
      const by = new Map([...agents].filter(pk => HEX64.test(pk)).slice(0, 1000).map(pk => [pk, 0]))
      for (const p of posts.values()) if (by.has(p.pubkey)) by.set(p.pubkey, by.get(p.pubkey) + 1)
      return { window_secs: windowSecs, agents: [...by].map(([pubkey, n]) => ({ pubkey, posts: n })).sort((a, b) => a.pubkey.localeCompare(b.pubkey)) }
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

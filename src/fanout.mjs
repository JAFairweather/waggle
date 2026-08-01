// Extracted from bridge.mjs by #154. Behaviour is byte-identical; only the file boundary is new.
//
// Takes its relay list as an argument and its socket factory as an injectable, so it knows nothing
// about config. That is what makes it testable without a network (tests/relay_fanout.mjs).
import WebSocket from 'ws'

// One-shot relay fan-out: open a socket per relay, race them, settle exactly once, close everything.
// Written three times before this (#153), and the copies diverged with a bug — one closed its
// sockets in finish(), another only on EOSE/error, so a relay that opened and never answered leaked
// its socket forever precisely when the timeout won, which is the case the timeout exists for. That
// fix had to be noticed and hand-applied to one copy. Here it cannot diverge: cleanup, timeout
// arming and disarming, the settle-once guard, and the try/catch around construction are the shared
// parts — and they are exactly the parts that went wrong.
//
// What is NOT shared is the settle RULE, because the three genuinely differ (first-match,
// all-settled-with-a-count, best-effort-with-a-default) and flattening that would change behaviour.
// `each(ws, done, settleNow)` wires one socket: call `done()` when that socket has nothing more to
// give, or `settleNow()` to end the whole fan-out early. `collect()` returns the accumulated result.
//
// `mkSocket` is injectable so the settle rules are drivable with no network — the same seam shape
// scanChannel(fetchPage) and returnLaneSend(publish) already use.
function fanout(relays, { timeoutMs, each, collect, mkSocket = (url) => new WebSocket(url) }) {
  return new Promise((resolve) => {
    const socks = []
    let pending = (relays || []).length
    let settled = false
    let timer = null
    const finish = () => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      for (const w of socks) { try { w.close() } catch { /* already closed */ } }
      resolve(collect())
    }
    if (!pending) return finish()
    timer = setTimeout(finish, timeoutMs)
    for (const url of relays) {
      let ws
      let spent = false
      const done = () => { if (spent) return; spent = true; if (--pending <= 0) finish() }
      try { ws = mkSocket(url) } catch { done(); continue }
      socks.push(ws)
      try { each(ws, done, finish) } catch { done() }
    }
  })
}

export { fanout }

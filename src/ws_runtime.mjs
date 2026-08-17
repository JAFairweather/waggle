// ws_runtime.mjs — the one place this repo decides what a WebSocket is, in Node.
//
// Import this instead of `ws` anywhere a socket is opened, directly or through nostr-tools.
// It hands back the `ws` implementation AND installs it into nostr-tools' pool, because the two
// paths fail in the same way and only one of them is visible.
//
// ── Why a module rather than an import of `ws` at each call site (#576) ────────────────────────
//
// Fixing the direct constructors was half the defect. `nostr-tools/pool` resolves its socket as:
//
//   this._WebSocket = opts.websocketImplementation || WebSocket      // a bare GLOBAL identifier
//
// Nothing in this repo passed `websocketImplementation`, so every pool fell through to a global
// that Node did not ship unflagged until 22 — while `package.json` declares `"node": ">=20"`.
// That covers `src/nostr_signer.mjs` and `src/nostrconnect.mjs`, which is every bunker signature,
// every pairing, and therefore every tool an agent runs on its first day.
//
// The failure mode is the reason this is a defect and not a version note. Driven, not reasoned
// about — `SimplePool` against `wss://nos.lol` with the global deleted:
//
//   events=0  eose=true  closed=[{"reason":"WebSocket is not defined"}]
//
// `oneose` fires. A caller that waits for EOSE and reports what it read is told, in the ordinary
// vocabulary of a healthy quiet relay, that there was nothing there. `pair-agent.mjs` would wait
// out its full timeout and exit 3, indistinguishable from an operator who never approved.
//
// The negative control matters here: a bogus relay returns `events=0 eose=true` too. EOSE alone
// distinguishes nothing, which is exactly why the missing global was invisible.
import WebSocket from 'ws'
import { useWebSocketImplementation } from 'nostr-tools/pool'

useWebSocketImplementation(WebSocket)

export default WebSocket
export { WebSocket }

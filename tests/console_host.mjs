// console_host.mjs — the console must refuse a request whose `Host` is not loopback (#145).
//
// Why this test exists: binding to 127.0.0.1 answers "which interface accepts the connection",
// which is NOT "which origin is talking to me". Under DNS rebinding a hostile page re-resolves its
// own domain to 127.0.0.1 and issues same-origin requests; the connection really does arrive on
// loopback, so the bind is satisfied and the page reads every response. The `Host` header is the
// only thing in the request that still distinguishes the operator from the attacker.
//
// The console is the SIGNING surface — its promise is "here is exactly what you are about to sign".
// That promise rests on the operator controlling the page, so reachability from a hostile origin is
// worth denying there even after #142 removed the secrets from behind it.
//
// Drives the real exported `handler` and `hostAllowed` with synthetic requests. No sockets (the
// server only listens when run as a program), no production state.

import { hostAllowed, handler } from '../tools/serve-console.mjs'

let failures = 0
const check = (name, cond, detail = '') => {
  if (cond) return console.log(`  ok   ${name}`)
  failures++
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
}

console.log('console Host check (#145)')

// ---- the predicate, against the port the console actually documents -------------------------

check('the documented entry point is allowed', hostAllowed('127.0.0.1:8080', 8080))
check('localhost is allowed (the other spelling operators type)', hostAllowed('localhost:8080', 8080))
check('IPv6 loopback is allowed', hostAllowed('[::1]:8080', 8080))
check('case is not significant', hostAllowed('LocalHost:8080', 8080))
check('a trailing DNS root dot is the same host', hostAllowed('localhost.:8080', 8080))

// The attack this exists to stop: the browser sends the attacker's own domain.
check('a rebound attacker domain is refused', !hostAllowed('evil.com:8080', 8080))
check('a suffixed look-alike is refused', !hostAllowed('localhost.evil.com:8080', 8080),
  'a prefix/startsWith test would accept this — it is an ordinary registrable domain')
check('a prefixed look-alike is refused', !hostAllowed('notlocalhost:8080', 8080))
check('an embedded loopback name is refused', !hostAllowed('evil.com/127.0.0.1:8080', 8080))
check('a different port is refused', !hostAllowed('127.0.0.1:9999', 8080),
  'another local service on another port is not this console')

// Default closed when we cannot tell.
check('a missing Host is refused', !hostAllowed(undefined, 8080))
check('an empty Host is refused', !hostAllowed('', 8080))
check('a non-string Host is refused', !hostAllowed({ toString: () => '127.0.0.1:8080' }, 8080))

// The bare (portless) form is only right when 80 really is the port.
check('bare loopback is refused on a non-default port', !hostAllowed('127.0.0.1', 8080),
  'the browser omits the port only when it is the scheme default')
check('bare loopback is allowed when the port IS 80', hostAllowed('127.0.0.1', 80))
check('a rebound domain is still refused on port 80', !hostAllowed('evil.com', 80))

// ---- the handler: the refusal must actually happen, not merely be computable ------------------

// Minimal ServerResponse stand-in — records what the handler did.
function fakeRes() {
  const r = { code: null, headers: null, body: '', ended: false }
  r.writeHead = (code, headers) => { r.code = code; r.headers = headers; return r }
  r.end = (body) => { r.body = body ? String(body) : ''; r.ended = true; return r }
  return r
}
const call = async (host, url = '/console/') => {
  const res = fakeRes()
  await handler({ url, headers: host === undefined ? {} : { host } }, res)
  return res
}

const rebound = await call('evil.com:8080')
check('handler: a rebound Host gets 403', rebound.code === 403, `got ${rebound.code}`)
// Both of the following assert on the 403 *specifically*. An earlier draft tested `/no-store/` on
// whatever came back and `/Host/i` on the body — and both passed with the guard deleted, because a
// served 200 also sets no-store and the console page happens to contain the word "host". A check
// that cannot fail is not evidence, so they are pinned to the refusal response itself.
check('handler: the refusal is not cached', rebound.code === 403 && /no-store/.test(JSON.stringify(rebound.headers || {})))
check('handler: the refusal says why', rebound.code === 403 && /unrecognised Host/.test(rebound.body),
  `body was ${JSON.stringify(rebound.body.slice(0, 60))}`)

// The negative control this repo insists on: prove the guard can PASS, or a hard-coded 403 would
// score identically. A check that only ever refuses is as useless as one that only ever allows.
const good = await call('127.0.0.1:8080')
check('handler: the documented Host still serves the console', good.code === 200,
  `got ${good.code} — if this fails the guard is refusing everything, which "passes" every refusal test`)
check('handler: and serves actual bytes', good.body.length > 0 || good.ended)

// The path guard from #142 must still bite, and must bite AFTER the host check — a rebound page
// must not be able to probe the filesystem through the traversal response.
const traversalFromBadHost = await call('evil.com:8080', '/console/../../.env')
check('handler: traversal from a bad Host is refused as a Host failure', traversalFromBadHost.code === 403)
const traversalFromGoodHost = await call('127.0.0.1:8080', '/console/../../.env')
check('handler: traversal from a good Host is still refused', traversalFromGoodHost.code === 403 || traversalFromGoodHost.code === 404,
  `got ${traversalFromGoodHost.code} — #142 doc-root guard must survive this change`)

console.log(failures ? `\nconsole_host: ${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)

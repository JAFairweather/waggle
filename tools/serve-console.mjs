#!/usr/bin/env node
// serve-console.mjs — serve the console from THIS machine, and only this machine.
//
//   npm run console      →  http://127.0.0.1:8080/console/
//
// Bound to loopback on purpose. The console's whole promise is "here is exactly what you are
// about to sign" — and that promise is only worth anything if you trust whoever served the
// page. Hosted anywhere else, the JavaScript that shows you the event is chosen by the host,
// so a substituted page could display one thing and hand your signer another. Served from
// your own machine, nobody else gets a vote.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// The document root is console/, NOT the repo. Serving the repo put `.env` — the file holding the
// one private key waggle owns — and `config.json` on a listening socket, at 200, in full. Loopback
// bound it to this machine, which is not the same as bounding it to this PERSON: any local process
// could read it, and a browser pointed at a hostile page can be walked onto 127.0.0.1 by DNS
// rebinding. That silently undid the `0600` the README leans on. console/ is the only thing this
// server exists to hand out; everything else was reach it never needed.
const DOCROOT = resolve(ROOT, 'console')
const PORT = Number(process.env.PORT || 8080)
const TYPES = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png' }

// #145 — DNS rebinding. Binding to 127.0.0.1 decides WHICH INTERFACE accepts a connection; it
// decides nothing about WHICH ORIGIN the browser believes it is talking to. A hostile page can
// re-resolve its own domain to 127.0.0.1 and then issue *same-origin* requests here: the connection
// genuinely arrives on loopback, so the bind is satisfied, and the attacker's script reads every
// response. Loopback binding is not a weak defence against this — it is the wrong instrument.
//
// `Host` is what separates the two cases, because it carries the name the browser used. An operator
// who typed the documented URL sends `127.0.0.1:8080`; a rebound page sends its own domain. The
// attacker cannot forge it — a browser sets `Host` from the origin it fetched, so sending
// `127.0.0.1` would require the page to genuinely be on 127.0.0.1, which is what we are allowing.
//
// Exact match, not a prefix or substring: `startsWith('localhost')` also accepts
// `localhost.evil.com`, an ordinary registrable domain an attacker can point wherever they like.
export function hostAllowed(host, port) {
  // HTTP/1.1 requires Host. Absent means we cannot tell which origin this is — default closed.
  if (typeof host !== 'string' || host === '') return false
  // A trailing dot is the DNS root form of the SAME name and some clients send it, but it is also a
  // stock allowlist bypass. Normalise it away rather than letting one host have two spellings.
  const h = host.toLowerCase().replace(/\.(?=:|$)/, '')
  // A browser omits the port only when it is the scheme default, so the bare form is accepted only
  // when 80 is genuinely what we are listening on.
  return ['127.0.0.1', 'localhost', '[::1]'].some(n => h === `${n}:${port}` || (port === 80 && h === n))
}

export const handler = async (req, res) => {
  if (!hostAllowed(req.headers?.host, PORT)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
    return res.end('forbidden: unrecognised Host — reach the console as 127.0.0.1 or localhost\n')
  }
  const url = (req.url || '/').split('?')[0]
  // Decode first, so a percent-encoded separator cannot hide from the normalisation below. A
  // malformed escape throws here rather than rejecting inside the handler and hanging the request.
  let decoded
  try { decoded = decodeURIComponent(url) } catch { res.writeHead(400); return res.end('bad request') }
  // Refuse to climb out, however the path is spelled — normalise, then drop any leading `../`.
  let rel = normalize(decoded).replace(/^(\.\.[/\\])+/, '')
  // The console is published at /console/ but its files ARE the document root, so the prefix is
  // stripped after normalisation (never before — `/console/../..` must collapse first).
  if (rel === '/' || rel === '/console' || rel === '/console/') rel = '/index.html'
  else if (rel.startsWith('/console/')) rel = rel.slice('/console'.length)
  const file = join(DOCROOT, rel)
  // The trailing separator matters: a bare prefix test also accepts a SIBLING whose name merely
  // starts with the same characters (console-backup/), which is not the directory we vouched for.
  if (file !== DOCROOT && !file.startsWith(DOCROOT + sep)) { res.writeHead(403); return res.end('forbidden') }
  try {
    const body = await readFile(file)
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' })
    res.end(body)
  } catch { res.writeHead(404); res.end('not found') }
}

// Only listen when run as a program. Importing this file — which the test does, to drive `handler`
// with synthetic requests — must not open a socket: the suite's standing rule is no sockets and no
// production state, and a test that binds 8080 fails on any machine already serving the console.
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  createServer(handler).listen(PORT, '127.0.0.1', () => {
    console.log(`\n  waggle console  →  http://127.0.0.1:${PORT}/console/\n`)
    console.log('  Bound to loopback: served from this machine only, so nobody else chooses the')
    console.log('  JavaScript that shows you what you are about to sign. Ctrl-C when finished.\n')
    console.log(`  Requests are accepted only as 127.0.0.1:${PORT} or localhost:${PORT} — a page that`)
    console.log('  rebinds its own domain to loopback gets 403, not the console.\n')
  })
}

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
  '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' }

createServer(async (req, res) => {
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
}).listen(PORT, '127.0.0.1', () => {
  console.log(`\n  waggle console  →  http://127.0.0.1:${PORT}/console/\n`)
  console.log('  Bound to loopback: served from this machine only, so nobody else chooses the')
  console.log('  JavaScript that shows you what you are about to sign. Ctrl-C when finished.\n')
})

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
import { extname, join, normalize, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.PORT || 8080)
const TYPES = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' }

createServer(async (req, res) => {
  let url = (req.url || '/').split('?')[0]
  if (url === '/' || url === '/console' || url === '/console/') url = '/console/index.html'
  // Refuse to climb out of the repo, however the path is spelled.
  const rel = normalize(decodeURIComponent(url)).replace(/^(\.\.[/\\])+/, '')
  const file = join(ROOT, rel)
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden') }
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

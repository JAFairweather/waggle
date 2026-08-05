#!/usr/bin/env node
import net from 'node:net'

const SOCKET = '/run/waggle-policy-shadow/request.sock'
if (process.argv.length !== 2) {
  process.stderr.write('waggle-policy-shadow-forward: arguments are not accepted\n')
  process.exit(2)
}
const socket = net.createConnection(SOCKET)
let settled = false
const fail = message => {
  if (settled) return
  settled = true
  process.stderr.write(`waggle-policy-shadow-forward: ${message}\n`)
  process.exitCode = 2
}
socket.setTimeout(15_000, () => { fail('shadow service timed out'); socket.destroy() })
socket.on('connect', () => process.stdin.pipe(socket))
socket.on('data', chunk => process.stdout.write(chunk))
socket.on('end', () => { settled = true })
socket.on('error', () => fail('shadow service unavailable'))
process.stdin.on('error', () => { fail('request stream failed'); socket.destroy() })

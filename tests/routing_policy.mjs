// #104 — a private, versioned routing snapshot prevents a rebuild from silently dropping
// live-only routes, while refusing credential-shaped values.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TOOL = join(ROOT, 'deploy/routing-policy.mjs')
const dir = mkdtempSync(join(tmpdir(), 'waggle-routing-policy-'))
const config = join(dir, 'config.json')
const policy = join(dir, 'policy.json')
let failed = 0
const check = (ok, message) => { console.log(ok ? '  ✓' : '  ✗', message); if (!ok) failed++ }
const run = (...args) => {
  try { return { code: 0, out: execFileSync('node', [TOOL, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) } }
  catch (e) { return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` } }
}

try {
  const original = {
    relays: ['wss://relay.example'],
    recipients: [{ name: 'Codex', npub_hex: 'a'.repeat(64), inbox: '11111111-1111-4111-8111-111111111111' }],
    channels: [{ name: 'general', plane_pubkey: 'b'.repeat(64), recipients: ['Codex'] }],
    public: { relays: ['wss://nos.lol'], inbox: '22222222-2222-4222-8222-222222222222', watch_authors: ['c'.repeat(64)], approvers: ['d'.repeat(64)], return_lane: [{ npub_hex: 'e'.repeat(64), mention: 'codex' }], control_state_command_at: 9 },
  }
  writeFileSync(config, JSON.stringify(original))
  const exported = run('export', '--config', config, '--out', policy)
  check(exported.code === 0 && /exported routing policy/.test(exported.out), 'export creates a portable policy snapshot')
  const snap = JSON.parse(readFileSync(policy, 'utf8'))
  check(!('control_state_command_at' in snap.public), 'runtime command bookkeeping is excluded')
  check(snap.public.watch_authors[0] === 'c'.repeat(64), 'watch authors are retained in the snapshot')
  check(run('check', '--config', config, '--policy', policy).code === 0, 'fresh snapshot matches live policy')

  original.public.watch_authors.push('f'.repeat(64)); writeFileSync(config, JSON.stringify(original))
  const drift = run('check', '--config', config, '--policy', policy)
  check(drift.code === 1 && /DRIFT/.test(drift.out), 'a live watchlist change is visible as drift')
  check(run('apply', '--config', config, '--policy', policy).code === 2, 'apply requires explicit confirmation')
  const apply = run('apply', '--config', config, '--policy', policy, '--confirm')
  check(apply.code === 0, 'confirmed apply restores reviewed policy')
  check(run('check', '--config', config, '--policy', policy).code === 0, 'applied config matches snapshot')

  writeFileSync(config, JSON.stringify({ public: { inbox: 'x', api_secret: 'never' } }))
  const secret = run('export', '--config', config, '--out', join(dir, 'bad.json'))
  check(secret.code === 2 && /credential-like/.test(secret.out), 'credential-shaped fields are refused')
} finally { rmSync(dir, { recursive: true, force: true }) }

if (failed) process.exit(1)
console.log('routing_policy: all checks passed')

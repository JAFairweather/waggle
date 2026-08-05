#!/usr/bin/env node
// Policy-host operator command, deliberately separate from the sshd forced command.
// It burns an exact inspected pre-prepare orphan as signed `ambiguous`; it can never
// claim that Buzz accepted or refused an event.
import { loadNostrSigner } from '../src/nostr_signer.mjs'
import { loadBuzzPolicyConfig, readBoundedPolicyRequest, runBuzzPolicyOrphanResolution } from '../src/buzz_policy_runner.mjs'

let signer
try {
  if (process.argv.length !== 4 || process.argv[2] !== '--claimed-at') throw new Error('usage: buzz-policy-resolve-orphan --claimed-at <exact unix seconds> < canonical-request.json')
  const claimedAt = Number(process.argv[3])
  if (!Number.isSafeInteger(claimedAt) || claimedAt < 0) throw new Error('--claimed-at must be exact non-negative unix seconds')
  const configPath = String(process.env.WAGGLE_POLICY_CONFIG_FILE || '')
  if (!configPath) throw new Error('WAGGLE_POLICY_CONFIG_FILE is required')
  const config = loadBuzzPolicyConfig(configPath)
  signer = loadNostrSigner()
  const raw = await readBoundedPolicyRequest(process.stdin)
  process.stdout.write(await runBuzzPolicyOrphanResolution(raw, claimedAt, config, signer))
} catch (error) {
  process.stderr.write(`${String(error?.message || 'buzz-policy orphan resolution refused').slice(0, 512)}\n`)
  process.exitCode = 2
} finally { try { signer?.close() } catch {} }

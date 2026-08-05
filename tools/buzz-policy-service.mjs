#!/usr/bin/env node
// Intended as the sole sshd forced command. It accepts no argv, shell, URL,
// signer, or destination selection from the caller.
import { loadNostrSigner } from '../src/nostr_signer.mjs'
import { loadBuzzPolicyConfig, readBoundedPolicyRequest, runBuzzPolicyRequest } from '../src/buzz_policy_runner.mjs'

let signer
try {
  if (process.argv.length !== 2) throw new Error('buzz-policy-service: arguments are not accepted')
  const configPath = String(process.env.WAGGLE_POLICY_CONFIG_FILE || '')
  if (!configPath) throw new Error('buzz-policy-service: WAGGLE_POLICY_CONFIG_FILE is required')
  const config = loadBuzzPolicyConfig(configPath, process.env, { requireRecovery: false })
  signer = loadNostrSigner()
  const raw = await readBoundedPolicyRequest(process.stdin)
  process.stdout.write(await runBuzzPolicyRequest(raw, config, signer))
} catch (error) {
  process.stderr.write(`${String(error?.message || 'buzz-policy-service: refused').slice(0, 512)}\n`)
  process.exitCode = 2
} finally { try { signer?.close() } catch {} }

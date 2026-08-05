#!/usr/bin/env node
// Sole derive-only forced command: no argv, signer, journal, endpoint, or network path.
import { loadBuzzPolicyShadowConfig, readBoundedShadowRequest, runBuzzPolicyShadow } from '../src/buzz_policy_shadow_runner.mjs'

try {
  if (process.argv.length !== 2) throw new Error('buzz-policy-shadow: arguments are not accepted')
  const configPath = String(process.env.WAGGLE_POLICY_SHADOW_CONFIG_FILE || '')
  if (!configPath) throw new Error('buzz-policy-shadow: WAGGLE_POLICY_SHADOW_CONFIG_FILE is required')
  const config = loadBuzzPolicyShadowConfig(configPath)
  const raw = await readBoundedShadowRequest(process.stdin)
  process.stdout.write(runBuzzPolicyShadow(raw, config))
} catch (error) {
  process.stderr.write(`${String(error?.message || 'buzz-policy-shadow: refused').slice(0, 512)}\n`)
  process.exitCode = 2
}

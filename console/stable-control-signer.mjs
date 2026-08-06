import { consoleSigner } from './signer-session.mjs'
import { requireFreshControlState } from './control-state-freshness.mjs'

// The verified bridge/state pair is one capability snapshot. Opening an external signer is an
// unbounded await, so mutable page globals must never be consulted afterward to choose a target.
// Recheck both freshness and object identity after the signer answers; a concurrent load either
// leaves this exact snapshot current or aborts before any event template is constructed.
export async function stableControlSigner(bridge, state, currentBinding, {
  signerFactory = consoleSigner,
  now = () => Math.floor(Date.now() / 1000),
} = {}) {
  if (!bridge || !state || typeof currentBinding !== 'function') throw Error('Load fresh verified routing state first.')
  requireFreshControlState(state, now())
  const signer = await signerFactory()
  const signerKey = await signer.getPublicKey()
  requireFreshControlState(state, now())
  const current = currentBinding()
  if (current?.bridge !== bridge || current?.state !== state) {
    throw Error('Verified routing state changed while the signer was opening. Reload and try again.')
  }
  return Object.freeze({ bridge, state, signer, signerKey })
}

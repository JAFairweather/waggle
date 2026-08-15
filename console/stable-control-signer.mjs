import { consoleSigner } from './signer-session.mjs'
import { requireFreshControlState } from './control-state-freshness.mjs'
import { assertConsoleFresh } from './staleness-guard.mjs'

// The verified bridge/state pair is one capability snapshot. Opening an external signer is an
// unbounded await, so mutable page globals must never be consulted afterward to choose a target.
// Recheck both freshness and object identity after the signer answers; a concurrent load either
// leaves this exact snapshot current or aborts before any event template is constructed.
export async function stableControlSigner(bridge, state, currentBinding, {
  signerFactory = consoleSigner,
  now = () => Math.floor(Date.now() / 1000),
} = {}) {
  if (!bridge || !state || typeof currentBinding !== 'function') throw Error('Load fresh verified routing state first.')
  // FIRST, because a stale module graph invalidates every check below it: the freshness rule, the
  // envelope shape and this function itself would all be the cached old copies (#418). Refusing
  // here is the load-bearing half of the staleness guard — the banner it also renders is undoable
  // by anything that draws a control afterwards, and an operator can sign through a banner.
  await assertConsoleFresh()
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

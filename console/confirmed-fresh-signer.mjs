import { consoleSigner } from './signer-session.mjs'
import { requireFreshControlState } from './control-state-freshness.mjs'

// A human confirmation dialog is an unbounded wait. Freshness checked before it is not a
// signing-boundary check: the state may expire while the dialog remains open. Confirm first,
// then read the clock and validate immediately before constructing the signer.
export async function confirmedFreshSigner(state, prompt, {
  confirmFn = globalThis.confirm,
  signerFactory = consoleSigner,
  now = () => Math.floor(Date.now() / 1000),
  onStale = () => {},
} = {}) {
  if (!confirmFn(prompt)) return null
  try { requireFreshControlState(state, now()) } catch (error) { onStale(); throw error }
  return signerFactory()
}

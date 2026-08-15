// guarded-signer.mjs — ask the signer for nothing until the page has proved it is not stale (#418).
//
// This exists because the kind 440/441 path was the one path the suite could not assert. Its guard
// call lived inside an inline `addEventListener` in index.html, so there was nothing importable to
// drive, and the closure walk in tests/console_staleness.mjs §9 cannot cover it: once every page's
// import graph reaches the guard module, no static import- or text-level check can tell a page that
// AWAITS the guard from one that merely imports it. Strip the `await` and the walk still reports
// clean (#436 review). The least recoverable operation this console performs was therefore the one
// with no regression cover.
//
// Moving those two lines into a module makes the ordering behavioural: inject an `assertFresh` that
// throws and the signer must never be asked. That is the whole property — a stale module graph means
// the scope-hash rule, the tag grammar and the capability vocabulary that built the template are all
// the cached old copies, so the operator would be approving a grant assembled by code they cannot
// see. Refusing after the signature is worthless; the signature is the irreversible part.
import { assertConsoleFresh } from './staleness-guard.mjs'

export async function signFresh(template, signer, { assertFresh = assertConsoleFresh } = {}) {
  if (!signer || typeof signer.signEvent !== 'function') throw new Error('sign in first — no signer is connected')
  await assertFresh()
  return signer.signEvent(template)
}

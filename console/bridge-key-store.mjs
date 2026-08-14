// One place the console remembers which hive it is looking at (#322).
//
// The reported symptom: paste the 64-hex bridge key on Config, click through to Agents, and the
// box is empty again. Three of five pages looked like they had simply never been taught to
// remember it.
//
// They had. `agents.html` persisted the key perfectly well — under `waggle-agents-bridge`, its
// own name for the same value, while every other page used `waggle-following-bridge`. So the
// console was not forgetting; it was keeping the answer somewhere the next page did not look. A
// split namespace reads exactly like a missing feature, and it is the kind that gets "fixed" by
// adding a fourth key.
//
// Hence a module rather than a shared string constant: `tests/console_bridge_key.mjs` asserts
// that no other file under console/ names a bridge storage key at all, so the next page cannot
// invent one without the suite saying so.
//
// WHAT IS DELIBERATELY NOT SHARED: `index.html` takes a GRANTOR key — whose approvals you want to
// see — which is the owner's key, not the bridge's. The issue asked whether they are the same
// value in practice. They are not, and prefilling one from the other would put a confidently
// wrong 64-hex string in front of an operator, which is worse than an empty box. The suite pins
// that separation too, so a later "helpful" prefill has to argue with a test.

export const BRIDGE_KEY_STORAGE = 'waggle-following-bridge'

// Read-only fallbacks, migrated on first read. Dropping the old name outright would silently
// empty the box for anyone who last used Agents, which is the exact complaint this fixes.
export const LEGACY_BRIDGE_KEY_STORAGE = ['waggle-agents-bridge']

const HEX64 = /^[0-9a-f]{64}$/

export function loadBridgeKey(storage = globalThis.localStorage) {
  let value = null
  try { value = storage?.getItem(BRIDGE_KEY_STORAGE) || null } catch { return '' }
  if (!value) {
    for (const legacy of LEGACY_BRIDGE_KEY_STORAGE) {
      let old = null
      try { old = storage?.getItem(legacy) || null } catch { /* private mode */ }
      if (old && HEX64.test(old)) {
        value = old
        try { storage?.setItem(BRIDGE_KEY_STORAGE, old) } catch { /* private mode */ }
        break
      }
    }
  }
  // A stored value that is not a bridge key is not a prefill, it is a puzzle. Refuse it rather
  // than putting it in the box for the operator to wonder about.
  return value && HEX64.test(value) ? value : ''
}

// The verified state is REQUIRED, not decorative. The four pages each wrote the key immediately
// after parsing the field and before a single relay had answered, so a well-formed key for a hive
// that does not exist was remembered and prefilled on every later visit — a typo that survives the
// error message that rejected it.
//
// Taking the verified state as an argument makes "save only after a load that verified" structural
// instead of a convention every page is trusted to follow: a page that calls this too early has
// nothing to pass, so it cannot persist.
export function rememberBridgeKey(bridge, verified, storage = globalThis.localStorage) {
  if (!HEX64.test(String(bridge || ''))) return false
  if (!verified || verified.bridge !== bridge || !Number.isFinite(verified.observed_at)) return false
  try { storage?.setItem(BRIDGE_KEY_STORAGE, bridge) } catch { return false }
  return true
}

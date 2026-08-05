// One freshness contract for every console reader of waggle-control-state.
// A signer may be honest while its clock is slightly ahead, so tolerate one minute; a farther
// future record must never suppress current state. Fifteen minutes without a refresh is stale.
export const CONTROL_STATE_MAX_AGE_SECS = 15 * 60
export const CONTROL_STATE_MAX_FORWARD_SKEW_SECS = 60

export function controlStateFresh(observedAt, now = Math.floor(Date.now() / 1000)) {
  return Number.isInteger(observedAt) && observedAt > 0 &&
    observedAt <= now + CONTROL_STATE_MAX_FORWARD_SKEW_SECS &&
    now - observedAt <= CONTROL_STATE_MAX_AGE_SECS
}

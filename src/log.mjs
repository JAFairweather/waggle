// Timestamped console logging, shared by every lane.
//
// Extracted from bridge.mjs by #154 — the first thing every other module needs, so it must be the
// module with no dependencies of its own. ISO-8601 on every line because these journals are read
// by the tripwire and correlated against relay timestamps; a bare message cannot be lined up.
const log = (...a) => console.log(new Date().toISOString(), ...a)
const err = (...a) => console.error(new Date().toISOString(), ...a)

export { log, err }

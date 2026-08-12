// suite_union.mjs — resolve the suite-count merge conflict without losing a suite (#387).
//
// Every PR that adds a test suite edits the same four places: the `test` script in package.json,
// and the roster + stated count in CLAUDE.md, README.md and docs/GETTING_STARTED.md. So any two
// such PRs conflict, always, about something they do not actually disagree on.
//
// That would be mere friction if the obvious resolution were safe. It is not. Across ten of these
// merges in one session, NEITHER SIDE WAS EVER A SUPERSET of the other — and twice the two sides
// declared the SAME COUNT while holding different suites:
//
//     ours 71 (has policy_sealed_direct)   theirs 71 (has tripwire_setup)
//
// Taking either side, or the side with the larger number, silently drops a working suite. Nothing
// fails afterwards, because a suite that is not invoked cannot fail. The number looks reconciled
// and the coverage is gone.
//
// So the union is computed, and every property that would make it wrong is asserted rather than
// assumed. Pure: no filesystem, no git — callers supply the strings and the directory listing.

const SUITE_RE = /node (tests\/[\w-]+\.mjs)/g

/** The suites a `test` script invokes, in invocation order. */
export function parseSuites(testScript) {
  return [...String(testScript ?? '').matchAll(SUITE_RE)].map(m => m[1])
}

/** Render a suite list back into a `test` script. */
export function renderSuites(suites) {
  return suites.map(s => `node ${s}`).join(' && ')
}

/**
 * Union of two suite lists.
 *
 * `theirs` is the spine — it is the side being merged in, so its order is the one the branch will
 * live with. Each suite only `ours` has is inserted directly after the suite that preceded it in
 * OURS, which keeps a related pair adjacent instead of dumping additions at the end. Order is not
 * cosmetic here: suite_count runs first and boot runs early.
 */
export function unionSuites(ours, theirs) {
  const merged = [...theirs]
  for (const suite of ours) {
    if (merged.includes(suite)) continue
    const i = ours.indexOf(suite)
    const predecessor = i > 0 ? ours[i - 1] : null
    const at = predecessor && merged.includes(predecessor) ? merged.indexOf(predecessor) + 1 : merged.length
    merged.splice(at, 0, suite)
  }
  return merged
}

/**
 * Everything that would make a resolution wrong, checked at resolve time.
 *
 * `onDisk` is the tests/ listing (bare filenames). The orphan check is the one that matters most:
 * it is the property that catches a dropped suite, and checking it here rather than only in
 * tests/suite_count.mjs means the resolver learns about it before committing rather than after.
 */
export function checkSuites(merged, onDisk = []) {
  const disk = new Set(onDisk.map(f => (f.startsWith('tests/') ? f : `tests/${f}`)))
  const seen = new Set()
  const duplicates = []
  for (const s of merged) {
    if (seen.has(s)) duplicates.push(s)
    seen.add(s)
  }
  const missing = merged.filter(s => !disk.has(s))
  const orphans = [...disk].filter(s => !seen.has(s)).sort()
  const problems = []
  if (duplicates.length) problems.push(`invoked twice: ${duplicates.join(', ')}`)
  if (missing.length) problems.push(`invoked but not on disk: ${missing.join(', ')}`)
  if (orphans.length) problems.push(`on disk but never invoked — a dropped suite: ${orphans.join(', ')}`)
  return { ok: problems.length === 0, duplicates, missing, orphans, problems }
}

/**
 * What each side alone would have lost — the argument for computing a union at all.
 * Returned so a resolver can PRINT it: a merge that silently did the right thing teaches nobody
 * that the wrong thing was available.
 */
export function unionReport(ours, theirs) {
  const onlyOurs = ours.filter(s => !theirs.includes(s))
  const onlyTheirs = theirs.filter(s => !ours.includes(s))
  const merged = unionSuites(ours, theirs)
  return {
    merged,
    onlyOurs,
    onlyTheirs,
    // The trap: equal counts, different contents. Neither number is wrong and a suite is missing.
    equalCountsDifferentSets: ours.length === theirs.length && (onlyOurs.length > 0 || onlyTheirs.length > 0),
    supersetExists: onlyOurs.length === 0 || onlyTheirs.length === 0,
  }
}

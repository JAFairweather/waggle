#!/usr/bin/env node
// memory-git-check.mjs — harness-side git checkout and evidence staleness checker
// (docs/DESIGN_HIVE_MEMORY.md § "Harness-side git check vs. broker-side claim digest").
//
// Brokers run on the fleet box and cannot inspect a Mac harness's local git working tree.
// This tool runs locally inside the agent's harness where the git checkout lives:
//   1. Compares local HEAD against origin/main (or a specified target ref) and produces an explicit
//      banner when the checkout is behind (`WARNING: local waggle checkout is N commits behind origin/main`),
//      including tracking-ref fetch freshness so an unfetched local ref is never silently reported as fresh.
//   2. Takes a list of `waggle@<sha>:<path>` evidence references (or `{ as_of_git, evidence }` claim
//      objects) and reports which cited files have been modified in `origin/main` since `<sha>`,
//      separating unverified diffs (missing/shallow SHA) from confirmed stale files and reporting
//      cross-repo references in `uncheckedRefs`.

import { spawnSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

const SHA_RE = /^[0-9a-f]{7,40}$/i
const DEFAULT_MAX_FETCH_AGE_MS = 60 * 60 * 1000 // 1 hour

function runGit(repoDir, args) {
  const res = spawnSync('git', args, {
    cwd: repoDir,
    encoding: 'utf8',
    timeout: 10000,
  })
  return {
    ok: res.status === 0,
    stdout: String(res.stdout || '').trim(),
    stderr: String(res.stderr || '').trim(),
  }
}

function revParseCommit(repoDir, ref) {
  const res = runGit(repoDir, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])
  const sha = res.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && line !== '--end-of-options') || ''
  return {
    ok: res.ok && SHA_RE.test(sha),
    stdout: sha,
    stderr: res.stderr,
  }
}

function getFetchHeadAgeMs(repoDir, nowMs = Date.now()) {
  const gitCommonRes = runGit(repoDir, ['rev-parse', '--git-common-dir'])
  const gitDir = gitCommonRes.ok && gitCommonRes.stdout
    ? resolve(repoDir, gitCommonRes.stdout)
    : resolve(repoDir, '.git')
  for (const candidate of [
    resolve(gitDir, 'FETCH_HEAD'),
    resolve(repoDir, '.git', 'FETCH_HEAD'),
  ]) {
    try {
      const st = statSync(candidate)
      return Math.max(0, nowMs - st.mtimeMs)
    } catch {
      // try next candidate
    }
  }
  return null
}

// Parses a reference like `waggle@a1b2c3d:docs/DESIGN_RELAY_INGRESS.md` or falls back to `asOfGit`.
export function parseEvidenceRef(refStr, fallbackAsOfGit = null) {
  const s = String(refStr || '').trim()
  const m = s.match(/^([a-z0-9._-]+)@([0-9a-f]{7,40}):(.+)$/i)
  if (m) {
    return { repo: m[1].toLowerCase(), sha: m[2].toLowerCase(), path: m[3].trim(), raw: s }
  }
  if (fallbackAsOfGit) {
    const g = String(fallbackAsOfGit).trim().match(/^([a-z0-9._-]+)@([0-9a-f]{7,40})$/i)
    if (g && s && !s.startsWith('nostr:')) {
      return { repo: g[1].toLowerCase(), sha: g[2].toLowerCase(), path: s, raw: s }
    }
  }
  return null
}

// Checks local HEAD vs targetRef (default `origin/main`) and checks whether any cited evidence files
// changed between their anchor SHA and targetRef.
export function checkMemoryGitState({
  repoDir = process.cwd(),
  repoName = 'waggle',
  targetRef = 'origin/main',
  claims = [],
  evidenceRefs = [],
  fetch = false,
  nowMs = Date.now(),
  maxFetchAgeMs = DEFAULT_MAX_FETCH_AGE_MS,
} = {}) {
  const dir = resolve(repoDir)
  const cleanTargetRef = String(targetRef || '').trim()

  // Reject option-like targetRef values before invoking git
  if (!cleanTargetRef || cleanTargetRef.startsWith('-')) {
    return {
      verified: false,
      localHead: null,
      targetHead: null,
      behindCount: null,
      aheadCount: null,
      fetchAgeMs: null,
      fetchStale: true,
      banner: `WARNING: cannot verify ${repoName} checkout against invalid targetRef "${cleanTargetRef}"`,
      staleFiles: [],
      staleWarningsByClaim: {},
      unverifiedRefs: [],
      unverifiedWarningsByClaim: {},
      uncheckedRefs: [],
    }
  }

  if (fetch) {
    runGit(dir, ['fetch', '--quiet'])
  }

  const headRes = revParseCommit(dir, 'HEAD')
  const targetRes = revParseCommit(dir, cleanTargetRef)

  if (!headRes.ok || !targetRes.ok) {
    return {
      verified: false,
      localHead: headRes.ok ? headRes.stdout : null,
      targetHead: targetRes.ok ? targetRes.stdout : null,
      behindCount: null,
      aheadCount: null,
      fetchAgeMs: null,
      fetchStale: true,
      banner: `WARNING: cannot verify ${repoName} checkout against ${cleanTargetRef} (${targetRes.stderr || headRes.stderr || 'git rev-parse failed'})`,
      staleFiles: [],
      staleWarningsByClaim: {},
      unverifiedRefs: [],
      unverifiedWarningsByClaim: {},
      uncheckedRefs: [],
    }
  }

  const localHead = headRes.stdout
  const targetHead = targetRes.stdout
  const countsRes = runGit(dir, ['rev-list', '--left-right', '--count', `${localHead}...${targetHead}`])
  let aheadCount = 0
  let behindCount = 0
  if (countsRes.ok) {
    const parts = countsRes.stdout.split(/\s+/)
    aheadCount = Number(parts[0]) || 0
    behindCount = Number(parts[1]) || 0
  }

  const fetchAgeMs = getFetchHeadAgeMs(dir, nowMs)
  const fetchStale = fetchAgeMs === null || fetchAgeMs > maxFetchAgeMs
  const fetchNote = fetchAgeMs === null
    ? ' [unfetched: no FETCH_HEAD]'
    : fetchStale
      ? ` [tracking ref last fetched ${Math.round(fetchAgeMs / 60000)}m ago]`
      : ''

  const banner = behindCount > 0
    ? `WARNING: local ${repoName} checkout is ${behindCount} commit${behindCount === 1 ? '' : 's'} behind ${cleanTargetRef} (local ${localHead.slice(0, 7)}, ${cleanTargetRef} ${targetHead.slice(0, 7)})${fetchNote}`
    : `OK: local ${repoName} checkout matches or leads ${cleanTargetRef} (${localHead.slice(0, 7)})${fetchNote}`

  const allRefs = []
  for (const ref of Array.isArray(evidenceRefs) ? evidenceRefs : []) {
    const parsed = parseEvidenceRef(ref)
    if (parsed) allRefs.push({ ...parsed, claimKey: null })
  }
  for (const claim of Array.isArray(claims) ? claims : []) {
    const asOfGit = claim?.as_of_git || claim?.asOfGit || null
    const claimKey = claim?.d || claim?.event_id || null
    for (const evRef of Array.isArray(claim?.evidence) ? claim.evidence : []) {
      const parsed = parseEvidenceRef(evRef, asOfGit)
      if (parsed) allRefs.push({ ...parsed, claimKey, asOfGit: asOfGit || `${parsed.repo}@${parsed.sha}` })
    }
  }

  const staleFilesSet = new Set()
  const staleWarningsByClaim = {}
  const unverifiedRefsSet = new Set()
  const unverifiedWarningsByClaim = {}
  const uncheckedRefsSet = new Set()
  const normalizedRepoName = String(repoName).toLowerCase()

  for (const item of allRefs) {
    if (item.repo !== normalizedRepoName) {
      uncheckedRefsSet.add(item.raw)
      continue
    }
    if (!SHA_RE.test(item.sha)) {
      unverifiedRefsSet.add(item.raw)
      if (item.claimKey) {
        unverifiedWarningsByClaim[item.claimKey] = `[UNVERIFIED: cannot diff ${item.asOfGit || `${item.repo}@${item.sha}`}]`
      }
      continue
    }
    const shaRes = revParseCommit(dir, item.sha)
    if (!shaRes.ok) {
      unverifiedRefsSet.add(item.raw)
      if (item.claimKey) {
        unverifiedWarningsByClaim[item.claimKey] = `[UNVERIFIED: cannot diff ${item.asOfGit || `${item.repo}@${item.sha}`}]`
      }
      continue
    }
    const ancestorRes = runGit(dir, ['merge-base', '--is-ancestor', shaRes.stdout, targetHead])
    if (!ancestorRes.ok) {
      unverifiedRefsSet.add(item.raw)
      if (item.claimKey) {
        unverifiedWarningsByClaim[item.claimKey] = `[UNVERIFIED: ${item.asOfGit || `${item.repo}@${item.sha}`} is not on ${cleanTargetRef}]`
      }
      continue
    }
    const diffRes = runGit(dir, ['diff', '--name-only', `${shaRes.stdout}..${targetHead}`, '--', item.path])
    if (!diffRes.ok) {
      unverifiedRefsSet.add(item.raw)
      if (item.claimKey) {
        unverifiedWarningsByClaim[item.claimKey] = `[UNVERIFIED: cannot diff ${item.asOfGit || `${item.repo}@${item.sha}`}]`
      }
      continue
    }
    if (diffRes.stdout.length > 0) {
      staleFilesSet.add(item.raw)
      if (item.asOfGit) staleFilesSet.add(`${item.asOfGit}:${item.raw}`)
      if (item.claimKey) {
        staleWarningsByClaim[item.claimKey] = `[STALE: evidence file changed since ${item.asOfGit || `${item.repo}@${item.sha}`}]`
      }
    }
  }

  return {
    verified: true,
    localHead,
    targetHead,
    behindCount,
    aheadCount,
    fetchAgeMs,
    fetchStale,
    banner,
    staleFiles: [...staleFilesSet],
    staleWarningsByClaim,
    unverifiedRefs: [...unverifiedRefsSet],
    unverifiedWarningsByClaim,
    uncheckedRefs: [...uncheckedRefsSet],
  }
}

// CLI entrypoint when invoked directly:
//   node tools/memory-git-check.mjs [--repo /path/to/waggle] [--repo-name waggle] [--target origin/main] [--fetch] [--claims-file /path/to/claims.json] [--ref waggle@sha:path]
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2)
  const flag = (name, def = null) => {
    const idx = args.indexOf(name)
    return idx === -1 ? def : args[idx + 1] ?? def
  }
  const repoDir = flag('--repo', process.cwd())
  const repoName = flag('--repo-name', 'waggle')
  const targetRef = flag('--target', 'origin/main')
  const claimsFile = flag('--claims-file', null)
  const doFetch = args.includes('--fetch')
  const refs = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--ref' && args[i + 1]) refs.push(args[++i])
  }
  let claims = []
  if (claimsFile) {
    const raw = JSON.parse(readFileSync(resolve(claimsFile), 'utf8'))
    claims = Array.isArray(raw) ? raw : Array.isArray(raw?.records) ? raw.records : []
  }
  const out = checkMemoryGitState({ repoDir, repoName, targetRef, claims, evidenceRefs: refs, fetch: doFetch })
  if (args.includes('--json')) {
    console.log(JSON.stringify(out, null, 2))
  } else {
    console.log(out.banner)
    for (const [k, w] of Object.entries(out.staleWarningsByClaim)) {
      console.log(`  ${k}: ${w}`)
    }
    for (const [k, w] of Object.entries(out.unverifiedWarningsByClaim)) {
      console.log(`  ${k}: ${w}`)
    }
    if (out.uncheckedRefs.length > 0) {
      console.log(`  unchecked cross-repo refs: ${out.uncheckedRefs.join(', ')}`)
    }
  }
}

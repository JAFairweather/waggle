#!/usr/bin/env node
// memory-git-check.mjs — harness-side git checkout and evidence staleness checker
// (docs/DESIGN_HIVE_MEMORY.md § "Harness-side git check vs. broker-side claim digest").
//
// Brokers run on the fleet box and cannot inspect a Mac harness's local git working tree.
// This tool runs locally inside the agent's harness where the git checkout lives:
//   1. Compares local HEAD against origin/main (or a specified target ref) and produces an explicit
//      banner when the checkout is behind (`WARNING: local waggle checkout is N commits behind origin/main`).
//   2. Takes a list of `waggle@<sha>:<path>` evidence references (or `{ as_of_git, evidence }` claim
//      objects) and reports which cited files have been modified in `origin/main` since `<sha>`.

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SHA_RE = /^[0-9a-f]{7,40}$/i

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
} = {}) {
  const dir = resolve(repoDir)
  const headRes = runGit(dir, ['rev-parse', 'HEAD'])
  const targetRes = runGit(dir, ['rev-parse', targetRef])

  if (!headRes.ok || !targetRes.ok) {
    return {
      verified: false,
      localHead: headRes.ok ? headRes.stdout : null,
      targetHead: targetRes.ok ? targetRes.stdout : null,
      behindCount: null,
      aheadCount: null,
      banner: `WARNING: cannot verify ${repoName} checkout against ${targetRef} (${targetRes.stderr || headRes.stderr || 'git rev-parse failed'})`,
      staleFiles: [],
      staleWarningsByClaim: {},
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

  const banner = behindCount > 0
    ? `WARNING: local ${repoName} checkout is ${behindCount} commit${behindCount === 1 ? '' : 's'} behind ${targetRef} (local ${localHead.slice(0, 7)}, ${targetRef} ${targetHead.slice(0, 7)})`
    : `OK: local ${repoName} checkout matches or leads ${targetRef} (${localHead.slice(0, 7)})`

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

  for (const item of allRefs) {
    if (item.repo !== String(repoName).toLowerCase() || !SHA_RE.test(item.sha)) continue
    const diffRes = runGit(dir, ['diff', '--name-only', `${item.sha}..${targetHead}`, '--', item.path])
    const changed = !diffRes.ok || diffRes.stdout.length > 0
    if (changed) {
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
    banner,
    staleFiles: [...staleFilesSet],
    staleWarningsByClaim,
  }
}

// CLI entrypoint when invoked directly:
//   node tools/memory-git-check.mjs [--repo /path/to/waggle] [--target origin/main] [--claims-file /path/to/claims.json] [--ref waggle@sha:path]
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2)
  const flag = (name, def = null) => {
    const idx = args.indexOf(name)
    return idx === -1 ? def : args[idx + 1] ?? def
  }
  const repoDir = flag('--repo', process.cwd())
  const targetRef = flag('--target', 'origin/main')
  const claimsFile = flag('--claims-file', null)
  const refs = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--ref' && args[i + 1]) refs.push(args[++i])
  }
  let claims = []
  if (claimsFile) {
    const raw = JSON.parse(readFileSync(resolve(claimsFile), 'utf8'))
    claims = Array.isArray(raw) ? raw : Array.isArray(raw?.records) ? raw.records : []
  }
  const out = checkMemoryGitState({ repoDir, targetRef, claims, evidenceRefs: refs })
  if (args.includes('--json')) {
    console.log(JSON.stringify(out, null, 2))
  } else {
    console.log(out.banner)
    for (const [k, w] of Object.entries(out.staleWarningsByClaim)) {
      console.log(`  ${k}: ${w}`)
    }
  }
}

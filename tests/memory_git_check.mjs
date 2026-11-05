import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { checkMemoryGitState, parseEvidenceRef } from '../tools/memory-git-check.mjs'

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

test('parseEvidenceRef parses inline repo@sha:path and fallback as_of_git', () => {
  const inline = parseEvidenceRef('waggle@a1b2c3d:docs/DESIGN_RELAY_INGRESS.md')
  assert.deepEqual(inline, {
    repo: 'waggle',
    sha: 'a1b2c3d',
    path: 'docs/DESIGN_RELAY_INGRESS.md',
    raw: 'waggle@a1b2c3d:docs/DESIGN_RELAY_INGRESS.md',
  })

  const fallback = parseEvidenceRef('docs/DESIGN_HIVE_MEMORY.md', 'waggle@f8798fd1')
  assert.deepEqual(fallback, {
    repo: 'waggle',
    sha: 'f8798fd1',
    path: 'docs/DESIGN_HIVE_MEMORY.md',
    raw: 'docs/DESIGN_HIVE_MEMORY.md',
  })
})

test('checkMemoryGitState detects behind origin/main and modified evidence files since as_of_git', () => {
  const dir = mkdtempSync(join(tmpdir(), 'waggle-git-check-'))
  git(dir, 'init', '-b', 'main')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'Test')

  mkdirSync(join(dir, 'docs'), { recursive: true })
  writeFileSync(join(dir, 'docs', 'A.md'), 'v1\n')
  writeFileSync(join(dir, 'docs', 'B.md'), 'v1\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-m', 'c1')
  const sha1 = git(dir, 'rev-parse', '--short', 'HEAD')

  // Second commit modifies docs/A.md but leaves docs/B.md untouched
  writeFileSync(join(dir, 'docs', 'A.md'), 'v2\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-m', 'c2')
  const sha2 = git(dir, 'rev-parse', 'HEAD')

  // Point refs/remotes/origin/main to sha2, then rewind local HEAD to sha1 (1 commit behind)
  git(dir, 'update-ref', 'refs/remotes/origin/main', sha2)
  git(dir, 'checkout', '--detach', sha1)

  const res = checkMemoryGitState({
    repoDir: dir,
    repoName: 'waggle',
    targetRef: 'origin/main',
    claims: [
      {
        d: 'hive-memory:hive:ops:claim-a',
        as_of_git: `waggle@${sha1}`,
        evidence: [`waggle@${sha1}:docs/A.md`],
      },
      {
        d: 'hive-memory:hive:ops:claim-b',
        as_of_git: `waggle@${sha1}`,
        evidence: [`waggle@${sha1}:docs/B.md`],
      },
    ],
  })

  assert.equal(res.verified, true)
  assert.equal(res.behindCount, 1)
  assert.match(res.banner, /WARNING: local waggle checkout is 1 commit behind origin\/main/)
  assert.equal(
    res.staleWarningsByClaim['hive-memory:hive:ops:claim-a'],
    `[STALE: evidence file changed since waggle@${sha1}]`,
  )
  assert.equal(res.staleWarningsByClaim['hive-memory:hive:ops:claim-b'], undefined)
})

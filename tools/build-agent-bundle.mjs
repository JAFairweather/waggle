#!/usr/bin/env node
// build-agent-bundle.mjs — produce dist/waggle-agent.mjs, the single file an agent runs on a host
// that will not let it install anything (#586).
//
// The artifact is the deliverable, so this script's job is not "call esbuild" — it is to refuse to
// emit a file that would fail on the host it exists for. Grok's host writes a file and runs it; it
// does not resolve `node_modules`, it does not have `nostr-tools`, and if it did we would not need
// a bundle. So every check below is about that one machine:
//
//   1. NO BARE IMPORTS SURVIVE. A single `import ... from 'ws'` left in the output turns the whole
//      exercise into an ordinary script with a missing dependency — and it fails at run time, on
//      the agent's machine, not here. Asserted against the built bytes, not against the config that
//      was meant to produce them.
//   2. ONE FILE. esbuild will happily emit a second chunk for a dynamic import; a second file is a
//      second thing to transfer, and the transfer is the part that is hard.
//   3. IT RUNS. `--version` is executed against the built artifact in a child process. A bundle
//      that parses is not a bundle that runs — `node --check` has passed here on code whose
//      identifiers did not exist.
//   4. THE WEBSOCKET DOOR IS SHUT. `src/ws_runtime.mjs` is the repo's only WebSocket resolution
//      point (#576/#578) and the bundle must not reintroduce a bare global lookup, or it
//      reproduces that defect on exactly the Node 20 hosts it was built to serve — reporting the
//      failure as EOSE, which reads as a healthy empty relay.
//
// Run: node tools/build-agent-bundle.mjs [--out <path>]
// Exit: 0 built and checked · 1 a check failed · 3 could not build (esbuild missing, etc.)

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { builtinModules } from 'node:module'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv
const flag = n => { const i = argv.indexOf(n); return i < 0 ? '' : (argv[i + 1] || '') }
const OUT = resolve(ROOT, flag('--out') || 'dist/waggle-agent.mjs')

const die = (msg, code = 1) => { console.error(`build-agent-bundle: ${msg}`); process.exit(code) }

let esbuild
try {
  esbuild = await import('esbuild')
} catch (e) {
  // Exit 3, not 1: we could not judge the artifact, which is a different fact from an artifact that
  // failed a check, and the two must not be collapsed (the repo's INCONCLUSIVE contract).
  die(`esbuild is not installed — run \`npm ci\`. (${e.message})`, 3)
}

// The build id is the commit, so an agent holding the file can say which one it has and we can read
// the same source. A dirty or unknown tree says so rather than claiming a commit it is not.
let buildId
try {
  const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim().length > 0
  buildId = dirty ? `${sha}-dirty` : sha
} catch {
  buildId = 'unknown'
}

mkdirSync(dirname(OUT), { recursive: true })

const result = await esbuild.build({
  entryPoints: [resolve(ROOT, 'src/agent_cli.mjs')],
  outfile: OUT,
  bundle: true,
  platform: 'node',
  format: 'esm',
  // Node 20 is what package.json declares and what Grok's class of host runs. Targeting it here
  // rather than "esnext" is what stops esbuild emitting syntax the host cannot parse — a parse
  // error on a 1MB single file is the least debuggable failure available to us.
  target: 'node20',
  // Off explicitly rather than by default. With splitting on, the dynamic imports in agent_cli.mjs
  // become separate chunk files and check 2 below starts failing — stating it here means a future
  // config change has to argue with this line rather than silently win.
  splitting: false,
  minify: false,
  sourcemap: false,
  // `ws` requires these two behind try/catch for a native speedup it works fine without. They are
  // optional by construction, so a stub that throws is the honest shim: `ws` catches it and takes
  // the pure-JS path, which is what an unbundled `npm ci` without a compiler does too.
  plugins: [{
    name: 'stub-optional-native',
    setup(build) {
      build.onResolve({ filter: /^(bufferutil|utf-8-validate)$/ }, args => ({ path: args.path, namespace: 'stub-native' }))
      build.onLoad({ filter: /.*/, namespace: 'stub-native' }, () => ({
        contents: 'module.exports = undefined; throw new Error("optional native binding not bundled")',
        loader: 'js',
      }))
    },
  }],
  define: { __WAGGLE_BUILD_ID__: JSON.stringify(buildId) },
  // `ws` is CommonJS and calls `require('events')`. In an ESM bundle esbuild replaces that with a
  // `__require` shim that THROWS on anything it could not resolve at build time — so the artifact
  // built clean, passed `node --check`, ran `--version`, and died the moment it tried to open a
  // socket: "Dynamic require of \"events\" is not supported". esbuild's shim defers to a real
  // `require` when one is in scope, so the banner puts one there. The shebang lives here too
  // because esbuild does not hoist the entry file's own shebang above a banner, and two of them is
  // a syntax error on line 2.
  banner: {
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __nodeCreateRequire } from 'node:module'",
      'const require = __nodeCreateRequire(import.meta.url)',
    ].join('\n'),
  },
  logLevel: 'warning',
  metafile: true,
})

// A Node builtin is not a dependency: `node:crypto` resolves on a host with no node_modules at all,
// which is the only property check 1 is about. Excluding them by the real builtin list rather than
// by a `node:` prefix test also covers the unprefixed spellings (`crypto`, `events`) that `ws` and
// nostr-tools still use — those resolve too, and calling them a failure would make this check fire
// on every possible bundle, which is the same as it never firing.
const isBuiltin = m => m.startsWith('node:') || builtinModules.includes(m)

const outputs = Object.keys(result.metafile.outputs)
const src = readFileSync(OUT, 'utf8')
const bytes = statSync(OUT).size
const failures = []

// 1. No bare imports. Match `from "x"` / `from 'x'` where x is not a path — that is the exact shape
//    that needs a node_modules on the running machine. A negative control lives in
//    tests/agent_bundle.mjs: the same matcher is run over a string that DOES contain one, so a
//    regex that can never match cannot pass this silently.
const BARE_IMPORT = /(?:^|\n)\s*(?:import|export)[^;\n]*?\bfrom\s*["']([^."'][^"']*)["']/g
const bare = [...src.matchAll(BARE_IMPORT)].map(m => m[1]).filter(m => !isBuiltin(m))
if (bare.length) failures.push(`bundle still imports ${[...new Set(bare)].join(', ')} — it will die on a host with no node_modules, which is the host this file exists for`)

// A `require()` of a bare name is the same defect wearing different clothes, and esbuild emits
// `__require` shims that would slip past the import matcher above.
const BARE_REQUIRE = /\brequire\s*\(\s*["']([^./"'][^"']*)["']\s*\)/g
const req = [...src.matchAll(BARE_REQUIRE)].map(m => m[1]).filter(m => !isBuiltin(m) && !['bufferutil', 'utf-8-validate'].includes(m))
if (req.length) failures.push(`bundle still require()s ${[...new Set(req)].join(', ')}`)

// 2. One file.
if (outputs.length !== 1) failures.push(`esbuild emitted ${outputs.length} files (${outputs.join(', ')}) — the transfer is the hard part, so the artifact must be one file`)

// 4. The WebSocket door. `ws_runtime` installs the implementation into nostr-tools' pool; if that
//    call is not in the output, the pool falls back to a bare global that Node 20 does not ship and
//    reports the failure as EOSE — indistinguishable from a healthy quiet relay (#576/#578).
if (!src.includes('useWebSocketImplementation')) {
  failures.push('useWebSocketImplementation is absent from the bundle — nostr-tools\' pool will fall through to a global Node 20 does not have, and report it as EOSE')
}

// 3. It runs. Executed, not parsed.
let ran = ''
try {
  ran = execFileSync(process.execPath, [OUT, '--version'], { encoding: 'utf8', timeout: 30000 }).trim()
} catch (e) {
  failures.push(`the built bundle could not run \`--version\`: ${String(e.stderr || e.message).split('\n')[0]}`)
}
if (ran && ran !== buildId) failures.push(`bundle reports build id ${JSON.stringify(ran)}, expected ${JSON.stringify(buildId)} — the define did not apply`)

// 5. IT LOADS THE SOCKET STACK. Check 3 is not enough on its own, and that is not a hypothetical:
//    `--version` answers before any subcommand is imported, so it passed a bundle that died on its
//    first socket with `Dynamic require of "events" is not supported`. `ws` is CommonJS, and
//    esbuild's ESM `__require` shim throws rather than resolving. Built clean, `node --check` clean,
//    `--version` clean, unusable on the one machine it exists for.
//
//    So drive `inbox` with no signer. That imports agent-inbox, ws_runtime, `ws` and nostr-tools,
//    then stops at the tool's OWN signer check — a sentence we can recognise. Asserting on the
//    sentence rather than on the exit code is what tells "reached the tool" apart from "died on the
//    way in": both are non-zero, and only one of them means the bundle works.
let loaded = ''
try {
  execFileSync(process.execPath, [OUT, 'inbox', '--pubkey', 'f'.repeat(64)], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] })
} catch (e) {
  loaded = String(e.stderr || e.stdout || e.message)
}
const loadErr = loaded.split('\n').find(l => /Dynamic require|Cannot find (module|package)|is not defined/.test(l))
if (loadErr) {
  failures.push(`the bundle loads its own entry but not its dependencies: ${loadErr.trim()}`)
} else if (!/no signer configured/.test(loaded)) {
  // Neither the known-good sentence nor a recognised failure. Refusing to call that a pass is the
  // point — we could not see enough to judge, which is not the same as fine.
  failures.push(`could not confirm the bundle reaches agent-inbox's own signer check — it said: ${loaded.split('\n').filter(Boolean).slice(-2).join(' / ').slice(0, 200)}`)
}

console.log(`build-agent-bundle: ${OUT.replace(ROOT + '/', '')}  ${(bytes / 1024).toFixed(0)} KiB  build ${buildId}`)
if (ran) console.log(`build-agent-bundle: ran \`--version\` from the built file -> ${ran}`)
if (!loadErr && /no signer configured/.test(loaded)) console.log('build-agent-bundle: `inbox` reached its own signer check — the socket stack loads')

if (failures.length) {
  for (const f of failures) console.error(`build-agent-bundle: FAIL ${f}`)
  process.exit(1)
}
console.log(`build-agent-bundle: ${outputs.length} file, no bare imports, socket door shut, runs.`)

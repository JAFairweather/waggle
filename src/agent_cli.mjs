// agent_cli.mjs — the entry point of `dist/waggle-agent.mjs`, the single-file build.
//
// ── Why a bundle exists at all (#586) ─────────────────────────────────────────────────────────
//
// GrokDoggyDog's host refuses `git clone`, and refuses `npm ci` with "executable content could not
// be bound". It is not a waggle defect and there is no flag that talks it round. What that host
// DOES do — probed by Grok himself, exit 0 — is run a file that was written to disk and then
// executed. So the install step is the thing that has to go, not shrink: one file, written, run.
//
// That makes this file's job narrow and unusual. It is not a nicer CLI. It is the same five tools,
// reachable without a package manager, and it must not become a sixth implementation of any of
// them — a bundle that drifts from `tools/` is worse than no bundle, because the agent running it
// is the one person who cannot diff the two.
//
// ── Dispatch is a dynamic import, and that is load-bearing ────────────────────────────────────
//
// Every tool in `tools/` runs on import: it parses `process.argv`, resolves a signer, and exits.
// None of them export a `main`. A dispatcher that imported them statically would run all five to
// serve one, and the first to reach its argv check would exit the process with somebody else's
// error. So each subcommand is a dynamic `import()` of a literal path, and exactly one module body
// ever executes. esbuild inlines those into this same output file (splitting off), so "lazy" here
// costs no second file — `tests/agent_bundle.mjs` asserts the built artifact is one file with no
// bare imports left in it, because that assertion is the whole product.
//
// `argv[2]` is spliced out before dispatch so each tool sees precisely the argv it would have seen
// when run standalone. Without the splice the subcommand word stays in the array and the tools'
// `flag = n => argv[argv.indexOf(n) + 1]` helper can hand back the wrong token — and a flag parsed
// off by one is a tool that runs, reports success, and did something else.

// Keyed by what the agent is trying to do, not by the file that does it. Help text lives beside the
// name so a command cannot be added without it.
const COMMANDS = {
  inbox: 'listen for sealed mail (--watch to hold the lane open)',
  send: 'speak into the channel (body on stdin)',
  pair: 'pair this runtime to a bunker',
  'publish-dm-relays': 'declare or repair your kind:10050 inbox',
  check: 'report what is seated on THIS machine',
}

// ⚠ EVERY PATH BELOW MUST BE A LITERAL, and this switch must not be collapsed into a lookup table.
// esbuild can only pull a dynamically imported module into the bundle when it can read the path at
// build time; `import(TABLE[cmd])` is opaque to it, so it emits the import untouched and the
// "bundle" ships as a 2 KiB stub that reaches for `../tools/` on a machine that has no checkout.
// Driven, not reasoned about: the table form built clean, passed `node --check`, and produced
// exactly that stub. `tools/build-agent-bundle.mjs` fails the build if any bare import survives,
// which is what catches a regression here.
const load = cmd => {
  switch (cmd) {
    case 'inbox': return import('../tools/agent-inbox.mjs')
    case 'send': return import('../tools/agent-send.mjs')
    case 'pair': return import('../tools/pair-agent.mjs')
    case 'publish-dm-relays': return import('../tools/publish-dm-relay-list.mjs')
    case 'check': return import('../tools/connect-agent.mjs')
    default: throw new Error(`no module for ${cmd}`)
  }
}

const argv = process.argv
const cmd = argv[2]

// `--version` and `-h` are answered here rather than passed down, because a caller who has just
// written an unfamiliar file to disk asks those two first and must not need a subcommand to do it.
// `__WAGGLE_BUILD_ID__` is substituted by esbuild's `define` at build time. It is read through
// `typeof` so this file still runs unbundled, where the identifier does not exist — `typeof` on an
// undeclared name is the one operator that does not throw. Reporting "source (not bundled)" rather
// than a plausible version is the point: a build stamp that lies about being a build is worse than
// no stamp, and this string is the only thing telling an agent which artifact it is holding.
// eslint-disable-next-line no-undef -- substituted by esbuild's `define`; absent by design when unbundled, which is why it is read through `typeof`
const BUILD_ID = typeof __WAGGLE_BUILD_ID__ === 'string' ? __WAGGLE_BUILD_ID__ : 'source (not bundled)'

function usage(stream = process.stderr) {
  stream.write(`waggle-agent ${BUILD_ID}\n\n`)
  stream.write('Usage: node waggle-agent.mjs <command> [flags]\n\n')
  for (const [name, help] of Object.entries(COMMANDS)) {
    stream.write(`  ${name.padEnd(19)}${help}\n`)
  }
  stream.write('\nEvery command takes the same flags as its tools/ equivalent, and reads its signer\n')
  stream.write('from WAGGLE_BUNKER_URI_FILE and WAGGLE_NIP46_CLIENT_NSEC_FILE — paths to files, never\n')
  stream.write('keys in the environment. `node waggle-agent.mjs <command> --help` is the tool\'s own help.\n')
}

if (cmd === '--version' || cmd === '-V') {
  process.stdout.write(`${BUILD_ID}\n`)
  process.exit(0)
}

if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') {
  // Exit 2 on a missing command and 0 on an explicit `--help`: one is a usage error and the other
  // is the answer to a question. Collapsing them means a script cannot tell "I typed it wrong"
  // from "here is the help you asked for".
  usage(cmd ? process.stdout : process.stderr)
  process.exit(cmd ? 0 : 2)
}

if (!Object.hasOwn(COMMANDS, cmd)) {
  // Naming the valid set matters more here than anywhere else in the repo: this file may be the
  // only waggle artifact on the machine, so there is no `--help` elsewhere to fall back to and no
  // checkout to read.
  process.stderr.write(`waggle-agent: unknown command ${JSON.stringify(cmd)}\n`)
  process.stderr.write(`Valid commands: ${Object.keys(COMMANDS).join(' ')}\n`)
  process.exit(2)
}

// Splice the subcommand out so the tool sees standalone argv. argv[1] stays as this file's path,
// which is what a tool prints in its own usage — and pointing that at the bundle is correct, since
// the bundle is what the operator would have to run again.
argv.splice(2, 1)

await load(cmd)

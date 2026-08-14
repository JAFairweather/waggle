// ESLint — configured to catch BUGS, not to have opinions about style.
//
// The deliberate omission: no formatting rules. This codebase is semicolon-free (3 of 1574
// lines in bridge.mjs end in one) and heavily, intentionally commented; a formatter would
// produce a thousand-line diff that reviews as noise and buries the next real change. Style
// here is consistent enough to read, and consistency is not what a linter is for.
//
// What it IS for, in a project whose governing lesson is "every real bug here was invisible
// to a test that merely ran": the failures a test cannot see. `node --check` has passed on
// code whose identifiers did not exist (CLAUDE.md, verification discipline) — no-undef is
// precisely that check, applied to every file at once, every push.
export default [
  {
    files: ['**/*.mjs'],
    // Vendored third-party code is not ours to lint; tests/fixtures under a scratch dir are
    // not shipped. Excluding them keeps a green run meaningful instead of habitually noisy.
    ignores: ['console/vendor/**', 'node_modules/**', '.scratch/**'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        // Node 20+ runtime surface the bridge and tools actually use.
        process: 'readonly', console: 'readonly', Buffer: 'readonly', URL: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly',
        clearInterval: 'readonly', setImmediate: 'readonly', fetch: 'readonly', TextEncoder: 'readonly',
        TextDecoder: 'readonly', WebSocket: 'readonly', crypto: 'readonly',
        // Global in Node since 16 and in every browser — `src/nip98.mjs` uses btoa to build the
        // Authorization header, deliberately, so the same file would still run in a page. It was
        // added when that module moved out of console/ (#432): `npm run lint` covers
        // `src tools tests` and never console/, so the move put it under the linter for the first
        // time and this was the one identifier missing.
        btoa: 'readonly',
      },
    },
    linterOptions: { reportUnusedDisableDirectives: true },
    rules: {
      // The load-bearing three: a name that does not exist, a value computed and dropped,
      // a promise whose rejection nobody handles. Each is a real defect, never a preference.
      'no-undef': 'error',
      'no-unused-vars': ['error', {
        // An unused CAUGHT binding is idiomatic here — `catch { /* closed */ }` appears
        // throughout, deliberately, where the failure is the expected case.
        caughtErrors: 'none',
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      }],
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Silent-failure shapes. `no-fallthrough` and `no-self-assign` have each hidden a
      // real bug in someone's codebase; they cost nothing to keep on.
      'no-fallthrough': 'error',
      'no-self-assign': 'error',
      'no-unsafe-negation': 'error',
      'no-unreachable': 'error',
      'valid-typeof': 'error',
      'use-isnan': 'error',
    },
  },
  // console/ is a browser tree, and until #434 it was not linted at all — `npm run lint` was
  // `eslint src tools tests`. The rule this config calls load-bearing, no-undef, had therefore
  // never run on the signing UI: the surface where an identifier that does not exist fails in a
  // page, in front of an operator who is approving something, with no test in between.
  //
  // ⚠ This covers the `.mjs` MODULES under console/ and nothing else. Most of the console's
  // JavaScript is inline `<script>` in HTML — 1,370 lines across six pages, of which index.html
  // (839) and connect.html (316) carry the kind 440/441 signing paths this block is written for.
  // ESLint will not read `.html` without a plugin, so that gap is silent: `npm run lint` exits 0
  // and reports nothing skipped. Tracked in #460; do not read a green run as "console/ is covered".
  //
  // `eslint console` also enumerates 24 files, but 5 are console/vendor/**, which no rule reaches:
  // the `ignores` above sits in a config object that also has `files`, making it a per-config
  // ignore rather than a global one, so vendor drops out of that block's rules and is linted by
  // nothing. Harmless — vendor is clean either way — but the count of modules actually carrying
  // no-undef is 19. Measured both directions: an undefined identifier in vendor reports 0 errors,
  // the same line in console/routing.mjs reports 1.
  //
  // One consequence to expect: no-undef is now a merge gate for new console/ module code, so a
  // module that starts using a browser global fails CI until the list below is extended. That is
  // this block working, not a broken lint.
  //
  // Three globals, not a blanket browser list, for the same reason the Node block above lists only
  // what the bridge and tools actually use. These are precisely what enabling the lint reported —
  // `document` ×8, `localStorage` ×2, `confirm` ×1, across three files. Add to this list when a
  // module genuinely starts using something; a name that is not here and not defined is the finding.
  //
  // `window` is deliberately NOT here. Console modules reach it as `globalThis.window`
  // (`console/signer-session.mjs:10`) so they stay importable under Node for the suite, and adding
  // the global would quietly make a bare `window` reference lint clean — which is the thing that
  // breaks those imports.
  {
    files: ['console/**/*.mjs'],
    languageOptions: {
      globals: { document: 'readonly', localStorage: 'readonly', confirm: 'readonly' },
    },
  },
]

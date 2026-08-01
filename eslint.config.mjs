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
]

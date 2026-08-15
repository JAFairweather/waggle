// bunker_paste.mjs — accept a bunker:// URI the operator pastes, without letting it reach a place
// that keeps it (#480).
//
// The operator holds the only key with `owner`/`admin` in `relay_members`, so they are the only
// one who can mint an invite — and their signer hands them a `bunker://` string to PASTE, not a
// pairing to seat in two files. Requiring the files put a key on disk to avoid putting a key on
// disk, which is the wrong trade and it stalled the one step everything else waits behind.
//
// A `bunker://` URI carries a `secret` parameter. That makes it credential material, so:
//
//   - it is read from `/dev/tty` with echo off, never from argv (`ps`) and never from an
//     environment variable (the shell history of whoever typed it, and `/proc` on Linux);
//   - `findBunkerUriExposure` refuses the run when one shows up in either place anyway. Without
//     that refusal the prompt is decoration, because the first person in a hurry routes around it
//     and nothing says otherwise;
//   - the URI is never written down. What persists is the CLIENT key, which is a different thing:
//     a NIP-46 bunker authorizes a specific client keypair, so a fresh one each run is an app the
//     signer has never seen and the connect is refused as "Unknown client"
//     (`tools/grant.mjs:56-66`, same reasoning, same 0600 file). Persisting it is what makes the
//     second run cost no approval; persisting the URI would keep the connect secret for no gain.
//
// Pure: strings in, verdicts out. No TTY, no filesystem, no socket — those live in the tool. This
// module also may not import the signer backend (egress ban), which is why the caller builds the
// signer from what these functions return.

const BUNKER_URI = /^bunker:\/\/([0-9a-f]{64})(\?|$)/i

/**
 * Is this pasted text a bunker URI that can actually be connected with?
 *
 * Every refusal names the part that is wrong. A paste is a manual act — a truncated copy, a
 * trailing quote from a chat client, or a signer that emitted `nostrconnect://` instead all land
 * here, and "invalid bunker URI" sends the operator back to re-copy the same string.
 *
 * @returns {{uri: string, pubkey: string, relays: string[], hasSecret: boolean}|{error: string}}
 */
export function checkPastedBunkerUri(text) {
  // Signers wrap the string in quotes, and a paste through a terminal can carry stray whitespace.
  const raw = String(text ?? '').trim().replace(/^["'<]+|["'>]+$/g, '').trim()
  if (!raw) return { error: 'nothing was pasted' }

  if (/^nostrconnect:\/\//i.test(raw)) {
    return { error: 'that is a nostrconnect:// URI, which is the OTHER direction — the client ' +
      'publishes it and the signer connects back.\n' +
      '  This tool needs the bunker:// string from your signer\'s "connect an app" flow.' }
  }
  if (!/^bunker:\/\//i.test(raw)) {
    const scheme = raw.includes('://') ? raw.split('://')[0] : '(no scheme)'
    return { error: `expected a bunker:// URI, got ${scheme}://…` }
  }
  const match = BUNKER_URI.exec(raw)
  if (!match) {
    // The commonest paste failure by far, and it does not look like a failure: the string is
    // plausible and merely short, so a length-blind check would hand it to the signer and report
    // the bunker's refusal instead of the truncation.
    const after = raw.slice('bunker://'.length).split('?')[0]
    return { error: `the pubkey in the URI is ${after.length} characters, not 64 — the paste looks ` +
      'truncated. Copy the whole string.' }
  }

  let url
  try { url = new URL(raw) } catch { return { error: 'the URI is not parseable — copy the whole string' } }
  const relays = [...new Set(url.searchParams.getAll('relay').filter(v => /^wss:\/\//i.test(v)))]
  if (!relays.length) {
    const any = url.searchParams.getAll('relay')
    return { error: any.length
      ? `the URI's relay(s) are not wss:// — NIP-46 traffic is not sent over ${any[0].split('://')[0]}://`
      : 'the URI names no relay, so there is no transport to reach the signer over. Copy the whole string.' }
  }
  return {
    uri: raw,
    pubkey: match[1].toLowerCase(),
    relays,
    // Not an error. A secret is single-use on first pairing, and a URI re-copied after the client
    // key is already authorized legitimately has none. Refusing here would break the second run.
    hasSecret: !!url.searchParams.get('secret'),
  }
}

/**
 * Did a bunker URI arrive by a route that records it?
 *
 * Checked BEFORE the prompt, so the answer is a refusal rather than a prompt the operator fills in
 * while the same secret already sits in their history.
 *
 * @returns {{error: string}|{}}
 */
export function findBunkerUriExposure(argv = [], env = {}) {
  const inArgv = (argv || []).some(a => /bunker:\/\//i.test(String(a)))
  if (inArgv) {
    return { error: 'a bunker:// URI was passed on the command line, and this tool will not take ' +
      'one that way.\n' +
      '  Argv is visible in `ps` to every user on this host and is kept in your shell history, and\n' +
      '  the URI carries a connect secret. Re-run with --bunker and paste it at the prompt — it is\n' +
      '  not echoed and it is not written down.\n' +
      '  Your shell history now holds that secret. Rotate the pairing in your signer.' }
  }
  const named = Object.keys(env || {}).filter(k => /bunker/i.test(k) && /uri/i.test(k) && !/_FILE$/i.test(k))
    .filter(k => /bunker:\/\//i.test(String(env[k] || '')))
  if (named.length) {
    return { error: `${named[0]} holds a bunker:// URI, and this tool will not take one from the ` +
      'environment.\n' +
      '  It is readable from /proc on Linux and it is in the history of whoever exported it.\n' +
      '  Use --bunker and paste at the prompt, or WAGGLE_BUNKER_URI_FILE with a mode-0600 file.' }
  }
  return {}
}

/**
 * The client key for this pairing — reuse what is there, or say a new one is needed.
 *
 * `existing` is the file's text, or null when there is no file. Reuse is the point: the bunker
 * authorized THIS keypair, so generating a fresh one turns every run into a new approval and some
 * signers refuse it outright as an unknown client.
 *
 * @returns {{hex: string, created: false}|{create: true}|{error: string}}
 */
export function planClientKey(existing) {
  if (existing === null || existing === undefined) return { create: true }
  const raw = String(existing).trim()
  if (!raw) return { create: true }
  if (!/^[0-9a-f]{64}$/i.test(raw)) {
    // Never silently replace it. A corrupt file that regenerates looks identical to a working one
    // for exactly as long as it takes the signer to ask for approval again, and the operator is
    // left approving a second app without being told the first was discarded.
    return { error: 'the saved client key is not 64-character hex. Delete the file to pair again — ' +
      'this tool will not overwrite it, because a silent replacement is a second app in your signer ' +
      'that you were never told about.' }
  }
  return { hex: raw.toLowerCase(), created: false }
}

// connect_flags.mjs — every flag `tools/connect-agent.mjs` reads, declared in one place (#522).
//
// The usage line used to be a literal, and it had drifted to five of nineteen flags. That is not a
// tidiness problem, because of what the missing ones are used for:
//
//   The startup document tells an agent to settle its install with `--lane sealed`. The agent runs
//   it, the tool dies on the `--name` the document omitted, and the usage line it prints back does
//   not list `--lane` at all. So the message the agent acts on argues that the document is stale
//   and the flag unsupported. Both were wrong, and the agent has no way to tell.
//
// A refusal that explains itself incorrectly is worse than one that says nothing, because it sends
// the reader somewhere. Hence the catalogue: `usageLine` renders from it, and `knownFlag` lets the
// tool refuse to read a flag that is not declared here. A flag added without a line in this table
// then fails at first use, loudly, instead of going missing from a message months later.
//
// `value: null` means the flag is a bare switch — `has('--check')`, no argument follows it.

export const FLAGS = Object.freeze([
  { flag: '--name', value: 'short-stable-id', required: true, what: 'which agent — names the directory under --root' },
  { flag: '--check', value: null, what: 'report install state and change nothing' },
  { flag: '--lane', value: 'sealed|broker', what: 'scope the check to one participation lane; undeclared means every row applies' },
  { flag: '--root', value: 'dir', what: 'where agent directories live (default ~/.nvoy/desktop)' },
  { flag: '--pubkey', value: '64-hex', what: 'the identity this install must resolve to' },
  { flag: '--owner', value: '64-hex', what: 'the owner key that granted admission' },
  { flag: '--whoami', value: 'path', what: 'a captured nvoy_whoami result, compared against --pubkey' },
  { flag: '--from', value: 'instance', what: 'mirror an existing agent manifest' },
  { flag: '--from-file', value: 'path', what: 'mirror from an exported manifest file' },
  { flag: '--export', value: null, what: 'write a portable manifest instead of checking' },
  { flag: '--out', value: 'path', what: 'where --export or --startup writes' },
  { flag: '--print', value: null, what: 'print to stdout rather than writing a file' },
  { flag: '--startup', value: null, what: "render the runtime's startup document" },
  { flag: '--runtime', value: 'id', what: 'which runtime the startup file and stanza are for' },
  { flag: '--stanza', value: null, what: 'print the channel registration for each runtime' },
  { flag: '--bridge', value: '64-hex', what: "waggle's own key, for the speak command in the startup document" },
  { flag: '--channel', value: 'uuid', what: 'the destination channel, for the same' },
  { flag: '--channel-host', value: 'host', what: 'the channel host a registration stanza points at' },
  { flag: '--channel-user', value: 'user', what: 'the account the channel transport authenticates as' },
])

const KNOWN = new Set(FLAGS.map(f => f.flag))

/** Is this a flag the tool declares? Used to refuse reading one that is not. */
export const knownFlag = n => KNOWN.has(n)

/** One token as it appears in usage: `--name <short-stable-id>`, or `[--check]` when optional. */
const token = f => {
  const body = f.value ? `${f.flag} <${f.value}>` : f.flag
  return f.required ? body : `[${body}]`
}

/**
 * The usage line, rendered from the catalogue so it cannot drift from what the tool reads.
 *
 * Wrapped rather than run out to one 400-column line, because a usage message that a terminal
 * folds at an arbitrary point is one nobody reads to the end of — and the flag the reader is
 * looking for is as likely to be past the fold as before it.
 */
export function usageLine(width = 96) {
  const lines = []
  let cur = 'usage: connect-agent'
  for (const f of FLAGS) {
    const t = token(f)
    if (cur.length + 1 + t.length > width) { lines.push(cur); cur = '       ' + t } else { cur += ' ' + t }
  }
  lines.push(cur)
  return lines.join('\n')
}

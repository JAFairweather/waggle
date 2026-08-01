# Contributing to waggle

waggle sits between a private community and the open internet, and both sides can be harmed by a
careless change. So the bar here is not "does it work" — it is **"how would we know if it didn't."**
Most of what follows is that one idea, applied.

## Before you write code

- **Open an issue first.** Every item becomes a GitHub issue before it becomes a commit. It does not
  need to be long; it needs to exist, so the reasoning is reviewable separately from the diff.
- **Check open *and recently merged* work.** `gh pr list --state open` is not enough on its own —
  work here has been built twice, once because only open PRs were checked while the same fix had
  already merged. Fetch `origin/main` and read the recent log too.
- **Say whether the thing is shipped or designed.** Never blur them. "Landed but not deployed" is a
  normal and useful state; describing it as done is not.

## Running it

```sh
npm ci
cp config.example.json config.json   # the suite grounds in this
npm test                             # every safety gate, exercised
npm run lint                         # correctness rules only, no style opinions
```

`npm test` runs the suites named in `package.json`'s `test` script, against the **real** exported
functions with synthetic events — no sockets, no production state, no writes outside a temp dir.
Some suites need `rsync` on `PATH`; without it `deploy_runner` reports **INCONCLUSIVE (exit 3)`**
rather than pretending to have judged.

## Verification discipline

This is the part we actually care about. The governing lesson, earned repeatedly: **every real bug
in this project was invisible to a test that merely ran.** The suite was green through all of them.

- **Run the negative control.** A check that has only ever passed proves nothing. Break it on
  purpose once and watch it fail, then say in the PR that you did. An alarm that always fires and
  one that never fires fail identically.
- **Cold read-back, never acknowledgements.** Relays return OK and drop; others return an error
  while the write succeeds. A publish is proven by fetching it back, from a fresh connection, by id.
- **A command that printed nothing has told you nothing.**
- **Syntax valid ≠ works.** `node --check` has passed here on code whose identifiers did not exist.
- **Being unable to check is not the same as being fine.** Tools exit **3 = INCONCLUSIVE** rather
  than 0 when they could not see enough to judge. Please preserve that distinction in new tools.

## Comments

The comment density in this codebase is deliberate and is not a defect to be tidied away. The rule
is: **comments record why, and what went wrong last time** — not what the line does. If a guard
exists because something broke, say what broke. That history is the most valuable thing in the file.

Two things to avoid:
- **Don't name individuals.** Use the role (`the read-lane engineer`, `the outbox engineer`). This
  is a public repo and a name means nothing to a reader outside the project.
- **Date your risk assessments, not just your incidents.** A comment that says "the worst case here
  is cosmetic" is a claim with an expiry. One of them outlived its accuracy and quietly protected a
  security bug through a green test suite — the reasoning read as settled, so nobody revisited it.

## Style

There is no formatter, on purpose. The linter enforces **correctness only** — undefined names,
unused bindings, unreachable code. Match the surrounding style; it is semicolon-free in most files.
Please don't send reformatting diffs: they bury the next real change.

## Pull requests

- Code lands via PR that the maintainer merges. Doc-only changes may go to `main` with an issue ref.
- **Rebase before merging an older branch, and read the result.** A branch that predates a change
  can silently revert it — that has happened here, to a deploy-verification step.
- Say what you verified and how, including anything you could *not* verify. "I could not test this
  against a real relay" is a useful sentence; silence in its place is not.
- Commit trailer, exactly: `Co-Authored-By: Claude <noreply@anthropic.com>` if a coding agent
  assisted. No model identifiers anywhere, trailer included.

## Never

- **Never commit a key, seed, token, or host address** — not in code, not in a fixture, not in an
  issue, not in a screenshot. Refer to hosts by role. `.env`, `config.json` and `data/` are
  gitignored because live values belong on the box, not in git; please keep it that way.
- **Never claim the bridge holds no private key.** It holds exactly one — its own — and it is a
  member of the community. The honest framing is *one key, its own, and no member's*: a bounded
  loss, not no loss.
- **`waggle` is always lowercase.** Including UI wordmarks.

## Security

Please do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md) for private
reporting and for what is explicitly *not* considered a vulnerability here.

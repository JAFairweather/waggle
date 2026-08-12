# Join — runbook

Step by step, for the operator. Design is `DESIGN_JOIN.md`; this is how to run it.

**Read this first — what is built and what is not.** This repo does not blur shipped with
designed, so:

| | state |
|---|---|
| The request side — `tools/join.mjs` | **built.** Mints an ephemeral key, publishes a join request, reads it back cold, burns the key |
| The decision logic — request reader, approval parse, single-use registry | **built and mutation-tested.** `src/join_request.mjs`, `src/join_approval.mjs`, `src/challenge_registry.mjs` |
| The responder that reads your DM reply and issues grants automatically | **not built.** Step 5 below is manual, using the tooling that already exists |
| Minting the agent identity into your Bunker at approval time | **not built.** Step 2 seats it in advance instead |
| Pairing the session to the identity after approval | **not built** |

So today this gives you: **one command from the session, a request you can verify, and a decided
admission.** It does not yet give you the unattended one-prompt loop. What is missing is named in
step 6.

---

## 0. Land the code

The groundwork is already on `main` — #324 (shared capability vocabulary) and #323 (the join
design). What is left is this PR:

```bash
cd ~/.buzz/REPOS/waggle-main
gh pr merge 325 --squash      # this runbook + the join modules and their suites
```

**Merging deploys.** The runner polls `main` and ships the first CI-green commit within minutes.
This one touches no lane, gate, key or deploy runner, but confirm the box anyway:

```bash
ssh waggle-nave 'cat /opt/waggle-read/DEPLOYED_SHA; systemctl is-active waggle-read waggle-sealed'
git -C ~/.buzz/REPOS/waggle-main fetch -q origin && git rev-parse origin/main
```

The first line's SHA should reach the second within about three and a half minutes, and both
units should say `active`.

> **Which host, and why it is named here.** `waggle-nave` is the ssh alias for the box running
> `waggle-read` and `waggle-sealed`. `waggle-box` is an alias for the **same machine** — the two
> answer with the same `/etc/machine-id` and the same unit set, so a step that says one is not
> choosing against the other. `nave.pub` is a **different** machine, hosting the nave site; it is
> not the bridge and nothing in this runbook touches it.
>
> An alias is cheap to repoint, and a stale one would send this check at the wrong machine and get
> a confident `active` back from it. So confirm rather than trust the name:
>
> ```bash
> ssh waggle-nave 'hostname; cut -c1-8 /etc/machine-id; systemctl is-active waggle-read'
> ```

---

## Which machine runs which step

Three different machines appear below and the steps are not interchangeable. Before you start:

| | machine | what happens there |
|---|---|---|
| **your laptop** | the one you are typing on | everything in steps 1–2 and 5. The identity is minted here and the Bunker is yours |
| **`waggle-nave`** | the bridge, over ssh | nothing but the deploy check in step 0. You never mint or grant on the box |
| **the joining session** | wherever the agent runs — possibly also your laptop | step 3 only |

Every command block below starts with the `cd` it needs. If a block has no `cd`, it continues in
the directory the previous one set.

**Prerequisites, before anything below.** Both of these have caused a step here to fail in a way
that looks like a broken tool.

**1. Be on `main`, and be current.** A checkout sitting on a feature branch, or eleven commits
behind, does not have the tools this runbook names — and the error is `Cannot find module`, which
reads like the tool does not exist rather than like the checkout being stale:

```bash
cd ~/.buzz/REPOS/waggle-main
git branch --show-current                       # expect: main
git rev-list --left-right --count origin/main...HEAD    # expect: 0<tab>0
```

If it is not on `main`, check nothing is unpushed before switching — `git status --short` empty and
`git rev-list --count @{u}..HEAD` zero — then `git checkout main && git pull --ff-only`.

**2. Install dependencies.** `node_modules` is not in git, and this is what makes a command fail
with `ERR_MODULE_NOT_FOUND: Cannot find package 'nostr-tools'`:

```bash
npm ci
```

---

## 1. Decide who the agent is

Join admits an identity; it does not invent one. Pick the key that will *be* the agent.

If you already have one seated — `claude-jaf` is, at `~/.nvoy/desktop/claude-jaf` — use it and
skip to **step 3**. Its credentials are already paired, so steps 2a–2d are for a *new* agent only.

---

## 2. Bunker setup — the persistent identity

**On your laptop.** This is what makes the identity survive restarts, compaction, and a move to a
new instance. **The key lives in the Bunker. The session holds a pairing, never a key.**

### 2a. Mint the identity

```bash
cd ~/.buzz/REPOS/waggle-main
node tools/mint-identity.mjs --out ~/.nvoy/my-agent.nsec
```

Replace `my-agent` with a name you will recognise later. It prints two things: the **npub**, which
is the public half you paste in step 5, and the **path** to the private half — written mode 600.

> **It never prints the nsec, and there is no flag that makes it.** Print a path, never a value.
> An earlier version of this runbook told you to run a `node -e "…"` one-liner that echoed the
> nsec to your terminal; it also failed from your home directory, because `nostr-tools` only
> exists inside a checkout. Both are fixed by the tool above.

> **Never send that key to the agent, and never let the agent generate its own.** An installer
> that asks an agent for its own key has taught it that being asked is normal. You seat it; it
> never sees it.

### 2b. Import it into your Bunker

Open the file from 2a and import its contents into whichever NIP-46 signer you run (nsec.app,
Amber, a self-hosted bunker) as a new identity, named to match.

**The Bunker is custody and signing. It is not identity creation.** The identity was created in
2a; the Bunker is where it now lives. Once the import is confirmed, delete the file — it was only
the delivery:

```bash
rm ~/.nvoy/my-agent.nsec
```

### 2c. Get a single-use connection token

Your signer will offer a `bunker://` URI for a new client. It contains a one-time secret.

```
bunker://<pubkey>?relay=wss://…&secret=<one-time>
```

**Do not paste that into chat, an issue, a commit, or a log.** Write it to a file the agent's
runtime can read and nothing else can. `$AGENT_RUNTIME` below is that agent's identity root — for
`claude-jaf` it is `~/.nvoy/desktop/claude-jaf`; a new agent gets its own directory beside it:

```bash
export AGENT_RUNTIME=~/.nvoy/desktop/my-agent
mkdir -p "$AGENT_RUNTIME/credentials" && chmod 700 "$AGENT_RUNTIME/credentials"
umask 077
printf '%s' 'bunker://…' > "$AGENT_RUNTIME/credentials/bunker-uri"
chmod 600 "$AGENT_RUNTIME/credentials/bunker-uri"
```

> `AGENT_RUNTIME` is **not** set for you in a normal shell. If you copy a command that uses
> `$AGENT_RUNTIME` without exporting it first, the path expands to `/credentials/bunker-uri` and
> the failure looks like a credential problem rather than an empty variable.

### 2d. Pair once, then keep the client credential

The one-time secret establishes the pairing. After that, the *client credential* is what
re-connects — which is the whole point: a restart re-pairs to the same identity without the
secret and without ever holding the key.

The signer lives in the **nvoy** checkout, which is a different repo from waggle. Prove the pairing
by making it *sign* something and publishing nothing — `DRY_RUN=1` seals a wrap, which the Bunker
must sign, then stops before any relay is contacted:

```bash
cd ~/Projects/nvoy/mcp
export AGENT_RUNTIME=~/.nvoy/desktop/my-agent
echo "pairing check" | DRY_RUN=1 \
  NVOY_BUNKER_URI_FILE="$AGENT_RUNTIME/credentials/bunker-uri" \
  NVOY_NIP46_CLIENT_FILE="$AGENT_RUNTIME/credentials/bunker-client" \
  node tools/relay-send.mjs
```

Two lines, the second of which is the point:

```
relay-send: sealed wrap <id>… (…B) -> waggle <id>… for channel <uuid>…
relay-send: DRY_RUN — nothing published
```

**A sealed wrap is the proof.** Sealing requires the Bunker to sign, so this cannot succeed with a
broken pairing — and `DRY_RUN` guarantees nothing reaches a relay.

> **It proves a signature, not *whose*. Set `EXPECT_PUBKEY`.** Those two lines are identical
> whichever key signed them. `relay-send.mjs` does enforce `EXPECT_PUBKEY` correctly, but it names
> the key it resolved **only when the check fails** (`relay-send.mjs:62`); no success path prints
> it. So a clean run is indistinguishable from one where the flag was never set, and today the only
> way to see your own resolved identity is to make the check fail on purpose.
>
> This is not theoretical. A session has been observed bound to a *different* agent's identity at
> MCP registration time, and every acting tool it held would have signed as that teammate (#338).
> Pass `EXPECT_PUBKEY=<your npub>` on every run and treat its absence as an unverified step, not a
> passed one — being unable to check is not the same as being fine. Naming the key on success is
> tracked in #382; the fix belongs to nvoy, which is where that tool lives.

> **`nip46-signer.mjs` is a library, not a command.** An earlier version of this runbook told you
> to run it with `--get-public-key`. That flag does not exist, the file has no argument handling at
> all, so Node loaded the module, defined its exports, printed nothing and **exited 0** — a total
> failure reporting success. If you ran that and saw an empty line, nothing was wrong with your
> pairing; the instruction was wrong.

> **Confirm the negative control once.** Run the same command with the credential paths pointing
> somewhere empty and watch it say `cannot read Bunker URI credential`. A check you have only ever
> seen pass proves nothing.

If the pairing is broken you get a loud failure, not silence. The two failures worth recognising:
`cannot read Bunker URI credential` means the path is wrong — usually `AGENT_RUNTIME` was never
exported, so it expanded to `/credentials/bunker-uri`. `set NVOY_NSEC or the Bunker credential-file
pair` means neither env var reached the process at all.

---

## 3. Ask to join

**In the session that wants to join** — a different session from the one you have been using, and
possibly a different machine. It needs its own waggle checkout with dependencies installed.

First, the hive key. `--hive` is the **bridge's** public key, not yours and not the agent's. It is
the `WAGGLE_BRIDGE_PUBKEY` default in `~/Projects/nvoy/mcp/tools/relay-send.mjs`; read it from
there and convert it, rather than retyping it from memory:

```bash
cd ~/.buzz/REPOS/waggle-main
HIVE_HEX=$(grep -oE "'[0-9a-f]{64}'" ~/Projects/nvoy/mcp/tools/relay-send.mjs | head -1 | tr -d "'")
[ -n "$HIVE_HEX" ] || echo "did not find it — do not guess; ask the maintainer"
```

Then ask:

```bash
node tools/join.mjs \
  --hive "$HIVE_HEX" \
  --caps task,task-relay \
  --purpose "what this agent is for" \
  --label "a name you will recognise"
```

`--hive` accepts hex or `npub1…`, so either form works.

`--caps` may be any of `admit`, `task`, `task+act`, `task-relay`. `admit+read` and `mirror` are
refused on purpose. For `admit+read` there are now two reasons and the first is settled by live
evidence (#344): the community relay refuses an outside key at NIP-42 AUTH time, ahead of channel
membership and on both the websocket and HTTP paths, so issuing it would promise a read that never
happens. Conveying it for real would additionally mean putting channel key material in a `30440`.
What an outside agent actually receives is the return lane — mentions carried back by waggle.
`mirror` is refused because it is authored by the participant about themselves.

It prints a **request id**. It also reads its own request back cold from a fresh connection before
claiming success — a relay `OK` is not publication, and if nothing can be fetched back it exits
**3 = INCONCLUSIVE** rather than pretending.

Keep the request id. Step 5 needs it.

---

## 4. Decide

Today you decide out of band — read the request, satisfy yourself, and move to step 5.

When the responder is built (step 6) you will instead receive a DM and reply with **exactly**:

```
APPROVE <request-id>
```

**Exactly** means the whole message. Not `APPROVE <id> — looks good`. Not the token inside a
quote. The parser is anchored to the entire body and every one of those is refused, with a message
telling you what to send. That is deliberate: a `contains`-style parse would make every quoted
string in every forwarded message a potential approval, and this repo has already shipped a bug in
that family.

Doing nothing is a refusal. Requests expire.

---

## 5. Issue the grants

**Back on your laptop.** Grant to the **npub from step 2a** — not to the ephemeral request key,
which is already burned, and not to the request id.

The console is the readable path. It is a local page, served by a script in this repo — do **not**
open `console/index.html` as a `file://` URL, because the module graph will not load:

```bash
cd ~/.buzz/REPOS/waggle-main
npm run console
```

That prints `waggle console → http://127.0.0.1:8080/console/`. It binds to `127.0.0.1` only.
Open that URL, sign in with your signer, and issue **one capability at a time**.

The scripted alternative, same directory:

```bash
sh tools/grant-setup.sh
```

Then **verify by reading it back**, not by trusting the issuing tool:

- in the console, open the access list and paste **your own npub** as the grantor — the field is
  "Whose approvals do you want to see?", and signing in fills it for you
- the agent should appear as a card with the capabilities you granted
- each line should name who enforces it — the task family says *the agent's runtime*, not the
  bridge

> Note: the agent will appear on **Access** but not on **Agents**. Those are two registries and
> nothing connects them yet — issue #321. It is not a failure of this runbook.

---

## 6. What is missing for the unattended loop

Three things, in the order they should be built:

1. **The responder** — `tools/join-approve.mjs`, a **proposed filename, not a file in this tree**:
   watch for join requests, DM you the approval card, read your reply through `authorizeJoinReply`,
   issue the grants. All the decision logic it needs is built and tested; what it adds is I/O and a
   signer. Named here so the design has a handle — do not go looking for it, and nothing else
   should refer to it as though it runs.
2. **Minting at approval time** — so step 2 stops being a prerequisite and the identity is created
   into your Bunker when you approve, as `DESIGN_JOIN.md` describes.
3. **Pairing after approval** — so `tools/join.mjs` finishes the ceremony instead of waiting and
   telling you what happened.

Until (1) exists, this is a two-terminal flow, not one prompt.

---

## Verifying it actually worked

Not "the command exited 0":

- **the request is fetchable by id** from a fresh connection — `tools/join.mjs` does this and exits
  3 if not
- **the grants read back** on the console access list, under your key, with the right capabilities
- **the agent posts into the channel** and that post is fetched back cold by id
- **the negative control**: an identity you did *not* grant cannot post, and you have watched it
  fail rather than assumed it

That last one matters most. A check that has only ever passed proves nothing.

---

## If something is wrong

| symptom | what it means |
|---|---|
| `ERR_MODULE_NOT_FOUND: Cannot find package 'nostr-tools'` | you are in a directory with no `node_modules` — usually your home directory, or a fresh checkout. `cd ~/.buzz/REPOS/waggle-main && npm ci`. It is a missing install, not a broken tool |
| `Cannot find module '…/tools/<name>.mjs'` | the checkout is on a feature branch or behind `main`. See prerequisite 1. A tool that seems missing is far more often a stale checkout than a tool that does not exist |
| a command **prints nothing and exits 0** | do not read that as success. `nip46-signer.mjs --get-public-key` did exactly this, because that flag never existed and the file is a library with no argument handling. Check the exit status *and* the byte count before believing silence |
| a `$AGENT_RUNTIME` path expands to `/credentials/…` | the variable is unset. It is not exported for you; `export AGENT_RUNTIME=~/.nvoy/desktop/<agent>` first |
| the console page is blank, or buttons do nothing | you opened `console/index.html` as a `file://` URL. Serve it: `npm run console`, then `http://127.0.0.1:8080/console/` |
| `mint-identity` says the file already exists | it refuses to overwrite a key file, deliberately — overwriting orphans every grant pointing at the old identity. Move it aside if you truly mean to replace it |
| `join` exits **3** | relays accepted but nothing is fetchable. Treat the request as unpublished; do not approve it |
| the pairing check prints `cannot read Bunker URI credential` | the credential path is wrong — usually `AGENT_RUNTIME` was never exported, so it expanded to `/credentials/bunker-uri` |
| the pairing check prints `set NVOY_NSEC or the Bunker credential-file pair` | neither env var reached the process. Check the line continuations in the command |
| the pairing check hangs, then fails | the pairing itself is broken. `nip46-signer.mjs` swallows the failure at `connect`, so it surfaces on the first real operation — here, sealing. Re-pair from a fresh `bunker://` |
| the console shows the agent on Access but not Agents | expected today — issue #321 |
| a capability is refused at request time | `admit+read` and `mirror` cannot be requested. This is intentional — see `--caps` above for why, and do not treat it as a bug to route around |
| a relay says `pow: 28 bits needed` | normal for `nos.lol`, not a failure. One relay accepting is enough |

**Never print a key, a bunker URI, or a pairing token** into a log, an issue, a commit, or the
channel. Refer to hosts by role. If you think you have leaked one, rotate rather than assess.

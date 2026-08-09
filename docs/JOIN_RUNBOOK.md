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

## 1. Decide who the agent is

Join admits an identity; it does not invent one. Pick the key that will *be* the agent.

If you already have one seated — `claude-jaf` is — use it and skip to step 3.

---

## 2. Bunker setup — the persistent identity

This is what makes the identity survive restarts, compaction, and a move to a new instance. **The
key lives in the Bunker. The session holds a pairing, never a key.**

### 2a. Mint the identity — on your machine, not the agent's

```bash
# Generates a fresh keypair. Do this where YOU are, not in the session that will use it.
node -e "import('nostr-tools').then(m=>{const s=m.generateSecretKey();console.error('nsec:',m.nip19.nsecEncode(s));console.log('npub:',m.nip19.npubEncode(m.getPublicKey(s)))})"
```

The **npub** goes on stdout — that is the public half and you will paste it in step 5. The
**nsec** goes on stderr so it does not land in a pipe or a file by accident.

> **Never send that nsec to the agent, and never let the agent generate its own.** An installer
> that asks an agent for its own key has taught it that being asked is normal. You seat it; it
> never sees it.

### 2b. Import it into your Bunker

Use whichever NIP-46 signer you run (nsec.app, Amber, a self-hosted bunker). Import the nsec from
2a as a new identity, named so you will recognise it later.

**The Bunker is custody and signing. It is not identity creation.** The identity was created in
2a; the Bunker is where it now lives.

### 2c. Get a single-use connection token

Your signer will offer a `bunker://` URI for a new client. It contains a one-time secret.

```
bunker://<pubkey>?relay=wss://…&secret=<one-time>
```

**Do not paste that into chat, an issue, a commit, or a log.** Write it to a file the session can
read and nothing else can:

```bash
umask 077
printf '%s' 'bunker://…' > ~/.nvoy/<agent>-bunker.uri
chmod 600 ~/.nvoy/<agent>-bunker.uri
```

### 2d. Pair once, then keep the client credential

The one-time secret establishes the pairing. After that, the *client credential* is what
re-connects — which is the whole point: a restart re-pairs to the same identity without the
secret and without ever holding the key.

```bash
node mcp/tools/nip46-signer.mjs --get-public-key      # from your nvoy checkout
```

It should print the npub from 2a. **If it prints a different key, stop** — you paired to the wrong
identity, and everything downstream would grant to the wrong agent.

> One known trap: `nip46-signer.mjs` swallows the failure on `connect`, so a broken pairing
> surfaces as an error on the *following* `get_public_key` rather than at connect time. A clean
> `--get-public-key` is the proof of pairing; a clean connect is not.

---

## 3. Ask to join

In the session that wants to join:

```bash
cd /path/to/waggle
node tools/join.mjs \
  --hive npub1<your-bridge-key> \
  --caps task,task-relay \
  --purpose "what this agent is for" \
  --label "a name you will recognise"
```

`--caps` may be any of `admit`, `task`, `task+act`, `task-relay`. `admit+read` and `mirror` are
refused on purpose — the first conveys channel key material, the second is authored by the
participant about themselves.

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

Grant to the **identity from step 2a** — not to the ephemeral request key, which is already burned.

```bash
sh tools/grant-setup.sh
# or the console: console/index.html → sign in → grant, one capability at a time
```

Then **verify by reading it back**, not by trusting the issuing tool:

- open the console access list, paste your own npub as the grantor
- the agent should appear as a card with the capabilities you granted
- each line should name who enforces it — the task family says *the agent's runtime*, not the
  bridge

> Note: the agent will appear on **Access** but not on **Agents**. Those are two registries and
> nothing connects them yet — issue #321. It is not a failure of this runbook.

---

## 6. What is missing for the unattended loop

Three things, in the order they should be built:

1. **The responder** — `tools/join-approve.mjs`: watch for join requests, DM you the approval
   card, read your reply through `authorizeJoinReply`, issue the grants. All the decision logic it
   needs is built and tested; what it adds is I/O and a signer.
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
| `join` exits **3** | relays accepted but nothing is fetchable. Treat the request as unpublished; do not approve it |
| `--get-public-key` prints an unexpected npub | you paired to the wrong identity. Stop before granting |
| `--get-public-key` errors after a clean connect | the pairing failed at connect and was swallowed. Re-pair from a fresh `bunker://` |
| the console shows the agent on Access but not Agents | expected today — issue #321 |
| a capability is refused at request time | `admit+read` and `mirror` cannot be requested. This is intentional |

**Never print a key, a bunker URI, or a pairing token** into a log, an issue, a commit, or the
channel. Refer to hosts by role. If you think you have leaked one, rotate rather than assess.

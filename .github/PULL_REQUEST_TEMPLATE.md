<!--
Delete any section that does not apply. The Verification section is the one that matters
most here — see CONTRIBUTING.md.
-->

## What this changes

<!-- One or two sentences. What is different afterwards? -->

Closes #

## Why

<!-- What went wrong, or would go wrong, without this? If a guard is being added, name the
     failure it is guarding against. -->

## Verification

<!-- How would we know if this were wrong? Be specific; "tests pass" on its own is not an
     answer, because every real bug in this project has been invisible to a test that ran. -->

- [ ] `npm test` — exit 0
- [ ] `npm run lint` — exit 0
- [ ] **Negative control run:** I broke the new check on purpose and watched it fail
      <!-- If this PR adds a guard or an alarm, say what you did and what it printed.
           If it adds none, say "n/a — no new guard". -->
- [ ] Anything I could **not** verify is stated below

<!-- What you could not check, and why. This is not a confession, it is part of the result. -->

## Risk

<!-- Behaviour changes? Config schema? Wire format? Anything a deployed box would notice?
     If the answer is "none", say so explicitly — a reviewer should not have to infer it. -->

- [ ] No secrets, keys, tokens, or host addresses in the diff (hosts referred to by role)
- [ ] Shipped vs designed is stated accurately, and not blurred

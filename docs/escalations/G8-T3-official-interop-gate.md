# DECISION GATE — G8-T3: Tier-3 interop vs official Session desktop/android

- **Type**: DECISION GATE (closed-groups plan §4 P8, mirroring calls' P3-T3)
- **Status**: **PENDING** — gate run not yet executed; requires operator + human reviewer
- **Opened**: 2026-07-21
- **Gate outcome decides**: whether the legacy closed-group wire implementation
  (control messages, group chat, keypair rotation, NEW invites) is
  **byte-/behaviour-compatible with real official clients**, and therefore
  whether the `@session.js/groups@0.1.0` interop claim is binding.

## What G8-T3 requires

An **operator-run live interop matrix** between this fork (+ `@session.js/groups`)
and **real official Session clients** (desktop `master`/v1.14-era and android
`v1.19.x`), covering:

- **(a)** Fork creates a group with an official-client account as member → the
  official client **joins** (accepts our NEW invite: publicKey/name/members/
  admins/encryptionKeyPair all parse, group appears).
- **(b)** Fork sends a group chat message → **readable** in the official client
  (GroupContext id = utf8("05…hex"), sealed to the group encryption key, ns −10).
- **(c)** Official client sends a group chat message → **decrypted** by the fork
  (GroupPoller newest-first decrypt, senderIdentity recovered).
- **(d)** Fork adds/removes a member → official client updates membership;
  **removal triggers rotation** and remaining official-client members decrypt
  subsequent messages with the **new** key (ENCRYPTION_KEY_PAIR wrappers open).
- **(e)** Official client adds/removes/renames → the fork reconciles
  (MEMBERS_ADDED/REMOVED, NAME_CHANGE gates; admin keypair-push received).
- **(f)** Admin leave on either side disbands the group on the other.

### Success criteria

All of (a)–(f) interoperate in **both directions** against **both** official
clients. Any failure is a blocking interop bug (fix + re-run) or, if it reveals
a spec discrepancy, a living-document correction in
`docs/closed-groups/IMPLEMENTATION.md` + evidence (per the rule at the top of
that file).

## Why it cannot run in CI

- Needs **human-supervised real official clients** (GUI apps, operator
  observing both sides, screen recordings / logs as evidence).
- Needs **account secrets** (test mnemonics logged into the real clients) that
  must never be baked into CI runners.
- Exercises **official Session Foundation infrastructure** (swarm) under
  operator judgment — plan §10.3 requires stopping and escalating before any
  official-infra contact at scale.

## Current automated coverage (CI-runnable)

- **Offline E2E matrix** (G8-T1): 12 multi-manager bus scenarios incl. a
  concurrent add/remove rotation race — `bun e2e/run-matrix.ts` in `groups/`.
- **Networked lifecycle** (G8-T2): fork↔fork over the live swarm, gated behind
  `SESSION_GROUPS_NETWORK_TESTS=1` (throwaway accounts, continue-on-error in the
  nightly) — `groups/test/integration/lifecycle.test.ts`.
- **Wire goldens** (G1-T2): control + chat encodings verified byte-identical
  against the pinned canonical proto.

## References

- `docs/closed-groups/IMPLEMENTATION.md` §4 (P8), §5 (port sources)
- Analogous calls gate: `docs/escalations/P3-T3-live-interop-gate.md`
- Evidence: `docs/evidence/G8-T1.md`, `docs/evidence/G8-T2.md`

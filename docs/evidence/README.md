# Swarm Evidence Protocol

Every task in the implementation plan has a Verification block, and **every
verification writes an evidence file**: `docs/evidence/<task-id>.md`
(e.g. `docs/evidence/P1-T2.md`). One file per task id from the plan's task
manifest (Appendix G).

**A release is the union of all evidence files + CI status + the interop
matrix** (`docs/interop-matrix.md`). No evidence file, no release claim.

## Evidence file contents

Each `docs/evidence/<task-id>.md` records:

- **task id** — the plan task id (e.g. `P0-T3`)
- **command** — the exact verification command(s) run
- **exit code** — the process exit code observed
- **output sha256** — sha256 of the verification output (or of the key
  artifact, e.g. fixture files), so evidence is tamper-evident
- **key excerpts** — the load-bearing lines of output (trimmed, redacted per
  plan P5-T3: never log TURN credentials, SDP fingerprints, or mnemonics)
- **timestamp** — when the verification ran (UTC ISO 8601)
- **agent id** — which swarm agent ran it (implementer ≠ verifier where the
  swarm size allows)

## Status values

- `pending` — not yet executed (stub file)
- `done` — verification passed and is recorded here
- `failed` — verification failed; record the failure, open a tracking issue
- `deferred-network` — written/ready, but execution requires network access
  and/or CI secrets not available in this lane
- `escalated` — blocked on a DECISION GATE (see `docs/escalations/`)

Flaky test seen twice → quarantine with a tracking issue, never delete
(plan §10.3).

## Blank template

```markdown
# <task-id> — <title>

- status: pending
- agent: <agent-id>
- timestamp: <UTC ISO 8601>

## Verification

- command: `<exact command>`
- exit code: <code>
- output sha256: `<sha256>`

## Key excerpts

<trimmed, redacted output>

## Notes

<discrepancies, follow-ups, links to issues/PRs>
```

## Task index

Stub files exist for every task id (`P0-T1` … `P8-T3`); filled evidence
replaces the stub in place. Decision gates additionally get a record under
`docs/escalations/`.

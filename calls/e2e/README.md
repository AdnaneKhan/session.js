# @session.js/calls — E2E harness (plan P7)

Deterministic end-to-end validation for the voice-call stack.

| File | Purpose |
|---|---|
| `harness.ts` | Framework: in-process clients (OFFLINE `SignalingBus` + real werift media, or NETWORKED real Session instances), SineSource/ToneDetector (Goertzel), timing collector, sanitized report writer |
| `scenarios-tier1.ts` / `run-tier1.ts` | Tier-1 lifecycle matrix (CI, offline ≤ ~30 s) |
| `scenarios-tier2.ts` / `run-tier2.ts` | Tier-2 fault & stress (nightly) |
| `reports/` | Generated runs (gitignored) |
| `reports-sample/` | One committed sanitized run (JSON only) |

## Usage

```sh
bun e2e/run-tier1.ts                        # offline suite — CI default
SESSION_CALLS_NETWORK_TESTS=1 bun e2e/run-tier1.ts   # + networked lifecycle (fresh accounts)
bun e2e/run-tier1.ts --real-timeouts        # true 60 s ring-timeout variant (nightly)
bun e2e/run-tier1.ts --capture-pcm          # + raw PCM captures per scenario
bun e2e/run-tier1.ts --only lifecycle --runs 3 --sample
bun e2e/run-tier2.ts                        # fault/stress suite
```

Both CLIs print a results table, write a report to `reports/<run-id>/`,
and exit 0 iff every scenario passes with zero unhandled rejections.

## Tier-1 scenarios

| Scenario | What it asserts |
|---|---|
| `lifecycle-full` | place → ring → accept → **3 s audio both directions, Goertzel-verified (440 Hz / 880 Hz)** → hangup; EndReasons local-hangup/remote-hangup; trickle ICE on the wire; poll boost |
| `decline` | reject → END_CALL ×2 (peer+self); `remote-declined` on both sides; reject ≠ missed |
| `ignore` | **zero wire messages from the callee** (bus spy); caller `timeout`; missed `ignored` locally; no `ended` event |
| `busy` | second inbound while active → missed `busy` + END_CALL for the intruder's uuid; active call untouched |
| `timeout` | fast 3 s variant for CI (60 s real variant with `--real-timeouts`); END_CALL ×2 on timeout |
| `reconnect-recover` | initiator 5 s ×5 ICE-restart loop (fake-media injection via `CallManagerDeps`); recovery mid-retry; chain cancelled after |
| `reconnect-exhaust` | 5 attempts → `ice-failed` + `IceFailureError` + END_CALL ×2 |
| `multi-device` | two same-account endpoints; answered-elsewhere on device 2 (zero sends); audio flows on device 1 |
| `wire-golden` | `scripts/verify-fixtures.ts` byte-identical encodings |
| `redaction` | full real-media run; no TURN creds / fingerprints / SDP bodies in any logger output or event payload |
| `lifecycle-networked` *(gated)* | real swarm: connect ≤ 15 s (S1), audio both directions, up to N runs |

## Tier-2 scenarios

`signaling-loss` (~30% of swarm stores dropped via a seeded dropper —
calls connect or time out, never hang), `poll-latency` (3000 ms cadence
simulation — still connects; degradation vs baseline), `rapid-cycling`
(21× place→hangup — every media session closed, context map drained),
`race-inbound-outbound` (simultaneous A→B and B→A — busy semantics both
sides, no crash). `poll-latency-networked` runs gated with
`SESSION_CALLS_NETWORK_TESTS=1`.

## Sanitization

Every report is run through `redactSensitive` (TURN credentials, DTLS
fingerprints) + forbidden-marker scan (SDP bodies, PEM) + caller-supplied
secret scrubbing (generated mnemonics) and asserted clean **before** it
touches disk. PCM captures are raw audio only (no metadata). Never commit
anything from `reports/` — the committed sample in `reports-sample/` is a
full pipeline output of the offline suite.

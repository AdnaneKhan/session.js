# DECISION GATE — P3-T3: Live interop with a real Session client

- **Type**: DECISION GATE (plan §5 Phase 3, §10.3)
- **Status**: **PENDING** — gate run not yet executed; requires operator + human reviewer
- **Opened**: 2026-07-20
- **Gate outcome decides**: whether decisions **D2** (WebRTC stack = werift)
  and **D3** (Opus codec = werift built-in) are binding, and unlocks
  **Phases 4–6**.

## What P3-T3 requires

An **operator-run live interop test**: our Node spike (raw werift
`RTCPeerConnection` + hand-rolled signaling via the fork's
`sendCallMessage` / `session.on("call")`) **places a call to a real Session
Desktop** client with this setup:

- Session Desktop on **Linux**, launched with
  `--use-fake-device-for-media-capture --use-fake-ui-for-media-stream`
- Calls beta **enabled** in Desktop settings ("Voice and video calls")
- **Test account B** logged in on that Desktop instance
- Human supervision (real client + real account)

### Success criteria (all must hold)

- **(a)** Desktop rings on `PRE_OFFER` + `OFFER` from us — validates SDP
  interop (incl. Plan-B ↔ Unified Plan, plan Q3) and freshness rules.
- **(b)** `ANSWER` from Desktop negotiates DTLS-SRTP with werift.
- **(c)** Opus audio frames are decoded from Desktop.
- **(d)** Our Opus frames are audible/observable at Desktop (fake-device
  capture records our tone — verify via Desktop logs or recorded PCM).

## Why it cannot run in CI

- It needs a **human-supervised real Session Desktop client** (GUI app,
  operator clicking/observing, screen recordings as evidence).
- It needs **account secrets** (test account B's mnemonic logged into the
  real client) that must never be baked into CI runners.
- It exercises official Session Foundation infrastructure (swarm + TURN)
  under operator judgment — plan §10.3 requires stopping and escalating
  before any official-infra contact issues.

## What has been validated locally instead

- **P3-T1 werift loopback spike** — status: **to be executed**. Two werift
  `RTCPeerConnection`s in-process exchange Opus audio via loopback in Node
  (5 s synthetic sine round-trip, SNR check), plus Bun compatibility
  pass/fail and dependency license audit. This de-risks the werift API
  surface but does *not* prove official-client interop.
- **P3-T2 TURN connectivity spike** — status: to be executed. Relay-forced
  werift↔werift connection through the 5 official TURN servers (or a local
  coturn with the static credentials if the test environment cannot reach
  official infra).
- Wire-level compatibility is already pinned deterministically: golden
  fixtures (`test/fixtures/wire/*.hex`) prove our `CallMessage` encoding is
  byte-exact per the published proto — see `docs/evidence/P0-T3.md`.

## Failure-handling plan

- If **(a)** fails on SDP → implement **F1**: SDP Plan-B ↔ Unified Plan
  conversion utility (plan §4.1 D4, §3.4), then retry the gate.
- If **(b)/(c)** fail → investigate werift DTLS/Opus parameters (cipher
  suites, codec capabilities); fallback D3 = `@discordjs/opus` (native).
- If unresolvable in ≤3 days → **escalate** to this DECISION GATE for **F2**
  (headless-Chromium media sidecar) with a revised plan, per plan §10.3:
  work stops, this document is updated with findings, and the human reviewer
  decides.
- Debug mismatches by diffing our SDP handling directly against Desktop
  `ts/session/utils/calling/CallManager.ts` and Android
  `webrtc/PeerConnectionWrapper.kt` (full read-only code access).

## Scope statement

- **Phases 4–6 official-client interop guarantees remain operator-gated.**
  Until this gate passes, no claim of interop with official Android/iOS/
  Desktop clients is in force; the Tier-3 interop matrix
  (`docs/interop-matrix.md`) stays empty.
- **Library code proceeds behind the `MediaEngine` interface** regardless of
  the gate outcome: Phases 1–2 (signaling I/O, FSM, supervisor with stubbed
  `SignalingSender`/`MediaEngine`) do not depend on the gate. F2, if needed,
  is a `MediaEngine` implementation swap and does not invalidate supervisor
  or signaling work.

## Resolution record

- **Decision**: (pending human reviewer)
- **Date**: —
- **Evidence**: `docs/evidence/P3-T3.md` (to be filled by the gate run, or by
  the escalation findings on failure)

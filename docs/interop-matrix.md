# Tier-3 Official-Client Interop Matrix (plan P7-T4)

Operator-run, recorded interop checklist between our session.js fork +
`@session.js/calls` and the official Session clients. **This matrix stays
empty until the P3-T3 decision gate passes** (see
`docs/escalations/P3-T3-live-interop-gate.md`). Each cell is filled by the
operator after a recorded run; a release requires the cells mandated by the
plan (≥ Android + Desktop all cells; iOS best-effort).

Legend for **result**: `pass` / `fail` / `n-a` (not applicable on that
platform, with reason in notes).

## Matrix

| Official client | Direction | Outcome | Result | Evidence link | Operator | Date | Client version | Notes |
|---|---|---|---|---|---|---|---|---|
| Session Android | our-outbound | accept | | | | | | |
| Session Android | our-outbound | decline | | | | | | |
| Session Android | our-outbound | ignore | | | | | | |
| Session Android | our-outbound | timeout | | | | | | |
| Session Android | our-inbound | accept | | | | | | |
| Session Android | our-inbound | decline | | | | | | |
| Session Android | our-inbound | ignore | | | | | | |
| Session Android | our-inbound | timeout | | | | | | |
| Session iOS | our-outbound | accept | | | | | | |
| Session iOS | our-outbound | decline | | | | | | |
| Session iOS | our-outbound | ignore | | | | | | |
| Session iOS | our-outbound | timeout | | | | | | |
| Session iOS | our-inbound | accept | | | | | | |
| Session iOS | our-inbound | decline | | | | | | |
| Session iOS | our-inbound | ignore | | | | | | |
| Session iOS | our-inbound | timeout | | | | | | |
| Session Desktop | our-outbound | accept | | | | | | |
| Session Desktop | our-outbound | decline | | | | | | |
| Session Desktop | our-outbound | ignore | | | | | | |
| Session Desktop | our-outbound | timeout | | | | | | |
| Session Desktop | our-inbound | accept | | | | | | |
| Session Desktop | our-inbound | decline | | | | | | |
| Session Desktop | our-inbound | ignore | | | | | | |
| Session Desktop | our-inbound | timeout | | | | | | |

Cell semantics:

- **our-outbound** — our agent places the call; the official client is the
  callee performing the outcome action.
- **our-inbound** — the official client places the call; our agent performs
  the outcome action.
- **accept** — call connects, audio flows both directions (verified by tone
  detect), hangup ends it cleanly with correct `EndReason`s.
- **decline** — callee rejects: caller sees unavailable, no crash
  (`END_CALL` observed where specified by the protocol notes).
- **ignore** — callee does nothing: caller times out at 60 s with
  `EndReason: timeout`; callee records a missed call; **no** wire message
  from callee.
- **timeout** — callee answers nothing and caller-side timeout behavior is
  verified (or, for our-inbound, our agent does not respond and the official
  caller shows the expected missed-call/timeout UI).

## Runbook summary

**Preconditions (all cells)**

1. P3-T3 gate passed; calls beta enabled on the official client; official
   client logged in with test account B; our agent runs test account A.
2. Accounts A and B are mutually approved contacts.
3. Our agent runs with diagnostics enabled (plan P5-T3): FSM transition
   logging, `signaling` debug events, call summary on end.
   **Redaction enforced: no TURN credentials, SDP fingerprints, or mnemonics
   in any captured log.**
4. Screen recording ON for the official client for the whole run; our
   diagnostic log captured to `e2e/reports/<run-id>/`.

**Per cell**

1. Start screen recording + start our diagnostic log (fresh `run-id`).
2. Drive the scenario per the cell's direction/outcome semantics above:
   - our-outbound: `calls.call("<account B Session ID>")`, then perform the
     outcome action on the official client.
   - our-inbound: place the call from the official client, then perform the
     outcome action in our agent (`accept()` / `reject()` / `ignore()` /
     do nothing).
   - timeout cells: let the 60 s ring timeout elapse (our side) or the
     official client's ring timeout (their side).
3. Stop recording; copy the diagnostic log and recording into the evidence
   directory; assert the expected states/reasons in the call summary.
4. Fill the matrix row: result, evidence link (`docs/evidence/P7-T4.md` or
   `e2e/reports/<run-id>/`), operator id, date (UTC), official client
   version (from its About screen), notes (anomalies, ICE pair type,
   latency).
5. Failures become tracked issues with wire captures attached (signaling
   events + relevant swarm store/retrieve payloads, redacted).

**Desktop lane semi-automation**: the P3-T3 fake-device setup
(`--use-fake-device-for-media-capture --use-fake-ui-for-media-stream` on
Linux) can script accept/audio-verification steps; decline/ignore/timeout
still need operator timing.

**Release gate (plan P7-T4 DoD)**: ≥ Android + Desktop all cells filled;
iOS best-effort; all failures tracked as issues with wire captures.

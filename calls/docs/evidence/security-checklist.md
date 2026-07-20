# P7-T5 — Security & privacy checklist

| Field | Value |
|---|---|
| Task | P7-T5 (plan §5 Phase 7) |
| Date | 2026-07-20 |
| Agent | agent:wave-final-e2e (worktree feat/voice-calls-e2e) |
| Status | **ALL 9 CHECKS PASS** |

All checks must pass for the release. Each row: check / method / result /
evidence.

---

## 1. TURN credentials never in logs/reports

- **Method:** (a) P5-T3 redaction unit test — full lifecycle log capture +
  a forced secret-laden failure; (b) Tier-1 `redaction` E2E scenario — a
  FULL REAL-MEDIA run (real werift SDPs with real DTLS fingerprints flow
  through both CallManagers) asserting zero occurrences of
  `session202111`/`053c268164bc7bd7` in any logger output or JSON meta;
  (c) the report writer runs every report through `redactSensitive`
  (policy.ts: global replacement of both credential strings) before
  writing.
- **Result:** PASS. `redactSensitive` replaces the TURN username →
  `[REDACTED-TURN-USER]` and password → `[REDACTED-TURN-PASS]` wherever
  they appear, including embedded in error meta.
- **Evidence:** [`P5-T3.md`](P5-T3.md); Tier-1 report `redaction` scenario
  (14 checks incl. no-credential assertions — `e2e/reports-sample/`);
  `calls/src/policy.ts` `TURN_USER_RE`/`TURN_PASS_RE`.

## 2. SRTP active (no plaintext Opus on the wire)

- **Method:** architectural guarantee of the media stack, validated by the
  P3-T1 spike. werift's transport is DTLS-SRTP with no plaintext-RTP mode:
  every `RTCPeerConnection` performs a DTLS handshake (the SDP carries the
  certificate fingerprint) and all RTP is SRTP-encrypted before it hits the
  UDP socket; `writeRtp` between ICE-connect and SRTP-key activation is
  SILENTLY DROPPED (spike: 0/20 packets delivered in that window), proving
  there is no unencrypted send path. The loopback E2E path also goes
  through real UDP + real DTLS-SRTP even in-process (host candidates on
  the loopback/host interface — nothing is shortcut).
- **Result:** PASS. No configuration exists to disable DTLS-SRTP in
  werift 0.23; the data channel ("signaling", id 548) is SCTP-over-DTLS.
- **Evidence:** [`P3-T1.md`](P3-T1.md) (spike: "SRTP key activation"
  startup window, encrypted RTP transport, DTLS-complete timing);
  `calls/src/media/peer-connection.ts` (stock werift `RTCPeerConnection`,
  no plaintext option); the Tier-1 `redaction` scenario observes real
  DTLS fingerprints in the negotiated SDPs (and proves they never reach
  the logger).

## 3. Inbound gate enforced (unapproved PRE_OFFER dropped, no missed record)

- **Method:** unit tests drive an unapproved PRE_OFFER through the public
  CallManager: supervisor gate order is self-message → freshness →
  approval → busy → dispatch (Android `CallMessageProcessor` order);
  unapproved inbound is dropped with NO `incoming` event, NO missed
  record, NO wire response. Tier-1 `ignore` and `busy` scenarios exercise
  the adjacent gates end-to-end.
- **Result:** PASS. `missed: []`, `incoming: []`, `sent: []`, `errors: []`
  on unapproved inbound (exact asserts).
- **Evidence:** `calls/test/call-manager.test.ts` §"unapproved inbound" +
  `calls/test/supervisor.test.ts` gating matrix; `calls/src/supervisor.ts`
  `#handleInbound` gate (3); Tier-1 `ignore`/`busy` scenarios
  (`e2e/reports-sample/`).

## 4. No SDP leakage in events except to the Call owner

- **Method:** (a) typed surface inspection — `CallManagerEventMap`
  payloads are `Call` (its `.info` is a `CallInfo`: uuid/peer/direction/
  state/timestamps/endReason — no `sdps` field), `MissedCallRecord`
  (peer/at/reason), `{call?, error}`; `CallEventMap` payloads are
  `CallState`, number, `CallInfo`, `{direction, type, uuid}` — no SDP
  carrier exists in the event types; (b) runtime assertion in the Tier-1
  `redaction` scenario: every consumer-visible payload (all `call.info`s,
  `ended` infos, `missed` records) is JSON-serialized and asserted free of
  `v=0`, `fingerprint`, and `sdps` keys. SDP strings live only in
  `CallContext.pendingOffer` / media sessions — the Call OWNER's surface —
  and in the logger-redacted zone.
- **Result:** PASS. Zero SDP in any emitted event payload.
- **Evidence:** `calls/src/types.ts` (`CallManagerEventMap`,
  `CallEventMap`, `CallInfo`); Tier-1 `redaction` scenario payload
  assertions (`e2e/reports-sample/`).

## 5. NetworkNode `insecureTls` default OFF

- **Method:** root-repo unit test constructs `new NetworkNode()` with no
  options and asserts `network.insecureTls === false` (TLS-verifying
  path), and `new NetworkNode({ insecureTls: true })` opts in explicitly.
  Run: `bun test test/network-node.test.ts`.
- **Result:** PASS — 12/12 tests green, incl. "insecureTls defaults to
  false and requests go through fetchImpl (TLS-verifying path)".
  Documented divergence from `@session.js/bun-network`'s insecure default.
- **Evidence:** `test/network-node.test.ts:251-255` (repo root); run
  2026-07-20: 12 pass / 0 fail.

## 6. Secrets not in artifacts

- **Method:** scan generated artifacts + committed docs for credential /
  key / SDP-body patterns:
  ```sh
  grep -rEn "session202111|053c268164bc7bd7|a=fingerprint|-----BEGIN" \
    calls/e2e/reports-sample calls/e2e calls/README.md
  ```
  plus per-report automated scan: `assertReportClean()` runs
  `FORBIDDEN_REPORT_MARKERS` (TURN creds, fingerprints, SDP `v=0`/`o=-`/
  `m=audio` lines, PEM) + generated-mnemonic scrubbing over every report
  BEFORE it is written (harness `writeRunReport`), and re-parses the JSON.
- **Result:** PASS. The committed sample `report.json` has ZERO matches.
  The only matches in `calls/e2e/**` are the redaction PATTERNS themselves
  (`harness.ts` `FORBIDDEN_REPORT_MARKERS`, `scenarios-tier1.ts` redaction
  scenario token list) — audit code, not secrets. In `calls/docs/evidence/`
  the credential strings appear ONLY as quoted audit tokens (P5-T3:
  "Zero occurrences of `session202111`…"; P2-T2: TURN-policy test prose) —
  deliberate references describing the checks, never leaked values. No
  mnemonic wordlist sequences appear anywhere in reports or evidence
  (mnemonics never leave the harness process except into the sanitizer's
  secret list).
- **Evidence:** scan commands above (run 2026-07-20);
  `e2e/reports-sample/2026-07-20T18-19-41-818Z-tier1/report.json`
  (sha256 `e45d60bdf90df60a3ac8fea811f799c2bd95536c357cccb663b0ffec9f9b3f27`).

## 7. AGPLv3 LICENSE + COPYING.provenance present/complete in calls/

- **Method:** verify both files exist, LICENSE is the full AGPLv3 text,
  COPYING.provenance carries per-file porting provenance with upstream
  copyright attribution and change statements (§0.2).
- **Result:** PASS. `calls/LICENSE` = 34,523 bytes (full AGPL-3.0 text);
  `calls/COPYING.provenance` = 96 lines covering every ported file
  (supervisor.ts, call-manager.ts, call.ts, media/peer-connection.ts,
  media/sdp.ts, fsm/state-machine.ts — "Ported from session-desktop /
  session-android … © Session Foundation, modified"), with fresh-written
  files marked as such.
- **Evidence:** `ls -l calls/LICENSE calls/COPYING.provenance`;
  `pack` includes both (`package.json` `files`: dist, README.md, LICENSE,
  COPYING.provenance — verified in the P8-T2 consumer smoke tarball
  listing).

## 8. Relay-only v1 limitation documented

- **Method:** the P5-T2 finding (relay negotiates — TURN allocation, ICE
  relay pairing, DTLS, data channels — but RTP audio does not flow over
  the relay leg in werift 0.23) must be documented for consumers.
- **Result:** PASS. README "Limitations & caveats" states relay-only is
  broken in v1 with a link to the evidence, and that the P2P-first
  default (`iceTransportPolicy: "all"`) is the working path.
- **Evidence:** [`P5-T2.md`](P5-T2.md); `calls/README.md` §"Limitations &
  caveats (v1)" → "Relay-only mode is broken in v1".

## 9. Privacy downgrade vs official clients documented (plan R5)

- **Method:** the no-onion-routing downgrade must be disclosed
  prominently: caller IP visible to snodes; callee IP visible in P2P;
  relay would hide IPs but is broken in v1.
- **Result:** PASS. README has a dedicated "Privacy disclosure vs
  official clients (plan R5)" section with exactly these points and the
  explicit "Do not market this library as anonymity-preserving" warning;
  the TURN ethics note (R7) accompanies it.
- **Evidence:** `calls/README.md` §"Privacy disclosure vs official
  clients (plan R5)" + §"TURN ethics (plan §3.4 / R7)".

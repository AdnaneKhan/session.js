# @session.js/calls

Headless 1:1 voice calls for [session.js](https://git.hloth.dev/session.js/client) —
Session-to-Session VoIP over WebRTC (werift) / Opus, speaking the official
Session call wire protocol (PRE_OFFER/OFFER/ANSWER/ICE_CANDIDATES/END_CALL
over the swarm). AGPL-3.0-or-later.

Calls are **Session-to-Session VoIP** — not PSTN phone calls. No microphone
or speaker is required: audio is exposed as raw PCM hooks for agent
STT/TTS pipelines.

---

## Quickstart

### 1. Install

The calls package needs the **patched** session.js client (this fork —
`@session.js/client@0.0.57-calls.1`), which adds `sendCallMessage()`, the
full `call` event (SDP/ICE fields), and `setPollInterval()`. The published
`@session.js/client@0.0.57` does **not** carry the call patch.

```sh
# from tarballs (see scripts/consumer-smoke.sh in the fork repo)
bun add ./session.js-calls-0.1.0.tgz ./session.js-client-0.0.57-calls.1.tgz

# or from the fork checkout
cd calls && bun install && bun run build
```

### 2. Register / load an account

```ts
import { Session, Poller, ready } from "@session.js/client";
import { encode } from "@session.js/mnemonic";
import { generateSeedHex } from "@session.js/keypair";

await ready;
const session = new Session();
session.setMnemonic(encode(generateSeedHex())); // fresh account — or an existing mnemonic
session.addPoller(new Poller({ interval: 500 }));
```

### 3. Place and answer calls with PCM hooks

```ts
import { CallManager } from "@session.js/calls";
// session = a PATCHED @session.js/client Session (sendCallMessage + full
// `call` event + setPollInterval — this fork provides it).
const calls = new CallManager(session, {
  logger: (level, msg) => console.log(`[calls:${level}] ${msg}`),
});

// Answer incoming calls:
calls.on("incoming", (call) => {
  call.onAudio((pcm) => mySink(pcm));       // 48 kHz mono s16, 20 ms frames
  void call.accept();                        // once the OFFER has arrived
});

// Place a call:
calls.approveContact(peerSessionId);         // contacts-only gate
const call = await calls.call(peerSessionId);
call.on("state", (s) => console.log(s));
call.writeAudio(pcmFrame);                   // false under backpressure
await call.hangup();
```

### 4. Runnable examples

```sh
bun install && bun test        # 170+ offline tests
bun run build                  # dist + examples typecheck
bun run example:echo           # full stack, no network (~6 s, PASS/FAIL)
bun run example:agent          # voice agent with pluggable STT/TTS
```

`example:echo` (`examples/offline-echo.ts`) runs two CallManagers over an
in-process signaling bus with the **real werift media plane** — A sends a
440 Hz sine, B's echo pipeline returns it, proving the full stack
round-trips real Opus audio with no Session network at all.
`example:agent` (`examples/voice-agent.ts`) needs a real (patched) Session
account; see [`examples/README.md`](examples/README.md) for plugging in
Whisper.cpp / any TTS.

### 5. End-to-end suites

```sh
bun e2e/run-tier1.ts            # Tier-1 offline lifecycle matrix (~20 s)
SESSION_CALLS_NETWORK_TESTS=1 bun e2e/run-tier1.ts   # + networked lifecycle
bun e2e/run-tier2.ts            # Tier-2 fault/stress (nightly)
```

Sanitized JSON reports land in `e2e/reports/<run-id>/` (a committed sample
lives in `e2e/reports-sample/`).

---

## API reference

Generated from the TSDoc surface in `src/` (`src/types.ts` is normative).

### `CallManager`

```ts
import type { Session } from "@session.js/client";

export interface CallManagerOptions {
  /** ICE servers; default = official Session TURN hosts (shuffle-take-2). */
  iceServers?: IceServer[];
  /** "all" (default, P2P-first) or "relay" (TURN-only; hides host IP — but see caveats). */
  iceTransportPolicy?: "all" | "relay";
  /** ms; default 60_000. */
  callTimeoutMs?: number;
  /** ms; default 200. */
  iceBatchIntervalMs?: number;
  /** Poller interval while a call is setting up/active; default 500. Restored after. */
  boostedPollIntervalMs?: number;
  /** Require local approval of the peer before placing a call; default true. */
  requireApprovedContact?: boolean;
  /** Auto-send MessageRequestResponse(approved) when placing a call; default true. */
  autoApproveOnCall?: boolean;
  logger?: (level: string, msg: string, meta?: unknown) => void;
}

export class CallManager extends EventEmitter {
  constructor(session: SessionLike, options?: CallManagerOptions);
  /** Place an outbound call. Rejects: InvalidCallMessageError (bad Session ID),
   *  CallInProgressError (v1: one concurrent call), PeerNotApprovedError
   *  (requireApprovedContact and not approved), media failures. */
  call(peerSessionId: string): Promise<Call>;
  /** The single active call, if any (v1: one concurrent call). */
  readonly activeCall: Call | undefined;
  /** Hang up any active call, unhook from the session, restore the poll
   *  cadence. Idempotent. */
  dispose(): Promise<void>;

  /** Approve a peer for inbound/outbound calls (contacts-only gate, §3.3).
   *  Documented additive extension over the plan's §4.3 surface — with the
   *  default requireApprovedContact:true this is how contacts are approved. */
  approveContact(peerSessionId: string): void;
  isContactApproved(peerSessionId: string): boolean;
}

// CallManager events:
//   "incoming"(call: Call)  — inbound call (fires on PRE_OFFER; accept once
//                              call.info.state === "remote-ring")
//   "outgoing"(call: Call)  — outbound call placed
//   "missed"({ peer, at, reason: "ignored" | "busy" | "stale" | "declined-wire" })
//   "error"({ call?, error })
```

### `Call`

```ts
export interface Call {
  readonly info: CallInfo;   // live view: uuid, peer, direction, state,
                             // startedAt, connectedAt?, endedAt?, endReason?
  accept(): Promise<void>;   // inbound only (once remote-ring)
  reject(): Promise<void>;   // sends END_CALL
  ignore(): void;            // local only — NO wire message; records missed
  hangup(): Promise<void>;   // datachannel hint + END_CALL (peer + self)
  /** Incoming decoded audio: 16-bit PCM, 48 kHz, mono, 20 ms frames (960 samples). */
  onAudio(cb: (pcm: Int16Array) => void): void;
  /** Queue outbound audio frames (same format). Returns false if the ~1 s
   *  bridge queue is full — retry the SAME frame after ~10 ms. */
  writeAudio(pcm: Int16Array): boolean;
  /** Remote peer signaled a video toggle (v1: informational only). */
  onRemoteVideoToggle(cb: (enabled: boolean) => void): void;
  on(event: "state" | "audio-level" | "ended" | "signaling", cb): void;
}

export type CallState =
  | "idle" | "local-pre-offer" | "local-ring" | "remote-pre-offer" | "remote-ring"
  | "connecting" | "connected" | "reconnecting" | "pending-reconnect"
  | "disconnected";

export type EndReason =
  | "local-hangup" | "remote-hangup" | "remote-declined" | "busy"
  | "timeout" | "ice-failed" | "error" | "ignored-locally"
  | "answered-elsewhere" | "ended-elsewhere";   // last two: multi-device races
```

### Audio contract

**48 kHz, mono, 16-bit signed LE PCM, 20 ms frames (960 samples /
1920 bytes)** — the Opus native frame size, in and out. `writeAudio` throws
`TypeError` on any other shape. There is no pacing inside the library:
frames are encoded immediately and held (≤ ~1 s queue) until the transport
is sender-ready — real-time pacing is the producer's job (pace with a
20 ms timer; see `examples/`). DSP helpers (`sineFrame()`, `goertzel()`,
`toneSnrDb()`, `bestCrossCorrelation()`) are exported for tests/pipelines.

### Error taxonomy

All failures are typed `CallError` subclasses with stable `.code`s:
`PeerNotApprovedError`, `CallInProgressError`, `SignalingTimeoutError`,
`IceFailureError`, `MediaFailureError`, `RuntimeUnsupportedError`,
`InvalidCallTransitionError`, `InvalidCallMessageError`. The manager never
crashes the host process on media/signaling/consumer errors — they surface
on the `"error"` event and end the affected call with `endReason: "error"`
(or `"ice-failed"`).

### `SessionLike` — structural contract for custom adapters

The package builds **without** `@session.js/client` installed: everything
it needs from a client instance is the structural interface below (see
`src/types.ts`). A patched `@session.js/client` `Session` satisfies it with
no casts (bivariant method typing); a hand-rolled adapter works too (the
`e2e/` harness and `examples/offline-echo.ts` run the full stack over an
in-process bus implementing exactly this surface).

```ts
export interface SessionLike {
  getSessionID(): string;
  /** Clock compensated for swarm/server offset — used for freshness checks. */
  getNowWithNetworkOffset(): number;
  on(event: "call", cb: (msg: CallMessageEvent) => void): void;
  off(event: "call", cb: (msg: CallMessageEvent) => void): void;
  sendCallMessage(
    to: string,
    msg: {
      type: CallMessageTypeValue;   // 1 OFFER, 2 ANSWER, 3 PROVISIONAL_ANSWER,
      uuid: string;                 // 4 ICE_CANDIDATES, 5 END_CALL, 6 PRE_OFFER
      sdps?: string[];
      sdpMLineIndexes?: number[];
      sdpMids?: string[];
    },
    options?: { isSyncMessage?: boolean },
  ): Promise<{ messageHash: string; timestamp: number }>;
  /** Boost/restore the poller cadence during calls (500 ms → restored to 3000 ms). */
  setPollInterval(interval: number): void;
  acceptConversationRequest(opts: { from: string }): Promise<unknown>;
}
```

Advanced consumers can also wire their own media plane (`MediaEngine` /
`MediaSession` in `src/types.ts`, via the non-normative third constructor
arg `CallManagerDeps`); `PeerConnectionManager` and `AudioBridge` are
exported for custom pipelines.

---

## Architecture

```
┌──────────────────────────── consumer (agent) ────────────────────────────┐
│  const calls = new CallManager(session, opts)                            │
│  calls.on("incoming" | "outgoing" | "missed" | "error")                  │
│  const call = await calls.call("05…")          call.accept() / reject()  │
│  call.onAudio(pcm => stt(pcm))                 call.writeAudio(ttsPcm)   │
└───────────────┬──────────────────────────────────────┬───────────────────┘
                │                                      │ PCM source/sink
┌───────────────▼───────────────┐      ┌───────────────▼──────────────────┐
│  @session.js/calls            │      │  AudioBridge                      │
│  ┌─────────────────────────┐  │      │  - Opus enc/dec (@discordjs/opus) │
│  │ CallSupervisor          │  │      │  - 48 kHz/16-bit/mono PCM ↔ RTP   │
│  │ - per-uuid CallContext  │  │      │  - ~1 s queue, sender-ready gate  │
│  │ - FSM (StateMachine)    │  │      │  - no device I/O                  │
│  │ - timers (60 s/200 ms/…)│  │      └───────────────┬──────────────────┘
│  │ - inbound gates         │  │                      │
│  └──────┬──────────┬───────┘  │      ┌───────────────▼──────────────────┐
│  ┌──────▼───────┐ ┌▼────────┐ │      │  PeerConnectionManager            │
│  │ Session-     │ │Trickle- │ │      │  ┌──────────────────────────────┐ │
│  │ Signaling    │ │IceSender│ │      │  │ werift RTCPeerConnection     │ │
│  │ - inbound    │ │- 200 ms │ │      │  │ - ICE (TURN cfg) / DTLS-SRTP │ │
│  │   dispatch   │ │  batch  │ │      │  │ - data channel "signaling"   │ │
│  │ - outbound   │ │- relay  │ │      │  │   (negotiated, id 548)       │ │
│  │   send       │ │  filter │ │      │  │ - Android-parity SDP munging │ │
│  │ - self-sync  │ │         │ │      │  └──────────────────────────────┘ │
│  └──────┬───────┘ └─────────┘ │      └──────────────────────────────────┘
└─────────┼─────────────────────┘
          │ session.on("call") + session.sendCallMessage() (fork patch)
┌─────────▼───────────────────────────────────────────────────────────────┐
│  patched @session.js/client (@session.js/client@0.0.57-calls.1)          │
│  - mapCallMessage carries sdps/sdpMLineIndexes/sdpMids                   │
│  - CallMessage schema class (ttl 5 min) + Session.sendCallMessage()      │
│  - NetworkNode (fetch-based Network impl for Node)                       │
│  - Poller interval control (boost to 500 ms during calls)                │
└──────────────────────────────────────────────────────────────────────────┘
```

- **CallSupervisor** executes the ported Android `StateMachine` FSM
  (10 states), the inbound gates (self-message handling → freshness →
  contacts-only approval → busy arbitration → type dispatch), the 60 s
  ring/setup timeout, and multi-device self-sync semantics (self-sent
  ANSWER/END_CALL silence linked devices; other self-sends dropped).
- **TrickleIceSender** debounces local candidates (200 ms) into
  parallel-array ICE_CANDIDATES messages, gated on the local description
  existing; relay mode filters non-relay candidates for wire cleanliness.
- **Signaling** rides the swarm via the fork's `sendCallMessage`
  (`ttl = 300000`); ANSWER and END_CALL are also stored to the own swarm
  (`isSyncMessage`) for linked-device races.
- **Media** is stock WebRTC: DTLS-SRTP, Opus, `bundlePolicy=max-bundle`,
  rtcp-mux, Unified Plan with Android-parity local-SDP munging
  (`;cbr=1`, `ssrc-audio-level` stripped; remote SDPs never munged).

---

## Limitations & caveats (v1)

- **Audio only.** Video toggles are received and surfaced
  (`onRemoteVideoToggle`) but never acted on. No group calls (Session has
  none), no PSTN/SIP bridging.
- **One concurrent call per CallManager.** A second `call()` rejects with
  `CallInProgressError`; a second inbound while active resolves with busy
  semantics (missed record + END_CALL to the intruder).
- **Contacts-only gating.** Inbound calls from unapproved senders are
  dropped silently (official-client behavior — no missed record); outbound
  calls require `approveContact()` first (default
  `requireApprovedContact: true`), with auto-approval of the callee sent
  at call time (`autoApproveOnCall`).
- **Callee beta opt-in.** Official clients ship calls disabled by default.
  There is no wire capability query — a call to a non-opted-in user simply
  rings out to a **silent 60 s timeout** (`endReason: "timeout"`).
- **Relay-only mode is broken in v1.** `iceTransportPolicy: "relay"`
  negotiates (TURN allocation, ICE relay pairing, DTLS, data channels all
  verified live) but **RTP audio does not flow** over the relay leg in our
  werift 0.23 environment (see `docs/evidence/P5-T2.md`). The default
  P2P-first policy (`"all"`) works — relay-only is offered for protocol
  completeness and hidden-IP intent, documented as degraded until the
  media-layer follow-ups land.
- **Polling-latency signaling.** session.js has no push channel; the fork
  boosts the poller to **500 ms during calls** and restores the
  **3000 ms default** afterwards. Expect ~0.5–3 s per signaling leg
  (measured: 521 ms connect boosted vs 6.5 s at 3 s cadence — e2e Tier-2).
- **Runtimes:** Node ≥ 22 is primary; Bun is a validated secondary runtime
  (spike, offline suite, and examples pass on both — see
  `docs/evidence/P3-T1.md`). Networked operation needs
  `@session.js/bun-network` (Bun) or the fork's `NetworkNode` (Node;
  `insecureTls` default OFF).
- **No onion routing** — see the privacy disclosure below.

### TURN ethics (plan §3.4 / R7)

The five default TURN hosts
(`turn:{freyr,angus,hereford,holstein,brahman}.getsession.org`) are run by
a nonprofit for their users' official clients, with static shared
credentials shipped in every client. **Heavy automated use should
self-host a [coturn](https://github.com/coturn/coturn) with the same
static credentials** (trivially compatible — pass it via `iceServers`) or
use relay sparingly. Our offline E2E suite sends **zero** TURN traffic
(`iceServers: []`), and network test volumes are recorded in
`docs/evidence/`.

### Privacy disclosure vs official clients (plan R5)

session.js has **no onion-request routing**, and this library inherits
that:

- the **caller's IP is visible to the service nodes** it talks to (direct
  HTTPS JSON-RPC; `NetworkNode` verifies TLS by default);
- in P2P mode (the working default) the **callee's IP is visible to the
  caller** via WebRTC host candidates — and vice versa.

The `iceTransportPolicy: "relay"` option would hide both hosts' IPs behind
the TURN relay — but relay audio is broken in v1 (above). **Do not market
this library as anonymity-preserving.** Signaling rides Session's
end-to-end encryption; media is DTLS-SRTP (werift has no plaintext-RTP
mode).

---

## Status

- **Signaling:** full Session call protocol incl. self-sync (multi-device
  race semantics verified), freshness/TTL gates, contacts-only gating,
  busy/missed handling, byte-identical wire encodings vs golden fixtures.
- **Media:** werift WebRTC, Opus, Android-parity SDP munging, official
  TURN servers (shuffle-take-2), ICE restart/reconnect (initiator
  5 s × 5; non-initiator 60 s wait), loopback + live-swarm E2E validated
  (150/150 audio frames both directions; connect ≤ 15 s).
- **E2E:** Tier-1 offline matrix (~20 s, 10 scenarios) + Tier-2
  fault/stress (signaling loss, poll latency, 21× rapid cycling,
  simultaneous inbound+outbound race) + networked lifecycle (gated).

---

## License

**AGPL-3.0-or-later** — see [`LICENSE`](LICENSE) and
[`COPYING.provenance`](COPYING.provenance) (per-file porting provenance:
ports of session-desktop (AGPLv3) and session-android (GPLv3) call code,
© Session Foundation, modified; upstream headers preserved, changes
documented).

**Provenance, plainly:** this package is **not a clean-room
reimplementation**. It contains code **directly ported** from the Session
Foundation's session-android (GPLv3) and session-desktop (AGPLv3) clients —
upstream copyright headers are preserved, modifications are annotated, and
every ported file is listed in [`COPYING.provenance`](COPYING.provenance).

**AGPL §13 network-use obligation, plainly:** if you run this library as
part of a network service (including an agent fleet others interact with
over Session), you must make the **complete corresponding source** of this
package and your modifications available to the users of that service,
under the same terms. Keep your forks public, tag releases, and state your
source location in the service.

The patched client fork keeps MIT for its original code; the small
call-signaling patches to the client core (`mapCallMessage` mapper fix,
`CallMessage` schema, `sendCallMessage`, `setPollInterval`, `NetworkNode`)
were written fresh from the published proto facts and remain MIT-licensable
for upstream contribution.

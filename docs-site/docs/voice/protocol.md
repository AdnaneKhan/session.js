# Protocol & caveats

How voice calls actually work under the hood — the wire protocol, the state
machine, media negotiation, and the things that will bite you.

## Wire protocol

Signaling rides the Session swarm as end-to-end-encrypted `CallMessage`
envelopes with a **5-minute TTL** (`ttl = 300000`), sent via the fork's
`session.sendCallMessage()`:

| Type | Value | Purpose |
|---|---|---|
| `PRE_OFFER` | 6 | Ring the callee (fires `"incoming"`) |
| `OFFER` | 1 | SDP offer |
| `ANSWER` | 2 | SDP answer |
| `PROVISIONAL_ANSWER` | 3 | (protocol-complete; unused by v1 flow) |
| `ICE_CANDIDATES` | 4 | Batched trickle candidates (parallel arrays `sdps` / `sdpMLineIndexes` / `sdpMids`) |
| `END_CALL` | 5 | Hangup / decline / busy / cancel |

The wire encodings are byte-identical to the official clients (verified
against golden fixtures in the fork repo).

### Self-sync (multi-device)

`ANSWER` and `END_CALL` are also stored to your **own** swarm
(`isSyncMessage: true`):

- Your other devices see your ANSWER and stop ringing
  (`endReason: "answered-elsewhere"`).
- Your other devices see your END_CALL and tear down
  (`"ended-elsewhere"`).
- Other self-sent signaling is dropped silently.

### Freshness & gating

Inbound messages pass, in order: self-message handling → freshness window
(TTL plus clock-offset tolerance via `getNowWithNetworkOffset()`) →
contacts-only approval → busy arbitration → type dispatch to the FSM.

### Polling latency

session.js has **no push channel**. During calls the fork boosts your
poller to `boostedPollIntervalMs` (default **500 ms**) and restores your
normal cadence afterwards. Expect **~0.5–3 s per signaling leg** (measured:
521 ms connect boosted vs 6.5 s at a 3 s cadence). A callee polling every
3 s hears your PRE_OFFER up to 3 s late.

## State machine

Ten states, ported from session-android's `StateMachine.kt` (plus two
documented supplementary rows for caller-side ambiguity):

```
idle ──send-pre-offer──▶ local-pre-offer ──send-offer──▶ local-ring
idle ──receive-pre-offer──▶ remote-pre-offer ──receive-offer──▶ remote-ring
local-ring ──receive-answer──▶ connecting ──ice-connected──▶ connected
remote-ring ──user-accept──▶ connecting
connected ──ice-disconnected──▶ pending-reconnect
pending-reconnect ──restart-attempt (initiator)──▶ reconnecting
pending-reconnect ──network-reconnect (non-initiator)──▶ reconnecting
reconnecting ──receive-offer-restart / ice-connected──▶ connecting
any non-idle ──receive-end-call / user-hangup──▶ disconnected ──cleanup──▶ idle
```

ICE reconnect: the **initiator** retries ICE restart every 5 s × 5 attempts;
the **non-initiator** waits up to 60 s for a fresh OFFER.

## Media

Stock WebRTC via werift:

- **DTLS-SRTP**, Opus, `bundlePolicy=max-bundle`, rtcp-mux, Unified Plan.
- **Android-parity SDP munging** on *local* SDPs only (`;cbr=1` added,
  `ssrc-audio-level` stripped) — remote SDPs are never munged. This is what
  keeps the official clients talking to us.
- Negotiated **"signaling" data channel (id 548)** — its open state is the
  full-stack readiness gate (ICE + DTLS + SCTP). RTP written before it is
  open would be silently dropped by werift, so the audio send gate waits for
  it.

## TURN servers and ethics

The five default TURN hosts —
`turn:{freyr,angus,hereford,holstein,brahman}.getsession.org` — are run by a
nonprofit for their users' official clients, with static shared credentials
shipped in every client.

!!! Warning "Heavy automated use"
    If you run fleets or high call volume, **self-host a
    [coturn](https://github.com/coturn/coturn) with the same static
    credentials** (trivially compatible — pass it via `iceServers`) or use
    relay sparingly. The fork's offline E2E suite sends **zero** TURN
    traffic (`iceServers: []`).

## Privacy disclosure

!!! Warning "No onion routing"
    session.js has no onion-request routing, and this library inherits that:

    - Your **IP is visible to the service nodes** you talk to (direct HTTPS
      JSON-RPC; `NetworkNode` verifies TLS by default).
    - In P2P mode (the working default) **peers see each other's IPs** via
      WebRTC host candidates.

    `iceTransportPolicy: "relay"` would hide both peers' IPs behind TURN —
    but relay audio is broken in v1 (below). **Do not market this library as
    anonymity-preserving.** Signaling is end-to-end encrypted (Session);
    media is DTLS-SRTP (werift has no plaintext-RTP mode).

## Limitations (v1)

- **Audio only.** Video toggles are received and surfaced
  (`onRemoteVideoToggle`) but never acted on. No group calls, no PSTN/SIP.
- **One concurrent call per CallManager.** A second `call()` rejects with
  `CallInProgressError`; a second inbound while active gets busy semantics.
- **Contacts-only gating** — inbound from unapproved senders dropped
  silently; outbound requires `approveContact()` first (defaults on).
- **Callee beta opt-in** — calls to non-opted-in users ring out to a silent
  60 s timeout.
- **Relay-only mode is broken.** `iceTransportPolicy: "relay"` negotiates
  fully (TURN allocation, relay pairing, DTLS, data channels — all verified
  live) but **RTP audio does not flow** over the relay leg in the werift 0.23
  environment. The default P2P-first policy (`"all"`) works; relay-only is
  offered for protocol completeness and documented as degraded.
- **Polling-latency signaling** — ~0.5–3 s per signaling leg (see above).
- **Runtimes:** Node ≥ 22 primary; Bun validated secondary. Networked
  operation needs `@session.js/bun-network` (Bun) or `NetworkNode` (Node).

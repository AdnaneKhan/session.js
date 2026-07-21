# Voice calls

**Headless 1:1 voice calls for Session** — Session-to-Session VoIP over
WebRTC ([werift](https://github.com/shinyoshiaki/werift-webrtc)) / Opus,
speaking the official Session call wire protocol. Provided by the
[`@session.js/calls`](https://github.com/AdnaneKhan/session.js/tree/main/calls)
package on top of this fork's patched `@session.js/client`.

!!! Warning "What this is — and isn't"
    - Calls are **Session-to-Session VoIP** — not PSTN phone calls. No phone
      numbers, no SIP.
    - The library is **headless**: there is no microphone or speaker. Audio is
      exposed as **raw PCM hooks** (`onAudio` / `writeAudio`) — designed for
      agent STT/TTS pipelines, bots, and custom clients that bring their own
      devices.
    - Audio only. Video toggles are surfaced but not acted on; there are no
      group calls (Session has none).

## How it fits together

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
│  ┌─────────────────────────┐  │      │  - Opus enc/dec                   │
│  │ CallSupervisor          │  │      │  - 48 kHz/16-bit/mono PCM ↔ RTP   │
│  │ - per-uuid CallContext  │  │      │  - ~1 s queue, sender-ready gate  │
│  │ - FSM (10 states)       │  │      │  - no device I/O                  │
│  │ - timers (60 s/200 ms)  │  │      └───────────────┬──────────────────┘
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
│  - NetworkNode (fetch-based Network impl for Node ≥ 22)                  │
│  - Poller interval control (boost to 500 ms during calls)                │
└──────────────────────────────────────────────────────────────────────────┘
```

- **CallSupervisor** executes the call state machine (10 states, ported from
  session-android), the inbound gates (self-message handling → freshness →
  contacts-only approval → busy arbitration → type dispatch), the 60 s
  ring/setup timeout, and multi-device self-sync semantics (your own
  ANSWER/END_CALL silence your linked devices; other self-sends are dropped).
- **TrickleIceSender** debounces local ICE candidates (200 ms batches) into
  parallel-array `ICE_CANDIDATES` messages.
- **Signaling** rides the swarm via the fork's `sendCallMessage`
  (TTL = 5 min); `ANSWER` and `END_CALL` are also stored to your own swarm
  (`isSyncMessage`) for linked-device races.
- **Media** is stock WebRTC: DTLS-SRTP, Opus, `bundlePolicy=max-bundle`,
  rtcp-mux, Unified Plan with Android-parity local-SDP munging.

## Where to go next

| I want to… | Page |
|---|---|
| Install and make my first call | [Setup & install](./setup.md) → [Making calls](./making-calls.md) |
| Answer calls / build an auto-answer agent | [Receiving calls](./receiving-calls.md) |
| Pipe audio through STT/TTS (Whisper, Piper…) | [Audio pipelines](./audio-pipeline.md) |
| See every type, option, event and error | [API reference](./api-reference.md) |
| Understand the wire protocol, TURN, privacy | [Protocol & caveats](./protocol.md) |
| Run the ready-made examples | [Examples](./examples.md) |

## Status (v1)

- **Signaling:** full Session call protocol incl. self-sync (multi-device
  race semantics verified), freshness/TTL gates, contacts-only gating,
  busy/missed handling, byte-identical wire encodings vs golden fixtures.
- **Media:** werift WebRTC, Opus, Android-parity SDP munging, official TURN
  servers, ICE restart/reconnect (initiator 5 s × 5; non-initiator 60 s
  wait), loopback + live-swarm E2E validated.
- **E2E:** Tier-1 offline matrix (~20 s, 10 scenarios) + Tier-2 fault/stress
  + networked lifecycle (nightly).

## License

`@session.js/calls` is **AGPL-3.0-or-later** and contains code directly
ported from the Session Foundation's session-android (GPLv3) and
session-desktop (AGPLv3) clients, with attribution and preserved copyright
headers (per-file provenance:
[`calls/COPYING.provenance`](https://github.com/AdnaneKhan/session.js/blob/main/calls/COPYING.provenance)).
The patched client core outside `calls/` remains MIT. If you run this
library as part of a network service, **AGPL §13** requires you to make the
complete corresponding source available to users of that service.

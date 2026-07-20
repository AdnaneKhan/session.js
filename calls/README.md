# @session.js/calls

Headless 1:1 voice calls for [session.js](https://github.com/session-eth/session.js) —
Session-to-Session VoIP over WebRTC (werift) / Opus, speaking the official
Session call wire protocol (PRE_OFFER/OFFER/ANSWER/ICE_CANDIDATES/END_CALL
over the swarm). AGPL-3.0-or-later.

Full documentation lands in a later wave (plan P8-T1); this is a quickstart stub.

## Quickstart

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

Runnable examples (offline full-stack echo demo + a voice-agent with
pluggable STT/TTS): see [`examples/`](examples/README.md).

```sh
bun install && bun test        # 170+ offline tests
bun run build                  # dist + examples typecheck
bun examples/offline-echo.ts   # full stack, no network
```

## Status

- Signaling: full Session call protocol incl. self-sync (multi-device),
  freshness/TTL gates, contacts-only gating, busy/missed handling.
- Media: werift WebRTC, Opus, Android-parity SDP munging, official TURN
  servers (shuffle-take-2), relay-only mode, ICE restart/reconnect.
- v1 limits: audio only (video toggles surfaced informationally), one
  concurrent call per manager, polling-latency signaling (~0.5–3 s),
  callee must have calls enabled in an official client (opt-in beta).

## License

AGPL-3.0-or-later — see `LICENSE` and `COPYING.provenance` (per-file porting
provenance; ports of session-desktop (AGPLv3) and session-android (GPLv3)
code, © Session Foundation, modified).

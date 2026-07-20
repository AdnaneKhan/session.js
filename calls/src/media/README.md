# calls/src/media — voice-call media plane (werift)

Implements the `MediaEngine` / `MediaSession` interfaces pinned in
`../types.ts` (binding shape — do not change without a decision gate) on top
of werift 0.23.0.

| File | Role |
|---|---|
| `peer-connection.ts` | `PeerConnectionManager` / `WeriftMediaSession` — PC lifecycle, offer/answer with local-only SDP munging, ICE candidate plumbing, 4-state connection mapping, negotiated `signaling` data channel (id 548), idempotent teardown. |
| `sdp.ts` | Android-parity local-SDP transforms: opus `;cbr=1`, strip `ssrc-audio-level` extmap. Never applied to remote SDPs. |
| `audio-bridge.ts` | PCM↔werift-track bridge: 960-sample 48 kHz mono Int16 frames, RTP seq/timestamp management, decode rechunking, bounded send queue backpressure. |
| `codec.ts` | `Codec` abstraction (plan D3): primary = werift Opus RTP pipeline + PCM conversion via optional `@discordjs/opus` (self-healing N-API loader). |
| `dsp.ts` | Dependency-free DSP helpers (sine frames, Goertzel, tone-SNR, xcorr) for tests/spikes. |

Validated by `calls/test/media/*.test.ts` and the spike evidence in
`calls/docs/evidence/{P3-T1,P3-T2,P4-T1,P4-T2}.md`.

Provenance: ports of session-android `PeerConnectionWrapper.kt` (GPLv3) and
session-desktop `CallManager.ts` (AGPLv3), © Session Foundation, modified
(config choices + SDP munging only; werift glue written fresh); shipped
under AGPL-3.0-or-later.

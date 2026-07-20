# calls/src/media — reserved

This directory is reserved for the media-plane implementation (Phase 4 tasks
P4-T1/P4-T2: `peer-connection.ts`, `audio-bridge.ts`, `codec.ts`, `sdp.ts`),
owned by the media agent. It will implement the `MediaEngine` / `MediaSession`
interfaces pinned in `../types.ts` (binding shape — do not change without a
decision gate) using werift.

Provenance for that future code: ports of session-android
`PeerConnectionWrapper.kt` (GPLv3) and session-desktop `CallManager.ts`
(AGPLv3), © Session Foundation, modified; shipped under AGPL-3.0-or-later.

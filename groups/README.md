# @session.js/groups

**Status: P0 — scaffolding only, no implementation yet.**

Legacy closed groups (05-prefixed) for the
[patched session.js client](../README.md) — programmatic group lifecycle
(create, join, send, receive, member add/remove/leave, rename, keypair
rotation) speaking the official Session closed-group wire protocol.

Companion to [`@session.js/calls`](../calls/README.md); same structural
decoupling pattern (`GroupSessionLike`), same evidence discipline, same
license posture.

- **Plan:** [`docs/closed-groups/IMPLEMENTATION.md`](../docs/closed-groups/IMPLEMENTATION.md)
  (protocol fact sheet, architecture, phase plan P0–P9)
- **Reference pins:** [`docs/closed-groups/reference-pins.md`](../docs/closed-groups/reference-pins.md)
- **Wire facts:** `docs/protocol-notes.md` Part II

## License

**AGPL-3.0-or-later** — will contain code directly ported from the Session
Foundation's session-desktop (AGPLv3) and session-android (GPLv3) clients,
with attribution and preserved copyright headers (per-file provenance:
[`COPYING.provenance`](COPYING.provenance), filled in as porting lands).
Client-core patches this package relies on (GroupPoller, send methods,
crypto exports) are fresh-written MIT.

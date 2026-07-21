# Closed groups — reference implementation pins

Protocol facts and port sources for the closed-groups work are verified
against these exact commits (fetched 2026-07-20/21, UTC):

| Repo | License | Ref | Commit |
|---|---|---|---|
| [oxen-io/session-desktop](https://github.com/oxen-io/session-desktop) | AGPL-3.0 | `master` (legacy groups era — v1.14.x) | `d86076b443bba73510c0f6b6124f5dbc59deb05c` |
| [oxen-io/session-android](https://github.com/oxen-io/session-android) | GPL-3.0 | tag `v1.19.1` | `e5ee2e1e1a72fd0b7229ff7385c52c3abb7b6d04` |
| [oxen-io/libsession-util](https://github.com/oxen-io/libsession-util) | (proto/util) | `dev` | `cc5033b49a6f538b37b025becf4282cbba7f6924` |

Notes:

- session-desktop `master` is the correct source for **legacy** closed
  groups. The default branch (`unstable`) is the groupv3 rewrite where
  legacy closed groups are being removed — code search finds zero
  legacy-group hits there.
- session-android `dev` has moved toward groupv2/v3 as well; `v1.19.1` is
  the last clean legacy-groups reference used here.
- libsession-util `dev` is used for the canonical proto
  (`proto/SessionProtos.proto`) and config namespace constants
  (`include/session/config/namespaces.hpp`).
- Our installed `@session.js/types@1.0.14` signal-bindings already contain
  the full `ClosedGroupControlMessage` / `KeyPair` / `KeyPairWrapper`
  schema and the `DataMessage.closedGroupControlMessage = 104` field —
  verified against the pinned proto (see `IMPLEMENTATION.md` §2.1).

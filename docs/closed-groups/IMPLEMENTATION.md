# Closed Groups — Implementation Plan (`@session.js/groups`)

> **Living document — update as implementation discovers discrepancies.**
> Anything observed to differ from what is written here must be corrected
> here *and* recorded in `docs/evidence/` (G-series task IDs) with the
> observation that forced the change. Same convention as the voice-call
> work (`P`-series).

Legacy closed groups (05-prefixed) for the patched session.js client:
programmatic group lifecycle — create, join, send, receive, member
add/remove/leave, name changes, keypair rotation — speaking the official
Session closed-group wire protocol, verified against the official clients.

Status: **P0 (scaffolding)**. Branch: `feat/closed-groups`.

---

## 1. Goals / non-goals

**v1 goals**
- Full legacy closed-group protocol: NEW / NAME_CHANGE / MEMBERS_ADDED /
  MEMBERS_REMOVED / MEMBER_LEFT / ENCRYPTION_KEY_PAIR (send + receive).
- Group chat messages (visible messages with `GroupContext`, sealed to the
  group encryption key, namespace −10).
- Multi-device *consumption* of group state via the legacy
  `ConfigurationMessage.activeClosedGroups`.
- Wire-identical encodings (golden fixtures), offline E2E matrix, gated
  networked E2E, Tier-3 interop vs official clients.

**Non-goals (v1)**
- Group v2/v3 (`03…` pubkeys, libsession GroupMessages/Keys/Info/Members
  namespaces 11–14) — separate protocol, still in rewrite upstream
  (session-desktop `unstable`); documented as future work.
- libsession `UserGroups` config wrapper sync (namespace 5,
  protobuf-in-`SharedConfigMessage`) — decision gate in P7.
- Admin transfer, group invites (`invited`/`invite_pending` states), group
  avatars, `ENCRYPTION_KEY_PAIR_REQUEST` (unused by desktop; ignored).
- Onion routing (inherits client limitation — disclosed in docs).

## 2. Verified protocol facts

Primary sources (pinned in `reference-pins.md`): session-desktop `master`
@ `d86076b` (legacy groups — the `unstable` branch is the v3 rewrite where
they're being removed), session-android `v1.19.1` @ `e5ee2e1`,
libsession-util `dev` @ `cc5033b`. **The wire schema is already compiled
into our installed `@session.js/types` bindings — no pbjs work needed.**

### 2.1 Wire schema

```proto
// Carried in DataMessage.closedGroupControlMessage = field 104.
message ClosedGroupControlMessage {
  enum Type {
    NEW                         = 1;  // publicKey, name, encryptionKeyPair, members, admins [, expirationTimer]
    // 2 = old UPDATE (removed; numbering gap is real — do not reuse)
    ENCRYPTION_KEY_PAIR         = 3;  // [publicKey], wrappers[]
    NAME_CHANGE                 = 4;  // name
    MEMBERS_ADDED               = 5;  // members[]
    MEMBERS_REMOVED             = 6;  // members[]
    MEMBER_LEFT                 = 7;
    ENCRYPTION_KEY_PAIR_REQUEST = 8;  // unused by desktop (cache-drop only); we ignore
  }
  required Type           type              = 1;
  optional bytes          publicKey         = 2;   // explicit group pubkey (1:1 keypair replies)
  optional string         name              = 3;
  optional KeyPair        encryptionKeyPair = 4;   // PLAINTEXT group keypair inside the sealed box (NEW)
  repeated bytes          members           = 5;
  repeated bytes          admins            = 6;
  repeated KeyPairWrapper wrappers          = 7;   // per-member wrapped keypairs (rotation)
  optional uint32         expirationTimer   = 8;   // seconds; deleteAfterSend only
}
message KeyPair        { required bytes publicKey = 1; required bytes privateKey = 2; }
message KeyPairWrapper { required bytes publicKey = 1;   // member this wrapper is for (prefixed 33 B)
                         required bytes encryptedKeyPair = 2; }  // sealed KeyPair proto, NO message padding
```

Group chat messages carry, inside `DataMessage`:

```proto
message GroupContext {
  enum Type { UNKNOWN = 0; UPDATE = 1; DELIVER = 2; QUIT = 3; REQUEST_INFO = 4; }
  optional bytes id   = 1;   // UTF-8 bytes of the ASCII "05…" hex string (not raw key bytes!)
  optional Type  type = 2;   // DELIVER for chat messages
}
```

Addresses & keys:
- **Group address**: random ed25519 keypair → convert public key ed→x25519
  → prepend `0x05` → 33 bytes → hex (66 chars). The ed25519 secret is
  **discarded** — the group cannot sign; there is no cryptographic
  membership proof (v1 protocol weakness; v3 direction).
- **Group encryption keypair**: fresh x25519 pair, stored **unprefixed**
  (32-byte hex). Wrapper `publicKey` fields and all account/group pubkeys
  on the wire are **prefixed** (33 bytes).
- **Envelope**: group-swarm traffic is `Envelope.type = CLOSED_GROUP_MESSAGE
  (7)` with `source = groupPubKey`; sender identity is recovered from the
  ed25519 key embedded in the sealed box (converted to x25519, `05`-prefixed
  → `senderIdentity`), never from the envelope.

### 2.2 Formation (NEW)

- Creator generates group address + first encryption keypair;
  `admins = [creator]`, members include creator.
- **One NEW per member (including self), sent 1:1 to each member's own
  swarm** (namespace 0 `UserMessages`, envelope `SESSION_MESSAGE`), each
  sealed to that member's x25519 identity key. The group keypair travels
  **plaintext inside the sealed protobuf** — confidentiality is the outer
  seal.
- Receiver gates (desktop+android): sender approved (or self); we are in
  `members`; all of name/publicKey/members/admins/encryptionKeyPair present;
  pubkey parses and is not `03…` (v3); dedupe — if the convo already exists
  and we haven't left, just append the keypair (dedupe by value);
  `lastJoinedTimestamp = envelope.timestamp` watermark (older updates are
  dropped later). Then: store group, store keypair, start group polling,
  retry any cached undecryptable messages from that group.

### 2.3 Group messaging & polling

- Chat + control messages to the group: sealed box (Session-protocol ECIES:
  `seal(plaintext ‖ senderEdPub ‖ sig(plaintext ‖ senderEdPub ‖
  recipientX25519))`) to the **latest group encryption pubkey**, envelope
  `CLOSED_GROUP_MESSAGE`, stored to **the group pubkey's swarm, namespace
  −10 (`ClosedGroupMessage`), unauthenticated retrieve** (no signature; our
  `NetworkNode` already implements this path incl. the `05`-prefix rule).
- Exceptions sent 1:1 (member swarms, ns 0): NEW invites and
  ENCRYPTION_KEY_PAIR *replies* to specific members.
- **TTL**: 14 days (`TTL_DEFAULT.CONTENT_MESSAGE`); control messages never
  expire (`expirationType: null`).
- **Polling** (desktop model — adopt): each group pubkey is an independent
  polling target over **namespace −10 only**; cadence scales with last
  activity (<2 d → 5 s; <7 d → 60 s; else 120 s; ≥95 messages in a response
  → immediate re-poll); per-(pubkey, namespace) lastHash dedupe. Android
  additionally gates group updates on `sentTimestamp ≥ formationTimestamp`.
- **Decryption**: try stored keypairs **newest-first**; keep **all**
  historical pairs (needed for in-flight/older messages and by newly-linked
  devices); on failure **cache the envelope** (do not drop) and retry when
  any new keypair for that group arrives.

### 2.4 Membership lifecycle

| Action | Who may | Wire | Receiver behavior |
|---|---|---|---|
| Add members | **any member** | `MEMBERS_ADDED` → group swarm (−10) + NEW DM (ns 0) to each newcomer with latest keypair | verify sender ∈ members, timestamp > lastJoinedTimestamp, update members; **admins additionally push** an `ENCRYPTION_KEY_PAIR` reply DM (explicit `publicKey`) to newcomers (removal/re-add race fix) |
| Remove members | **admins only** (enforced on receive) | `MEMBERS_REMOVED` → group swarm | removed member: **delete group** (stop polling, wipe keys); others: update members; the **removing admin rotates** (§2.5). Non-admin senders' removals are dropped. The first admin cannot be removed ("admins can only leave") |
| Leave | any member | `MEMBER_LEFT` → group swarm | leaver is an **admin → group disbands for everyone** (`deleteClosedGroup`); own MEMBER_LEFT → another of our devices left → delete locally; otherwise remove from members, add to **zombies** (left-but-not-removed; pruned on re-add; admin expected to convert leaves to removals, which rotates) |
| Rename | any member | `NAME_CHANGE` → group swarm | update name |

**Revocation is weak by design** — a removed member keeps all historical
private keys (can decrypt swarm content until 14-day expiry and anything
sent before rotation lands; can even keep depositing ciphertext). Official
clients accept this; document it in user-facing docs. There is no group
signature scheme (v3 direction, commented-out `GroupAdminMessage` proto).

### 2.5 Keypair rotation (ENCRYPTION_KEY_PAIR)

- Triggered **only by an admin removing members**, sent after
  `MEMBERS_REMOVED` lands: fresh x25519 pair → per **remaining** member a
  wrapper `{ publicKey: member's prefixed key, encryptedKeyPair:
  seal(KeyPair-proto-bytes → member's identity key) }` — **no message
  padding** on wrapper plaintext (decrypt side must not unpad). Message goes
  to the group swarm (−10), timestamp = snode network time.
- In-flight copy held in memory until the send confirms (admins use it for
  concurrent newcomer pushes).
- **Receive**: group exists & active; sender ∈ admins (or explicit 1:1
  reply); find wrapper for our pubkey; unseal with identity key; decode
  `KeyPair`; dedupe by value; **append** (no timestamp ordering — "latest" =
  last appended); retry cached undecryptables.

### 2.6 Multi-device

- Group **chat** self-syncs implicitly: linked devices poll the same group
  swarm (−10) with the shared keypair. Own messages from the group swarm are
  dropped; own NEW invites are sync-eligible.
- Group **state** syncs via (a) legacy `ConfigurationMessage` to own swarm
  — `activeClosedGroups[] { publicKey, name, encryptionKeyPair }` carrying
  **only the latest keypair** (schema already exists in this client; TTL 30
  d) and (b) libsession `UserGroups` `SharedConfigMessage` (ns 5, latest
  keypair only). **v1 implements (a); (b) is a P7 decision gate.**
  Consequence (both mechanisms): linked devices get only the newest keypair
  — pre-rotation history is undecryptable on them.

### 2.7 Limits & misc

- 100 members (`VALIDATION.CLOSED_GROUP_SIZE_LIMIT`).
- Disappearing messages: `deleteAfterSend` only; `deleteAfterRead` is
  rejected for groups.
- Namespaces (libsession-util): UserProfile=2, Contacts=3,
  ConvoInfoVolatile=4, UserGroups=5; group v2/v3: GroupMessages=11,
  GroupKeys=12, GroupInfo=13, GroupMembers=14. Legacy group messages: −10.

## 3. Architecture (decisions)

1. **Separate `@session.js/groups` package, AGPL-3.0-or-later**, same
   pattern as `calls/`: structural `GroupSessionLike` interface (no
   compile-time client dependency), `COPYING.provenance` per-file port
   records, own test/e2e/examples. Keeps the client core MIT/upstreamable.
2. **Fresh MIT core patches** (upstreamable, `sendCallMessage` precedent):
   - `./crypto` package export (`encrypt`, `wrap`, `decryptMessage`,
     `decodeMessage`, `extractContent`, `cryptoBoxSeal/Open`) — currently
     internal-only.
   - Fix `decryptForClosedGroup` (upstream bug: successful decrypt is
     shadowed by loop-scoped variable; `.pop()` mutation of caller array).
   - New **`GroupPoller`** (targets an arbitrary pubkey over ns −10,
     unauthenticated retrieve, per-group lastHashes storage keys, activity
     cadence) — the existing `Poller` is hardcoded to the instance's own
     pubkey/swarm.
   - Public **`sendClosedGroupUpdate()`** and **`sendGroupMessage()`**
     instance methods (the `wrap()`/`toRawMessage(isGroup)`/`buildEnvelope`
     plumbing for `isGroup` already exists; the `encrypt()` closed-group
     branch is dead commented code — leave it, route via the new methods).
   - `ClosedGroupControlMessage` schema class in `src/messages/schema/`
     + mapper + typed `groupUpdate` event (the `call` event precedent).
   - `GroupContext` support in visible-message sends; legacy
     `ConfigurationMessage.activeClosedGroups` parse/emit.
3. **Storage**: `GroupManager` takes its **own `Storage` constructor
   dependency** (core storage is protected; no core change needed). Keys
   follow the dynamic-prefix convention (`message_hash:` precedent):
   `closed_group:{groupId}:state` / `:keypairs` / `:last_hashes` /
   `:undecryptable` — JSON string values.
4. **License split**: groups package AGPL (ported logic — per-file
   provenance); all core patches MIT and upstreamable. Root NOTICE updated.

## 4. Phase plan & evidence manifest

One `docs/evidence/G<phase>-T<task>.md` per task (status / command / exit
code / output sha256 / redacted excerpts / UTC timestamp), same protocol as
`docs/evidence/README.md`.

- **P0 — Scaffolding** (this commit): this plan; `docs/protocol-notes.md`
  Part II cross-reference; `reference-pins.md`; `groups/` package scaffold
  (AGPL); `G0-T1` evidence (branch + pins).
- **P1 — Wire facts & goldens**: golden fixtures for all 7 control types +
  group visible message + keypair wrapper (`scripts/generate-goldens.ts` +
  `test/fixtures/wire/groups/`); `ClosedGroupControlMessage` schema class +
  mapper + `groupUpdate` event in core (MIT); decode/encode tests.
  Evidence: `G1-T1` (schema+mapper), `G1-T2` (goldens).
- **P2 — Core primitives** (MIT patches): `./crypto` export;
  `decryptForClosedGroup` fix + tests; `GroupPoller` + stub-network tests;
  `sendClosedGroupUpdate`/`sendGroupMessage` + offline tests; `GroupContext`
  in visible sends; legacy config `activeClosedGroups` parse/emit.
  Evidence: `G2-T1…T4`.
- **P3 — groups package foundations**: `GroupManager` skeleton,
  `GroupSessionLike`, storage schema, keypair registry (append/latest/dedupe
  by value), unit tests. `G3-T1…T2`.
- **P4 — Formation & join**: keygen per §2.1 (ed25519→x25519 group address;
  unprefixed encryption pair), per-member NEW DMs, inbound NEW handling per
  §2.2 gates, polling lifecycle, `groupCreated`/`groupJoined` events,
  two-manager offline bus tests (calls' `BusSession` pattern). `G4-T1…T3`.
- **P5 — Group chat send/receive**: send per §2.3 (seal + GroupContext +
  −10); receive via GroupPoller keypair provider + newest-first decrypt +
  `senderIdentity`; undecryptable cache + retry-on-new-keypair; tests incl.
  decryption with historical (rotated-out) keys. `G5-T1…T3`.
- **P6 — Member lifecycle**: add (§2.4 incl. admin keypair-push reply),
  remove (admin-only enforcement, deletion, admin-side rotation with
  wrappers per §2.5), leave (zombies, admin-leave disband), rename,
  expirationTimer; fault tests (non-admin removal dropped, stale update
  dropped by watermark, duplicate keypair ignored). `G6-T1…T4`.
- **P7 — Multi-device & config**: inbound
  `ConfigurationMessage.activeClosedGroups` reconciliation (join missing,
  delete absent without leave message, overwrite state); include groups in
  own config sends; **decision gate doc**
  (`docs/escalations/G7-T3-usergroups-wrapper.md`) for libsession UserGroups
  wrapper (defer/adopt). `G7-T1…T3`.
- **P8 — E2E & interop**: offline tier matrix (multi-manager bus, ≥10
  scenarios incl. concurrent add/remove rotation races); networked lifecycle
  gated behind `SESSION_GROUPS_NETWORK_TESTS=1` (fresh throwaway accounts,
  continue-on-error in nightly); Tier-3 interop matrix vs official
  desktop/android with escalation gate (calls' `P3-T3` pattern).
  `G8-T1…T3`.
- **P9 — Docs & packaging**: docs-site "Closed groups" section (create /
  join / send / member ops / limits / **weak-revocation & no-onion privacy
  disclosures**); `groups/README.md` finalized; `COPYING.provenance`
  finalized; `@session.js/groups@0.1.0`; NOTICE + root README roadmap
  checkbox; version scheme `0.0.57-groups.1` client bump. `G9-T1…T3`.

## 5. Port sources (per-file provenance recorded in groups/COPYING.provenance as work lands)

| Concern | session-desktop (`master` @ d86076b, AGPLv3) | session-android (`v1.19.1` @ e5ee2e1, GPLv3) |
|---|---|---|
| Group lifecycle (create/add/remove/leave/rename/rotate) | `ts/session/group/closed-group.ts` | `…/messaging/groups/ClosedGroup.kt`, `…/utilities/GroupUtil.kt` |
| Creation flow | `ts/session/conversations/createClosedGroup.ts` | `…/messaging/groups/ClosedGroup.kt` (form) |
| Inbound control dispatch | `ts/receiver/closedGroups.ts` (`handleClosedGroupControlMessage`) | `…/sending_receiving/ReceivedMessageHandler.kt` (closed-group handlers) |
| Group decrypt + keypair cache | `ts/receiver/contentMessage.ts` (`decryptForClosedGroup`) | `…/sending_receiving/MessageDecrypter.kt` |
| Outgoing message classes | `ts/session/messages/outgoing/controlMessage/group/*.ts`, `…/visibleMessage/ClosedGroupVisibleMessage.ts` | `…/messaging/messages/control/ClosedGroupUpdateMessage.kt` |
| Namespaces / polling model | `ts/session/apis/snode_api/{namespaces,swarmPolling}.ts` | `…/jobs/ClosedGroupPollerV2.kt` |
| Multi-device (legacy config) | `ts/receiver/configMessage.ts`, `…/outgoing/controlMessage/ConfigurationMessage.ts` | `…/messages/control/ConfigurationMessage.kt` |
| TTL/constants | `ts/session/constants.ts` | (TTL in Message base) |

## 6. Open questions (resolve → update here + evidence)

| # | Question | Due | Status |
|---|---|---|---|
| GQ1 | Exact `ConfigurationMessage` TTL official clients use for group-carrying configs (desktop: 30 d) — verify snode honoring | P7 | open |
| GQ2 | Android `isValidGroupUpdate` full predicate vs desktop's `lastJoinedTimestamp` watermark — reconcile into one rule set | P4 | open |
| GQ3 | Desktop zombie auto-cleanup: is there any send-path that converts MEMBER_LEFT → MEMBERS_REMOVED automatically, or is it manual-only? | P6 | **resolved (P6)**: manual-only. Verified in pinned desktop `handleClosedGroupMemberLeft` — on a member's MEMBER_LEFT the receiver removes them and adds a zombie; the "admin removes right away" behaviour is only an aspirational code comment, no automatic MEMBERS_REMOVED/rotation is sent. v1 matches: zombies are cleared only by an explicit `sendRemoveMembers` (which rotates) or by re-adding the member. |
| GQ4 | libsession UserGroups wrapper: adopt in v1.1 or defer (P7 gate) | P7 | **resolved (P7)**: **deferred to v1.1** — v1 ships the legacy `ConfigurationMessage` sync only (G7-T1/T2). Decision gate: `docs/escalations/G7-T3-usergroups-wrapper.md`. |
| GQ5 | Group v2/v3 timeline upstream — when does legacy interop stop mattering? (affects investment horizon) | P9 | open |

## 7. Licensing

`@session.js/groups` is **AGPL-3.0-or-later** and will contain code ported
— as direct ports, not clean-room — from the Session Foundation's
session-desktop (AGPLv3) and session-android (GPLv3) clients; upstream
copyright headers preserved, modifications annotated, per-file provenance in
`groups/COPYING.provenance` (GPLv3 combines into AGPLv3 per AGPLv3 §13).
All client-core patches listed in §3 are written fresh from the published
proto facts, © AdnaneKhan, MIT-licensable for upstream contribution. AGPL
§13 network-use obligation applies to the combined work (see root NOTICE).

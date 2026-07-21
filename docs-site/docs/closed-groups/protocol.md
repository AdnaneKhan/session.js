# Protocol, limits & caveats

How legacy closed groups work on the wire, and the properties you must
understand before building on them. Verified against the pinned official
clients (session-desktop `master` @ `d86076b`, session-android `v1.19.1`).

## Wire model

- **Group address**: a random ed25519 keypair whose public key is converted
  ed→x25519 and `05`-prefixed (33 bytes → 66-char hex). The ed25519 secret is
  **discarded** — a legacy group cannot sign; there is no cryptographic
  membership proof.
- **Group encryption keypair**: a fresh x25519 pair, stored **unprefixed**,
  kept **append-only** (all historical pairs retained; decrypt newest-first).
- **Control messages** ride `DataMessage.closedGroupControlMessage` (field 104):
  `NEW=1`, `ENCRYPTION_KEY_PAIR=3`, `NAME_CHANGE=4`, `MEMBERS_ADDED=5`,
  `MEMBERS_REMOVED=6`, `MEMBER_LEFT=7` (`2` is a removed numbering gap; `8`
  `ENCRYPTION_KEY_PAIR_REQUEST` is unused).
- **Group traffic** is `Envelope.type = CLOSED_GROUP_MESSAGE` (source = group
  address), sealed to the latest group encryption key, stored to the group's
  swarm at **namespace −10** (unauthenticated retrieve). Chat messages carry
  `GroupContext{ id: utf8("05…hex"), type: DELIVER }`.
- **NEW invites** and **ENCRYPTION_KEY_PAIR replies** are sent **1:1** to
  member swarms (namespace 0), sealed to the member's identity key.
- **TTL**: group messages 14 days; control messages never expire; config sync
  30 days.

## Keypair rotation (§2.5)

Triggered **only by an admin removing members**: after `MEMBERS_REMOVED` lands,
a fresh x25519 pair is wrapped per remaining member
(`wrapper = seal(KeyPair-proto → member identity key)`, **no padding**) and sent
to the group swarm. Receivers find their wrapper, unseal, and append the key
(deduped by value). Undecryptable messages are cached and retried when a new
key arrives.

## Limits

| | |
|---|---|
| Members | **100** (`CLOSED_GROUP_SIZE_LIMIT`) |
| Group name | non-empty |
| Disappearing messages | `deleteAfterSend` only (`deleteAfterRead` rejected for groups) |
| Admins | creator is the sole admin; **no admin transfer**; the first admin can only **leave** (which disbands the group) |

## Caveats & privacy disclosures

!!! Warning "Weak revocation (by design)"
    Removing a member rotates the group key, but the removed member **keeps all
    historical private keys**. They can decrypt swarm content until its 14-day
    expiry and anything sent before the rotation lands — and can even keep
    depositing ciphertext. The official Session clients accept this. There is no
    group signature scheme in the legacy protocol (the v3 rewrite adds one).

!!! Warning "No onion routing"
    This client talks to service nodes over **direct HTTPS** (TLS-verified),
    not onion requests. Group payloads are end-to-end encrypted, but a service
    node / network observer can see that you are contacting the group's swarm.
    This is an inherited client limitation, disclosed here per the plan.

!!! note "Multi-device carries only the latest key"
    Both config-sync mechanisms carry **only the latest** encryption keypair, so
    a newly-linked device cannot decrypt pre-rotation history.

## Out of scope (v1)

- **Group v2/v3** (`03…` pubkeys; libsession GroupMessages/Keys/Info/Members
  namespaces 11–14) — a separate protocol, still being rewritten upstream.
- **libsession `UserGroups` wrapper** (namespace 5) — deferred to v1.1
  (decision gate `docs/escalations/G7-T3-usergroups-wrapper.md`). v1 uses the
  legacy `ConfigurationMessage` sync.
- Admin transfer, group invites (`invite_pending`), group avatars,
  `ENCRYPTION_KEY_PAIR_REQUEST`.

# Closed groups (legacy, 05-prefixed)

`@session.js/groups` adds **legacy closed-group** support to the patched
session.js client: programmatic group lifecycle — create, join, chat, add /
remove / leave members, rename, and encryption-key rotation — speaking the
official Session closed-group wire protocol.

It is the companion to [`@session.js/calls`](../voice/index.md): same structural
decoupling (a `GroupSessionLike` interface, no compile-time client dependency),
same evidence discipline, same license posture (**AGPL-3.0-or-later**).

## What you can do

- **Create** a closed group and invite members (`createGroup`)
- **Join** automatically when invited (inbound `NEW` handling with the official
  client gates)
- **Send & receive** group chat messages (`sendMessage` + `groupMessage` event)
- **Manage members** — add, remove (admin-only, with key rotation), leave,
  rename
- **Multi-device** group state sync via the legacy `ConfigurationMessage`
- Receive group updates as typed events (`groupCreated`, `groupJoined`,
  `groupChanged`, `groupRemoved`, `groupMessage`)

## Scope & limitations (read this)

| | |
|---|---|
| **In scope** | Legacy closed groups — group address `05…`, group encryption keypair, control messages (NEW / NAME_CHANGE / MEMBERS_ADDED / MEMBERS_REMOVED / MEMBER_LEFT / ENCRYPTION_KEY_PAIR), group chat, rotation, legacy config sync |
| **Not in scope (v1)** | Group v2/v3 (`03…` pubkeys, libsession GroupMessages/Keys/Info/Members namespaces 11–14) — a separate protocol still being rewritten upstream; the libsession `UserGroups` config wrapper (namespace 5) — deferred to v1.1 |

!!! Warning "Weak revocation — by design"
    Removing a member rotates the group encryption key, but **a removed member
    keeps every historical private key**. They can still decrypt swarm content
    until its 14-day expiry and anything sent before the rotation lands. The
    official Session clients accept this; it is a property of the legacy
    protocol, not a bug in this library. See [Protocol & caveats](protocol.md).

!!! Warning "No onion routing"
    This client talks to service nodes over direct HTTPS (inherited client
    limitation). Group traffic is end-to-end encrypted, but requests are not
    onion-routed like the official clients. See [Protocol & caveats](protocol.md).

## Pages

- [Setup & install](setup.md)
- [Creating a group](creating.md)
- [Joining & receiving](joining.md)
- [Group messaging](messaging.md)
- [Managing members](members.md)
- [API reference](api-reference.md)
- [Protocol, limits & caveats](protocol.md)

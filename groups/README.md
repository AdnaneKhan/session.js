# @session.js/groups

Legacy **closed groups** (05-prefixed) for the patched
[session.js client](../README.md) — programmatic group lifecycle: create, join,
chat, add / remove / leave members, rename, and encryption-key rotation,
speaking the official Session closed-group wire protocol.

Companion to [`@session.js/calls`](../calls/README.md): same structural
decoupling (`GroupSessionLike`, no compile-time client dependency), same
evidence discipline, same license posture (**AGPL-3.0-or-later**).

- **Plan & protocol facts:** [`docs/closed-groups/IMPLEMENTATION.md`](../docs/closed-groups/IMPLEMENTATION.md)
- **Reference pins:** [`docs/closed-groups/reference-pins.md`](../docs/closed-groups/reference-pins.md)
- **Docs:** [docs-site "Closed groups"](../docs-site/docs/closed-groups/index.md)
- **Version:** `0.1.0` (pairs with `@session.js/client@0.0.57-groups.1`)

## Features

- `createGroup` — generate the group address + first encryption keypair, invite
  members (one `NEW` DM each), start polling
- Automatic **join** on a valid `NEW` invite (official-client gates)
- **Group chat** send/receive (`sendMessage` + `groupMessage` event)
- **Member ops** — add (any member), remove (admin-only, **with key rotation**),
  leave (zombies / admin-leave disbands), rename
- **Keypair rotation** (§2.5) with per-member wrappers + undecryptable retry
- **Multi-device** state sync via the legacy `ConfigurationMessage`
- Typed events: `groupCreated`, `groupJoined`, `groupChanged`, `groupRemoved`,
  `groupMessage`, `error`

## Quick start

```ts
import { Session, Poller, ready } from "@session.js/client";
import { GroupManager, InMemoryGroupStorage } from "@session.js/groups";

await ready;
const session = new Session();
session.setMnemonic(process.env.SESSION_MNEMONIC!);
session.addPoller(new Poller({ interval: 1500 }));

const groups = new GroupManager(session as never, undefined, {
	storage: new InMemoryGroupStorage(),
});
await groups.init();

groups.on("groupMessage", (m) => console.log(`<${m.from}> ${m.text}`));

const group = await groups.createGroup({ name: "team", members: [friendId] });
await groups.sendMessage(group.publicKey, "hello");
```

See the [docs-site section](../docs-site/docs/closed-groups/index.md) for the
full guide and [API reference](../docs-site/docs/closed-groups/api-reference.md).

## Testing

- **Unit / lifecycle:** `bun test` (storage, keypair registry, formation/join,
  chat, member ops + fault cases, config sync)
- **Offline E2E matrix:** `bun e2e/run-matrix.ts` — 12 multi-manager scenarios
  incl. a concurrent add/remove rotation race
- **Networked lifecycle:** `SESSION_GROUPS_NETWORK_TESTS=1 bun test
  test/integration/lifecycle.test.ts` (gated; throwaway accounts; nightly,
  continue-on-error)

## License

**AGPL-3.0-or-later.** Contains code directly ported from the Session
Foundation's session-desktop (AGPLv3) and session-android (GPLv3) clients, with
attribution and preserved copyright headers (per-file provenance:
[`COPYING.provenance`](COPYING.provenance)). The client-core patches it relies
on (`GroupPoller`, group send methods, `./crypto` export,
`ClosedGroupControlMessage` schema/mapper, the `decryptForClosedGroup` fix) are
written fresh from the published proto facts and are **MIT**.

!!! note "AGPL §13"
    If you run this code as a network service (e.g. an agent fleet others
    interact with over Session), AGPL §13 requires you to make the complete
    corresponding source — including your modifications — available to the
    users of that service. See the root [`NOTICE`](../NOTICE).

## Known limitations

- **Weak revocation** — a removed member keeps historical keys (decryptable
  until 14-day expiry / pre-rotation). By design of the legacy protocol.
- **No onion routing** — inherited client limitation (direct HTTPS to snodes).
- **No group v2/v3** (`03…`, namespaces 11–14) and no libsession `UserGroups`
  wrapper (deferred to v1.1). See
  [Protocol, limits & caveats](../docs-site/docs/closed-groups/protocol.md).

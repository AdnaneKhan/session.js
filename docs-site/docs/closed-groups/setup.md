# Setup & install

Closed groups need **two pieces**, both from this fork:

| Piece | Version | Why |
|---|---|---|
| `@session.js/client` (patched) | `0.0.57-groups.1` | Adds the group core: `./crypto` export, `decryptForClosedGroup` fix, `GroupPoller`, `sendGroupMessage` / `sendClosedGroupUpdate`, `sendConfigurationMessage`, `addGroupPoller` / `removeGroupPoller`, the `ClosedGroupControlMessage` schema + `groupUpdate` / `syncClosedGroups` events |
| `@session.js/groups` | `0.1.0` | The group engine (`GroupManager`: lifecycle, keypair registry, rotation, config reconciliation) |

!!! Warning "The published client won't work"
    The `@session.js/client@0.0.57` published to npm does **not** carry the
    group patches (no `groupUpdate` event, `decryptForClosedGroup` is broken
    upstream, no `GroupPoller` / group send methods). You must use this fork's
    build (`0.0.57-groups.1`).

## Runtimes

- **Bun** — primary (offline suite and E2E matrix pass on Bun).
- **Node ≥ 22** — supported via the fork's `NetworkNode` connector
  ([details](../network/node.md)).

## Installation

### Option A — from a fork checkout (development)

```bash
git clone https://github.com/AdnaneKhan/session.js
cd session.js/client
bun install
# client core (dist/) and the groups package live side by side
cd groups && bun install
```

Import the client from the repo root and the groups package from `groups/`:

```ts
import { Session, Poller, ready } from "@session.js/client";
import { GroupManager } from "@session.js/groups";
```

### Option B — package consumers

```bash
bun add @session.js/client@0.0.57-groups.1 @session.js/groups@0.1.0
```

## Minimal wiring

```ts
import { Session, Poller, ready } from "@session.js/client";
import { GroupManager, InMemoryGroupStorage } from "@session.js/groups";

await ready;

const session = new Session();               // or new Session({ network: new NetworkNode() }) on Node
session.setMnemonic(process.env.SESSION_MNEMONIC!);
session.addPoller(new Poller({ interval: 1500 }));

// The GroupManager drives group state; it talks to the Session through the
// structural GroupSessionLike interface (a boundary cast, like @session.js/calls).
const groups = new GroupManager(session as never, undefined, {
	storage: new InMemoryGroupStorage(),      // or a persistent Storage
});
await groups.init();                          // load known groups from storage

groups.on("groupMessage", (m) => console.log(`${m.from} in ${m.groupId}: ${m.text}`));
groups.on("groupJoined", (g) => console.log(`joined ${g.name}`));
```

The `GroupManager` takes **its own `Storage`** (the client's storage is
protected). Persist it (e.g. `@session.js/file-keyval-storage`) to keep groups
across restarts.

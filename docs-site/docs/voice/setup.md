# Setup & install

Voice calls need **two pieces**, both from this fork:

| Piece | Version | Why |
|---|---|---|
| `@session.js/client` (patched) | `0.0.57-calls.1` | Adds `sendCallMessage()`, the full `call` event (SDP/ICE fields), `setPollInterval()`, `NetworkNode` |
| `@session.js/calls` | `0.1.0` | The call engine (FSM, signaling, werift media plane, PCM hooks) |

!!! Warning "The published client won't work"
    The `@session.js/client@0.0.57` published to npm does **not** carry the
    call patch — it only surfaces a placeholder `call` event with no SDP/ICE
    fields and has no `sendCallMessage`. You must use this fork's build.

## Runtimes

- **Node ≥ 22** — primary for the calls stack. Use the fork's `NetworkNode`
  connector ([details](../network/node.md)).
- **Bun** — fully validated secondary runtime (offline suite, examples, and
  the media spike pass on both). The default `BunNetwork` connector works.

## Installation

### Option A — from a fork checkout (development)

```sh
git clone https://github.com/AdnaneKhan/session.js
cd session.js

# build the patched client
bun install && bun run build          # produces dist/

# build the calls package
cd calls && bun install && bun run build
```

Then link both into your project (workspace, `file:` dependencies, or
`bun link`), or pack tarballs:

```sh
bun pack                              # session.js-client-0.0.57-calls.1.tgz (in repo root)
cd calls && bun pack                  # session.js-calls-0.1.0.tgz
# in your project:
bun add ../session.js/session.js-client-0.0.57-calls.1.tgz ../session.js/calls/session.js-calls-0.1.0.tgz
```

### Option B — depend on the GitHub repo

```jsonc
// package.json
{
  "dependencies": {
    "@session.js/calls": "github:AdnaneKhan/session.js#main"
  }
}
```

Note that git dependencies install the repo root package; the nested
`calls/` package is most reliably consumed via the tarballs/checkout route
above (see `scripts/consumer-smoke.sh` in the fork for a worked consumer
install).

## Bring an account

```ts
import { Session, Poller, ready } from "@session.js/client";
import { encode } from "@session.js/mnemonic";
import { generateSeedHex } from "@session.js/keypair";

await ready;

const session = new Session();
// Fresh throwaway account…
session.setMnemonic(encode(generateSeedHex()));
// …or load an existing one:
// session.setMnemonic("word ".repeat(13).trim(), "My agent");

session.addPoller(new Poller({ interval: 500 }));
console.log("Session ID:", session.sessionID);
```

On **Node**, pass a `NetworkNode` — without it the Session constructor
throws outside Bun:

```ts
import { Session, Poller, ready } from "@session.js/client";
import { NetworkNode } from "@session.js/client/network";

await ready;
const session = new Session({ network: new NetworkNode() }); // TLS verified by default
session.addPoller(new Poller({ interval: 500 }));
```

## Smoke-test without any network

The fastest way to prove your install: the **offline echo example** runs two
`CallManager`s over an in-process signaling bus with the *real* werift media
plane (Opus over host/loopback ICE) — no Session account, no TURN, no
internet egress:

```sh
cd calls
bun run example:echo     # ~6 s, prints PASS/FAIL, exit code 0/1
```

Expected tail of the output:

```
offline-echo: B received 100 frames, A got 100 echo frames back
offline-echo: PASS (pipeline round-trips real Opus audio)
```

If that passes, the entire stack (FSM → signaling dispatch → ICE → DTLS →
Opus → PCM hooks) works on your machine, and you're ready for
[making real calls](./making-calls.md).

!!! Info "See also"
    - [Examples](./examples.md) — the offline echo and the networked voice
      agent, explained
    - [NetworkNode](../network/node.md) — running the client on Node

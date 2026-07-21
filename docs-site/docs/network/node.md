# Node.js

This fork adds first-class **Node ≥ 22** support via `NetworkNode`, a
`fetch`/`node:https`-based `Network` implementation that mirrors
`@session.js/bun-network` semantics. Bun remains a fully supported runtime
(with the default `BunNetwork`); upstream session.js itself is Bun-only.

```ts
import { Session, Poller, ready } from "@session.js/client";
import { NetworkNode } from "@session.js/client/network";

await ready;

const session = new Session({ network: new NetworkNode() });
session.setMnemonic("…");
session.addPoller(new Poller());
```

Without an explicit `network`, constructing a `Session` outside Bun throws —
pass `NetworkNode` (or any `@session.js/client`-compatible `Network`).

## TLS verification

**TLS verification is ON by default** (`insecureTls: false`) — a deliberate,
safer divergence from `@session.js/bun-network`, which disables TLS
verification for all snode/seed requests. For parity experiments with
bun-network you can opt out:

```ts
const session = new Session({ network: new NetworkNode({ insecureTls: true }) });
```

!!! Warning
    `insecureTls: true` disables certificate verification for snode/seed
    traffic. Use only for experiments.

## Documented divergences from bun-network

- **TLS on by default** (see above).
- **Seed handling:** bun-network fetches snode lists from `http://` seed
  URLs and (due to an upstream bug) only ever queries the first seed;
  `NetworkNode` uses `https://<seed>/json_rpc` and iterates **all**
  configured seeds.
- **Timeouts:** `AbortSignal.timeout` (Node-compatible) instead of Bun's
  fetch `timeout` option.

## Voice calls on Node

`@session.js/calls` treats **Node ≥ 22 as its primary runtime** — pair it
with `NetworkNode` as in the [voice setup guide](../voice/setup.md). The
media plane (werift/Opus) is pure JavaScript and runs identically under Node
and Bun; the offline E2E suite and examples pass on both.

# Session.js

Session.js is JavaScript library for programmatic usage of [Session messenger by OXEN](https://getsession.org). Supports server and browser environment with built-in proxy network module. Shipped with TypeScript definitions. Tested with bun:test. It's aimed for [Bun](https://bun.sh) users — a modern runtime for JavaScript and alternative to Node.js. But it can also be used on most platforms and runtimes thanks to external modules system and platform-agnostic architecture with vanilla [noble](https://paulmillr.com/noble/) cryptography instead of WASM-compiled libsodium and bytebuffer.

Session.js allows you to create:
- Highly optimized Session bots (hundreds of bots in a single app)
- Custom Session clients (web-based and native with JS backend)
- Automation tools for Session

## Features

- On-demand polling — you decide when to get new messages and whether instance should poll them (and poll settings like frequency) or work just for sending
- Per-instance storage and network settings — you can attach persistant storage to instance or use in-memory storage for throwaway one-time instances
- Session.js can be used in browser, keeping private keys on client-side and doing network requests on server-side. See this in action with [my full-featured Session Web client](https://git.hloth.dev/hloth/session-web)!

[Project roadmap](https://sessionjs.github.io/docs/#roadmap).

## Voice-call additions (this fork)

This fork (`feat/voice-calls` → `main`) adds 1:1 voice-call support on top of
upstream `@session.js/client@0.0.57` (pin recorded in `docs/upstream-pin.md`).
Additions, all covered by tests:

- **Complete inbound call events** — the `call` event payload now carries the
  full `CallMessage` signaling fields (`sdps`, `sdpMLineIndexes`, `sdpMids`,
  envelope `timestamp`) instead of only `uuid`/`type`/`from`.
- **`session.sendCallMessage(to, callMessage, { isSyncMessage })`** — send
  Session call-control messages (`PRE_OFFER`, `OFFER`, `ANSWER`,
  `ICE_CANDIDATES`, `END_CALL`) with the correct 5-minute TTL.
  `isSyncMessage: true` stores the message to your own swarm (self-sync, used
  for `ANSWER`/`END_CALL` so linked devices stop ringing).
- **`session.setPollInterval(ms)`** — change the polling interval of all
  registered pollers at runtime (used to boost cadence during calls).
- **Node.js support** — `import { NetworkNode } from "@session.js/client/network"`:
  a fetch/`node:https`-based `Network` implementation for Node ≥ 22, mirroring
  `@session.js/bun-network` semantics with TLS verification **on** by default
  (opt-out: `insecureTls: true`). Bun remains the primary runtime.
- **`@session.js/calls`** — the companion voice-call package in [`calls/`](./calls):
  headless WebRTC audio (werift + Opus), call state machine, programmatic PCM
  I/O (48 kHz mono 16-bit, 20 ms frames) for STT/TTS pipelines. See
  [`calls/README.md`](./calls/README.md) and [`calls/examples/`](./calls/examples).

> [!NOTE]
> **License:** original client code in this fork stays MIT. The `calls/`
> package is **AGPL-3.0-or-later** and contains code ported from Session
> Foundation's session-android (GPLv3) and session-desktop (AGPLv3) clients
> (see `NOTICE` and `calls/COPYING.provenance`). The fresh-written core
> patches above (mapper fix, `CallMessage` schema, `sendCallMessage`,
> `setPollInterval`, `NetworkNode`) remain MIT-licensable for upstream
> contribution. If you run this code as a network service, AGPL §13 requires
> you to make the corresponding source available to users.

## Getting started

Visit documentation website for guide: [https://sessionjs.github.io/docs/](https://sessionjs.github.io/docs/)

## Credits

This fork is maintained by [AdnaneKhan](https://github.com/AdnaneKhan) and
builds on [Session.js](https://git.hloth.dev/session.js/client) by
[Viktor Shchelochkov (hloth.dev)](https://hloth.dev) — an excellent library
for programmatic Session usage. All credit for the original client, its
documentation and roadmap belongs to the upstream author; the voice-call
additions and the AGPL `calls/` package in this fork are by the fork
maintainer.

- Noble PRs by [li0ard](https://li0ard.rest)

## License

This repository is a fork of the MIT-licensed
[Session.js client](https://git.hloth.dev/session.js/client)
(© Viktor Shchelochkov) with an added voice-call package. The
**combined work is distributed under AGPL-3.0-or-later**. Full
details: [`NOTICE`](./NOTICE).

| If you… | License that applies | What that means |
|---|---|---|
| Use `calls/`, or the client together with `calls/` | **AGPL-3.0-or-later** | Copyleft. Running it as a network service (incl. an agent fleet others interact with over Session) triggers **AGPL §13**: you must give users of the service the complete corresponding source, including your modifications. |
| Use only the client core (everything outside `calls/`) | **MIT** | Permissive — see [`LICENSES/MIT.txt`](./LICENSES/MIT.txt). The fresh call-signaling patches listed below are also MIT. |
| Redistribute or fork | Both | Preserve the copyright notices, `LICENSE`, `LICENSES/MIT.txt`, `NOTICE`, and `calls/COPYING.provenance`; annotate your changes to ported files. |

The call-signaling patches to the client core (`mapCallMessage` mapper
fix, `CallMessage` schema, `sendCallMessage`, `setPollInterval`,
`NetworkNode`) were written fresh from the published
`SessionProtos.proto` field facts and are MIT-licensable for upstream
contribution.

The `calls/` package is **not clean-room**: it contains code directly
ported from the Session Foundation's session-android (GPLv3) and
session-desktop (AGPLv3) clients, with upstream headers preserved and
per-file provenance in
[`calls/COPYING.provenance`](./calls/COPYING.provenance).

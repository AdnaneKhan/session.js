# Session.js

Session.js is JavaScript library for programmatic usage of [Session messenger by OXEN](https://getsession.org). Supports server and browser environment with built-in proxy network module. Shipped with TypeScript definitions. Tested with bun:test. It's aimed for [Bun](https://bun.sh) users — a modern runtime for JavaScript and alternative to Node.js. But it can also be used on most platforms and runtimes thanks to external modules system and platform-agnostic architecture with vanilla [noble](https://paulmillr.com/noble/) cryptography instead of WASM-compiled libsodium and bytebuffer.

Session.js allows you to create:
- Highly optimized Session bots (hundreds of bots in a single app)
- Custom Session clients (web-based and native with JS backend)
- Automation tools for Session

> [!IMPORTANT]
> I'm looking for a job! Interested in hiring me? Visit [cv.hloth.dev](https://cv.hloth.dev) to review my resume & CV.

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

## Acknowledgements

- Noble PRs by [li0ard](https://li0ard.rest)

## Donate

[hloth.dev/donate](https://hloth.dev/donate) · Tor: [hlothdevzkti6suoksy7lcy7hmpxnr3msu5waokzaslsi2mnx5ouu4qd.onion/donate](http://hlothdevzkti6suoksy7lcy7hmpxnr3msu5waokzaslsi2mnx5ouu4qd.onion/donate)

PGP-signed list of my crypto wallets: [hloth.dev/donate-pgp-signed.txt](https://hloth.dev/donate-pgp-signed.txt) · Tor: [hlothdevzkti6suoksy7lcy7hmpxnr3msu5waokzaslsi2mnx5ouu4qd.onion/donate-pgp-signed.txt](http://hlothdevzkti6suoksy7lcy7hmpxnr3msu5waokzaslsi2mnx5ouu4qd.onion/donate-pgp-signed.txt)

## License

[MIT](./LICENSE)

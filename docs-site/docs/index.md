Session.js is JavaScript library for programmatic usage of [Session messenger by OXEN](https://getsession.org). Supports server and browser environment with built-in proxy network module. Shipped with TypeScript definitions. Tested with bun:test. It's aimed for [Bun](https://bun.sh) users — a modern runtime for JavaScript and alternative to Node.js. But it can also be used on most platforms and runtimes thanks to external modules system and platform-agnostic architecture with vanilla [noble](https://paulmillr.com/noble/) cryptography instead of WASM-compiled libsodium and bytebuffer.

!!! Note "This is the fork's documentation"
    This site is maintained with the
    [AdnaneKhan/session.js](https://github.com/AdnaneKhan/session.js) fork,
    which adds **headless 1:1 voice calls** ([`@session.js/calls`](./voice/index.md))
    and **Node ≥ 22 support** ([`NetworkNode`](./network/node.md)) on top of
    upstream Session.js. Upstream original:
    [sessionjs.github.io/docs](https://sessionjs.github.io/docs).

Session.js allows you to create:

- Highly optimized Session bots (hundreds of bots in a single app)
- Custom Session clients (web-based and native with JS backend)
- Automation tools for Session

## Features

- On-demand polling — you decide when to get new messages and whether instance should poll them (and poll settings like frequency) or work just for sending
- Per-instance storage and network settings — you can attach persistant storage to instance or use in-memory storage for throwaway one-time instances
- Session.js can be used in browser, keeping private keys on client-side and doing network requests on server-side. See this in action with [my full-featured Session Web client](https://git.hloth.dev/hloth/session-web)!

## Getting started

Jump to [getting started](./getting-started.md) page to start using Session.js!

## Roadmap
- [X] Messages
  - [X] Automatic snodes fetching
  - [X] Automatic swarms selection
  - [ ] Manual snode/swarm control
  - [X] Data retrieving from swarms
  - [X] Messages polling
  - [X] Messages types
    - [X] Regular chat message
      - [X] Text
      - [X] Attachments
        - [X] Images
        - [X] Files
        - [X] Voice messages
        - [X] Quotes
        - [ ] Web links previews
    - [X] Service messages
      - [X] Sync message
      - [X] Configuration message
        - Uses legacy constructor for now
      - [X] Read message (ReadReceipt)
      - [X] Typing message
      - [X] Message request response
      - [X] Screenshot / media saved (DataExtraction)
      - [X] Delete message (Unsend)
      - [X] Call message
        - Upstream: event with placeholder fields only
        - **This fork:** full `CallMessage` mapping (SDP/ICE fields) + `sendCallMessage()`
  - [X] Reactions
  - [X] Closed chats (legacy, 05-prefixed) — **this fork**: create / join / chat / member ops / rotation, see [Closed groups](./closed-groups/index.md)
    - [ ] Group v2/v3 (03-prefixed) — separate protocol, future work
  - [ ] Open groups (SOGS)
  - [ ] Expirable messages
- [X] Calls — **this fork**: headless 1:1 voice calls over WebRTC/Opus, see [Voice calls](./voice/index.md)
- [ ] Messages editing (SOGS)
- [X] Profile editing
  - [X] Display name
  - [X] Avatar
  - [X] Syncing between devices
- [X] ONS resolving

</details>

## License

The original Session.js client was written by Viktor Shchelochkov aka hloth
and is licensed under the [MIT license](https://git.hloth.dev/session.js/client/blob/main/LICENSE.md);
those portions remain MIT in this fork (see
[`LICENSES/MIT.txt`](https://github.com/AdnaneKhan/session.js/blob/main/LICENSES/MIT.txt)).
The voice-call additions (`calls/`) and the closed-group additions
(`groups/`) — both ported from the Session Foundation's official clients — and
the combined work are licensed **AGPL-3.0-or-later** — see the
[`NOTICE`](https://github.com/AdnaneKhan/session.js/blob/main/NOTICE), the
[voice calls license notes](./voice/index.md#license), and the
[closed groups license notes](./closed-groups/index.md).
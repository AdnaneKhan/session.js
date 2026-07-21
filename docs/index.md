Session.js is JavaScript library for programmatic usage of [Session messenger by OXEN](https://getsession.org). Supports server and browser environment with built-in proxy network module. Shipped with TypeScript definitions. Tested with bun:test. It's aimed for [Bun](https://bun.sh) users — a modern runtime for JavaScript and alternative to Node.js. But it can also be used on most platforms and runtimes thanks to external modules system and platform-agnostic architecture with vanilla [noble](https://paulmillr.com/noble/) cryptography instead of WASM-compiled libsodium and bytebuffer.

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
        - Just event to display placeholder warning about unsupported feature
  - [X] Reactions
  - [ ] Closed chats
  - [ ] Open groups (SOGS)
  - [ ] Expirable messages
- [ ] Calls
- [ ] Messages editing (SOGS)
- [X] Profile editing
  - [X] Display name
  - [X] Avatar
  - [X] Syncing between devices
- [X] ONS resolving

</details>

## License

All code in Session.js (including any submodules) was written by Viktor Shchelochkov aka hloth and licensed under [MIT license](https://git.hloth.dev/session.js/client/blob/main/LICENSE.md)

## Funding

You can donate here: [hloth.dev/donate](https://hloth.dev/donate)
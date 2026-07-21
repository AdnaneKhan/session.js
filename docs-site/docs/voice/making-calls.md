# Making calls

Outbound calls go through a single `CallManager` attached to your (patched)
client instance. **One concurrent call per manager** (v1).

## Minimal outbound call

```ts
import { CallManager } from "@session.js/calls";

const calls = new CallManager(session, {
  logger: (level, msg) => console.log(`[calls:${level}] ${msg}`),
});

// 1. Approve the peer first (contacts-only gate is on by default)
const peer = "05…"; // 66-char Session ID
calls.approveContact(peer);

// 2. Place the call
const call = await calls.call(peer);
call.on("state", (s) => console.log("state →", s));

// 3. Send audio once connected (48 kHz mono s16, 20 ms frames)
call.on("state", function send(s) {
  if (s !== "connected") return;
  call.writeAudio(myPcmFrame); // returns false under backpressure — see audio page
});

// 4. Hang up when done
await call.hangup();
```

`call()` resolves as soon as the call is *placed* (PRE_OFFER sent) — not when
it's answered. Watch `call.info.state` / the `"state"` event for the ring and
connection progression:

```
idle → local-pre-offer → local-ring → connecting → connected → disconnected
```

## CallManager options

```ts
const calls = new CallManager(session, {
  iceServers: undefined,          // default: official Session TURN hosts (shuffle-take-2)
  iceTransportPolicy: "all",      // "all" (P2P-first) | "relay" (TURN-only — see caveats)
  callTimeoutMs: 60_000,          // ring/setup timeout
  iceBatchIntervalMs: 200,        // trickle-ICE batching window
  boostedPollIntervalMs: 500,     // poller cadence during calls (restored after)
  requireApprovedContact: true,   // peers must be approved before calling
  autoApproveOnCall: true,        // auto-send conversation approval to the callee
  logger: (level, msg, meta) => {},
});
```

| Option | Default | Notes |
|---|---|---|
| `iceServers` | official Session TURN hosts | Pass `[]` for host-only ICE (offline/LAN), or your own [coturn](./protocol.md#turn-servers-and-ethics) |
| `iceTransportPolicy` | `"all"` | `"relay"` hides host IPs but **audio over relay is broken in v1** — see [caveats](./protocol.md#limitations-v1) |
| `callTimeoutMs` | `60_000` | Unanswered calls end with `endReason: "timeout"` |
| `boostedPollIntervalMs` | `500` | session.js has no push channel — the poller is boosted during calls for timely signaling, then restored to your normal cadence |
| `requireApprovedContact` | `true` | `call()` rejects with `PeerNotApprovedError` for unapproved peers |
| `autoApproveOnCall` | `true` | Sends `MessageRequestResponse(approved)` to the callee so your call doesn't land in their requests |

## Manager events & helpers

```ts
calls.on("outgoing", (call) => {});   // fired when you place a call
calls.on("missed", ({ peer, at, reason }) => {});
calls.on("error", ({ call, error }) => {});  // manager never crashes the host on these

calls.activeCall;                     // the single active Call, if any
calls.isContactApproved(peer);        // → boolean
await calls.dispose();                // hang up any active call, unhook, restore polling (idempotent)
```

## What call() can reject with

All failures are typed `CallError` subclasses with stable `.code`s:

| Error | When |
|---|---|
| `InvalidCallMessageError` | Bad Session ID format |
| `CallInProgressError` | Another call is already active on this manager |
| `PeerNotApprovedError` | `requireApprovedContact` is on and you haven't called `approveContact()` |
| `MediaFailureError` | Media plane failed to initialize |

Mid-call failures (ICE death, signaling timeout) don't reject `call()` —
they end the call with `endReason: "ice-failed"` / `"error"` and fire
`"error"` on the manager.

## Full example: call a peer and play a tone

```ts
import { Session, Poller, ready } from "@session.js/client";
import { NetworkNode } from "@session.js/client/network";
import { CallManager, sineFrame, FRAME_MS } from "@session.js/calls";

await ready;
const session = new Session({ network: new NetworkNode() });
session.setMnemonic(process.env.MY_MNEMONIC!);
session.addPoller(new Poller({ interval: 3000 }));

const calls = new CallManager(session);
calls.approveContact(process.argv[2]);
const call = await calls.call(process.argv[2]);

call.on("state", (s) => {
  console.log("state:", s);
  if (s === "disconnected") console.log("end reason:", call.info.endReason);
});

// 3 s of 440 Hz once connected, paced in real time
call.on("state", async function tone(s) {
  if (s !== "connected") return;
  for (let i = 0; i < 150; i++) {
    while (!call.writeAudio(sineFrame(i, 440))) {
      await new Promise((r) => setTimeout(r, 10)); // backpressure: retry same frame
    }
    await new Promise((r) => setTimeout(r, FRAME_MS)); // pace at 20 ms/frame
  }
  await call.hangup();
});
```

!!! Info "See also"
    - [Audio pipelines](./audio-pipeline.md) — the PCM contract, pacing and
      backpressure in depth
    - [Receiving calls](./receiving-calls.md) — the other half
    - [API reference](./api-reference.md) — complete `Call` surface

# Receiving calls

Inbound calls arrive on the manager's `"incoming"` event. One subtlety
matters: **the event fires on `PRE_OFFER`** (the ring), but `accept()` is
only valid once the `OFFER` has arrived and the call is in `remote-ring`.
The OFFER follows PRE_OFFER almost immediately over the swarm.

```ts
calls.on("incoming", (call) => {
  console.log("ring ring from", call.info.peer);

  call.onAudio((pcm) => mySink(pcm));   // wire your sink BEFORE accepting

  call.on("state", (s) => {
    if (s === "remote-ring") void call.accept();  // OFFER has arrived
  });
});
```

Or accept on the next microtask if you auto-answer everything (the OFFER
lands mid-dispatch — a microtask defers just long enough):

```ts
calls.on("incoming", (call) => {
  queueMicrotask(() => void call.accept().catch(() => {}));
});
```

## Accept, reject, ignore

| Action | Wire message | Effect |
|---|---|---|
| `await call.accept()` | `ANSWER` (+ own-swarm sync copy) | Starts media setup → `connecting` → `connected` |
| `await call.reject()` | `END_CALL` | Caller sees `endReason: "remote-declined"` |
| `call.ignore()` | **none** | Purely local — the caller rings out to the 60 s timeout; a missed call is recorded locally |

## Missed calls & busy handling

```ts
calls.on("missed", ({ peer, at, reason }) => {
  // reason: "ignored" | "busy" | "stale" | "declined-wire"
});
```

- **Busy:** a second inbound call while one is active resolves with busy
  semantics — the intruder gets `END_CALL` and you get a `"missed"` event
  with `reason: "busy"`.
- **Stale:** signaling that arrives past the freshness window (5-minute TTL
  plus clock-offset tolerance) is dropped.

## Contacts-only gate

Matching official-client behavior:

- **Inbound calls from unapproved senders are dropped silently** — no ring,
  no missed record. Approve peers with `calls.approveContact(peer)`.
- **Outbound** calls require prior approval too (`requireApprovedContact`
  defaults to `true`), and with `autoApproveOnCall` (default `true`) your
  client sends a `MessageRequestResponse(approved)` to the callee when you
  call, so you don't land in their message requests.

## The callee must opt in

Official Session clients ship voice calls **disabled by default** (opt-in
beta). There is no wire capability query — a call to a user who hasn't
enabled calls simply rings out to a **silent 60 s timeout**
(`endReason: "timeout"`). Nothing is wrong with your setup if this happens;
ask the callee to enable calls in their client settings.

## Multi-device (linked devices) behavior

`ANSWER` and `END_CALL` are also stored to your own swarm
(`isSyncMessage: true`). The semantics:

- If **another of your devices** answers a call, your instance sees
  `endReason: "answered-elsewhere"` and stops ringing.
- If another of your devices ends it, you see `"ended-elsewhere"`.
- Other self-sent signaling (e.g. your own OFFER echoed back by the swarm)
  is dropped.

## Complete auto-answer example

```ts
import { CallManager, FRAME_MS } from "@session.js/calls";

const calls = new CallManager(session, { logger: console.log });
calls.approveContact(myFriend); // gate is bilateral — approve who may call you

calls.on("incoming", (call) => {
  console.log(`☎️  inbound from ${call.info.peer}`);

  // Echo every received frame back (the simplest possible pipeline)
  call.onAudio((pcm) => {
    if (!call.writeAudio(pcm)) {
      // backpressure — drop or queue per your latency budget
    }
  });

  call.on("state", (s) => {
    if (s === "remote-ring") void call.accept();
    if (s === "disconnected") console.log("ended:", call.info.endReason);
  });
});

calls.on("missed", (m) => console.log("missed call:", m));
calls.on("error", ({ error }) => console.error("call error:", error));
```

!!! Info "See also"
    - [Audio pipelines](./audio-pipeline.md) — wire in real STT/TTS instead
      of the echo
    - [Protocol & caveats](./protocol.md) — freshness windows, self-sync
      details, and why polling latency affects ring time

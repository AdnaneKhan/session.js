# API reference

The normative API surface lives in
[`calls/src/types.ts`](https://github.com/AdnaneKhan/session.js/blob/main/calls/src/types.ts);
this page mirrors it.

## `CallManager`

```ts
import type { Session } from "@session.js/client"; // the PATCHED fork client

const calls = new CallManager(session, options?);
```

### Options (`CallManagerOptions`)

```ts
export interface CallManagerOptions {
  /** ICE servers; default = official Session TURN hosts (shuffle-take-2). */
  iceServers?: IceServer[];
  /** "all" (default, P2P-first) or "relay" (TURN-only; hides host IP — but see caveats). */
  iceTransportPolicy?: "all" | "relay";
  /** ms; default 60_000. */
  callTimeoutMs?: number;
  /** ms; default 200. */
  iceBatchIntervalMs?: number;
  /** Poller interval while a call is setting up/active; default 500. Restored after. */
  boostedPollIntervalMs?: number;
  /** Require local approval of the peer before placing a call; default true. */
  requireApprovedContact?: boolean;
  /** Auto-send MessageRequestResponse(approved) when placing a call; default true. */
  autoApproveOnCall?: boolean;
  logger?: (level: string, msg: string, meta?: unknown) => void;
}

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}
```

### Methods & properties

```ts
class CallManager extends EventEmitter {
  constructor(session: SessionLike, options?: CallManagerOptions);

  /** Place an outbound call. Resolves when the call is PLACED (PRE_OFFER
   *  sent), not when answered. Rejects: InvalidCallMessageError (bad Session
   *  ID), CallInProgressError (one concurrent call), PeerNotApprovedError
   *  (requireApprovedContact and not approved), media failures. */
  call(peerSessionId: string): Promise<Call>;

  /** The single active call, if any (v1: one concurrent call). */
  readonly activeCall: Call | undefined;

  /** Hang up any active call, unhook from the session, restore the poll
   *  cadence. Idempotent. */
  dispose(): Promise<void>;

  /** Approve a peer for inbound/outbound calls (contacts-only gate). */
  approveContact(peerSessionId: string): void;
  isContactApproved(peerSessionId: string): boolean;
}
```

### Events

| Event | Payload | Fires when |
|---|---|---|
| `"incoming"` | `(call: Call)` | Inbound call — on **PRE_OFFER**; accept once `call.info.state === "remote-ring"` |
| `"outgoing"` | `(call: Call)` | Outbound call placed |
| `"missed"` | `({ peer, at, reason })` | `reason: "ignored" \| "busy" \| "stale" \| "declined-wire"` |
| `"error"` | `({ call?, error })` | Media/signaling/consumer errors — the manager never crashes the host |

## `Call`

```ts
export interface Call {
  /** Live view: uuid, peer, direction, state, startedAt, connectedAt?,
   *  endedAt?, endReason? */
  readonly info: CallInfo;

  accept(): Promise<void>;   // inbound only — once state is "remote-ring"
  reject(): Promise<void>;   // sends END_CALL to the caller
  ignore(): void;            // local only — NO wire message; records missed
  hangup(): Promise<void>;   // datachannel hint + END_CALL (peer + self swarm)

  /** Incoming decoded audio: 16-bit PCM, 48 kHz, mono, 20 ms frames
   *  (960 samples). */
  onAudio(cb: (pcm: Int16Array) => void): void;

  /** Queue outbound audio frames (same format). Returns false if the ~1 s
   *  bridge queue is full — retry the SAME frame after ~10 ms. Throws
   *  TypeError on wrong frame shape. */
  writeAudio(pcm: Int16Array): boolean;

  /** Remote peer signaled a video toggle (v1: informational only). */
  onRemoteVideoToggle(cb: (enabled: boolean) => void): void;

  on(event: "state" | "audio-level" | "ended" | "signaling", cb): void;
}
```

### `CallState`

```ts
export type CallState =
  | "idle" | "local-pre-offer" | "local-ring"
  | "remote-pre-offer" | "remote-ring"
  | "connecting" | "connected"
  | "reconnecting" | "pending-reconnect"
  | "disconnected";
```

Outbound happy path: `idle → local-pre-offer → local-ring → connecting →
connected → disconnected`. Inbound: `idle → remote-pre-offer → remote-ring →
connecting → connected → disconnected`. Mid-call network loss: `connected →
pending-reconnect → reconnecting → connecting → connected` (or
`disconnected` on exhaustion).

### `EndReason`

```ts
export type EndReason =
  | "local-hangup" | "remote-hangup" | "remote-declined" | "busy"
  | "timeout" | "ice-failed" | "error" | "ignored-locally"
  | "answered-elsewhere" | "ended-elsewhere"; // last two: multi-device races
```

## Error taxonomy

All failures are typed `CallError` subclasses with stable `.code`s:

`PeerNotApprovedError` · `CallInProgressError` · `SignalingTimeoutError` ·
`IceFailureError` · `MediaFailureError` · `RuntimeUnsupportedError` ·
`InvalidCallTransitionError` · `InvalidCallMessageError`

The manager contains media/signaling/consumer errors — they surface on the
`"error"` event and end the affected call with `endReason: "error"` (or
`"ice-failed"`), never as an uncaught crash.

## `SessionLike` — structural contract for custom adapters

The package builds **without** `@session.js/client` installed: everything it
needs from a client instance is this structural interface. A patched
`Session` satisfies it with no casts; a hand-rolled adapter works too (the
offline example and the E2E harness run the full stack over an in-process
bus implementing exactly this surface — see
[Examples](./examples.md#offline-echo-no-network)).

```ts
export interface SessionLike {
  getSessionID(): string;
  /** Clock compensated for swarm/server offset — used for freshness checks. */
  getNowWithNetworkOffset(): number;
  on(event: "call", cb: (msg: CallMessageEvent) => void): void;
  off(event: "call", cb: (msg: CallMessageEvent) => void): void;
  sendCallMessage(
    to: string,
    msg: {
      type: CallMessageTypeValue;   // 1 OFFER, 2 ANSWER, 3 PROVISIONAL_ANSWER,
      uuid: string;                 // 4 ICE_CANDIDATES, 5 END_CALL, 6 PRE_OFFER
      sdps?: string[];
      sdpMLineIndexes?: number[];
      sdpMids?: string[];
    },
    options?: { isSyncMessage?: boolean },
  ): Promise<{ messageHash: string; timestamp: number }>;
  /** Boost/restore the poller cadence during calls. */
  setPollInterval(interval: number): void;
  acceptConversationRequest(opts: { from: string }): Promise<unknown>;
}
```

## Advanced: custom media plane

`PeerConnectionManager` and `AudioBridge` are exported for custom pipelines,
and advanced consumers can wire their own media engine (`MediaEngine` /
`MediaSession` in `src/types.ts`) via the non-normative third constructor
argument (`CallManagerDeps`).

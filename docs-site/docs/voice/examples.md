# Examples

Two runnable examples ship with
[`calls/examples/`](https://github.com/AdnaneKhan/session.js/tree/main/calls/examples),
plus end-to-end suites for verifying your own setup.

| File | What it does | Needs network? |
|---|---|---|
| `offline-echo.ts` | Two CallManagers over an in-process signaling bus, **real werift media** (Opus over host/loopback ICE). A sends a 440 Hz sine, B's echo pipeline returns it. | **No** |
| `voice-agent.ts` | A voice agent on a real (patched) Session account: auto-answers inbound calls through a pluggable STT→TTS pipeline, or calls a peer and records received audio. | Yes (Session swarm) |

```sh
bun examples/offline-echo.ts                                    # ~6 s, prints PASS/FAIL
EXAMPLE_MNEMONIC="…" bun examples/voice-agent.ts                # inbound, auto-answer
EXAMPLE_MNEMONIC="…" bun examples/voice-agent.ts --call 05…     # outbound, 3 s sine + record out.pcm
```

## Offline echo (no network)

`bun run example:echo` (from `calls/`) runs the *entire* stack with zero
external dependencies:

- two `BusSession`s implement [`SessionLike`](./api-reference.md#sessionlike-structural-contract-for-custom-adapters)
  over an in-process bus — the swarm replaced by a function call;
- both agents are created with `iceServers: []`, so ICE is host/loopback-only
  (deterministic, CI-safe);
- A sends 2 s of 440 Hz sine through real Opus, B's echo pipeline returns it,
  A verifies it got frames back.

```
offline-echo: connected — sending 2 s of 440 Hz sine
offline-echo: B received 100 frames, A got 100 echo frames back
offline-echo: PASS (pipeline round-trips real Opus audio)
```

Use it as a smoke test after install and as a template for custom
`SessionLike` adapters.

## Voice agent (real Session account)

`voice-agent.ts` attaches a `CallManager` + voice pipeline to a real
account:

- **Inbound mode** (default): auto-accepts every approved inbound call and
  runs received PCM through the STT→TTS pipeline (defaults: `EchoStub` +
  `PassthroughTTS` — echoes audio back after 200 ms, works offline once the
  call connects).
- **Outbound mode** (`--call 05…`): calls the peer, sends 3 s of 440 Hz
  sine, records whatever comes back to `examples/out.pcm`.

Without `EXAMPLE_MNEMONIC` an ephemeral account is generated and printed —
useful for a quick two-terminal test:

```sh
# terminal 1
bun examples/voice-agent.ts        # prints a fresh Session ID, auto-answers

# terminal 2
bun examples/voice-agent.ts --call 05<terminal-1-id>
```

### Plugging in real STT/TTS

The pipeline is two interfaces — see
[Audio pipelines](./audio-pipeline.md#plugging-in-stt-tts) for the Whisper.cpp
and Piper walkthroughs.

```ts
interface STTEngine {
  onAudio(pcm: Int16Array): Promise<Int16Array[] | undefined>;
}
interface TTSEngine {
  toSpeech(reply: Int16Array): Promise<Int16Array>;
}

const agent = startVoiceAgent(session, {
  stt: new WhisperSTT(),
  tts: new PiperTTS(),
  autoAccept: true,
});
```

## End-to-end suites

For verifying the stack in your environment (from `calls/`):

```sh
bun test                                             # 170+ offline unit/integration tests
bun e2e/run-tier1.ts                                 # Tier-1 offline lifecycle matrix (~20 s, 10 scenarios)
SESSION_CALLS_NETWORK_TESTS=1 bun e2e/run-tier1.ts   # + networked lifecycle over the live swarm (fresh throwaway accounts)
bun e2e/run-tier2.ts                                 # Tier-2 fault/stress (signaling loss, poll latency, rapid cycling, races)
```

Networked tiers are gated behind `SESSION_CALLS_NETWORK_TESTS=1` (they need
UDP egress to the swarm/TURN and generate fresh accounts by default).
Sanitized JSON reports land in `e2e/reports/<run-id>/` — a committed sample
lives in `e2e/reports-sample/`.

## Writing your own minimal agent

```ts
import { Session, Poller, ready } from "@session.js/client";
import { NetworkNode } from "@session.js/client/network";
import { CallManager, FRAME_MS } from "@session.js/calls";

await ready;
const session = new Session({ network: new NetworkNode() });
session.setMnemonic(process.env.EXAMPLE_MNEMONIC!);
session.addPoller(new Poller({ interval: 3000 }));
console.log("I am", session.sessionID);

const calls = new CallManager(session, {
  logger: (lvl, msg) => console.log(`[${lvl}] ${msg}`),
});

// Auto-accept approved peers and echo their audio back.
calls.on("incoming", (call) => {
  call.onAudio((pcm) => void call.writeAudio(pcm));
  call.on("state", (s) => s === "remote-ring" && void call.accept());
});
calls.on("missed", (m) => console.log("missed:", m));

// Approve a peer, then call them from another terminal:
//   calls.approveContact("05…"); await calls.call("05…");

await new Promise(() => {}); // run forever
```

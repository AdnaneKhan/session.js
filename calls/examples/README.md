# @session.js/calls — examples

> Note: the repo-root `.gitignore` ignores only the ROOT-level `examples`
> sandbox (the pattern is anchored as `/examples`), so files in this
> directory track normally.

Two runnable examples:

| File | What it does | Needs network? |
|---|---|---|
| `offline-echo.ts` | Two CallManagers over an in-process signaling bus, **real werift media** (Opus over loopback ICE). A sends a 440 Hz sine, B's echo pipeline returns it. Proves the full stack round-trips audio. | No |
| `voice-agent.ts` | A voice agent on a real (patched) Session account: auto-answers inbound calls through a pluggable STT→TTS pipeline, or calls a peer and records received audio. | Yes (Session swarm) |

```sh
bun examples/offline-echo.ts          # ~5 s, prints PASS/FAIL

EXAMPLE_MNEMONIC="…" bun examples/voice-agent.ts                # inbound, auto-echo
EXAMPLE_MNEMONIC="…" bun examples/voice-agent.ts --call 05…     # outbound, 3 s sine + record out.pcm
```

`voice-agent.ts` requires the **patched** session.js client (this fork) —
the published `@session.js/client` has no `sendCallMessage`. Without
`EXAMPLE_MNEMONIC` an ephemeral account is generated and printed.

## Audio contract

Everywhere in this package: **48 kHz, mono, 16-bit signed PCM, 20 ms frames
(960 samples / 1920 bytes)** — the Opus native frame size. `writeAudio`
returns `false` under backpressure (bridge queue ≈ 1 s); retry after
~10 ms.

## Plugging in a real STT / TTS

The pipeline is two interfaces (`voice-agent.ts`):

```ts
interface STTEngine {
  // One 20 ms PCM frame in; reply PCM frames out whenever you have
  // something to say (or undefined to stay silent).
  onAudio(pcm: Int16Array): Promise<Int16Array[] | undefined>;
}
interface TTSEngine {
  toSpeech(reply: Int16Array): Promise<Int16Array>;
}
```

The defaults (`EchoStub`, `PassthroughTTS`) echo audio back after 200 ms so
the example works offline. A production pipeline lives entirely inside
`STTEngine.onAudio`:

### Whisper.cpp (STT) + any LLM

```ts
import { spawn } from "node:child_process";

class WhisperSTT implements STTEngine {
  // Spawn whisper-cli in streaming mode ONCE; pipe resampled 16 kHz f32
  // mono PCM in, read transcripts from stdout. Our contract is 48 kHz —
  // resample first (e.g. @audiojs/resample, or soxr):
  //   48k s16 → 16k f32 mono.
  async onAudio(pcm: Int16Array) {
    this.pushToWhisper(resample48kTo16k(pcm));
    const text = this.takeCompletedTranscript();
    if (!text) return undefined;
    const replyText = await myLLM(text);        // any LLM client
    return this.ttsFrames(replyText);           // see TTS below
  }
}
```

whisper.cpp invocation: `whisper-cli -m ggml-base.en.bin -s 16000 -ns -t 4`
(`-s` = stream mode, stdin PCM). Feed it 16 kHz f32 mono chunks; parse
transcript lines from stdout.

### Any TTS (Piper, espeak-ng, cloud TTS…)

Most TTS engines emit WAV/PCM at their own rate — convert to the 48 kHz
s16 mono 960-sample frame contract before returning:

```ts
class PiperTTS {
  // piper -m voice.onnx --output-raw  →  22050 Hz s16 mono
  async synthesize(text: string): Promise<Int16Array[]> {
    const raw = await runPiper(text);            // Int16Array @ 22050 Hz
    const pcm48k = resample(raw, 22050, 48000);  // your resampler
    return chunk(pcm48k, 960);                   // exact 20 ms frames
  }
}
```

Keep `synthesize` chunked into exact 960-sample frames — `writeAudio`
drops nothing but backpressures (`false`) when you outrun the link.

## Limitations (v1)

- No video (remote video toggles surface via `call.onRemoteVideoToggle`,
  informational only).
- One concurrent call per CallManager.
- Contacts-only gating: call `manager.approveContact(peer)` before
  `call()`; inbound calls from unapproved peers are dropped silently
  (Android behavior). `autoApproveOnCall` (default on) sends a
  MessageRequestResponse approval to the callee when you place a call.
- The callee must have voice calls enabled in an official client (opt-in
  beta) or the call times out after 60 s.
- Polling transport: expect ~0.5–3 s signaling latency (poller is boosted
  to 500 ms during calls).

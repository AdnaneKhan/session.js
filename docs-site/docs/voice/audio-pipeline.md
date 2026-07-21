# Audio pipelines

The library is headless by design: no microphone, no speaker. You get raw
PCM in and out, and you decide what to do with it — STT/TTS pipelines,
recording, tone generation, device bridges.

## The PCM contract

**Everywhere in this package — `onAudio`, `writeAudio`, the examples, the
tests:**

| Property | Value |
|---|---|
| Sample rate | **48 kHz** |
| Channels | **mono** |
| Format | **16-bit signed little-endian** (`Int16Array`) |
| Frame size | **20 ms = 960 samples = 1920 bytes** (Opus native frame) |

```ts
call.onAudio((pcm: Int16Array) => {
  // pcm.length === 960, always
});

call.writeAudio(frame); // throws TypeError on any other shape
```

## Pacing & backpressure

There is **no pacing inside the library**. `writeAudio` encodes immediately
and holds frames in a ~1 s queue until the transport is sender-ready.
Real-time pacing is **your** job:

```ts
import { FRAME_MS } from "@session.js/calls"; // 20

for (const frame of mySource) {
  // writeAudio returns false when the ~1 s bridge queue is full —
  // retry the SAME frame after ~10 ms, don't drop it
  while (!call.writeAudio(frame)) {
    await new Promise((r) => setTimeout(r, 10));
  }
  await new Promise((r) => setTimeout(r, FRAME_MS)); // real-time cadence
}
```

Notes:

- Frames written before the media path is sender-ready are queued (up to
  ~1 s), not dropped — but writing a whole file instantly will overflow the
  queue and backpressure.
- Received audio arrives as soon as RTP is decoded; consumption is your
  responsibility (push to an STT engine, a queue, a `.pcm` file…).
- Audio written before DTLS completes is dropped by design (the negotiated
  data channel opening is the readiness gate — ICE "connected" alone is not
  enough).

## DSP helpers

The package exports small DSP utilities used by the tests and handy for
pipelines:

```ts
import { sineFrame, goertzel, toneSnrDb, bestCrossCorrelation } from "@session.js/calls";

sineFrame(index, 440);          // Int16Array — frame #index of a 440 Hz sine
goertzel(pcm, 440);             // single-frequency energy detection
toneSnrDb(a, b);                // tone SNR between two frame buffers
bestCrossCorrelation(a, b);     // alignment/latency estimation
```

## Plugging in STT / TTS

The voice-agent example models the pipeline as two interfaces:

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

A production pipeline lives entirely inside `STTEngine.onAudio`:

### Whisper.cpp (STT) + any LLM

```ts
class WhisperSTT implements STTEngine {
  // Spawn whisper-cli in streaming mode ONCE; pipe resampled 16 kHz f32
  // mono PCM in, read transcripts from stdout. Our contract is 48 kHz —
  // resample first (e.g. @audiojs/resample or soxr): 48k s16 → 16k f32 mono.
  async onAudio(pcm: Int16Array) {
    this.pushToWhisper(resample48kTo16k(pcm));
    const text = this.takeCompletedTranscript();
    if (!text) return undefined;
    const replyText = await myLLM(text);   // any LLM client
    return this.ttsFrames(replyText);      // see TTS below
  }
}
```

whisper.cpp invocation:

```sh
whisper-cli -m ggml-base.en.bin -s 16000 -ns -t 4
```

(`-s` = stream mode, stdin PCM). Feed it 16 kHz f32 mono chunks and parse
transcript lines from stdout.

### Any TTS (Piper, espeak-ng, cloud TTS…)

Most TTS engines emit WAV/PCM at their own rate — convert to the 48 kHz s16
mono 960-sample frame contract before returning:

```ts
class PiperTTS {
  // piper -m voice.onnx --output-raw  →  22050 Hz s16 mono
  async synthesize(text: string): Promise<Int16Array[]> {
    const raw = await runPiper(text);             // Int16Array @ 22050 Hz
    const pcm48k = resample(raw, 22050, 48000);   // your resampler of choice
    return chunk(pcm48k, 960);                    // exact 20 ms frames
  }
}
```

Keep output chunked into **exact 960-sample frames** — `writeAudio` drops
nothing but backpressures (`false`) when you outrun the link.

## Recording & playback bridges

To bridge the headless library to real devices or files, the PCM contract is
all you need:

```ts
// Record a call to a raw PCM file (play with:
//   ffplay -f s16le -ar 48000 -ac 1 call.pcm)
import { createWriteStream } from "node:fs";
const rec = createWriteStream("call.pcm");
call.onAudio((pcm) => rec.write(Buffer.from(pcm.buffer)));

// Stream a decoded file into a call (decode to the contract first:
//   ffmpeg -i in.mp3 -f s16le -ar 48000 -ac 1 out.pcm)
const raw = readFileSync("out.pcm");
for (let off = 0; off + 1920 <= raw.length; off += 1920) {
  const frame = new Int16Array(raw.buffer.slice(off, off + 1920));
  while (!call.writeAudio(frame)) await sleep(10);
  await sleep(FRAME_MS);
}
```

!!! Info "See also"
    - [Examples](./examples.md) — the ready-made voice agent with pluggable
      STT/TTS
    - [API reference](./api-reference.md) — `onAudio` / `writeAudio` details

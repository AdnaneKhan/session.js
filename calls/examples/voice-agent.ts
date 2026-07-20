// SPDX-License-Identifier: AGPL-3.0-or-later
//
// voice-agent.ts — example voice pipeline for @session.js/calls (plan P5-T1).
//
//   Inbound mode (default):  answer every incoming call, run received PCM
//     through a pluggable STT stage and a pluggable TTS stage, speak the
//     result back. Defaults are offline stubs (EchoStub + PassthroughTTS)
//     so the example runs with zero external services — see README.md for
//     plugging in Whisper.cpp / any TTS.
//   Outbound mode (--call 05…):  call a peer, send 3 s of 440 Hz sine,
//     record whatever comes back to examples/out.pcm, hang up.
//
// Runtime requirements: a PATCHED @session.js/client (this fork) providing
// Session.sendCallMessage / setPollInterval / the full `call` event — the
// published 0.0.57 client does NOT carry the call patch. The session is
// duck-typed as SessionLike here, so this file typechecks without the
// client's types (zero compile-time dependency, per src/types.ts design).
//
//   EXAMPLE_MNEMONIC="…" bun examples/voice-agent.ts            # inbound
//   EXAMPLE_MNEMONIC="…" bun examples/voice-agent.ts --call 05… # outbound
//
// Audio contract everywhere: 48 kHz, mono, 16-bit signed PCM, 20 ms frames
// (960 samples / 1920 bytes) — see src/types.ts.

import { writeFileSync } from "node:fs";

import {
	CallManager,
	FRAME_MS,
	sineFrame,
	type Call,
	type CallLogger,
	type SessionLike,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Pluggable pipeline interfaces
// ---------------------------------------------------------------------------

/**
 * Speech-to-understanding stage. Consumes 20 ms PCM frames; returns reply
 * PCM frames to speak whenever it has something to say (or undefined to
 * stay silent). A real integration runs whisper.cpp (or any STT) + an LLM
 * here and produces reply text; see README.md.
 */
export interface STTEngine {
	onAudio(pcm: Int16Array): Promise<Int16Array[] | undefined>;
}

/**
 * Text/plan-to-speech stage. Transforms one reply payload into a speakable
 * frame. The default PassthroughTTS returns the frame unchanged (the reply
 * payload already IS PCM in stub mode).
 */
export interface TTSEngine {
	toSpeech(reply: Int16Array): Promise<Int16Array>;
}

/**
 * EchoStub — offline default STT: buffers incoming PCM and, after 200 ms
 * of accumulation, returns the buffered frames verbatim as the "reply".
 */
export class EchoStub implements STTEngine {
	#buffer: Int16Array[] = [];
	#lastFlush = Date.now();
	readonly flushMs: number;

	constructor(flushMs = 200) {
		this.flushMs = flushMs;
	}

	async onAudio(pcm: Int16Array): Promise<Int16Array[] | undefined> {
		this.#buffer.push(pcm.slice());
		if (Date.now() - this.#lastFlush >= this.flushMs && this.#buffer.length > 0) {
			const reply = this.#buffer;
			this.#buffer = [];
			this.#lastFlush = Date.now();
			return reply;
		}
		return undefined;
	}
}

/** PassthroughTTS — offline default TTS: reply frames pass through as-is. */
export class PassthroughTTS implements TTSEngine {
	async toSpeech(reply: Int16Array): Promise<Int16Array> {
		return reply;
	}
}

/** Wire a call's receive path through the STT → TTS pipeline. */
export function wireVoicePipeline(
	call: Call,
	stt: STTEngine = new EchoStub(),
	tts: TTSEngine = new PassthroughTTS(),
): void {
	call.onAudio((pcm) => {
		void (async () => {
			try {
				const replies = await stt.onAudio(pcm);
				if (!replies) return;
				for (const reply of replies) {
					const frame = await tts.toSpeech(reply);
					call.writeAudio(frame); // backpressure handled by the bridge
				}
			} catch (err) {
				console.error("[voice-agent] pipeline error (contained):", err);
			}
		})();
	});
}

// ---------------------------------------------------------------------------
// Agent wiring
// ---------------------------------------------------------------------------

export interface VoiceAgentOptions {
	stt?: STTEngine;
	tts?: TTSEngine;
	logger?: CallLogger;
	/** Auto-accept inbound calls (default true). */
	autoAccept?: boolean;
}

export interface VoiceAgent {
	manager: CallManager;
	dispose(): Promise<void>;
}

/**
 * Attach a CallManager + voice pipeline to a session.js client instance.
 * The session must be the PATCHED fork client (SessionLike structurally).
 */
export function startVoiceAgent(session: SessionLike, options: VoiceAgentOptions = {}): VoiceAgent {
	const log: CallLogger =
		options.logger ?? ((level, msg) => console.log(`[calls:${level}] ${msg}`));
	const manager = new CallManager(session, { logger: log });

	manager.on("incoming", (call) => {
		log("info", `incoming call from ${call.info.peer} uuid=${call.info.uuid}`);
		wireVoicePipeline(call, options.stt, options.tts);
		if (options.autoAccept ?? true) {
			// accept() is only valid once the OFFER has arrived (remote-ring) —
			// PRE_OFFER rings first, OFFER follows. Accept exactly once. The
			// accept is deferred a microtask: the remote-ring state event fires
			// mid-dispatch, before the supervisor has stored the pending offer.
			let accepted = false;
			const tryAccept = (): void => {
				if (accepted || call.info.state !== "remote-ring") return;
				accepted = true;
				queueMicrotask(() => {
					call.accept().catch((err) => log("error", `accept failed: ${String(err)}`));
				});
			};
			tryAccept(); // OFFER-without-PRE_OFFER case (Desktop-tolerant)
			call.on("state", tryAccept);
		}
		call.on("ended", (info) => {
			log("info", `call ended uuid=${info.uuid} reason=${info.endReason ?? "unknown"}`);
		});
	});
	manager.on("missed", (m) => {
		log("info", `missed call from ${m.peer} reason=${m.reason}`);
	});
	manager.on("error", (e) => {
		log("error", `call error: ${e.error.message}`);
	});

	return {
		manager,
		dispose: () => manager.dispose(),
	};
}

/** Wait (polling) until the call reaches `connected` or `timeoutMs` elapses. */
async function waitConnected(call: Call, timeoutMs = 30_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (call.info.state === "connected") return true;
		if (call.info.state === "disconnected") return false;
		await new Promise((r) => setTimeout(r, 100));
	}
	return false;
}

// ---------------------------------------------------------------------------
// Session bootstrap (dynamic imports — keeps the build free of a compile
// dependency on @session.js/client; a PATCHED fork must satisfy SessionLike
// at runtime).
// ---------------------------------------------------------------------------

async function bootstrapSession(mnemonic: string): Promise<SessionLike> {
	// The published client lacks sendCallMessage — the fork provides it.
	const client = (await import("@session.js/client")) as unknown as {
		Session: new () => SessionLike & {
			setMnemonic(m: string): void;
			addPoller(p: unknown): void;
		};
		Poller: new (opts: { interval: number | null }) => unknown;
	};
	const session = new client.Session();
	session.setMnemonic(mnemonic);
	session.addPoller(new client.Poller({ interval: 500 }));
	return session;
}

async function resolveMnemonic(): Promise<string> {
	const fromEnv = process.env.EXAMPLE_MNEMONIC;
	if (fromEnv) return fromEnv;
	const mnemonic = (await import("@session.js/mnemonic")) as unknown as {
		encode(seedHex: string): string;
	};
	const keypair = (await import("@session.js/keypair")) as unknown as {
		generateSeedHex(): string;
	};
	const generated = mnemonic.encode(keypair.generateSeedHex());
	console.log(`[voice-agent] no EXAMPLE_MNEMONIC set — generated ephemeral account:`);
	console.log(`[voice-agent]   mnemonic:  ${generated}`);
	return generated;
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

async function runInbound(session: SessionLike, agent: VoiceAgent): Promise<void> {
	const id = session.getSessionID();
	console.log(`[voice-agent] inbound mode — listening as ${id}`);
	console.log(`[voice-agent] incoming calls are auto-accepted and echoed (EchoStub/PassthroughTTS)`);
	// Park forever.
	await new Promise(() => undefined);
	void agent;
}

async function runOutbound(session: SessionLike, agent: VoiceAgent, peer: string): Promise<void> {
	console.log(`[voice-agent] outbound mode — calling ${peer}`);
	agent.manager.approveContact(peer);
	const call = await agent.manager.call(peer);
	const received: Int16Array[] = [];
	call.onAudio((pcm) => received.push(pcm.slice()));
	call.on("ended", (info) => {
		console.log(`[voice-agent] call ended: ${info.endReason ?? "unknown"}`);
	});

	if (!(await waitConnected(call))) {
		console.error(`[voice-agent] call did not connect (state=${call.info.state})`);
		await agent.dispose();
		process.exitCode = 1;
		return;
	}
	console.log(`[voice-agent] connected — sending 3 s of 440 Hz sine`);
	const frames = 3000 / FRAME_MS; // 150 × 20 ms
	for (let i = 0; i < frames; i++) {
		while (!call.writeAudio(sineFrame(i))) {
			await new Promise((r) => setTimeout(r, FRAME_MS / 2)); // backpressure
		}
		await new Promise((r) => setTimeout(r, FRAME_MS));
	}
	// Record a bit of whatever comes back.
	await new Promise((r) => setTimeout(r, 2000));
	const total = received.reduce((n, f) => n + f.length, 0);
	const out = new Int16Array(total);
	let offset = 0;
	for (const frame of received) {
		out.set(frame, offset);
		offset += frame.length;
	}
	const outPath = new URL("out.pcm", import.meta.url);
	writeFileSync(outPath, Buffer.from(out.buffer));
	console.log(
		`[voice-agent] recorded ${received.length} frames (${total} samples) → ${outPath.pathname}`,
	);
	await call.hangup().catch(() => undefined);
	await agent.dispose();
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const callIdx = args.indexOf("--call");
	const peer = callIdx >= 0 ? args[callIdx + 1] : undefined;

	const mnemonic = await resolveMnemonic();
	const session = await bootstrapSession(mnemonic);
	const agent = startVoiceAgent(session);

	if (peer) {
		await runOutbound(session, agent, peer);
		// werift may keep the event loop alive after teardown; outbound mode is
		// a finite script — exit explicitly with the recorded verdict.
		process.exit(process.exitCode ?? 0);
	} else {
		await runInbound(session, agent);
	}
}

// Run when executed directly (bun examples/voice-agent.ts); importing this
// module for the exported interfaces/stubs does not start anything.
if (import.meta.main) {
	main().catch((err) => {
		console.error("[voice-agent] fatal:", err);
		process.exitCode = 1;
	});
}

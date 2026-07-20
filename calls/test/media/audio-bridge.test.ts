// SPDX-License-Identifier: AGPL-3.0-or-later
// P4-T2 verification: AudioBridge over loopback PeerConnectionManager
// sessions (frame contract, tone integrity, format guards, backpressure,
// rechunking with a fake codec). Offline — host/loopback ICE only.

import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { MediaStreamTrack, RtpHeader, RtpPacket } from "werift";

import { AudioBridge, MAX_QUEUED_FRAMES } from "../../src/media/audio-bridge.js";
import type { Codec } from "../../src/media/codec.js";
import { FRAME_SAMPLES, SAMPLE_RATE, sineFrame, toneSnrDb } from "../../src/media/dsp.js";
import {
	PeerConnectionManager,
	WeriftMediaSession,
} from "../../src/media/peer-connection.js";
import type { IceServer } from "../../src/types.js";

const NO_SERVERS: { iceServers: IceServer[]; iceTransportPolicy: "all" | "relay" } = {
	iceServers: [],
	iceTransportPolicy: "all",
};

async function connectPair(): Promise<{ caller: WeriftMediaSession; callee: WeriftMediaSession }> {
	const manager = new PeerConnectionManager();
	const caller = manager.createSession(randomUUID(), "caller", NO_SERVERS) as WeriftMediaSession;
	const callee = manager.createSession(randomUUID(), "callee", NO_SERVERS) as WeriftMediaSession;
	caller.onLocalCandidate((c) => void callee.addRemoteCandidate(c));
	callee.onLocalCandidate((c) => void caller.addRemoteCandidate(c));
	const waitConnected = (s: WeriftMediaSession): Promise<void> =>
		new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("connect timeout")), 15_000);
			s.onConnectionState((st) => {
				if (st === "connected") {
					clearTimeout(timer);
					resolve();
				} else if (st === "failed") {
					clearTimeout(timer);
					reject(new Error("failed"));
				}
			});
		});
	const both = Promise.all([waitConnected(caller), waitConnected(callee)]);
	const offer = await caller.createOffer();
	await callee.setRemoteOffer(offer);
	const answer = await callee.createAnswer();
	await caller.setRemoteAnswer(answer);
	await both;
	return { caller, callee };
}

async function waitDelivered(session: WeriftMediaSession, frames: number, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (session.audioBridge.deliveredFrames < frames) {
		if (Date.now() > deadline) {
			throw new Error(
				`timeout: delivered ${session.audioBridge.deliveredFrames}/${frames} frames`,
			);
		}
		await new Promise((r) => setTimeout(r, 50));
	}
}

describe("loopback audio", () => {
	test("caller writeAudio sine frames → callee onAudio: 960-len frames, ≤10% loss, 440 Hz present", async () => {
		const { caller, callee } = await connectPair();

		const N = 50; // 1 s of audio
		const received: Int16Array[] = [];
		callee.onAudio((pcm) => received.push(pcm));

		// Connected → sender ready → queue drains into the werift sender.
		for (let i = 0; i < N; i++) {
			expect(caller.writeAudio(sineFrame(i, 440))).toBe(true);
		}

		await waitDelivered(callee, Math.ceil(N * 0.9));

		// Frame contract: every delivered frame is exactly 960 samples.
		expect(received.length).toBeGreaterThanOrEqual(Math.ceil(N * 0.9));
		expect(received.length).toBeLessThanOrEqual(N);
		for (const frame of received) {
			expect(frame).toBeInstanceOf(Int16Array);
			expect(frame.length).toBe(FRAME_SAMPLES);
		}
		const loss = 1 - received.length / N;
		expect(loss).toBeLessThanOrEqual(0.1);

		// Tone integrity: clear 440 Hz peak in the concatenated PCM.
		const total = received.reduce((a, f) => a + f.length, 0);
		const stream = new Int16Array(total);
		let off = 0;
		for (const f of received) {
			stream.set(f, off);
			off += f.length;
		}
		const snr = toneSnrDb(stream, 440, SAMPLE_RATE);
		expect(snr).toBeGreaterThan(20);

		caller.close();
		callee.close();
	}, 60_000);

	test("frames written before connection are queued and delivered after", async () => {
		const manager = new PeerConnectionManager();
		const caller = manager.createSession(randomUUID(), "caller", NO_SERVERS) as WeriftMediaSession;
		const callee = manager.createSession(randomUUID(), "callee", NO_SERVERS) as WeriftMediaSession;
		caller.onLocalCandidate((c) => void callee.addRemoteCandidate(c));
		callee.onLocalCandidate((c) => void caller.addRemoteCandidate(c));

		const received: Int16Array[] = [];
		callee.onAudio((pcm) => received.push(pcm));

		// 10 frames into the void — held by the bounded queue, not dropped.
		for (let i = 0; i < 10; i++) {
			expect(caller.writeAudio(sineFrame(i, 440))).toBe(true);
		}
		expect(caller.audioBridge.queuedFrames).toBe(10);

		const waitConnected = (s: WeriftMediaSession): Promise<void> =>
			new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("connect timeout")), 15_000);
				s.onConnectionState((st) => {
					if (st === "connected") {
						clearTimeout(timer);
						resolve();
					} else if (st === "failed") {
						clearTimeout(timer);
						reject(new Error("failed"));
					}
				});
			});
		const both = Promise.all([waitConnected(caller), waitConnected(callee)]);
		const offer = await caller.createOffer();
		await callee.setRemoteOffer(offer);
		const answer = await callee.createAnswer();
		await caller.setRemoteAnswer(answer);
		await both;

		await waitDelivered(callee, 10);
		expect(received.length).toBeGreaterThanOrEqual(10);
		expect(caller.audioBridge.queuedFrames).toBe(0);

		caller.close();
		callee.close();
	}, 60_000);
});

describe("format guards", () => {
	const makeBridge = (): AudioBridge => new AudioBridge(new MediaStreamTrack({ kind: "audio" }));

	test("writeAudio rejects non-Int16Array inputs with TypeError", () => {
		const bridge = makeBridge();
		expect(() => bridge.writeAudio(new Float32Array(FRAME_SAMPLES))).toThrow(TypeError);
		expect(() => bridge.writeAudio(new Uint8Array(FRAME_SAMPLES * 2) as never)).toThrow(TypeError);
		expect(() => bridge.writeAudio(new Array(FRAME_SAMPLES).fill(0) as never)).toThrow(TypeError);
		expect(() => bridge.writeAudio(null as never)).toThrow(TypeError);
	});

	test("writeAudio rejects wrong frame sizes with TypeError", () => {
		const bridge = makeBridge();
		expect(() => bridge.writeAudio(new Int16Array(480))).toThrow(/960/);
		expect(() => bridge.writeAudio(new Int16Array(1920))).toThrow(/960/);
		expect(() => bridge.writeAudio(new Int16Array(0))).toThrow(TypeError);
	});

	test("writeAudio accepts exactly 960-sample Int16Array", () => {
		const bridge = makeBridge();
		expect(bridge.writeAudio(new Int16Array(FRAME_SAMPLES))).toBe(true);
		bridge.close();
		expect(bridge.writeAudio(new Int16Array(FRAME_SAMPLES))).toBe(false); // closed
	});
});

describe("backpressure", () => {
	test("saturated queue returns false and counts drops (bound documented)", () => {
		expect(MAX_QUEUED_FRAMES).toBe(50); // 50 × 20 ms = 1 s — documented bound
		const bridge = new AudioBridge(new MediaStreamTrack({ kind: "audio" }), { maxQueuedFrames: 5 });
		for (let i = 0; i < 5; i++) {
			expect(bridge.writeAudio(new Int16Array(FRAME_SAMPLES))).toBe(true);
		}
		expect(bridge.queuedFrames).toBe(5);
		// Not ready → queue holds → 6th frame rejected.
		expect(bridge.writeAudio(new Int16Array(FRAME_SAMPLES))).toBe(false);
		expect(bridge.droppedFrames).toBe(1);
		expect(bridge.writeAudio(new Int16Array(FRAME_SAMPLES))).toBe(false);
		expect(bridge.droppedFrames).toBe(2);
		bridge.close();
	});

	test("default session bound: 50 queued, 51st rejected", () => {
		const manager = new PeerConnectionManager();
		const session = manager.createSession(randomUUID(), "caller", NO_SERVERS);
		for (let i = 0; i < MAX_QUEUED_FRAMES; i++) {
			expect(session.writeAudio(new Int16Array(FRAME_SAMPLES))).toBe(true);
		}
		expect(session.writeAudio(new Int16Array(FRAME_SAMPLES))).toBe(false);
		session.close();
	});

	test("queue drains once the sender becomes ready", async () => {
		const bridge = new AudioBridge(new MediaStreamTrack({ kind: "audio" }), { maxQueuedFrames: 5 });
		for (let i = 0; i < 5; i++) {
			bridge.writeAudio(new Int16Array(FRAME_SAMPLES));
		}
		expect(bridge.queuedFrames).toBe(5);
		bridge.setSenderReady(true);
		await new Promise((r) => setTimeout(r, 50)); // microtask drain
		expect(bridge.queuedFrames).toBe(0);
		expect(bridge.writeAudio(new Int16Array(FRAME_SAMPLES))).toBe(true);
		bridge.close();
	});
});

describe("receive rechunking (fake codec)", () => {
	/** Codec whose decode returns a configurable frame size. */
	const fakeCodec = (decodeSize: number): Codec => ({
		name: "fake",
		encode: () => new Uint8Array([0]),
		decode: () => new Int16Array(decodeSize),
	});

	const pump = (bridge: AudioBridge, track: MediaStreamTrack, packets: number): void => {
		for (let i = 0; i < packets; i++) {
			track.onReceiveRtp.execute(new RtpPacket(new RtpHeader(), Buffer.from([0xf8, 0xff, 0xfe])));
		}
	};

	test("undersized decoded chunks are joined into exact 960 frames", () => {
		const track = new MediaStreamTrack({ kind: "audio", remote: true });
		const bridge = new AudioBridge(new MediaStreamTrack({ kind: "audio" }), { codec: fakeCodec(480) });
		const frames: Int16Array[] = [];
		bridge.onAudio((pcm) => frames.push(pcm));
		bridge.attachRemoteTrack(track);
		pump(bridge, track, 3); // 3 × 480 = 1440 samples → exactly one 960 frame
		expect(frames.length).toBe(1);
		expect(frames[0]?.length).toBe(FRAME_SAMPLES);
		bridge.close();
	});

	test("oversized decoded chunks are split with residue carried over", () => {
		const track = new MediaStreamTrack({ kind: "audio", remote: true });
		const bridge = new AudioBridge(new MediaStreamTrack({ kind: "audio" }), { codec: fakeCodec(1200) });
		const frames: Int16Array[] = [];
		bridge.onAudio((pcm) => frames.push(pcm));
		bridge.attachRemoteTrack(track);
		pump(bridge, track, 2); // 2400 samples → two 960 frames, residue 480
		expect(frames.length).toBe(2);
		expect(frames.every((f) => f.length === FRAME_SAMPLES)).toBe(true);
		bridge.close();
	});

	test("standard 960-sized decodes pass straight through", () => {
		const track = new MediaStreamTrack({ kind: "audio", remote: true });
		const bridge = new AudioBridge(new MediaStreamTrack({ kind: "audio" }), { codec: fakeCodec(960) });
		const frames: Int16Array[] = [];
		bridge.onAudio((pcm) => frames.push(pcm));
		bridge.attachRemoteTrack(track);
		pump(bridge, track, 7);
		expect(frames.length).toBe(7);
		expect(bridge.deliveredFrames).toBe(7);
		bridge.close();
	});

	test("a throwing onAudio subscriber does not break delivery to others", () => {
		const track = new MediaStreamTrack({ kind: "audio", remote: true });
		const bridge = new AudioBridge(new MediaStreamTrack({ kind: "audio" }), { codec: fakeCodec(960) });
		const good: Int16Array[] = [];
		bridge.onAudio(() => {
			throw new Error("broken consumer");
		});
		bridge.onAudio((pcm) => good.push(pcm));
		bridge.attachRemoteTrack(track);
		pump(bridge, track, 4);
		expect(good.length).toBe(4);
		bridge.close();
	});

	test("decode failures are dropped, not fatal (throwing codec)", () => {
		const track = new MediaStreamTrack({ kind: "audio", remote: true });
		const throwing: Codec = {
			name: "throwing",
			encode: () => new Uint8Array([0]),
			decode: () => {
				throw new Error("corrupt packet");
			},
		};
		const bridge = new AudioBridge(new MediaStreamTrack({ kind: "audio" }), { codec: throwing });
		const frames: Int16Array[] = [];
		bridge.onAudio((pcm) => frames.push(pcm));
		bridge.attachRemoteTrack(track);
		// Must not throw out of the receive path.
		track.onReceiveRtp.execute(new RtpPacket(new RtpHeader(), Buffer.from("garbage")));
		track.onReceiveRtp.execute(new RtpPacket(new RtpHeader(), Buffer.from("more garbage")));
		expect(frames.length).toBe(0); // both dropped silently
		expect(bridge.deliveredFrames).toBe(0);
		bridge.close();
	});

	test("real opus is robust: garbage payloads decode to (noisy) frames, never crash", () => {
		// Opus decoders conceal errors by design — garbage usually decodes
		// to *something* rather than failing. Assert only survival here.
		const track = new MediaStreamTrack({ kind: "audio", remote: true });
		const bridge = new AudioBridge(new MediaStreamTrack({ kind: "audio" }));
		const frames: Int16Array[] = [];
		bridge.onAudio((pcm) => frames.push(pcm));
		bridge.attachRemoteTrack(track);
		track.onReceiveRtp.execute(new RtpPacket(new RtpHeader(), Buffer.from("not opus at all")));
		track.onReceiveRtp.execute(new RtpPacket(new RtpHeader(), Buffer.alloc(0)));
		for (const f of frames) {
			expect(f.length).toBe(FRAME_SAMPLES);
		}
		bridge.close();
	});
});

// SPDX-License-Identifier: AGPL-3.0-or-later
//
// P3-T1 spike (DECISION GATE evidence) — werift loopback Opus audio round-trip.
//
// Two werift RTCPeerConnections in ONE process, connected via host/loopback
// ICE candidates only (iceServers: [] — NO external network). The caller
// writes 5 s of synthetic 440 Hz sine PCM (48 kHz mono Int16, 960-sample
// frames paced at 20 ms) through the full pipeline:
//
//   PCM → @discordjs/opus encode → RtpPacket → track.writeRtp → werift
//   ICE/DTLS-SRTP → callee remote track onReceiveRtp → opus decode → PCM
//   → (echo) encode → writeRtp → … → caller decode → verify.
//
// Pass criteria: a clear 440 Hz peak in the echo (Goertzel tone-SNR > 20 dB),
// normalized cross-correlation with the sent sine > 0.5, and ≤ 10 % frame
// loss each way over loopback. Prints a metrics summary and exits 0 on pass.
//
// Run: cd calls && bun spike/werift-loopback.ts    (primary for the spike)
//      cd calls && node spike/werift-loopback.ts    (Node ≥ 23 strips TS)
//
// API intel captured here feeds P4-T1/P4-T2 — see calls/docs/evidence/P3-T1.md.

import {
	MediaStreamTrack,
	RTCPeerConnection,
	RtpHeader,
	RtpPacket,
} from "werift";

import { createDefaultCodec } from "../src/media/codec.ts";
import {
	bestCrossCorrelation,
	FRAME_SAMPLES,
	SAMPLE_RATE,
	sineFrame,
	toneSnrDb,
} from "../src/media/dsp.ts";

const FREQ = 440;
const DURATION_S = 5;
const TOTAL_FRAMES = (DURATION_S * 1000) / 20; // 250 frames
const CONNECT_TIMEOUT_MS = 15_000;
const HARD_TIMEOUT_MS = 60_000;
const DRAIN_MS = 2_000; // keep receiving after the sender finishes

function runtimeName(): string {
	return typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"
		? `bun ${((globalThis as { Bun?: { version?: string } }).Bun?.version ?? "?")}`
		: `node ${process.version}`;
}

/** Per-track RTP writer state: 20 ms frames, 960 samples per timestamp tick. */
class RtpWriter {
	#seq = Math.floor(Math.random() * 0xffff);
	#timestamp = Math.floor(Math.random() * 0xffffffff);
	#first = true;
	readonly track: MediaStreamTrack;
	constructor(track: MediaStreamTrack) {
		this.track = track;
	}
	write(opusPacket: Uint8Array): void {
		const header = new RtpHeader({
			sequenceNumber: this.#seq,
			timestamp: this.#timestamp,
			marker: this.#first,
			payloadType: 111, // overwritten by werift's sender with the negotiated PT
		});
		this.#first = false;
		this.#seq = (this.#seq + 1) & 0xffff;
		this.#timestamp = (this.#timestamp + FRAME_SAMPLES) >>> 0;
		this.track.writeRtp(new RtpPacket(header, Buffer.from(opusPacket)));
	}
}

function concatInt16(chunks: Int16Array[]): Int16Array {
	let total = 0;
	for (const c of chunks) {
		total += c.length;
	}
	const out = new Int16Array(total);
	let offset = 0;
	for (const c of chunks) {
		out.set(c, offset);
		offset += c.length;
	}
	return out;
}

async function main(): Promise<number> {
	const t0 = Date.now();
	// One codec per peer — mirrors real deployments (two processes/engines).
	// CRITICAL (P3-T1 finding): a libopus encoder is stateful; sharing ONE
	// encoder between two interleaved PCM streams (here: caller's sine and
	// the callee's decoded echo of it) wrecks its prediction state and
	// collapses output quality (~−4 dB measured). One encoder per send
	// stream is mandatory — AudioBridge satisfies this by construction
	// (one encode path per session).
	const callerCodec = createDefaultCodec();
	const calleeCodec = createDefaultCodec();
	console.log(`runtime=${runtimeName()} codec=${callerCodec.name} werift=0.23.0`);

	const iceConfig = {
		iceServers: [], // loopback only — no STUN/TURN, no external network
		iceAdditionalHostAddresses: ["127.0.0.1"],
		bundlePolicy: "max-bundle" as const,
	};
	const callerPc = new RTCPeerConnection(iceConfig);
	const calleePc = new RTCPeerConnection(iceConfig);

	// Local (send) tracks.
	const callerTrack = new MediaStreamTrack({ kind: "audio" });
	callerPc.addTransceiver(callerTrack, { direction: "sendrecv" });
	const calleeTrack = new MediaStreamTrack({ kind: "audio" });
	calleePc.addTransceiver(calleeTrack, { direction: "sendrecv" });

	// Remote tracks arrive via onTrack once the remote description is set.
	const callerRemoteTrack = new Promise<MediaStreamTrack>((resolve) => {
		callerPc.onTrack.once((track) => resolve(track));
	});
	const calleeRemoteTrack = new Promise<MediaStreamTrack>((resolve) => {
		calleePc.onTrack.once((track) => resolve(track));
	});

	// Trickle ICE both ways. Candidates may fire before the remote description
	// is set — buffer and flush (mirrors what the supervisor's ICE batching
	// does with the `readyForIce` gate, plan §3.2).
	type Cand = { candidate: string; sdpMLineIndex?: number; sdpMid?: string };
	const wireCandidates = (
		from: RTCPeerConnection,
		to: RTCPeerConnection,
		dump: string[],
	): void => {
		const pending: Cand[] = [];
		let ready = false;
		const flush = async (): Promise<void> => {
			while (ready && pending.length > 0) {
				const c = pending.shift() as Cand;
				try {
					await to.addIceCandidate(c as never);
				} catch (err) {
					console.log(`addIceCandidate error: ${String(err)}`);
				}
			}
		};
		from.onIceCandidate.subscribe((cand) => {
			if (cand === undefined) {
				return; // end of gathering
			}
			dump.push(cand.candidate ?? "");
			pending.push({
				candidate: cand.candidate ?? "",
				sdpMLineIndex: cand.sdpMLineIndex ?? undefined,
				sdpMid: cand.sdpMid ?? undefined,
			});
			void flush();
		});
		// Expose the "remote description set" gate via closure.
		(from as unknown as { __armCandidates?: () => void }).__armCandidates = () => {
			ready = true;
			void flush();
		};
	};
	const callerCands: string[] = [];
	const calleeCands: string[] = [];
	wireCandidates(callerPc, calleePc, callerCands);
	wireCandidates(calleePc, callerPc, calleeCands);

	// Offer / answer exchange.
	const offer = await callerPc.createOffer();
	await callerPc.setLocalDescription(offer);
	(callerPc as unknown as { __armCandidates: () => void }).__armCandidates?.();
	await calleePc.setRemoteDescription(offer);
	(calleePc as unknown as { __armCandidates: () => void }).__armCandidates?.();
	const answer = await calleePc.createAnswer();
	await calleePc.setLocalDescription(answer);
	await callerPc.setRemoteDescription(answer);

	// Wait for ICE to connect on both sides.
	await Promise.all([
		waitIceConnected(callerPc, "caller"),
		waitIceConnected(calleePc, "callee"),
	]);
	const connectMs = Date.now() - t0;
	console.log(`ICE connected both sides in ${connectMs} ms`);

	const callerRemote = await callerRemoteTrack;
	const calleeRemote = await calleeRemoteTrack;

	// Callee: decode inbound frames, record, echo them back.
	const calleeDecoded: Int16Array[] = [];
	const calleeWriter = new RtpWriter(calleeTrack);
	const calleeSub = calleeRemote.onReceiveRtp.subscribe((rtp) => {
		try {
			const pcm = calleeCodec.decode(rtp.payload);
			calleeDecoded.push(pcm);
			if (pcm.length === FRAME_SAMPLES) {
				calleeWriter.write(calleeCodec.encode(pcm));
			} else {
				console.log(`callee: unexpected decoded size ${pcm.length}, not echoed`);
			}
		} catch (err) {
			console.log(`callee decode/echo error: ${String(err)}`);
		}
	});

	// Caller: record the returning echo.
	const echoFrames: Int16Array[] = [];
	const callerSub = callerRemote.onReceiveRtp.subscribe((rtp) => {
		try {
			echoFrames.push(callerCodec.decode(rtp.payload));
		} catch (err) {
			console.log(`caller decode error: ${String(err)}`);
		}
	});

	// Caller: pace TOTAL_FRAMES sine frames at 20 ms.
	const sent = concatInt16(
		Array.from({ length: TOTAL_FRAMES }, (_, i) => sineFrame(i, FREQ)),
	);
	const callerWriter = new RtpWriter(callerTrack);
	const sendDone = new Promise<void>((resolve) => {
		let i = 0;
		const timer = setInterval(() => {
			if (i >= TOTAL_FRAMES) {
				clearInterval(timer);
				resolve();
				return;
			}
			callerWriter.write(callerCodec.encode(sineFrame(i, FREQ)));
			i++;
		}, 20);
	});
	await sendDone;
	const sendMs = Date.now() - t0 - connectMs;
	await sleep(DRAIN_MS);

	callerSub.unSubscribe();
	calleeSub.unSubscribe();

	// --- Metrics -----------------------------------------------------------
	const calleeStream = concatInt16(calleeDecoded);
	const echoStream = concatInt16(echoFrames);

	const calleeSnr = toneSnrDb(calleeStream, FREQ, SAMPLE_RATE);
	const echoSnr = toneSnrDb(echoStream, FREQ, SAMPLE_RATE);
	const xcorr = bestCrossCorrelation(echoStream, sent.subarray(0, SAMPLE_RATE), 4_800);
	const oneWayLoss = 1 - calleeDecoded.length / TOTAL_FRAMES;
	const roundTripLoss = 1 - echoFrames.length / TOTAL_FRAMES;
	const elapsed = Date.now() - t0;

	console.log("=== P3-T1 werift loopback spike metrics ===");
	console.log(`runtime:                ${runtimeName()}`);
	console.log(`werift:                 0.23.0 (pinned)`);
	console.log(`codec:                  ${callerCodec.name} (@discordjs/opus)`);
	console.log(`connect time:           ${connectMs} ms`);
	console.log(`send duration:          ${sendMs} ms (${TOTAL_FRAMES} frames @ 20 ms)`);
	console.log(`frames sent:            ${TOTAL_FRAMES}`);
	console.log(
		`callee received frames: ${calleeDecoded.length} (loss ${(oneWayLoss * 100).toFixed(1)} %)`,
	);
	console.log(
		`echo frames at caller:  ${echoFrames.length} (loss ${(roundTripLoss * 100).toFixed(1)} %)`,
	);
	console.log(`callee samples decoded: ${calleeStream.length}`);
	console.log(`echo samples decoded:   ${echoStream.length}`);
	console.log(`tone SNR one-way:       ${fmtDb(calleeSnr)}`);
	console.log(`tone SNR round-trip:    ${fmtDb(echoSnr)}`);
	console.log(
		`cross-correlation:      ${xcorr.coefficient.toFixed(4)} @ lag ${xcorr.lag} samples`,
	);
	console.log(`elapsed:                ${elapsed} ms`);
	console.log(`ICE candidates caller:  ${callerCands.length} callee: ${calleeCands.length}`);

	const pass =
		echoSnr > 20 &&
		calleeSnr > 20 &&
		Math.abs(xcorr.coefficient) > 0.5 &&
		oneWayLoss <= 0.1 &&
		roundTripLoss <= 0.1;
	console.log(pass ? "RESULT: PASS" : "RESULT: FAIL");

	await callerPc.close();
	await calleePc.close();
	return pass ? 0 : 1;
}

function waitIceConnected(pc: RTCPeerConnection, label: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error(`${label}: ICE connect timeout`));
		}, CONNECT_TIMEOUT_MS);
		const check = (): void => {
			const s = pc.iceConnectionState;
			if (s === "connected" || s === "completed") {
				clearTimeout(timer);
				sub.unSubscribe();
				resolve();
			} else if (s === "failed" || s === "closed") {
				clearTimeout(timer);
				sub.unSubscribe();
				reject(new Error(`${label}: ICE ${s}`));
			}
		};
		const sub = pc.iceConnectionStateChange.subscribe(() => check());
		check();
	});
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function fmtDb(v: number): string {
	return Number.isFinite(v) ? `${v.toFixed(1)} dB` : "-inf dB";
}

const hardTimer = setTimeout(() => {
	console.log("HARD TIMEOUT — aborting");
	process.exit(2);
}, HARD_TIMEOUT_MS);

main()
	.then((code) => {
		clearTimeout(hardTimer);
		process.exit(code);
	})
	.catch((err) => {
		console.error("SPIKE ERROR:", err);
		process.exit(1);
	});

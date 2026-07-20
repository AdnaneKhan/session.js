// SPDX-License-Identifier: AGPL-3.0-or-later
//
// AudioBridge — PCM↔werift-track media bridge (plan §4.3 audio contract,
// §4.7, P4-T2). Written fresh, built on the P3-T1-validated werift APIs:
//
//   send: PCM 960-frame → Codec.encode → RtpPacket(seq++, ts += 960) →
//         localTrack.writeRtp (werift's sender fixes ssrc + payload type)
//   recv: remoteTrack.onReceiveRtp → rtp.payload (raw Opus packet) →
//         Codec.decode → rechunk to exactly 960-sample frames → onAudio
//
// No device I/O, no VAD/AGC/NS — raw decoded PCM per plan §4.7. Jitter and
// reordering are tolerated by the rechunk buffer; loss shows up as dropped
// frames (documented: loopback measures ≤ 2 % startup loss, steady-state 0).
//
// Backpressure (plan §4.3 `writeAudio` contract): encoded frames queue in a
// bounded FIFO until the sender is ready (ICE/DTLS up — PeerConnectionManager
// calls setSenderReady on "connected"). When the queue is full, writeAudio
// returns false and the frame is dropped; the producer (agent TTS pipeline)
// decides how to handle that (skip / pace / abort). Bound: 50 frames = 1 s
// of audio by default (MAX_QUEUED_FRAMES).

import { RtpHeader, RtpPacket, type MediaStreamTrack } from "werift";

import { type Codec, createDefaultCodec } from "./codec.js";
import { FRAME_SAMPLES } from "./dsp.js";

/** Backpressure bound: frames of encoded audio held before dropping. */
export const MAX_QUEUED_FRAMES = 50; // 50 × 20 ms = 1 s

export interface AudioBridgeOptions {
	/** PCM↔Opus codec; default createDefaultCodec() (D3 primary). */
	codec?: Codec;
	/** Send-queue backpressure bound in 20 ms frames; default 50 (= 1 s). */
	maxQueuedFrames?: number;
}

export class AudioBridge {
	readonly #localTrack: MediaStreamTrack;
	readonly #codec: Codec;
	readonly #maxQueuedFrames: number;
	#audioSubscribers: Array<(pcm: Int16Array) => void> = [];
	#sendQueue: Uint8Array[] = [];
	#drainScheduled = false;
	#ready = false;
	#closed = false;
	#seq = Math.floor(Math.random() * 0x10000);
	#timestamp = Math.floor(Math.random() * 0x100000000);
	#firstPacket = true;
	#remoteSub: { unSubscribe(): void } | undefined;
	/** Rechunk residue for decoded frames that are not exactly 960 samples. */
	#residue: Int16Array = new Int16Array(0);
	/** Diagnostics: frames dropped by backpressure. */
	droppedFrames = 0;
	/** Diagnostics: frames delivered to onAudio subscribers. */
	deliveredFrames = 0;

	constructor(localTrack: MediaStreamTrack, opts?: AudioBridgeOptions) {
		this.#localTrack = localTrack;
		this.#codec = opts?.codec ?? createDefaultCodec();
		this.#maxQueuedFrames = opts?.maxQueuedFrames ?? MAX_QUEUED_FRAMES;
	}

	/** The codec in use (diagnostics/tests). */
	get codecName(): string {
		return this.#codec.name;
	}

	/** Number of encoded frames currently queued for send. */
	get queuedFrames(): number {
		return this.#sendQueue.length;
	}

	/**
	 * Queue one outbound audio frame.
	 *
	 * Contract (plan §4.3): 48 kHz mono Int16 PCM, exactly 960 samples.
	 * @throws TypeError on non-Int16Array input or wrong frame size.
	 * @returns false when closed or the send queue is saturated
	 *          (backpressure — frame dropped); true otherwise.
	 */
	writeAudio(pcm: Int16Array): boolean {
		if (!(pcm instanceof Int16Array)) {
			throw new TypeError(
				`writeAudio expects an Int16Array (48 kHz mono PCM), got ${
					pcm === null ? "null" : (pcm as { constructor?: { name?: string } })?.constructor?.name ?? typeof pcm
				}`,
			);
		}
		if (pcm.length !== FRAME_SAMPLES) {
			throw new TypeError(
				`writeAudio expects ${FRAME_SAMPLES}-sample frames (20 ms @ 48 kHz), got ${pcm.length}`,
			);
		}
		if (this.#closed) {
			return false;
		}
		if (this.#sendQueue.length >= this.#maxQueuedFrames) {
			this.droppedFrames++;
			return false;
		}
		this.#sendQueue.push(this.#codec.encode(pcm));
		this.#scheduleDrain();
		return true;
	}

	/**
	 * Subscribe to inbound decoded audio: exactly 960-sample Int16Array
	 * frames, 48 kHz mono. Multiple subscribers all receive every frame.
	 */
	onAudio(cb: (pcm: Int16Array) => void): void {
		this.#audioSubscribers.push(cb);
	}

	/**
	 * Wire the receive path to the session's remote track. Called by
	 * PeerConnectionManager when werift's onTrack fires (and re-wired if
	 * the remote track changes, e.g. renegotiation).
	 */
	attachRemoteTrack(track: MediaStreamTrack): void {
		this.#remoteSub?.unSubscribe();
		this.#residue = new Int16Array(0);
		this.#remoteSub = track.onReceiveRtp.subscribe((rtp) => {
			let pcm: Int16Array;
			try {
				pcm = this.#codec.decode(rtp.payload);
			} catch {
				return; // corrupt/undecodable packet → drop (loss, not crash)
			}
			this.#deliver(pcm);
		});
	}

	/**
	 * Sender readiness gate. Before ready, encoded frames accumulate in the
	 * bounded queue (backpressure visible to writeAudio); on ready, the
	 * queue drains into the werift sender immediately.
	 */
	setSenderReady(ready: boolean): void {
		this.#ready = ready;
		if (ready && this.#sendQueue.length > 0) {
			this.#scheduleDrain();
		}
	}

	/** Idempotent teardown: stops receive, drops the queue, keeps callbacks. */
	close(): void {
		this.#closed = true;
		this.#sendQueue = [];
		this.#remoteSub?.unSubscribe();
		this.#remoteSub = undefined;
		this.#residue = new Int16Array(0);
	}

	#scheduleDrain(): void {
		if (this.#drainScheduled || this.#closed) {
			return;
		}
		this.#drainScheduled = true;
		queueMicrotask(() => {
			this.#drainScheduled = false;
			this.#drain();
		});
	}

	#drain(): void {
		if (this.#closed || !this.#ready) {
			return; // hold the (bounded) queue until ready
		}
		while (this.#sendQueue.length > 0) {
			const packet = this.#sendQueue.shift() as Uint8Array;
			const header = new RtpHeader({
				sequenceNumber: this.#seq,
				timestamp: this.#timestamp,
				marker: this.#firstPacket,
				// payloadType/ssrc are overwritten by werift's sender with
				// the negotiated values (P3-T1 finding) — 111 is a
				// conventional opus dynamic-PT placeholder only.
				payloadType: 111,
			});
			this.#firstPacket = false;
			this.#seq = (this.#seq + 1) & 0xffff;
			this.#timestamp = (this.#timestamp + FRAME_SAMPLES) >>> 0;
			this.#localTrack.writeRtp(new RtpPacket(header, Buffer.from(packet)));
		}
	}

	/** Rechunk decoded PCM into exactly FRAME_SAMPLES-sized frames. */
	#deliver(pcm: Int16Array): void {
		if (this.#closed || this.#audioSubscribers.length === 0) {
			return;
		}
		let input = pcm;
		if (this.#residue.length > 0) {
			input = new Int16Array(this.#residue.length + pcm.length);
			input.set(this.#residue, 0);
			input.set(pcm, this.#residue.length);
			this.#residue = new Int16Array(0);
		}
		let offset = 0;
		while (input.length - offset >= FRAME_SAMPLES) {
			// Copy out — subscribers must own stable 960-sample frames.
			const frame = input.slice(offset, offset + FRAME_SAMPLES);
			offset += FRAME_SAMPLES;
			this.deliveredFrames++;
			for (const cb of this.#audioSubscribers) {
				try {
					cb(frame);
				} catch {
					// A broken consumer must not kill the receive path.
				}
			}
		}
		if (offset < input.length) {
			this.#residue = input.slice(offset);
		}
	}
}

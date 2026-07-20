// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PeerConnectionManager — werift RTCPeerConnection lifecycle wrapper
// implementing the binding MediaEngine/MediaSession interfaces from
// ../types.ts (plan §4.2/§4.7, P4-T1).
//
// Ported from session-android `app/src/main/java/org/thoughtcrime/securesms/
// webrtc/PeerConnectionWrapper.kt` (GPLv3) and session-desktop
// `ts/session/utils/calling/CallManager.ts` (AGPLv3), © Session Foundation,
// modified — specifically the peer-connection configuration choices
// (bundlePolicy max-bundle, rtcp-mux, Opus preference, Android-parity SDP
// munging, the negotiated "signaling" data channel id 548). The werift
// glue, the ICE-state mapping, and teardown are written fresh.
// Shipped under AGPL-3.0-or-later.
//
// werift config gaps vs the plan's RTCConfiguration (P3-T1/P3-T2 findings):
//   - rtcpMuxPolicy: werift has no such key; it always bundles+rtcp-muxes
//     (equivalent to "require" — matches the plan).
//   - sdpSemantics: werift is Unified Plan only (matches Desktop; D4).
//   - iceServers[].urls must be a SINGLE string with an explicit port
//     (parseIceServers parseInts a missing port to NaN and fails silently),
//     so urls are normalized/flattened here; only the first turn: entry is
//     used by werift (documented limitation).
//   - iceTransportPolicy: supported ("all" | "relay" → forceTurn). Note the
//     relay policy filters candidate PAIRS, not gathering — non-relay
//     candidates may still be emitted; Wave-3 signaling may filter them
//     before sending if desired.

import {
	MediaStreamTrack,
	RTCPeerConnection,
	type BundlePolicy,
	type RTCIceCandidate,
} from "werift";

import type { IceServer, MediaEngine, MediaSession } from "../types.js";
import { AudioBridge, type AudioBridgeOptions } from "./audio-bridge.js";
import { extractUfrag, mungeLocalSdp } from "./sdp.js";

export type MediaConnectionState = "connecting" | "connected" | "disconnected" | "failed";

export interface CandidateInfo {
	candidate: string;
	sdpMLineIndex: number;
	sdpMid: string;
}

export type DataChannelMessage = { hangup?: boolean; hang_up?: boolean; video?: boolean };

/** Session "signaling" data channel parameters (plan §3.1, Android parity). */
export const SIGNALING_CHANNEL_LABEL = "signaling";
export const SIGNALING_CHANNEL_ID = 548;

const BUNDLE_POLICY: BundlePolicy = "max-bundle";

/**
 * Normalize the IceServer list for werift: flatten urls arrays, ensure an
 * explicit default port (3478) on turn/stun URLs (werift's parseIceServers
 * requires it), and map into werift's single-string-per-server shape.
 */
export function toWeriftIceServers(servers: IceServer[]): Array<{
	urls: string;
	username?: string;
	credential?: string;
}> {
	const out: Array<{ urls: string; username?: string; credential?: string }> = [];
	for (const server of servers) {
		const urls = typeof server.urls === "string" ? [server.urls] : server.urls;
		for (let url of urls) {
			const scheme = url.split(":")[0];
			const hasPort = url.slice((scheme?.length ?? 0) + 1).includes(":");
			if (!hasPort && (scheme === "turn" || scheme === "turns" || scheme === "stun" || scheme === "stuns")) {
				url = `${url}:3478`;
			}
			const entry: { urls: string; username?: string; credential?: string } = { urls: url };
			if (server.username !== undefined) entry.username = server.username;
			if (server.credential !== undefined) entry.credential = server.credential;
			out.push(entry);
		}
	}
	return out;
}

export class PeerConnectionManager implements MediaEngine {
	#bridgeOptions: AudioBridgeOptions | undefined;

	/** Options forwarded to every session's AudioBridge (e.g. custom codec). */
	constructor(opts?: { audioBridge?: AudioBridgeOptions }) {
		this.#bridgeOptions = opts?.audioBridge;
	}

	createSession(
		uuid: string,
		role: "caller" | "callee",
		opts: { iceServers: IceServer[]; iceTransportPolicy: "all" | "relay" },
	): MediaSession {
		return new WeriftMediaSession(uuid, role, opts, this.#bridgeOptions);
	}
}

/**
 * One call's media session over a werift RTCPeerConnection.
 * Implements the MediaSession surface from ../types.ts exactly.
 */
export class WeriftMediaSession implements MediaSession {
	readonly uuid: string;
	readonly role: "caller" | "callee";

	readonly #pc: RTCPeerConnection;
	readonly #localTrack: MediaStreamTrack;
	readonly #dataChannel: ReturnType<RTCPeerConnection["createDataChannel"]>;
	readonly #bridge: AudioBridge;

	#candidateCallbacks: Array<(c: CandidateInfo) => void> = [];
	#stateCallbacks: Array<(s: MediaConnectionState) => void> = [];
	#dcMessageCallbacks: Array<(msg: DataChannelMessage) => void> = [];
	#videoToggleCallbacks: Array<(enabled: boolean) => void> = [];

	#localCandidates: CandidateInfo[] = [];
	#pendingRemoteCandidates: CandidateInfo[] = [];
	#pendingDcMessages: string[] = [];
	#remoteDescriptionSet = false;
	#lastEmittedState: MediaConnectionState | undefined;
	#closed = false;
	#subs: Array<{ unSubscribe(): void }> = [];

	constructor(
		uuid: string,
		role: "caller" | "callee",
		opts: { iceServers: IceServer[]; iceTransportPolicy: "all" | "relay" },
		bridgeOptions?: AudioBridgeOptions,
	) {
		this.uuid = uuid;
		this.role = role;

		this.#pc = new RTCPeerConnection({
			iceServers: toWeriftIceServers(opts.iceServers),
			iceTransportPolicy: opts.iceTransportPolicy === "relay" ? "relay" : "all",
			bundlePolicy: BUNDLE_POLICY,
			// rtcpMuxPolicy: werift always rtcp-muxes (== "require"); there
			// is no config key (documented gap, header comment).
		});

		// One audio transceiver, sendrecv, Opus-preferred (werift's default
		// codec order is [OPUS, PCMU] — Desktop/Android parity).
		this.#localTrack = new MediaStreamTrack({ kind: "audio" });
		this.#pc.addTransceiver(this.#localTrack, { direction: "sendrecv" });

		// Negotiated data channel — created on BOTH roles with identical
		// parameters (plan §3.1; Android sets negotiated/id 548/ordered).
		this.#dataChannel = this.#pc.createDataChannel(SIGNALING_CHANNEL_LABEL, {
			negotiated: true,
			id: SIGNALING_CHANNEL_ID,
			ordered: true,
		});

		this.#bridge = new AudioBridge(this.#localTrack, bridgeOptions);

		this.#wireEvents();
	}

	// --- negotiation (MediaSession) ------------------------------------

	async createOffer(opts?: { iceRestart?: boolean }): Promise<string> {
		const offer = await this.#pc.createOffer({ iceRestart: opts?.iceRestart ?? false });
		return this.#setMungedLocal(offer, "offer");
	}

	async setRemoteOffer(offer: string): Promise<void> {
		await this.#pc.setRemoteDescription({ type: "offer", sdp: offer });
		this.#onRemoteDescriptionSet();
	}

	async createAnswer(): Promise<string> {
		const answer = await this.#pc.createAnswer();
		return this.#setMungedLocal(answer, "answer");
	}

	async setRemoteAnswer(answer: string): Promise<void> {
		await this.#pc.setRemoteDescription({ type: "answer", sdp: answer });
		this.#onRemoteDescriptionSet();
	}

	async addRemoteCandidate(c: CandidateInfo): Promise<void> {
		if (this.#closed) {
			return;
		}
		if (!this.#remoteDescriptionSet) {
			// werift throws before the remote description exists; buffer.
			this.#pendingRemoteCandidates.push(c);
			return;
		}
		await this.#injectCandidate(c);
	}

	async #injectCandidate(c: CandidateInfo): Promise<void> {
		try {
			await this.#pc.addIceCandidate({
				candidate: c.candidate,
				sdpMLineIndex: c.sdpMLineIndex,
				sdpMid: c.sdpMid,
			});
		} catch {
			// Garbage/unusable candidates must never crash the session
			// (Android's guarded posts; P4-T1 test 6).
		}
	}

	// --- events (MediaSession) ------------------------------------------

	onLocalCandidate(cb: (c: CandidateInfo) => void): void {
		this.#candidateCallbacks.push(cb);
	}

	onConnectionState(cb: (s: MediaConnectionState) => void): void {
		this.#stateCallbacks.push(cb);
		if (this.#lastEmittedState !== undefined) {
			cb(this.#lastEmittedState); // late subscribers see current state
		}
	}

	onDataChannelMessage(cb: (msg: DataChannelMessage) => void): void {
		this.#dcMessageCallbacks.push(cb);
	}

	sendDataChannelMessage(msg: { hangup?: boolean; video?: boolean }): void {
		if (this.#closed) {
			return;
		}
		const serialized = JSON.stringify(msg);
		if (this.#dataChannel.readyState === "open") {
			this.#dataChannel.send(serialized);
		} else if (this.#pendingDcMessages.length < 16) {
			// Best-effort buffer for pre-open sends (e.g. very early hangup).
			this.#pendingDcMessages.push(serialized);
		}
	}

	onAudio(cb: (pcm: Int16Array) => void): void {
		this.#bridge.onAudio(cb);
	}

	writeAudio(pcm: Int16Array): boolean {
		return this.#bridge.writeAudio(pcm);
	}

	onRemoteVideoToggle(cb: (enabled: boolean) => void): void {
		this.#videoToggleCallbacks.push(cb);
	}

	// --- diagnostics ------------------------------------------------------

	/** Local candidates gathered so far (tests/diagnostics). */
	get localCandidates(): readonly CandidateInfo[] {
		return this.#localCandidates;
	}

	/** Current werift ICE connection state (tests/diagnostics). */
	get iceConnectionState(): string {
		return this.#pc.iceConnectionState;
	}

	/** Data channel readyState (tests/diagnostics). */
	get dataChannelState(): string {
		return this.#dataChannel.readyState;
	}

	/** True once close() has been called. */
	get closed(): boolean {
		return this.#closed;
	}

	/** ufrag of the current local description (ICE-restart verification). */
	get localUfrag(): string | undefined {
		const sdp = this.#pc.localDescription?.sdp;
		return sdp === undefined ? undefined : extractUfrag(sdp);
	}

	/** The AudioBridge (advanced: stats, codec name). */
	get audioBridge(): AudioBridge {
		return this.#bridge;
	}

	// --- teardown -----------------------------------------------------------

	/** Idempotent: closes the data channel, the PC, and clears everything. */
	close(): void {
		if (this.#closed) {
			return;
		}
		this.#closed = true;
		this.#bridge.close();
		try {
			this.#dataChannel.close();
		} catch {
			// already closed
		}
		this.#localTrack.stop();
		for (const sub of this.#subs) {
			try {
				sub.unSubscribe();
			} catch {
				// best-effort
			}
		}
		this.#subs = [];
		this.#candidateCallbacks = [];
		this.#stateCallbacks = [];
		this.#dcMessageCallbacks = [];
		this.#videoToggleCallbacks = [];
		this.#localCandidates = [];
		this.#pendingRemoteCandidates = [];
		this.#pendingDcMessages = [];
		// werift's close() resolves once transports are down; fire-and-forget
		// (the MediaSession contract is synchronous-close), rejections
		// contained so teardown can never crash the host process (P6-T3).
		this.#pc.close().catch(() => undefined);
	}

	// --- internals ------------------------------------------------------------

	async #setMungedLocal(
		description: { type?: string; sdp?: string },
		type: "offer" | "answer",
	): Promise<string> {
		const raw = description.sdp;
		if (raw === undefined) {
			throw new Error(`werift produced an empty local ${type}`);
		}
		// MUNGE LOCAL SDP ONLY (§4.7/D4): opus ;cbr=1 + strip
		// ssrc-audio-level extmaps. Remote SDPs are never munged.
		const sdp = mungeLocalSdp(raw);
		await this.#pc.setLocalDescription({ type, sdp });
		return sdp;
	}

	#onRemoteDescriptionSet(): void {
		this.#remoteDescriptionSet = true;
		const pending = this.#pendingRemoteCandidates;
		this.#pendingRemoteCandidates = [];
		for (const c of pending) {
			void this.#injectCandidate(c);
		}
	}

	#wireEvents(): void {
		// Local ICE candidates → signaling callback (extract the triple).
		this.#subs.push(
			this.#pc.onIceCandidate.subscribe((cand: RTCIceCandidate | undefined) => {
				if (cand === undefined || cand.candidate === undefined || cand.candidate === "") {
					return; // end-of-gathering marker / null candidate
				}
				const info: CandidateInfo = {
					candidate: cand.candidate,
					sdpMLineIndex: cand.sdpMLineIndex ?? 0,
					sdpMid: cand.sdpMid ?? "0",
				};
				this.#localCandidates.push(info);
				for (const cb of this.#candidateCallbacks) {
					try {
						cb(info);
					} catch {
						// consumer errors must not break gathering
					}
				}
			}),
		);

		// werift ICE states → the 4-state contract. Mapping (P3-T1 findings):
		//   new/checking            → connecting
		//   connected/completed     → connected
		//   disconnected            → disconnected
		//   failed/closed           → failed
		// Hysteresis: once "connected" has been emitted, a brief flap back
		// to "checking" (observed ~25 ms after nomination while werift
		// finishes the remaining pair checks) is NOT downgraded to
		// "connecting" — per RFC 8445 an established ICE connection leaves
		// connected only via disconnected/failed. After "disconnected",
		// "connecting" flows again (ICE-restart / reconnect semantics).
		this.#subs.push(
			this.#pc.iceConnectionStateChange.subscribe((s) => {
				let mapped: MediaConnectionState;
				switch (s) {
					case "connected":
					case "completed":
						mapped = "connected";
						break;
					case "disconnected":
						mapped = "disconnected";
						break;
					case "failed":
					case "closed":
						mapped = "failed";
						break;
					default: // "new" | "checking"
						mapped = "connecting";
						break;
				}
				if (mapped === this.#lastEmittedState) {
					return; // dedupe (e.g. connected→completed)
				}
				if (mapped === "connecting" && this.#lastEmittedState === "connected") {
					return; // post-nomination flap — keep "connected"
				}
				this.#lastEmittedState = mapped;
				for (const cb of this.#stateCallbacks) {
					try {
						cb(mapped);
					} catch {
						// consumer errors must not break state handling
					}
				}
			}),
		);

		// Remote tracks → AudioBridge receive path.
		this.#subs.push(
			this.#pc.onTrack.subscribe((track) => {
				if (track.kind === "audio") {
					this.#bridge.attachRemoteTrack(track);
				}
			}),
		);

		// SENDER READINESS — P4-T2 finding (verified in spike): RTP written
		// between ICE "connected" and DTLS completion is SILENTLY DROPPED by
		// werift's sender (0/20 delivered). The full-stack connectionState
		// (ICE + DTLS [+SCTP]) "connected" is the true readiness gate; there
		// the AudioBridge send queue drains (20/20 burst delivered). The
		// 4-state contract above still derives from iceConnectionStateChange
		// (the FSM wants ICE-level disconnects).
		this.#subs.push(
			this.#pc.connectionStateChange.subscribe((s) => {
				if (s === "connected") {
					this.#bridge.setSenderReady(true);
				} else if (s === "disconnected" || s === "failed" || s === "closed") {
					this.#bridge.setSenderReady(false);
				}
			}),
		);

		// Data channel: JSON messages → callbacks; video boolean → toggle cbs.
		// We accept BOTH `hangup` (Android/Desktop, and what we send) and
		// `hang_up` (iOS) keys per plan §3.1.
		this.#subs.push(
			this.#dataChannel.onMessage.subscribe((data) => {
				let parsed: unknown;
				try {
					parsed = JSON.parse(typeof data === "string" ? data : data.toString("utf8"));
				} catch {
					return; // non-JSON garbage: drop
				}
				if (typeof parsed !== "object" || parsed === null) {
					return;
				}
				const msg = parsed as DataChannelMessage;
				for (const cb of this.#dcMessageCallbacks) {
					try {
						cb(msg);
					} catch {
						// consumer errors contained
					}
				}
				if (typeof msg.video === "boolean") {
					for (const cb of this.#videoToggleCallbacks) {
						try {
							cb(msg.video);
						} catch {
							// consumer errors contained
						}
					}
				}
			}),
		);

		// Flush buffered data-channel sends once open.
		this.#subs.push(
			this.#dataChannel.stateChange.subscribe((state) => {
				if (state !== "open") {
					return;
				}
				const pending = this.#pendingDcMessages;
				this.#pendingDcMessages = [];
				for (const serialized of pending) {
					try {
						this.#dataChannel.send(serialized);
					} catch {
						// best-effort
					}
				}
			}),
		);
	}
}

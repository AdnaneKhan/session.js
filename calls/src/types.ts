// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Normative public type surface for @session.js/calls (plan §4.3).
// Written fresh — no lines copied from GPL/AGPL sources.
//
// Deliberate design rule: this package must build WITHOUT @session.js/client
// installed. Everything the calls package needs from a session.js client
// instance is described structurally (SessionLike), so a patched
// @session.js/client Session satisfies it but we carry no compile-time
// dependency on the client package or its protobuf bindings.

// ---------------------------------------------------------------------------
// Wire message types (§3.1) — plain numbers matching SessionProtos.proto
// CallMessage.Type. Intentionally NOT re-exported from @session.js/types so
// this package has zero dependency on protobuf bindings.
// ---------------------------------------------------------------------------

/** SessionProtos.proto `CallMessage.Type` enum values (plain numbers). */
export const CallMessageType = {
	/** Ring/wake notification, sent BEFORE the offer. */
	PRE_OFFER: 6,
	/** sdps[0] = local SDP offer. */
	OFFER: 1,
	/** sdps[0] = local SDP answer. */
	ANSWER: 2,
	/** Defined; currently a no-op on all platforms. */
	PROVISIONAL_ANSWER: 3,
	/** Parallel arrays: sdps[i] / sdpMLineIndexes[i] / sdpMids[i]. */
	ICE_CANDIDATES: 4,
	/** Decline, busy, and hangup are all this one message. */
	END_CALL: 5,
} as const;

export type CallMessageTypeValue = (typeof CallMessageType)[keyof typeof CallMessageType];

// ---------------------------------------------------------------------------
// Signaling payloads
// ---------------------------------------------------------------------------

/**
 * Payload of the fork's updated `call` event on a session.js client instance
 * (plan §4.4.1 — the fixed mapCallMessage carrying SDP/ICE fields).
 */
export interface CallMessageEvent {
	uuid: string;
	type: CallMessageTypeValue;
	/** Session ID hex (05…) of the sender — our own id for self-sync copies. */
	from: string;
	/** Envelope timestamp, ms epoch. */
	timestamp: number;
	sdps: string[];
	sdpMLineIndexes: number[];
	sdpMids: string[];
}

/** Outgoing call message body (what gets encoded into CallMessage protobuf). */
export interface OutgoingCallMessage {
	type: CallMessageTypeValue;
	uuid: string;
	sdps?: string[];
	sdpMLineIndexes?: number[];
	sdpMids?: string[];
}

// ---------------------------------------------------------------------------
// Call state model (§4.5 — 10 states; the machine-readable table is in
// src/fsm/state-machine.ts, Appendix C of the plan)
// ---------------------------------------------------------------------------

export type CallState =
	| "idle"
	| "local-pre-offer"
	| "local-ring"
	| "remote-pre-offer"
	| "remote-ring"
	| "connecting"
	| "connected"
	| "pending-reconnect"
	| "reconnecting"
	| "disconnected";

export type CallDirection = "inbound" | "outbound";

/** Why a call ended (§4.3; last two per P6-T2 multi-device race semantics). */
export type EndReason =
	| "local-hangup"
	| "remote-hangup"
	| "remote-declined"
	| "busy"
	| "timeout"
	| "ice-failed"
	| "error"
	| "ignored-locally"
	| "answered-elsewhere"
	| "ended-elsewhere";

// ---------------------------------------------------------------------------
// ICE / transport
// ---------------------------------------------------------------------------

/** RTCIceServer-shaped config (subset werift honors). */
export interface IceServer {
	urls: string | string[];
	username?: string;
	credential?: string;
}

// ---------------------------------------------------------------------------
// Manager options & call info (§4.3 — exact fields)
// ---------------------------------------------------------------------------

export interface CallManagerOptions {
	/** ICE servers; default = official Session TURN hosts (shuffle-take-2). */
	iceServers?: IceServer[];
	/** "all" (default, P2P-first) or "relay" (TURN-only; hides host IP). */
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

export interface CallInfo {
	uuid: string;
	/** Session ID hex (05…). */
	peer: string;
	direction: CallDirection;
	state: CallState;
	/** ms epoch. */
	startedAt: number;
	connectedAt?: number;
	endedAt?: number;
	endReason?: EndReason;
}

// ---------------------------------------------------------------------------
// Public Call handle (§4.3 — exact surface)
// ---------------------------------------------------------------------------

/** Events emitted by a Call handle. */
export interface CallEventMap {
	state: CallState;
	/** Best-effort RTP audio level (0..1); may not fire if the ext is absent. */
	"audio-level": number;
	ended: CallInfo;
	/** Diagnostics: signaling send/receive trace (plan §P5-T3). */
	signaling: { direction: "in" | "out"; type: CallMessageTypeValue; uuid: string };
}

export interface Call {
	readonly info: CallInfo;
	/** Inbound only. */
	accept(): Promise<void>;
	/** Sends END_CALL. */
	reject(): Promise<void>;
	/** Local only, no wire message. */
	ignore(): void;
	hangup(): Promise<void>;
	/** Incoming decoded audio: 16-bit PCM, 48 kHz, mono, 20 ms frames (960 samples). */
	onAudio(cb: (pcm: Int16Array) => void): void;
	/** Queue outbound audio frames (same format). Backpressure: returns false if buffer full. */
	writeAudio(pcm: Int16Array): boolean;
	/** Remote peer signaled video toggle (v1: informational only). */
	onRemoteVideoToggle(cb: (enabled: boolean) => void): void;
	on<E extends keyof CallEventMap>(event: E, cb: (payload: CallEventMap[E]) => void): void;
	off<E extends keyof CallEventMap>(event: E, cb: (payload: CallEventMap[E]) => void): void;
}

// ---------------------------------------------------------------------------
// Structural dependency interfaces (decouple from @session.js/client at build
// time; a patched Session satisfies SessionLike)
// ---------------------------------------------------------------------------

/**
 * What the calls package needs from a session.js client instance. A patched
 * @session.js/client Session (plan §4.4) satisfies this structurally.
 */
export interface SessionLike {
	getSessionID(): string;
	/** Clock compensated for swarm/server offset — used for freshness checks. */
	getNowWithNetworkOffset(): number;
	on(event: "call", cb: (msg: CallMessageEvent) => void): void;
	off(event: "call", cb: (msg: CallMessageEvent) => void): void;
	sendCallMessage(
		to: string,
		msg: {
			type: CallMessageTypeValue;
			uuid: string;
			sdps?: string[];
			sdpMLineIndexes?: number[];
			sdpMids?: string[];
		},
		options?: { isSyncMessage?: boolean },
	): Promise<{ messageHash: string; timestamp: number }>;
	/** Boost/restore the poller cadence during calls (plan §4.6). */
	setPollInterval(interval: number): void;
	acceptConversationRequest(opts: { from: string }): Promise<unknown>;
}

/**
 * What the supervisor uses to emit signaling. The real implementation (Phase 4)
 * wraps SessionLike.sendCallMessage (sendToPeer → to=peer; sendToSelf →
 * to=own id with isSyncMessage: true).
 */
export interface SignalingSender {
	sendToPeer(peer: string, msg: OutgoingCallMessage): Promise<void>;
	sendToSelf(msg: OutgoingCallMessage): Promise<void>;
}

// ---------------------------------------------------------------------------
// Media plane interfaces (binding shape — implemented by the media agent in
// Phase 4; see src/media/README.md). DO NOT change without a decision gate.
// ---------------------------------------------------------------------------

export interface MediaSession {
	/** Returns local SDP. */
	createOffer(opts?: { iceRestart?: boolean }): Promise<string>;
	setRemoteOffer(offer: string): Promise<void>;
	/** Returns local SDP. */
	createAnswer(): Promise<string>;
	setRemoteAnswer(answer: string): Promise<void>;
	addRemoteCandidate(c: { candidate: string; sdpMLineIndex: number; sdpMid: string }): Promise<void>;
	onLocalCandidate(
		cb: (c: { candidate: string; sdpMLineIndex: number; sdpMid: string }) => void,
	): void;
	onConnectionState(
		cb: (s: "connecting" | "connected" | "disconnected" | "failed") => void,
	): void;
	onDataChannelMessage(
		cb: (msg: { hangup?: boolean; hang_up?: boolean; video?: boolean }) => void,
	): void;
	sendDataChannelMessage(msg: { hangup?: boolean; video?: boolean }): void;
	/** 48kHz mono 16-bit, 20ms frames (960 samples). */
	onAudio(cb: (pcm: Int16Array) => void): void;
	writeAudio(pcm: Int16Array): boolean;
	onRemoteVideoToggle(cb: (enabled: boolean) => void): void;
	close(): void;
}

export interface MediaEngine {
	createSession(
		uuid: string,
		role: "caller" | "callee",
		opts: { iceServers: IceServer[]; iceTransportPolicy: "all" | "relay" },
	): MediaSession;
}

// ---------------------------------------------------------------------------
// Event payloads
// ---------------------------------------------------------------------------

/** Missed-call record emitted on the manager "missed" event. */
export interface MissedCallRecord {
	peer: string;
	/** ms epoch. */
	at: number;
	reason: "ignored" | "busy" | "stale" | "declined-wire";
}

/** Events emitted by CallManager / CallSupervisor. */
export interface CallManagerEventMap {
	incoming: Call;
	outgoing: Call;
	missed: MissedCallRecord;
	error: { call?: Call; error: Error };
}

/** Logger signature shared across the package. */
export type CallLogger = (level: string, msg: string, meta?: unknown) => void;

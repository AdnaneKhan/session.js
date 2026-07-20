// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Error taxonomy for @session.js/calls (plan P6-T3). Written fresh.
//
// Every failure mode maps to a typed CallError subclass so consumers can
// switch on `code` (stable string) or instanceof. The supervisor must never
// let one of these (or a media-layer rejection) crash the host process —
// see the catch-and-log discipline in supervisor.ts.

import type { CallFsmEvent } from "./fsm/state-machine.js";
import type { CallState } from "./types.js";

/** Stable machine-readable error codes. */
export const CallErrorCode = {
	PEER_NOT_APPROVED: "PEER_NOT_APPROVED",
	CALL_IN_PROGRESS: "CALL_IN_PROGRESS",
	SIGNALING_TIMEOUT: "SIGNALING_TIMEOUT",
	ICE_FAILURE: "ICE_FAILURE",
	MEDIA_FAILURE: "MEDIA_FAILURE",
	RUNTIME_UNSUPPORTED: "RUNTIME_UNSUPPORTED",
	INVALID_CALL_TRANSITION: "INVALID_CALL_TRANSITION",
	INVALID_CALL_MESSAGE: "INVALID_CALL_MESSAGE",
} as const;

export type CallErrorCodeValue = (typeof CallErrorCode)[keyof typeof CallErrorCode];

/** Base class for all errors raised by the calls package. */
export class CallError extends Error {
	readonly code: string;
	readonly callUuid?: string;

	constructor(code: CallErrorCodeValue | string, message: string, callUuid?: string) {
		super(message);
		this.name = new.target.name;
		this.code = code;
		this.callUuid = callUuid;
		// Restore prototype chain for downlevel targets (harmless on ES2022).
		Object.setPrototypeOf(this, new.target.prototype);
	}
}

/** Outbound gate: peer is not an approved contact and requireApprovedContact is on. */
export class PeerNotApprovedError extends CallError {
	readonly peer: string;

	constructor(peer: string, callUuid?: string) {
		super(CallErrorCode.PEER_NOT_APPROVED, `Peer ${peer} is not an approved contact`, callUuid);
		this.peer = peer;
	}
}

/** v1 allows exactly one concurrent call. */
export class CallInProgressError extends CallError {
	readonly activeUuid: string;

	constructor(activeUuid: string) {
		super(
			CallErrorCode.CALL_IN_PROGRESS,
			`Another call is already in progress (uuid ${activeUuid})`,
			activeUuid,
		);
		this.activeUuid = activeUuid;
	}
}

/** No ANSWER / ICE connection before callTimeoutMs elapsed. */
export class SignalingTimeoutError extends CallError {
	readonly timeoutMs: number;

	constructor(timeoutMs: number, callUuid?: string) {
		super(
			CallErrorCode.SIGNALING_TIMEOUT,
			`Call signaling timed out after ${timeoutMs}ms`,
			callUuid,
		);
		this.timeoutMs = timeoutMs;
	}
}

/** ICE failed to connect (restart attempts exhausted or transport failure). */
export class IceFailureError extends CallError {
	constructor(message: string, callUuid?: string) {
		super(CallErrorCode.ICE_FAILURE, message, callUuid);
	}
}

/** Media plane failure (werift PC error, codec failure, SDP error). */
export class MediaFailureError extends CallError {
	constructor(message: string, callUuid?: string) {
		super(CallErrorCode.MEDIA_FAILURE, message, callUuid);
	}
}

/** Runtime lacks required capabilities (e.g. werift incompatible with this Bun/Node). */
export class RuntimeUnsupportedError extends CallError {
	constructor(message: string) {
		super(CallErrorCode.RUNTIME_UNSUPPORTED, message);
	}
}

/** (state, event) pair has no row in the FSM transition table. */
export class InvalidCallTransitionError extends CallError {
	readonly state: CallState;
	readonly event: CallFsmEvent;

	constructor(state: CallState, event: CallFsmEvent, callUuid?: string) {
		super(
			CallErrorCode.INVALID_CALL_TRANSITION,
			`Invalid call transition: event "${event}" is not valid from state "${state}"`,
			callUuid,
		);
		this.state = state;
		this.event = event;
	}
}

/** Inbound/outbound call message failed structural validation. */
export class InvalidCallMessageError extends CallError {
	readonly reason: string;

	constructor(reason: string, callUuid?: string) {
		super(CallErrorCode.INVALID_CALL_MESSAGE, `Invalid call message: ${reason}`, callUuid);
		this.reason = reason;
	}
}

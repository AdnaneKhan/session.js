// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Signaling transport adapters for @session.js/calls (plan §4.6, P4-T3).
// Written fresh from the verified protocol facts — no lines copied from
// GPL/AGPL sources.
//
// ── THE ENUM / LITERAL TYPE BRIDGE (read before touching casts here) ──────
// This package describes call-message types as a numeric LITERAL union
// (CallMessageTypeValue = 1|2|3|4|5|6, src/types.ts) so it builds with ZERO
// dependency on @session.js/types' protobuf bindings. The patched
// @session.js/client speaks the protobuf ENUM SignalService.CallMessage.Type
// instead (nominal TS enum — same numbers at runtime: OFFER=1, ANSWER=2,
// PROVISIONAL_ANSWER=3, ICE_CANDIDATES=4, END_CALL=5, PRE_OFFER=6).
//
// The two are structurally compatible AT RUNTIME (identical wire values).
// At compile time, SessionLike (src/types.ts) declares its members in
// METHOD style, which TypeScript checks bivariantly — so a real patched
// Session satisfies SessionLike with NO casts at all, in both directions.
// Explicit `as` casts appear ONLY in this file's boundary helpers (and in
// tests that construct protobuf-enum-typed payloads) as a belt-and-braces
// measure: if a consumer's stricter typing (property-style declarations,
// exactOptionalPropertyTypes, etc.) ever rejects the bivariant match, the
// cast sites below are the single sanctioned place to bridge the types.
// Never widen these casts beyond this boundary.
// ─────────────────────────────────────────────────────────────────────────

import { IceCandidateBatcher } from "./policy.js";
import type { BatcherTimerHooks, IceCandidate, IceCandidateBatch } from "./policy.js";
import type {
	CallLogger,
	IceServer,
	OutgoingCallMessage,
	SessionLike,
	SignalingSender,
} from "./types.js";
import { callMessageTypeName, CallMessageType } from "./types.js";

// ---------------------------------------------------------------------------
// SessionSignaling — SignalingSender over a SessionLike (fork patch §4.4)
// ---------------------------------------------------------------------------

/**
 * Real SignalingSender implementation:
 * - sendToPeer(peer, msg) → session.sendCallMessage(peer, msg)
 * - sendToSelf(msg)       → session.sendCallMessage(ownId, msg, { isSyncMessage: true })
 *   (ANSWER/END_CALL self-sync copies so linked devices stop ringing, §4.5;
 *   the swarm store uses the call TTL — the fork's CallMessage schema class
 *   carries ttl = TTL_DEFAULT.CALL_MESSAGE.)
 */
export class SessionSignaling implements SignalingSender {
	readonly #session: SessionLike;
	readonly #log: CallLogger;

	constructor(session: SessionLike, logger?: CallLogger) {
		this.#session = session;
		this.#log = logger ?? (() => undefined);
	}

	async sendToPeer(peer: string, msg: OutgoingCallMessage): Promise<void> {
		// Diagnostics (P5-T3): direction/type/uuid only — NEVER SDP payloads.
		this.#log(
			"debug",
			`signaling send peer type=${callMessageTypeName(msg.type)} uuid=${msg.uuid}`,
		);
		// TYPE BRIDGE (header comment): msg.type is CallMessageTypeValue; the
		// client's sendCallMessage expects SignalService.CallMessage.Type.
		// Bivariant method typing makes this assignment compile without a cast
		// for method-style SessionLike declarations; OutgoingCallMessage is
		// already shaped exactly like the client's callMessage parameter.
		await this.#session.sendCallMessage(peer, msg);
	}

	async sendToSelf(msg: OutgoingCallMessage): Promise<void> {
		this.#log(
			"debug",
			`signaling send self type=${callMessageTypeName(msg.type)} uuid=${msg.uuid}`,
		);
		await this.#session.sendCallMessage(this.#session.getSessionID(), msg, {
			isSyncMessage: true,
		});
	}
}

// ---------------------------------------------------------------------------
// TrickleIceSender — batched ICE_CANDIDATES sending (§3.2 / §4.6)
// ---------------------------------------------------------------------------

/** True for `relay` candidates (TURN). werift's candidate attribute syntax. */
export function isRelayCandidate(candidate: string): boolean {
	return /\btyp\s+relay\b/i.test(candidate);
}

export interface TrickleIceSenderOptions {
	peer: string;
	uuid: string;
	signaling: SignalingSender;
	/** Debounce window (default DEFAULT_ICE_BATCH_MS = 200 ms via the batcher). */
	batchIntervalMs?: number;
	/** "relay" filters out non-relay local candidates before batching. */
	iceTransportPolicy?: "all" | "relay";
	logger?: CallLogger;
	/** Injectable timers (default setTimeout/clearTimeout) — testability. */
	timers?: BatcherTimerHooks;
}

/**
 * Per-call trickle-ICE sender.
 *
 * feed() ← MediaSession.onLocalCandidate; candidates are debounced
 * (iceBatchIntervalMs, default 200 ms) by IceCandidateBatcher (policy.ts)
 * and flushed as ONE ICE_CANDIDATES message with parallel arrays
 * {sdps, sdpMLineIndexes, sdpMids}.
 *
 * GATE: nothing is sent until arm() is called — the local description must
 * exist before candidates are meaningful. CallManager arms the sender when
 * it observes the outbound OFFER / ANSWER "signaling" trace (both imply
 * setLocalDescription has completed — the media session only resolves
 * createOffer/createAnswer after setting the munged local description).
 * Candidates arriving before arming are buffered and flushed after arm().
 *
 * RELAY MODE: with iceTransportPolicy === "relay" werift still GATHERS
 * host/srflx candidates (forceTurn only filters pair selection — media-layer
 * finding P4-T1); for wire cleanliness those are filtered out here before
 * batching, so only `typ relay` candidates are ever sent.
 *
 * dispose(): drops anything pending and clears the timer — flushes NOTHING
 * (teardown path; candidates for a dead call are worthless).
 */
export class TrickleIceSender {
	readonly #peer: string;
	readonly #uuid: string;
	readonly #signaling: SignalingSender;
	readonly #relayOnly: boolean;
	readonly #log: CallLogger;
	readonly #batcher: IceCandidateBatcher;

	#armed = false;
	#disposed = false;
	#preArmQueue: IceCandidate[] = [];

	constructor(opts: TrickleIceSenderOptions) {
		this.#peer = opts.peer;
		this.#uuid = opts.uuid;
		this.#signaling = opts.signaling;
		this.#relayOnly = opts.iceTransportPolicy === "relay";
		this.#log = opts.logger ?? (() => undefined);
		this.#batcher = new IceCandidateBatcher(
			(batch: IceCandidateBatch) => this.#flush(batch),
			{
				windowMs: opts.batchIntervalMs,
				setTimer: opts.timers?.setTimer,
				clearTimer: opts.timers?.clearTimer,
			},
		);
	}

	get armed(): boolean {
		return this.#armed;
	}

	get pending(): number {
		return this.#batcher.pending + this.#preArmQueue.length;
	}

	/**
	 * Buffer a local candidate. relay-mode filters non-relay candidates;
	 * before arm() the candidate is parked (NOT dropped) so early gather
	 * results still ship once the local description exists.
	 */
	feed(c: IceCandidate): void {
		if (this.#disposed) {
			return;
		}
		if (this.#relayOnly && !isRelayCandidate(c.candidate)) {
			this.#log("debug", "trickle: dropped non-relay candidate (relay mode)", {
				uuid: this.#uuid,
			});
			return;
		}
		if (!this.#armed) {
			this.#preArmQueue.push(c);
			return;
		}
		this.#batcher.enqueue(c);
	}

	/** Local description is set — release buffered candidates into the batcher. */
	arm(): void {
		if (this.#armed || this.#disposed) {
			return;
		}
		this.#armed = true;
		const queued = this.#preArmQueue;
		this.#preArmQueue = [];
		for (const c of queued) {
			this.#batcher.enqueue(c);
		}
	}

	/** Flush any buffered candidates immediately (no-op before arm / if empty). */
	flushNow(): void {
		if (this.#armed && !this.#disposed) {
			this.#batcher.flushNow();
		}
	}

	/** Teardown: drop pending candidates, clear the timer, flush NOTHING. */
	dispose(): void {
		this.#disposed = true;
		this.#preArmQueue = [];
		this.#batcher.dispose();
	}

	#flush(batch: IceCandidateBatch): void {
		if (this.#disposed || batch.sdps.length === 0) {
			return;
		}
		this.#log("debug", `signaling send peer type=ICE_CANDIDATES uuid=${this.#uuid}`, {
			count: batch.sdps.length,
		});
		const msg: OutgoingCallMessage = {
			type: CallMessageType.ICE_CANDIDATES,
			uuid: this.#uuid,
			sdps: batch.sdps,
			sdpMLineIndexes: batch.sdpMLineIndexes,
			sdpMids: batch.sdpMids,
		};
		// Containment (P6-T3): a rejected ICE send must never escape as an
		// unhandled rejection — ICE is best-effort; the call can still
		// connect via candidates already delivered.
		void this.#signaling.sendToPeer(this.#peer, msg).catch((err: unknown) => {
			this.#log("warn", "ICE_CANDIDATES send failed", {
				uuid: this.#uuid,
				err: err instanceof Error ? err.message : String(err),
			});
		});
	}
}

/** Re-exported for consumers configuring ICE (Appendix B lives in policy.ts). */
export type { IceServer };

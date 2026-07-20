// SPDX-License-Identifier: AGPL-3.0-or-later
//
// CallManager — the public entry point of @session.js/calls (plan §4.3,
// P4-T3). Call sequencing and lifecycle wiring adapted from session-desktop
// `ts/session/utils/calling/CallManager.ts` (AGPLv3), © Session Foundation,
// modified (structural SessionLike dependency; werift media plane via
// PeerConnectionManager; CallSupervisor FSM/gating; headless operation).
// ICE-restart wiring adapted from session-android
// `webrtc/WebRtcCallBridge.kt` / `PeerConnectionWrapper.kt` (GPLv3),
// © Session Foundation, modified. Licensed under AGPL-3.0-or-later.
//
// Composition:
//   SessionLike ── SessionSignaling ──┐
//               └── TrickleIceSender ─┤   CallSupervisor (FSM, gating, timers)
//   PeerConnectionManager (MediaEngine) ┘
//
// Containment discipline (P6-T3): NO failure — media engine throw, signaling
// rejection, consumer callback error — may escape the CallManager as an
// unhandled promise rejection. Every async effect chain lands in a catch
// that emits "error" (with call attribution where possible) and ends the
// affected call with reason "error"/typed error.

import { EventEmitter } from "node:events";

import { CallImpl } from "./call.js";
import { CallError, CallInProgressError, InvalidCallMessageError } from "./errors.js";
import { PeerConnectionManager, WeriftMediaSession } from "./media/peer-connection.js";
import { redactSensitive } from "./policy.js";
import { SessionSignaling, TrickleIceSender } from "./signaling.js";
import { CallSupervisor } from "./supervisor.js";
import type { CallContext, CallTimers } from "./supervisor.js";
import type {
	Call,
	CallInfo,
	CallLogger,
	CallManagerEventMap,
	CallManagerOptions,
	MediaEngine,
	MediaSession,
	SessionLike,
} from "./types.js";
import { CallMessageType } from "./types.js";

/** 66-hex Session ID with the 05 ed25519-pubkey prefix. */
const SESSION_ID_RE = /^05[0-9a-f]{64}$/i;

/**
 * Optional construction seams (NON-normative, additive — the normative
 * consumer signature remains `new CallManager(session, options?)` per
 * §4.3). Tests inject a fake clock/timers (the ICE-restart cadence and the
 * non-initiator reconnect wait are fixed policy constants) and a fake
 * MediaEngine; consumers never need this.
 */
export interface CallManagerDeps {
	/** Injectable clock (default Date.now) — forwarded to the supervisor. */
	now?: () => number;
	/** Injectable UUID factory (default crypto.randomUUID). */
	createUuid?: () => string;
	/** Injectable timers (default global setTimeout/clearTimeout). */
	timers?: CallTimers;
	/** Override the default werift PeerConnectionManager (tests/fakes). */
	media?: MediaEngine;
}

/** Call-end diagnostics summary logged on every end (plan §P5-T3). */
export interface CallSummary {
	uuid: string;
	peer: string;
	direction: "inbound" | "outbound";
	durationMs: number;
	connectedMs?: number;
	endReason?: string;
	/** v1: always "unknown" — the media binding does not expose the selected
	 *  candidate pair type (documented media-layer delta for a future wave). */
	icePairType: "unknown" | "host" | "relay";
	framesDelivered: number;
	framesDropped: number;
}

/**
 * Wrap a consumer logger so NOTHING sensitive can reach it (P5-T3): every
 * message string and the JSON snapshot of every meta object pass through
 * redactSensitive (TURN username/password, DTLS fingerprints). Errors in
 * meta are serialized as {name, message, code}.
 */
function redactingLogger(sink: CallLogger): CallLogger {
	const replacer = (_key: string, value: unknown): unknown => {
		if (value instanceof Error) {
			return {
				name: value.name,
				message: value.message,
				code: (value as { code?: string }).code,
			};
		}
		return value;
	};
	return (level: string, msg: string, meta?: unknown): void => {
		let safeMeta: unknown = meta;
		if (meta !== undefined) {
			try {
				safeMeta = JSON.parse(redactSensitive(JSON.stringify(meta, replacer)));
			} catch {
				safeMeta = "[unserializable-meta]";
			}
		}
		sink(level, redactSensitive(msg), safeMeta);
	};
}

export class CallManager extends EventEmitter {
	readonly #log: CallLogger;
	readonly #signaling: SessionSignaling;
	readonly #supervisor: CallSupervisor;
	readonly #deps: CallManagerDeps;
	readonly #options: CallManagerOptions;

	readonly #calls = new Map<string, CallImpl>();
	readonly #trickle = new Map<string, TrickleIceSender>();
	readonly #mediaSessions = new Map<string, MediaSession>();
	#disposed = false;

	/**
	 * @param session  A patched @session.js/client Session (satisfies
	 *   SessionLike structurally — see src/types.ts header and signaling.ts
	 *   enum-bridge comment).
	 * @param options  §4.3 options; defaults: iceServers = defaultIceServers()
	 *   (official Session TURN hosts, shuffle-take-2), callTimeoutMs 60_000,
	 *   iceBatchIntervalMs 200, boostedPollIntervalMs 500,
	 *   requireApprovedContact true, autoApproveOnCall true,
	 *   iceTransportPolicy "all".
	 * @param deps  Non-normative test seams (see CallManagerDeps).
	 */
	constructor(session: SessionLike, options?: CallManagerOptions, deps?: CallManagerDeps) {
		super();
		this.#options = options ?? {};
		this.#deps = deps ?? {};
		const userLogger = this.#options.logger;
		this.#log = userLogger ? redactingLogger(userLogger) : () => undefined;
		this.#signaling = new SessionSignaling(session, this.#log);

		// Decorate the media engine so every created session is observable
		// (trickle-ICE wiring) regardless of which side created it.
		const innerMedia: MediaEngine = this.#deps.media ?? new PeerConnectionManager();
		const observedMedia: MediaEngine = {
			createSession: (uuid, role, opts) => {
				const ms = innerMedia.createSession(uuid, role, opts);
				this.#onMediaSession(uuid, ms);
				return ms;
			},
		};

		this.#supervisor = new CallSupervisor({
			session,
			signaling: this.#signaling,
			media: observedMedia,
			options: this.#options,
			logger: this.#log,
			now: this.#deps.now,
			createUuid: this.#deps.createUuid,
			timers: this.#deps.timers,
		});

		this.#supervisor.onIncoming((ctx) => {
			this.#guard(() => this.#onNewContext(ctx, "incoming"));
		});
		this.#supervisor.onOutgoing((ctx) => {
			this.#guard(() => this.#onNewContext(ctx, "outgoing"));
		});
		this.#supervisor.onMissed((record) => {
			this.#guard(() => {
				this.emit("missed", record);
			});
		});
		this.#supervisor.onEnded((ctx, info) => {
			this.#guard(() => this.#onCallEnded(ctx, info));
		});
		this.#supervisor.onError((err, ctx) => {
			this.#guard(() => {
				const call = ctx ? this.#calls.get(ctx.uuid) : undefined;
				this.#log("error", `call error${ctx ? ` uuid=${ctx.uuid}` : ""}`, {
					err,
				});
				this.emit("error", { call, error: err });
			});
		});
	}

	// --- Public API (§4.3) ---------------------------------------------------

	/**
	 * Place an outbound call.
	 * Rejects: InvalidCallMessageError (bad Session ID), CallInProgressError
	 * (v1: one concurrent call), PeerNotApprovedError (requireApprovedContact
	 * and the peer was not approved via approveContact()), media failures.
	 */
	async call(peerSessionId: string): Promise<Call> {
		if (this.#disposed) {
			throw new CallError("DISPOSED", "CallManager is disposed");
		}
		if (typeof peerSessionId !== "string" || !SESSION_ID_RE.test(peerSessionId)) {
			throw new InvalidCallMessageError(
				`not a valid Session ID (expected 66 hex chars with 05 prefix, got ${JSON.stringify(
					peerSessionId === undefined ? null : String(peerSessionId).slice(0, 8),
				)}…)`,
			);
		}
		const activeCtx = this.#supervisor.activeContext;
		if (activeCtx) {
			throw new CallInProgressError(activeCtx.uuid);
		}
		// placeCall throws synchronously on policy errors and on synchronous
		// media-engine failure (it fails the just-registered context in that
		// case — the "error" event still fires via the supervisor channel).
		const ctx = this.#supervisor.placeCall(peerSessionId);
		const impl = this.#calls.get(ctx.uuid);
		if (!impl) {
			// Unreachable — the onOutgoing callback runs synchronously inside
			// placeCall, before it returns.
			throw new CallError("INTERNAL", "outgoing call context was not registered");
		}
		return impl;
	}

	/** The single active call, if any (v1: one concurrent call). */
	get activeCall(): Call | undefined {
		const ctx = this.#supervisor.activeContext;
		return ctx ? this.#calls.get(ctx.uuid) : undefined;
	}

	/**
	 * Hang up any active call, unhook from the session, dispose all per-call
	 * state, restore the poll cadence. Idempotent.
	 */
	async dispose(): Promise<void> {
		if (this.#disposed) {
			return;
		}
		this.#disposed = true;
		for (const sender of this.#trickle.values()) {
			sender.dispose();
		}
		this.#trickle.clear();
		await this.#supervisor.dispose();
		this.#mediaSessions.clear();
		this.removeAllListeners();
	}

	// --- Approval management (additive — see note below) ----------------------
	//
	// §4.3 does not enumerate an approval API, but with the normative default
	// requireApprovedContact:true there is otherwise NO way for a consumer to
	// approve a contact — outbound calls would always reject and every inbound
	// call would be dropped. approveContact() delegates to the supervisor's
	// markApproved() (the same hook the auto-approve-on-call path uses).
	// Documented additive extension; the normative 2-arg construction and the
	// enumerated members are unchanged.

	/** Approve a peer for inbound/outbound calls (contacts-only gate, §3.3). */
	approveContact(peerSessionId: string): void {
		this.#supervisor.markApproved(peerSessionId);
	}

	/** Whether a peer is currently approved. */
	isContactApproved(peerSessionId: string): boolean {
		return this.#supervisor.isApproved(peerSessionId);
	}

	// --- Typed event surface (§4.3 events) --------------------------------------

	override on<E extends keyof CallManagerEventMap>(
		event: E,
		listener: (payload: CallManagerEventMap[E]) => void,
	): this;
	override on(event: string | symbol, listener: (...args: unknown[]) => void): this;
	override on(event: string | symbol, listener: (...args: unknown[]) => void): this {
		return super.on(event, listener);
	}

	override off<E extends keyof CallManagerEventMap>(
		event: E,
		listener: (payload: CallManagerEventMap[E]) => void,
	): this;
	override off(event: string | symbol, listener: (...args: unknown[]) => void): this;
	override off(event: string | symbol, listener: (...args: unknown[]) => void): this {
		return super.off(event, listener);
	}

	override once<E extends keyof CallManagerEventMap>(
		event: E,
		listener: (payload: CallManagerEventMap[E]) => void,
	): this;
	override once(event: string | symbol, listener: (...args: unknown[]) => void): this;
	override once(event: string | symbol, listener: (...args: unknown[]) => void): this {
		return super.once(event, listener);
	}

	override emit<E extends keyof CallManagerEventMap>(
		event: E,
		payload: CallManagerEventMap[E],
	): boolean;
	override emit(event: string | symbol, ...args: unknown[]): boolean;
	override emit(event: string | symbol, ...args: unknown[]): boolean {
		return super.emit(event, ...args);
	}

	// --- internals ---------------------------------------------------------------

	/** A new call context (inbound or outbound) → CallImpl + trickle sender. */
	#onNewContext(ctx: CallContext, kind: "incoming" | "outgoing"): void {
		let impl = this.#calls.get(ctx.uuid);
		if (!impl) {
			impl = new CallImpl(ctx, (err: unknown) => this.#onCallFatal(ctx, err));
			this.#calls.set(ctx.uuid, impl);

			const sender = new TrickleIceSender({
				peer: ctx.peer,
				uuid: ctx.uuid,
				signaling: this.#signaling,
				batchIntervalMs: this.#options.iceBatchIntervalMs,
				iceTransportPolicy: this.#options.iceTransportPolicy,
				logger: this.#log,
				timers: this.#deps.timers
					? {
							setTimer: (cb, ms) => (this.#deps.timers as CallTimers).setTimeout(cb, ms),
							clearTimer: (handle) => (this.#deps.timers as CallTimers).clearTimeout(handle),
						}
					: undefined,
			});
			this.#trickle.set(ctx.uuid, sender);

			// Arm trickle ICE once the LOCAL description exists: the outbound
			// OFFER (caller) / ANSWER (callee) traces fire only after
			// createOffer/createAnswer resolved, which the media session does
			// strictly AFTER setLocalDescription (§4.6 readyForIce gate).
			ctx.on("signaling", (s) => {
				if (
					s.direction === "out" &&
					(s.type === CallMessageType.OFFER || s.type === CallMessageType.ANSWER)
				) {
					sender.arm();
				}
			});
		}
		this.emit(kind, impl);
	}

	/** Media engine created a session for one of our calls → wire trickle ICE. */
	#onMediaSession(uuid: string, ms: MediaSession): void {
		this.#mediaSessions.set(uuid, ms);
		const sender = this.#trickle.get(uuid);
		if (!sender) {
			return;
		}
		try {
			ms.onLocalCandidate((c) => {
				try {
					sender.feed(c);
				} catch (err) {
					this.#log("warn", "trickle feed failed", {
						uuid,
						err: err instanceof Error ? err.message : String(err),
					});
				}
			});
		} catch (err) {
			this.#log("warn", "onLocalCandidate wiring failed", {
				uuid,
				err: err instanceof Error ? err.message : String(err),
			});
		}
	}

	#onCallEnded(ctx: CallContext, info: CallInfo): void {
		const sender = this.#trickle.get(ctx.uuid);
		sender?.dispose();
		this.#trickle.delete(ctx.uuid);
		const ms = this.#mediaSessions.get(ctx.uuid);
		this.#mediaSessions.delete(ctx.uuid);

		// Diagnostics call summary (P5-T3).
		const summary = buildCallSummary(info, ms);
		this.#log(
			"info",
			`call ended uuid=${summary.uuid} peer=${summary.peer} direction=${summary.direction}` +
				` endReason=${summary.endReason ?? "unknown"} durationMs=${summary.durationMs}` +
				`${summary.connectedMs !== undefined ? ` connectedMs=${summary.connectedMs}` : ""}` +
				` icePairType=${summary.icePairType} framesDelivered=${summary.framesDelivered}` +
				` framesDropped=${summary.framesDropped}`,
			{ summary },
		);
	}

	/** Contained fatal error from the Call handle layer (consumer/media). */
	#onCallFatal(ctx: CallContext, err: unknown): void {
		const error =
			err instanceof Error ? err : new CallError("CALL_ERROR", String(err), ctx.uuid);
		// Emits the "error" event (with call attribution) and ends the call
		// with reason "error" via the supervisor's error channel.
		this.#supervisor.failCall(ctx.uuid, error);
	}

	/** Last-resort guard: callback bugs must never crash the event plumbing. */
	#guard(fn: () => void): void {
		try {
			fn();
		} catch (err) {
			try {
				this.#log("error", "internal CallManager callback failure", {
					err: err instanceof Error ? err.message : String(err),
				});
			} catch {
				// Logging itself must not throw out.
			}
		}
	}
}

function buildCallSummary(info: CallInfo, ms: MediaSession | undefined): CallSummary {
	const endedAt = info.endedAt ?? Date.now();
	const summary: CallSummary = {
		uuid: info.uuid,
		peer: info.peer,
		direction: info.direction,
		durationMs: endedAt - info.startedAt,
		endReason: info.endReason,
		// v1: the MediaSession binding does not expose the selected candidate
		// pair — always "unknown" (documented media-layer delta; a future
		// wave may add MediaSession.selectedCandidatePairType).
		icePairType: "unknown",
		framesDelivered: 0,
		framesDropped: 0,
	};
	if (info.connectedAt !== undefined) {
		summary.connectedMs = endedAt - info.connectedAt;
	}
	if (ms instanceof WeriftMediaSession) {
		// Real werift sessions expose AudioBridge diagnostic counters.
		summary.framesDelivered = ms.audioBridge.deliveredFrames;
		summary.framesDropped = ms.audioBridge.droppedFrames;
	}
	return summary;
}

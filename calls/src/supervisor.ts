// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Ported from session-android
// `org/session/libsession/messaging/calls/CallMessageProcessor.kt` (GPLv3)
// and session-desktop `ts/receiver/callMessage.ts` (AGPLv3),
// © Session Foundation, modified. Licensed under AGPL-3.0-or-later.
//
// Modifications vs upstream:
//  - Adapted to structural dependency interfaces (SessionLike /
//    SignalingSender / MediaEngine) so the package builds without
//    @session.js/client installed; media/signaling are injected fakes in
//    tests and real adapters in Phase 4 (plan P2-T3 skeleton).
//  - Single-device headless operation: self-sync copies are still emitted
//    (wire compat / future linked devices) and self-receipt is honored.
//  - Inbound gate ORDER follows Android CallMessageProcessor:
//    (1) self-message handling (2) freshness (3) approval (4) busy
//    arbitration (5) type dispatch. Desktop-tolerant: an OFFER without a
//    preceding PRE_OFFER still creates a context.
//  - Heuristic end-reason on inbound END_CALL while outbound and never
//    connected: "remote-declined"; otherwise "remote-hangup" (documented —
//    the wire carries one END_CALL for decline, busy and hangup alike).
//  - Graveyard: ended contexts are kept ~10 s (detached, timers unref'd) to
//    absorb duplicate END_CALLs; then dropped. Documented optionality.
//  - P6-T1 (reconnect completion): the deferred reconnect paths are filled
//    in — initiator: restart-attempt loop (5 s × 5, OFFER with iceRestart,
//    IceFailureError + END_CALL on exhaustion); non-initiator: the restored
//    Appendix C `network-reconnect` FSM event enters `reconnecting` and a
//    ≤60 s wait (NON_INITIATOR_RECONNECT_WAIT_MS, spec §3.2) ends the call
//    with `ice-failed` if no restarted OFFER arrives. Timers are injectable
//    (CallSupervisorDeps.timers) so the reconnect cadence is testable
//    offline; the default is the global setTimeout/clearTimeout.
//  - Early-media-connect deferral (P4-T3 wiring fix): werift can complete
//    ICE BEFORE the signaling FSM is connectable (observed caller-side:
//    media "connected" while still in local-pre-offer with the ANSWER in
//    flight — and werift dedupes emissions, so the event is not repeated).
//    Such events are remembered (CallContext.earlyMediaConnected) and
//    applied once accept()/setRemoteAnswer/answer-restart brings the FSM to
//    `connecting`. Without this, the call hangs in `connecting` until the
//    60 s timeout despite a live media path.
//  - P6-T3 (containment): signaling-send failures on a context's critical
//    path now fail that call (error event + end reason "error") instead of
//    only logging, and `failCall` is public so the CallManager layer can
//    escalate media/consumer failures it observes. `CallContext.ignore()`
//    attaches a catch so the void return can never leak an unhandled
//    promise rejection.

import {
	CallError,
	CallInProgressError,
	IceFailureError,
	InvalidCallMessageError,
	InvalidCallTransitionError,
	MediaFailureError,
	PeerNotApprovedError,
} from "./errors.js";
import { StateMachine } from "./fsm/state-machine.js";
import type { CallEffect, CallFsmEvent } from "./fsm/state-machine.js";
import {
	DEFAULT_BOOSTED_POLL_MS,
	DEFAULT_CALL_TIMEOUT_MS,
	DEFAULT_ICE_BATCH_MS,
	ICE_RESTART_INTERVAL_MS,
	ICE_RESTART_MAX_ATTEMPTS,
	isFresh,
	NON_INITIATOR_RECONNECT_WAIT_MS,
	shouldDropSelfMessage,
} from "./policy.js";
import { defaultIceServers } from "./policy.js";
import type {
	Call,
	CallEventMap,
	CallInfo,
	CallLogger,
	CallManagerOptions,
	CallMessageEvent,
	CallMessageTypeValue,
	CallState,
	EndReason,
	IceServer,
	MediaEngine,
	MediaSession,
	MissedCallRecord,
	SessionLike,
	SignalingSender,
} from "./types.js";
import { callMessageTypeName, CallMessageType } from "./types.js";

/** Assumed session.js default poll interval, restored after calls (§4.6). */
export const ASSUMED_DEFAULT_POLL_INTERVAL_MS = 3000;

/** How long ended contexts linger to absorb duplicate END_CALLs. */
export const GRAVEYARD_MS = 10_000;

function unrefTimer(handle: unknown): void {
	(handle as { unref?: () => void } | undefined)?.unref?.();
}

// ---------------------------------------------------------------------------
// CallContext — per-uuid call state + the public Call handle surface
// ---------------------------------------------------------------------------

type CallEventListener<E extends keyof CallEventMap> = (payload: CallEventMap[E]) => void;

export class CallContext implements Call {
	readonly uuid: string;
	readonly peer: string;
	readonly direction: "inbound" | "outbound";
	/** Live view — mutated on every transition. */
	readonly info: CallInfo;
	readonly fsm: StateMachine;

	mediaSession: MediaSession | undefined;
	pendingOffer: string | undefined;
	pendingRemoteCandidates: { candidate: string; sdpMLineIndex: number; sdpMid: string }[] = [];
	everConnected = false;
	/**
	 * werift can complete ICE BEFORE the signaling FSM catches up (observed:
	 * caller-side media "connected" while still in local-pre-offer, ANSWER in
	 * flight; werift dedupes state emissions, so the event would be lost).
	 * The supervisor defers ice-connected until the FSM is connectable.
	 */
	earlyMediaConnected = false;
	endReason: EndReason | undefined;

	/** Set by the supervisor when this context is active (for timer cleanup). */
	callTimeoutTimer: unknown = undefined;
	restartTimer: unknown = undefined;
	restartAttempts = 0;
	/** Non-initiator ≤60 s wait for the restarted OFFER (P6-T1, spec §3.2). */
	reconnectWaitTimer: unknown = undefined;

	/** Supervisor-level transition observer (wired by registerContext). */
	onTransition: ((state: CallState) => void) | undefined;

	#listeners: { [E in keyof CallEventMap]: Set<CallEventListener<E>> } = {
		state: new Set(),
		"audio-level": new Set(),
		ended: new Set(),
		signaling: new Set(),
	};
	#audioCbs: ((pcm: Int16Array) => void)[] = [];
	#videoToggleCbs: ((enabled: boolean) => void)[] = [];
	readonly #logger: CallLogger | undefined;

	constructor(uuid: string, peer: string, direction: "inbound" | "outbound", startedAt: number, logger?: CallLogger) {
		this.uuid = uuid;
		this.peer = peer;
		this.direction = direction;
		this.#logger = logger;
		this.fsm = new StateMachine("idle", logger);
		this.info = { uuid, peer, direction, state: "idle", startedAt };
	}

	get state(): CallState {
		return this.fsm.getState();
	}

	/** Apply an FSM event, keep info.state in sync, emit "state". */
	apply(event: CallFsmEvent, ctx?: { isInitiator?: boolean }): CallEffect[] {
		const result = this.fsm.send(event, ctx);
		this.info.state = result.next;
		this.emit("state", result.next);
		this.onTransition?.(result.next);
		return result.effects;
	}

	attachMediaSession(ms: MediaSession): void {
		this.mediaSession = ms;
		ms.onAudio((pcm) => {
			for (const cb of this.#audioCbs) cb(pcm);
		});
		ms.onRemoteVideoToggle((enabled) => {
			for (const cb of this.#videoToggleCbs) cb(enabled);
		});
	}

	// --- Call interface (delegating) -------------------------------------

	accept(): Promise<void> {
		return this.#supervisorActions.accept(this.uuid);
	}
	reject(): Promise<void> {
		return this.#supervisorActions.reject(this.uuid);
	}
	ignore(): void {
		// Containment (P6-T3): the void signature must never leak an unhandled
		// rejection (e.g. ignore racing teardown). Log + swallow.
		void this.#supervisorActions.ignore(this.uuid).catch((err: unknown) => {
			this.#logger?.("debug", "ignore() failed (call already gone?)", {
				uuid: this.uuid,
				err: err instanceof Error ? err.message : String(err),
			});
		});
	}
	hangup(): Promise<void> {
		return this.#supervisorActions.hangup(this.uuid);
	}

	onAudio(cb: (pcm: Int16Array) => void): void {
		this.#audioCbs.push(cb);
	}
	writeAudio(pcm: Int16Array): boolean {
		return this.mediaSession ? this.mediaSession.writeAudio(pcm) : false;
	}
	onRemoteVideoToggle(cb: (enabled: boolean) => void): void {
		this.#videoToggleCbs.push(cb);
	}

	on<E extends keyof CallEventMap>(event: E, cb: CallEventListener<E>): void {
		this.#listeners[event].add(cb);
	}
	off<E extends keyof CallEventMap>(event: E, cb: CallEventListener<E>): void {
		this.#listeners[event].delete(cb);
	}
	emit<E extends keyof CallEventMap>(event: E, payload: CallEventMap[E]): void {
		for (const cb of this.#listeners[event]) {
			cb(payload);
		}
	}

	/** Late-bound back-reference so Call methods can drive the supervisor. */
	#supervisorActions: SupervisorActions = {
		accept: () => Promise.resolve(),
		reject: () => Promise.resolve(),
		ignore: () => Promise.resolve(),
		hangup: () => Promise.resolve(),
	};
	bindSupervisorActions(actions: SupervisorActions): void {
		this.#supervisorActions = actions;
	}
}

interface SupervisorActions {
	accept(uuid: string): Promise<void>;
	reject(uuid: string): Promise<void>;
	ignore(uuid: string): Promise<void>;
	hangup(uuid: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// CallSupervisor
// ---------------------------------------------------------------------------

/**
 * Injectable timer pair (P6-T1 testability: the ICE-restart cadence and the
 * non-initiator reconnect wait are driven by fixed policy constants —
 * ICE_RESTART_INTERVAL_MS / NON_INITIATOR_RECONNECT_WAIT_MS — so tests
 * advance a fake scheduler instead of waiting real seconds). Default:
 * global setTimeout/clearTimeout.
 */
export interface CallTimers {
	setTimeout(cb: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

export interface CallSupervisorDeps {
	session: SessionLike;
	signaling: SignalingSender;
	media: MediaEngine;
	options?: CallManagerOptions;
	logger?: CallLogger;
	/** Injectable clock (default Date.now). */
	now?: () => number;
	/** Injectable UUID factory (default crypto.randomUUID). */
	createUuid?: () => string;
	/** Injectable timers (default global setTimeout/clearTimeout). */
	timers?: CallTimers;
}

export class CallSupervisor {
	readonly #session: SessionLike;
	readonly #signaling: SignalingSender;
	readonly #media: MediaEngine;
	readonly #options: Required<
		Pick<
			CallManagerOptions,
			| "iceTransportPolicy"
			| "callTimeoutMs"
			| "iceBatchIntervalMs"
			| "boostedPollIntervalMs"
			| "requireApprovedContact"
			| "autoApproveOnCall"
		>
	> & { iceServers: IceServer[] };
	readonly #log: CallLogger;
	readonly #now: () => number;
	readonly #createUuid: () => string;
	readonly #timers: CallTimers;

	readonly #contexts = new Map<string, CallContext>();
	/** Ended contexts lingering to absorb duplicate END_CALLs. */
	readonly #graveyard = new Map<string, { peer: string; endReason?: EndReason }>();
	readonly #approvedPeers = new Set<string>();
	#pollBoosted = false;
	#disposed = false;

	// Event callback registries
	#incomingCbs = new Set<(ctx: CallContext) => void>();
	#outgoingCbs = new Set<(ctx: CallContext) => void>();
	#missedCbs = new Set<(record: MissedCallRecord) => void>();
	#endedCbs = new Set<(ctx: CallContext, info: CallInfo) => void>();
	#stateChangedCbs = new Set<(ctx: CallContext, state: CallState) => void>();
	// ctx is passed when the error is attributable to a specific call (P6-T3
	// error events at the CallManager layer carry the Call handle).
	#errorCbs = new Set<(err: Error, ctx?: CallContext) => void>();

	readonly #onCallEvent = (msg: CallMessageEvent): void => {
		try {
			this.#handleInbound(msg);
		} catch (err) {
			// Chaos protection (plan P6-T3): NEVER throw out to the session
			// event emitter — log + surface on the error channel.
			this.#emitError(err instanceof Error ? err : new CallError("INBOUND_HANDLER", String(err)));
		}
	};

	constructor(deps: CallSupervisorDeps) {
		this.#session = deps.session;
		this.#signaling = deps.signaling;
		this.#media = deps.media;
		const o = deps.options ?? {};
		this.#options = {
			iceServers: o.iceServers ?? defaultIceServers(),
			iceTransportPolicy: o.iceTransportPolicy ?? "all",
			callTimeoutMs: o.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
			iceBatchIntervalMs: o.iceBatchIntervalMs ?? DEFAULT_ICE_BATCH_MS,
			boostedPollIntervalMs: o.boostedPollIntervalMs ?? DEFAULT_BOOSTED_POLL_MS,
			requireApprovedContact: o.requireApprovedContact ?? true,
			autoApproveOnCall: o.autoApproveOnCall ?? true,
		};
		this.#log = deps.logger ?? (() => undefined);
		this.#now = deps.now ?? (() => Date.now());
		this.#createUuid = deps.createUuid ?? (() => crypto.randomUUID());
		this.#timers =
			deps.timers ??
			({
				setTimeout: (cb, ms) => setTimeout(cb, ms),
				clearTimeout: (handle) => clearTimeout(handle as never),
			} satisfies CallTimers);
		this.#session.on("call", this.#onCallEvent);
	}

	// --- Timer plumbing (injectable — see CallTimers) -------------------------

	#setTimeout(cb: () => void, ms: number): unknown {
		return this.#timers.setTimeout(cb, ms);
	}
	#clearTimeout(handle: unknown): void {
		this.#timers.clearTimeout(handle);
	}

	// --- Event registration ----------------------------------------------

	onIncoming(cb: (ctx: CallContext) => void): void {
		this.#incomingCbs.add(cb);
	}
	onOutgoing(cb: (ctx: CallContext) => void): void {
		this.#outgoingCbs.add(cb);
	}
	onMissed(cb: (record: MissedCallRecord) => void): void {
		this.#missedCbs.add(cb);
	}
	onEnded(cb: (ctx: CallContext, info: CallInfo) => void): void {
		this.#endedCbs.add(cb);
	}
	onStateChanged(cb: (ctx: CallContext, state: CallState) => void): void {
		this.#stateChangedCbs.add(cb);
	}
	onError(cb: (err: Error, ctx?: CallContext) => void): void {
		this.#errorCbs.add(cb);
	}

	// --- Policy -----------------------------------------------------------

	markApproved(peer: string): void {
		this.#approvedPeers.add(peer);
	}

	isApproved(peer: string): boolean {
		return this.#approvedPeers.has(peer);
	}

	get activeContext(): CallContext | undefined {
		for (const ctx of this.#contexts.values()) {
			return ctx;
		}
		return undefined;
	}

	// --- Outbound ----------------------------------------------------------

	/**
	 * Place an outbound call. Throws synchronously on policy errors
	 * (PeerNotApprovedError / CallInProgressError). Signaling continues
	 * asynchronously; subscribe via onOutgoing()/context events.
	 */
	placeCall(peer: string): CallContext {
		if (this.#disposed) {
			throw new CallError("DISPOSED", "CallSupervisor is disposed");
		}
		if (this.#options.requireApprovedContact && !this.#approvedPeers.has(peer)) {
			throw new PeerNotApprovedError(peer);
		}
		const active = this.activeContext;
		if (active) {
			throw new CallInProgressError(active.uuid);
		}
		if (this.#options.autoApproveOnCall) {
			// Fire-and-forget with error containment (Desktop behavior).
			this.#session.acceptConversationRequest({ from: peer }).catch((err: unknown) => {
				this.#log("warn", "auto-approve conversation request failed", { peer, err });
				this.#emitError(err instanceof Error ? err : new Error(String(err)));
			});
		}
		this.markApproved(peer);

		const uuid = this.#createUuid();
		const ctx = this.#registerContext(uuid, peer, "outbound");
		// FSM: idle -> local-pre-offer
		// effects: gen-uuid, send-pre-offer, send-offer, start-call-timeout, boost-poll
		ctx.apply("send-pre-offer");
		this.#boostPoll();
		this.#startCallTimeout(ctx);
		for (const cb of this.#outgoingCbs) cb(ctx);

		// Signaling: PRE_OFFER immediately, OFFER after createOffer resolves.
		void this.#signaling
			.sendToPeer(peer, { type: CallMessageType.PRE_OFFER, uuid })
			.catch((err) => this.#onSignalingError(ctx, err));
		this.#trace(ctx, "out", CallMessageType.PRE_OFFER);

		let ms: MediaSession;
		try {
			ms = this.#createMediaSession(ctx, "caller");
		} catch (err) {
			// Synchronous media-engine failure (P6-T3 containment): fail the
			// just-registered context (error event + end, reason "error") and
			// rethrow so CallManager.call() rejects with the typed error.
			this.#failCall(
				ctx,
				err instanceof Error ? err : new MediaFailureError(String(err), uuid),
			);
			throw err;
		}
		void ms
			.createOffer()
			.then((offer) =>
				this.#signaling.sendToPeer(peer, {
					type: CallMessageType.OFFER,
					uuid,
					sdps: [offer],
				}),
			)
			.then(() => {
				this.#trace(ctx, "out", CallMessageType.OFFER);
			})
			.catch((err) => this.#onSignalingError(ctx, err));
		return ctx;
	}

	// --- User actions -------------------------------------------------------

	/** Callee accepts: setRemoteOffer(pending), createAnswer, ANSWER×2 (peer+self). */
	async accept(uuid: string): Promise<void> {
		const ctx = this.#requireContext(uuid);
		if (!ctx.pendingOffer) {
			throw new InvalidCallMessageError("accept before OFFER received", uuid);
		}
		// FSM: remote-ring -> connecting
		ctx.apply("user-accept");
		const ms = this.#requireMedia(ctx);
		try {
			await ms.setRemoteOffer(ctx.pendingOffer);
			const answer = await ms.createAnswer();
			await this.#signaling.sendToPeer(ctx.peer, {
				type: CallMessageType.ANSWER,
				uuid,
				sdps: [answer],
			});
			this.#trace(ctx, "out", CallMessageType.ANSWER);
			// Self-sync copy so linked devices stop ringing (§4.5).
			await this.#signaling.sendToSelf({ type: CallMessageType.ANSWER, uuid, sdps: [answer] });
			this.#drainRemoteCandidates(ctx);
			this.#maybeApplyEarlyConnected(ctx);
		} catch (err) {
			this.#failCall(ctx, err instanceof Error ? err : new MediaFailureError(String(err), uuid));
		}
	}

	/** Callee rejects: END_CALL peer+self. Caller-view reason: remote-declined. */
	async reject(uuid: string): Promise<void> {
		const ctx = this.#requireContext(uuid);
		// FSM: remote-pre-offer|remote-ring -> disconnected
		ctx.apply("user-decline");
		await this.#sendEndCall(ctx);
		this.#endCall(ctx, "remote-declined");
	}

	/** Local-only: no wire message; record missed (reason ignored). */
	async ignore(uuid: string): Promise<void> {
		const ctx = this.#requireContext(uuid);
		// FSM: remote-pre-offer|remote-ring -> idle, effects: record-missed-local
		ctx.apply("user-ignore");
		this.#recordMissed(ctx.peer, "ignored");
		this.#teardownContext(ctx);
	}

	/** Hangup: datachannel hint best-effort + END_CALL peer+self. */
	async hangup(uuid: string): Promise<void> {
		const ctx = this.#requireContext(uuid);
		if (ctx.state === "remote-pre-offer" || ctx.state === "remote-ring") {
			// Callee hanging up while ringing IS a decline in the FSM table.
			return this.reject(uuid);
		}
		ctx.apply("user-hangup");
		try {
			ctx.mediaSession?.sendDataChannelMessage({ hangup: true });
		} catch (err) {
			this.#log("debug", "datachannel hangup hint failed (best-effort)", { uuid, err });
		}
		await this.#sendEndCall(ctx);
		this.#endCall(ctx, "local-hangup");
	}

	/** Tear everything down: hangup active calls, unhook, restore poll cadence. */
	async dispose(): Promise<void> {
		if (this.#disposed) {
			return;
		}
		this.#disposed = true;
		for (const ctx of [...this.#contexts.values()]) {
			if (ctx.state !== "idle" && ctx.state !== "disconnected") {
				const reason: EndReason =
					ctx.state === "remote-pre-offer" || ctx.state === "remote-ring"
						? "remote-declined"
						: "local-hangup";
				try {
					ctx.apply(reason === "remote-declined" ? "user-decline" : "user-hangup");
					ctx.mediaSession?.sendDataChannelMessage({ hangup: true });
				} catch (err) {
					this.#log("debug", "dispose hangup transition failed", { uuid: ctx.uuid, err });
				}
				try {
					await this.#sendEndCall(ctx);
				} catch (err) {
					this.#log("warn", "dispose END_CALL send failed", { uuid: ctx.uuid, err });
				}
				this.#endCall(ctx, reason);
			} else {
				this.#teardownContext(ctx);
			}
		}
		this.#session.off("call", this.#onCallEvent);
		this.#restorePoll();
	}

	// --- Inbound dispatch (Android CallMessageProcessor order) ---------------

	#handleInbound(msg: CallMessageEvent): void {
		if (this.#disposed) {
			return;
		}
		// (1) Self-message handling — own-swarm sync copies (§4.5).
		if (msg.from === this.#session.getSessionID()) {
			this.#handleSelfMessage(msg);
			return;
		}
		// (2) Freshness gates (§3.1): TTL / 15-min absolute / 60-s PRE_OFFER.
		const kind = msg.type === CallMessageType.PRE_OFFER ? "pre-offer" : "other";
		if (!isFresh(kind, msg.timestamp, this.#now())) {
			if (msg.type === CallMessageType.PRE_OFFER) {
				this.#recordMissed(msg.from, "stale");
			}
			this.#log("debug", "dropped stale call message", {
				uuid: msg.uuid,
				type: msg.type,
				ageMs: this.#now() - msg.timestamp,
			});
			return;
		}
		// (3) Approval gate — drop unapproved silently, NO missed record
		//     (Android behavior; Desktop: isApproved || weSentAMessage).
		if (this.#options.requireApprovedContact && !this.#approvedPeers.has(msg.from)) {
			this.#log("debug", "dropped unapproved inbound call message", {
				uuid: msg.uuid,
				from: msg.from,
			});
			return;
		}
		// (4) Busy arbitration — a DIFFERENT uuid while a call is active.
		const active = this.activeContext;
		if (active && active.uuid !== msg.uuid) {
			this.#recordMissed(msg.from, "busy");
			void this.#signaling
				.sendToPeer(msg.from, { type: CallMessageType.END_CALL, uuid: msg.uuid })
				.catch((err) => this.#log("warn", "busy END_CALL send failed", { err }));
			this.#log("info", "inbound call while busy — missed recorded, END_CALL sent", {
				inboundUuid: msg.uuid,
				activeUuid: active.uuid,
			});
			try {
				active.apply("inbound-while-busy");
			} catch (err) {
				this.#log("debug", "inbound-while-busy transition rejected", { err });
			}
			return;
		}
		// (5) Type dispatch.
		this.#dispatch(msg);
	}

	#handleSelfMessage(msg: CallMessageEvent): void {
		const ctx = this.#contexts.get(msg.uuid);
		switch (msg.type) {
			case CallMessageType.ANSWER: {
				// Another of our devices answered (self-sync race, P6-T2).
				if (ctx) {
					this.#trace(ctx, "in", msg.type);
					try {
						ctx.apply("self-answer");
						this.#endCall(ctx, "answered-elsewhere");
					} catch (err) {
						this.#log("debug", "self-answer ignored in current state", {
							uuid: msg.uuid,
							state: ctx.state,
							err,
						});
					}
				}
				return;
			}
			case CallMessageType.END_CALL: {
				// Another of our devices ended the call.
				if (ctx) {
					this.#trace(ctx, "in", msg.type);
					try {
						ctx.apply("self-end-call");
						this.#endCall(ctx, "ended-elsewhere");
					} catch (err) {
						this.#log("debug", "self-end-call ignored in current state", {
							uuid: msg.uuid,
							state: ctx.state,
							err,
						});
					}
				}
				return;
			}
			default: {
				// Self-sent PRE_OFFER/OFFER/ICE_CANDIDATES/PROVISIONAL_ANSWER
				// must be dropped on receipt from self (§3.1).
				if (shouldDropSelfMessage(msg.type)) {
					if (ctx) {
						try {
							ctx.apply("drop-self-signaling");
						} catch (err) {
							this.#log("debug", "drop-self-signaling transition rejected", { err });
						}
					}
					this.#log("debug", "dropped self-sent signaling", {
						uuid: msg.uuid,
						type: msg.type,
					});
				}
				return;
			}
		}
	}

	#dispatch(msg: CallMessageEvent): void {
		switch (msg.type) {
			case CallMessageType.PRE_OFFER:
				this.#onPreOffer(msg);
				return;
			case CallMessageType.OFFER:
				this.#onOffer(msg);
				return;
			case CallMessageType.ICE_CANDIDATES:
				this.#onIceCandidates(msg);
				return;
			case CallMessageType.ANSWER:
				this.#onAnswer(msg);
				return;
			case CallMessageType.PROVISIONAL_ANSWER:
				this.#log("debug", "PROVISIONAL_ANSWER no-op", { uuid: msg.uuid });
				return;
			case CallMessageType.END_CALL:
				this.#onEndCall(msg);
				return;
		}
	}

	#onPreOffer(msg: CallMessageEvent): void {
		if (this.#contexts.has(msg.uuid)) {
			this.#log("debug", "duplicate PRE_OFFER ignored", { uuid: msg.uuid });
			return;
		}
		const ctx = this.#registerContext(msg.uuid, msg.from, "inbound");
		// FSM: idle -> remote-pre-offer
		// effects: freshness-check-60s (done above), ring, boost-poll, force-poll
		ctx.apply("receive-pre-offer");
		this.#boostPoll();
		// force-poll: SessionLike exposes only setPollInterval; the boost is
		// the observable effect. An immediate-poll hook is future work.
		this.#log("debug", "inbound PRE_OFFER — ringing", { uuid: msg.uuid, from: msg.from });
		for (const cb of this.#incomingCbs) cb(ctx);
	}

	#onOffer(msg: CallMessageEvent): void {
		let ctx = this.#contexts.get(msg.uuid);
		if (!ctx) {
			// Desktop-tolerant: OFFER arrived without PRE_OFFER — create anyway.
			ctx = this.#registerContext(msg.uuid, msg.from, "inbound");
			ctx.apply("receive-pre-offer");
			this.#boostPoll();
			for (const cb of this.#incomingCbs) cb(ctx);
		}
		const offer = msg.sdps[0];
		if (!offer) {
			this.#log("warn", "OFFER without SDP dropped", { uuid: msg.uuid });
			return;
		}
		this.#trace(ctx, "in", msg.type);
		if (
			ctx.direction === "inbound" &&
			(ctx.state === "reconnecting" || ctx.state === "pending-reconnect")
		) {
			// Mid-call ICE restart offer from the initiator (guard: non-initiator).
			// Defensively: if the restart wait hasn't transitioned us yet
			// (pending-reconnect), enter `reconnecting` first.
			if (ctx.state === "pending-reconnect") {
				try {
					ctx.apply("network-reconnect", { isInitiator: false });
					this.#clearReconnectWaitTimer(ctx);
				} catch (err) {
					this.#log("debug", "network-reconnect rejected on restart offer", {
						uuid: msg.uuid,
						err,
					});
					return;
				}
			}
			try {
				ctx.apply("receive-offer-restart", { isInitiator: false });
			} catch (err) {
				this.#log("debug", "receive-offer-restart rejected", { uuid: msg.uuid, err });
				return;
			}
			this.#answerRestart(ctx, offer);
			return;
		}
		try {
			ctx.apply("receive-offer");
		} catch (err) {
			if (err instanceof InvalidCallTransitionError) {
				this.#log("debug", "OFFER ignored in current state", {
					uuid: msg.uuid,
					state: ctx.state,
				});
				return;
			}
			throw err;
		}
		ctx.pendingOffer = offer;
		if (!ctx.mediaSession) {
			this.#createMediaSession(ctx, "callee");
		}
	}

	#onIceCandidates(msg: CallMessageEvent): void {
		const ctx = this.#contexts.get(msg.uuid);
		if (!ctx) {
			this.#log("debug", "ICE_CANDIDATES for unknown call dropped", { uuid: msg.uuid });
			return;
		}
		this.#trace(ctx, "in", msg.type);
		for (let i = 0; i < msg.sdps.length; i++) {
			const candidate = msg.sdps[i];
			const sdpMLineIndex = msg.sdpMLineIndexes[i];
			const sdpMid = msg.sdpMids[i];
			if (candidate === undefined || sdpMLineIndex === undefined || sdpMid === undefined) {
				this.#log("warn", "ICE_CANDIDATES parallel-array length mismatch", { uuid: msg.uuid, i });
				continue;
			}
			const c = { candidate, sdpMLineIndex, sdpMid };
			if (ctx.mediaSession) {
				void ctx.mediaSession.addRemoteCandidate(c).catch((err) => {
					this.#log("warn", "addRemoteCandidate failed", { uuid: msg.uuid, err });
				});
			} else {
				ctx.pendingRemoteCandidates.push(c);
			}
		}
	}

	#onAnswer(msg: CallMessageEvent): void {
		const ctx = this.#contexts.get(msg.uuid);
		if (!ctx) {
			this.#log("debug", "ANSWER for unknown call dropped", { uuid: msg.uuid });
			return;
		}
		this.#trace(ctx, "in", msg.type);
		const answer = msg.sdps[0];
		if (!answer) {
			this.#log("warn", "ANSWER without SDP dropped", { uuid: msg.uuid });
			return;
		}
		try {
			// FSM: local-pre-offer (supplementary) | local-ring | reconnecting -> connecting
			ctx.apply("receive-answer");
		} catch (err) {
			if (err instanceof InvalidCallTransitionError) {
				this.#log("debug", "ANSWER ignored in current state", {
					uuid: msg.uuid,
					state: ctx.state,
				});
				return;
			}
			throw err;
		}
		const ms = ctx.mediaSession;
		if (!ms) {
			this.#failCall(ctx, new MediaFailureError("ANSWER received without media session", ctx.uuid));
			return;
		}
		void ms
			.setRemoteAnswer(answer)
			.then(() => {
				this.#drainRemoteCandidates(ctx);
				this.#maybeApplyEarlyConnected(ctx);
			})
			.catch((err) => {
				this.#failCall(
					ctx,
					err instanceof Error ? err : new MediaFailureError(String(err), ctx.uuid),
				);
			});
	}

	#onEndCall(msg: CallMessageEvent): void {
		const ctx = this.#contexts.get(msg.uuid);
		if (!ctx) {
			if (this.#graveyard.has(msg.uuid)) {
				this.#log("debug", "duplicate END_CALL absorbed by graveyard", { uuid: msg.uuid });
			} else {
				this.#log("debug", "END_CALL for unknown call dropped", { uuid: msg.uuid });
			}
			return;
		}
		this.#trace(ctx, "in", msg.type);
		const prevState = ctx.state;
		try {
			ctx.apply("receive-end-call");
		} catch (err) {
			this.#log("debug", "receive-end-call rejected", { uuid: msg.uuid, err });
			return;
		}
		// Heuristic end reason: outbound + never connected => callee declined;
		// otherwise the peer hung up. (One END_CALL covers decline/busy/hangup.)
		const reason: EndReason =
			ctx.direction === "outbound" && !ctx.everConnected && prevState !== "connected"
				? "remote-declined"
				: "remote-hangup";
		this.#endCall(ctx, reason);
	}

	// --- Media wiring --------------------------------------------------------

	#createMediaSession(ctx: CallContext, role: "caller" | "callee"): MediaSession {
		const ms = this.#media.createSession(ctx.uuid, role, {
			iceServers: this.#options.iceServers,
			iceTransportPolicy: this.#options.iceTransportPolicy,
		});
		ctx.attachMediaSession(ms);
		ms.onLocalCandidate((c) => {
			// Trickle ICE is batched by the media agent's adapter in Phase 4;
			// the supervisor keeps the plumbing observable here.
			this.#log("debug", "local ICE candidate", { uuid: ctx.uuid });
		});
		ms.onConnectionState((s) => {
			this.#onMediaConnectionState(ctx, s);
		});
		ms.onDataChannelMessage((m) => {
			if (m.hangup || m.hang_up) {
				// Datachannel hangup is a HINT; END_CALL over the swarm is
				// authoritative (§3.1). Accelerate teardown.
				this.#log("debug", "datachannel hangup hint received", { uuid: ctx.uuid });
				if (ctx.state !== "disconnected" && ctx.state !== "idle") {
					try {
						ctx.apply("receive-end-call");
						this.#endCall(ctx, "remote-hangup");
					} catch (err) {
						this.#log("debug", "datachannel-hint end rejected", { uuid: ctx.uuid, err });
					}
				}
				return;
			}
			// {"video": bool} toggles are surfaced via MediaSession
			// .onRemoteVideoToggle (wired in attachMediaSession) — the
			// supervisor does not act on them (v1: informational only).
		});
		this.#drainRemoteCandidates(ctx);
		return ms;
	}

	#onMediaConnectionState(
		ctx: CallContext,
		s: "connecting" | "connected" | "disconnected" | "failed",
	): void {
		try {
			switch (s) {
				case "connected": {
					if (ctx.state === "connecting" || ctx.state === "reconnecting") {
						this.#markConnected(ctx);
					} else if (ctx.state === "connected") {
						// Duplicate — ignore.
					} else {
						// Media completed before the FSM is connectable
						// (caller-side ANSWER still in flight — werift can win
						// that race; it will not re-emit). Defer; the deferred
						// mark fires from accept()/#onAnswer/#answerRestart
						// once the FSM reaches `connecting`.
						ctx.earlyMediaConnected = true;
						this.#log("debug", "media connected before FSM connectable — deferring", {
							uuid: ctx.uuid,
							state: ctx.state,
						});
					}
					break;
				}
				case "disconnected": {
					ctx.earlyMediaConnected = false; // a flap invalidates it
					if (ctx.state === "connected") {
						ctx.apply("ice-disconnected");
						this.#scheduleRestartIfInitiator(ctx);
					}
					break;
				}
				case "failed": {
					this.#failCall(ctx, new MediaFailureError("ICE connection failed", ctx.uuid), "ice-failed");
					break;
				}
				case "connecting":
					break;
			}
		} catch (err) {
			this.#log("debug", "media connection-state transition rejected", {
				uuid: ctx.uuid,
				s,
				err,
			});
		}
	}

	/** FSM ice-connected + the mark-connected effect bundle. */
	#markConnected(ctx: CallContext): void {
		ctx.earlyMediaConnected = false;
		ctx.apply("ice-connected");
		ctx.everConnected = true;
		ctx.info.connectedAt = this.#now();
		this.#cancelCallTimeout(ctx);
		ctx.restartAttempts = 0;
		this.#clearRestartTimer(ctx);
		this.#clearReconnectWaitTimer(ctx);
	}

	/**
	 * Apply a deferred early media-"connected" once the FSM has become
	 * connectable (called after accept(), setRemoteAnswer, answer-restart).
	 */
	#maybeApplyEarlyConnected(ctx: CallContext): void {
		if (
			ctx.earlyMediaConnected &&
			(ctx.state === "connecting" || ctx.state === "reconnecting")
		) {
			this.#markConnected(ctx);
		}
	}

	/**
	 * Mid-call ICE disconnect handling (P6-T1, spec §3.2):
	 * - initiator (outbound): every ICE_RESTART_INTERVAL_MS (5 s), up to
	 *   ICE_RESTART_MAX_ATTEMPTS (5) restart OFFERs (`iceRestart: true`, same
	 *   uuid, new SDP). FSM: restart-attempt → reconnecting (first attempt;
	 *   later attempts stay in `reconnecting` and just resend). A restart
	 *   ANSWER takes the FSM reconnecting → connecting and `ice-connected`
	 *   restores `connected` (restartAttempts/reset timer cleared there).
	 *   Exhaustion → IceFailureError, END_CALL peer+self, endReason
	 *   `ice-failed` (Android WebRtcCallBridge behavior).
	 * - non-initiator (inbound): FSM `network-reconnect` (restored Appendix C
	 *   row) → reconnecting, then wait ≤ NON_INITIATOR_RECONNECT_WAIT_MS
	 *   (60 s, spec §3.2) for the restarted OFFER — answered via
	 *   receive-offer-restart in #onOffer. Elapsed → END_CALL, `ice-failed`.
	 */
	#scheduleRestartIfInitiator(ctx: CallContext): void {
		if (ctx.direction !== "outbound") {
			this.#beginNonInitiatorReconnectWait(ctx);
			return;
		}
		const attempt = (): void => {
			ctx.restartTimer = undefined;
			// Recovered (connecting/connected) or torn down → stop the chain.
			if (ctx.state !== "pending-reconnect" && ctx.state !== "reconnecting") {
				return;
			}
			if (ctx.restartAttempts >= ICE_RESTART_MAX_ATTEMPTS) {
				this.#log("warn", "ICE restart attempts exhausted", { uuid: ctx.uuid });
				const err = new IceFailureError(
					`ICE restart failed after ${ICE_RESTART_MAX_ATTEMPTS} attempts`,
					ctx.uuid,
				);
				this.#emitError(err, ctx);
				try {
					ctx.apply("user-hangup");
				} catch (err2) {
					this.#log("debug", "hangup after ICE exhaustion rejected", { err: err2 });
				}
				void this.#sendEndCall(ctx).catch(() => undefined);
				this.#endCall(ctx, "ice-failed");
				return;
			}
			if (ctx.state === "pending-reconnect") {
				// First attempt: FSM pending-reconnect → reconnecting.
				try {
					ctx.apply("restart-attempt", { isInitiator: true });
				} catch (err) {
					this.#log("debug", "restart-attempt rejected", { uuid: ctx.uuid, err });
					return;
				}
			}
			ctx.restartAttempts += 1;
			this.#log("info", "ICE restart attempt", {
				uuid: ctx.uuid,
				attempt: ctx.restartAttempts,
				max: ICE_RESTART_MAX_ATTEMPTS,
			});
			const ms = ctx.mediaSession;
			if (ms) {
				void ms
					.createOffer({ iceRestart: true })
					.then((offer) =>
						this.#signaling.sendToPeer(ctx.peer, {
							type: CallMessageType.OFFER,
							uuid: ctx.uuid,
							sdps: [offer],
						}),
					)
					.then(() => {
						this.#trace(ctx, "out", CallMessageType.OFFER);
					})
					.catch((err) => this.#onSignalingError(ctx, err));
			}
			ctx.restartTimer = this.#setTimeout(attempt, ICE_RESTART_INTERVAL_MS);
			unrefTimer(ctx.restartTimer);
		};
		ctx.restartTimer = this.#setTimeout(attempt, ICE_RESTART_INTERVAL_MS);
		unrefTimer(ctx.restartTimer);
	}

	/** Non-initiator: enter `reconnecting`, await the restarted OFFER ≤60 s. */
	#beginNonInitiatorReconnectWait(ctx: CallContext): void {
		try {
			ctx.apply("network-reconnect", { isInitiator: false });
		} catch (err) {
			this.#log("debug", "network-reconnect rejected", { uuid: ctx.uuid, err });
			return;
		}
		this.#log("info", "non-initiator awaiting ICE restart offer", {
			uuid: ctx.uuid,
			waitMs: NON_INITIATOR_RECONNECT_WAIT_MS,
		});
		ctx.reconnectWaitTimer = this.#setTimeout(() => {
			ctx.reconnectWaitTimer = undefined;
			this.#onReconnectWaitExpired(ctx);
		}, NON_INITIATOR_RECONNECT_WAIT_MS);
		unrefTimer(ctx.reconnectWaitTimer);
	}

	#onReconnectWaitExpired(ctx: CallContext): void {
		if (!this.#contexts.has(ctx.uuid)) {
			return;
		}
		if (ctx.state !== "reconnecting" && ctx.state !== "pending-reconnect") {
			// Reconnected or ended meanwhile.
			return;
		}
		this.#log("warn", "ICE restart wait expired (non-initiator, spec §3.2 ≤60 s)", {
			uuid: ctx.uuid,
		});
		const err = new IceFailureError(
			`No ICE restart offer within ${NON_INITIATOR_RECONNECT_WAIT_MS}ms`,
			ctx.uuid,
		);
		this.#emitError(err, ctx);
		try {
			ctx.apply("timeout");
		} catch (err2) {
			this.#log("debug", "reconnect-wait timeout transition rejected", { uuid: ctx.uuid, err: err2 });
		}
		void this.#sendEndCall(ctx).catch(() => undefined);
		this.#endCall(ctx, "ice-failed");
	}

	#answerRestart(ctx: CallContext, offer: string): void {
		this.#clearReconnectWaitTimer(ctx);
		const ms = ctx.mediaSession;
		if (!ms) {
			this.#failCall(ctx, new MediaFailureError("restart OFFER without media session", ctx.uuid));
			return;
		}
		void (async () => {
			try {
				await ms.setRemoteOffer(offer);
				const answer = await ms.createAnswer();
				await this.#signaling.sendToPeer(ctx.peer, {
					type: CallMessageType.ANSWER,
					uuid: ctx.uuid,
					sdps: [answer],
				});
				await this.#signaling.sendToSelf({
					type: CallMessageType.ANSWER,
					uuid: ctx.uuid,
					sdps: [answer],
				});
				this.#drainRemoteCandidates(ctx);
				this.#maybeApplyEarlyConnected(ctx);
			} catch (err) {
				this.#failCall(
					ctx,
					err instanceof Error ? err : new MediaFailureError(String(err), ctx.uuid),
				);
			}
		})();
	}

	#drainRemoteCandidates(ctx: CallContext): void {
		const ms = ctx.mediaSession;
		if (!ms || ctx.pendingRemoteCandidates.length === 0) {
			return;
		}
		const buffered = ctx.pendingRemoteCandidates;
		ctx.pendingRemoteCandidates = [];
		for (const c of buffered) {
			void ms.addRemoteCandidate(c).catch((err) => {
				this.#log("warn", "drained addRemoteCandidate failed", { uuid: ctx.uuid, err });
			});
		}
	}

	// --- Timers ----------------------------------------------------------------

	#startCallTimeout(ctx: CallContext): void {
		ctx.callTimeoutTimer = this.#setTimeout(() => {
			ctx.callTimeoutTimer = undefined;
			this.#onCallTimeout(ctx);
		}, this.#options.callTimeoutMs);
		unrefTimer(ctx.callTimeoutTimer);
	}

	#cancelCallTimeout(ctx: CallContext): void {
		if (ctx.callTimeoutTimer !== undefined) {
			this.#clearTimeout(ctx.callTimeoutTimer);
			ctx.callTimeoutTimer = undefined;
		}
	}

	#onCallTimeout(ctx: CallContext): void {
		if (!this.#contexts.has(ctx.uuid)) {
			return;
		}
		try {
			// FSM: local-pre-offer (supplementary) | local-ring | remote-ring |
			//      connecting | reconnecting -> disconnected
			ctx.apply("timeout");
		} catch (err) {
			// Already connected/ended — timeout raced; cancel-timeout effect
			// should have cleared us. Log + swallow.
			this.#log("debug", "call timeout in non-timeoutable state", {
				uuid: ctx.uuid,
				state: ctx.state,
				err,
			});
			return;
		}
		// effects: send-end-call-peer-if-local, send-end-call-self, reason-timeout
		void this.#sendEndCall(ctx).catch(() => undefined);
		// Caller-side timeout: NOT a missed call (it's our own call).
		this.#endCall(ctx, "timeout");
	}

	#clearRestartTimer(ctx: CallContext): void {
		if (ctx.restartTimer !== undefined) {
			this.#clearTimeout(ctx.restartTimer);
			ctx.restartTimer = undefined;
		}
	}

	#clearReconnectWaitTimer(ctx: CallContext): void {
		if (ctx.reconnectWaitTimer !== undefined) {
			this.#clearTimeout(ctx.reconnectWaitTimer);
			ctx.reconnectWaitTimer = undefined;
		}
	}

	// --- End / teardown ---------------------------------------------------------

	async #sendEndCall(ctx: CallContext): Promise<void> {
		await this.#signaling.sendToPeer(ctx.peer, { type: CallMessageType.END_CALL, uuid: ctx.uuid });
		this.#trace(ctx, "out", CallMessageType.END_CALL);
		await this.#signaling.sendToSelf({ type: CallMessageType.END_CALL, uuid: ctx.uuid });
	}

	#endCall(ctx: CallContext, reason: EndReason): void {
		ctx.info.endedAt = this.#now();
		ctx.info.endReason = reason;
		ctx.emit("ended", { ...ctx.info });
		for (const cb of this.#endedCbs) cb(ctx, { ...ctx.info });
		// FSM "cleanup" effects (dispose-pc, restore-poll, emit-ended) are
		// executed here as teardown semantics: contexts are per-call and
		// discarded rather than recycled back to idle.
		this.#teardownContext(ctx);
	}

	#failCall(ctx: CallContext, err: Error, reason: EndReason = "error"): void {
		this.#log("error", "call failed", {
			uuid: ctx.uuid,
			err: err instanceof Error ? err.message : String(err),
		});
		this.#emitError(err, ctx);
		if (!this.#contexts.has(ctx.uuid)) {
			// Already torn down (e.g. a late async signaling rejection raced
			// teardown): surface the error but never end twice.
			return;
		}
		if (ctx.state !== "idle" && ctx.state !== "disconnected") {
			try {
				ctx.apply("receive-end-call");
			} catch {
				// State already terminal — fine.
			}
		}
		this.#endCall(ctx, reason);
	}

	/**
	 * Escalate an externally-observed failure for a call (media engine throw,
	 * consumer pipeline error surfaced by the CallManager layer — P6-T3).
	 * Emits the error on the error channel (with call attribution) and ends
	 * the call with `reason` (default "error"). Safe if the call is already
	 * gone (the error is still emitted).
	 */
	failCall(uuid: string, err: Error, reason: EndReason = "error"): void {
		const ctx = this.#contexts.get(uuid);
		if (!ctx) {
			this.#emitError(err);
			return;
		}
		this.#failCall(ctx, err, reason);
	}

	#teardownContext(ctx: CallContext): void {
		this.#cancelCallTimeout(ctx);
		this.#clearRestartTimer(ctx);
		try {
			ctx.mediaSession?.close();
		} catch (err) {
			this.#log("debug", "media close failed", { uuid: ctx.uuid, err });
		}
		ctx.mediaSession = undefined;
		this.#contexts.delete(ctx.uuid);
		this.#clearReconnectWaitTimer(ctx);
		this.#graveyard.set(ctx.uuid, { peer: ctx.peer, endReason: ctx.info.endReason });
		const g = this.#setTimeout(() => {
			this.#graveyard.delete(ctx.uuid);
		}, GRAVEYARD_MS);
		unrefTimer(g);
		if (this.#contexts.size === 0) {
			this.#restorePoll();
		}
	}

	// --- Signaling plumbing -------------------------------------------------------

	#registerContext(uuid: string, peer: string, direction: "inbound" | "outbound"): CallContext {
		const ctx = new CallContext(uuid, peer, direction, this.#now(), this.#log);
		ctx.bindSupervisorActions({
			accept: (id) => this.accept(id),
			reject: (id) => this.reject(id),
			ignore: (id) => this.ignore(id),
			hangup: (id) => this.hangup(id),
		});
		ctx.onTransition = (state) => {
			for (const cb of this.#stateChangedCbs) cb(ctx, state);
		};
		this.#contexts.set(uuid, ctx);
		return ctx;
	}

	#requireContext(uuid: string): CallContext {
		const ctx = this.#contexts.get(uuid);
		if (!ctx) {
			throw new InvalidCallMessageError(`no active call with uuid ${uuid}`, uuid);
		}
		return ctx;
	}

	#requireMedia(ctx: CallContext): MediaSession {
		if (!ctx.mediaSession) {
			throw new MediaFailureError("media session not initialized", ctx.uuid);
		}
		return ctx.mediaSession;
	}

	#trace(ctx: CallContext, direction: "in" | "out", type: CallMessageTypeValue): void {
		ctx.emit("signaling", { direction, type, uuid: ctx.uuid });
		// Diagnostics (P5-T3): every signaling receive (and the FSM-level send
		// trace) is logged — direction/type/uuid ONLY, never SDP payloads.
		if (direction === "in") {
			this.#log("debug", `signaling recv type=${callMessageTypeName(type)} uuid=${ctx.uuid}`);
		} else {
			this.#log("debug", `signaling send (fsm) type=${callMessageTypeName(type)} uuid=${ctx.uuid}`);
		}
	}

	#onSignalingError(ctx: CallContext, err: unknown): void {
		// A failure on the context's CRITICAL signaling path (PRE_OFFER/OFFER
		// send, ICE-restart OFFER send) means the call cannot succeed — end it
		// with an error instead of letting it limp into the timeout (P6-T3
		// containment; the error event carries call attribution).
		this.#log("warn", "signaling send failed", {
			uuid: ctx.uuid,
			err: err instanceof Error ? err.message : String(err),
		});
		this.#failCall(
			ctx,
			err instanceof Error ? err : new CallError("SIGNALING_FAILURE", String(err), ctx.uuid),
		);
	}

	#recordMissed(peer: string, reason: MissedCallRecord["reason"]): void {
		const record: MissedCallRecord = { peer, at: this.#now(), reason };
		this.#log("info", "missed call", record);
		for (const cb of this.#missedCbs) cb(record);
	}

	#emitError(err: Error, ctx?: CallContext): void {
		this.#log("error", "call error", { err: err.message, uuid: ctx?.uuid });
		for (const cb of this.#errorCbs) cb(err, ctx);
	}

	#boostPoll(): void {
		if (!this.#pollBoosted) {
			this.#pollBoosted = true;
			this.#session.setPollInterval(this.#options.boostedPollIntervalMs);
		}
	}

	#restorePoll(): void {
		if (this.#pollBoosted) {
			this.#pollBoosted = false;
			this.#session.setPollInterval(ASSUMED_DEFAULT_POLL_INTERVAL_MS);
		}
	}
}

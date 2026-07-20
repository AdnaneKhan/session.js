// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Ported from session-android
// `app/src/main/java/org/thoughtcrime/securesms/webrtc/data/StateMachine.kt`
// (GPLv3), © Session Foundation, modified. Licensed under AGPL-3.0-or-later.
//
// Modifications vs upstream (GPL requires stating changes):
//  - Kotlin → TypeScript, table-driven: transitions are DATA
//    (CALL_FSM_TRANSITIONS), `transition()` is a pure function, zero I/O.
//  - Two documented supplementary rows added (marked `supplementary: true`
//    below): the caller sends PRE_OFFER and OFFER back-to-back and may
//    receive ANSWER — or hit the call timeout — while the FSM is still in
//    `local-pre-offer` (upstream Android distinguishes local-pre-offer /
//    local-ring on internal events we do not model; the two states are not
//    distinguishable on the wire). See docs/evidence/P2-T1.md.
//  - `inbound-while-busy` is accepted from every state except idle and
//    disconnected (task spec; Appendix C listed [local-*, remote-*,
//    connecting, connected]). The effect is identical (unchanged + record
//    missed + END_CALL for the other uuid); the wider validity only makes
//    the busy arbiter total during reconnect states. Documented deviation.
//  - Side-effect *interpretation* lives in the supervisor (src/supervisor.ts);
//    this module only emits effect names.

import { InvalidCallTransitionError } from "../errors.js";
import type { CallLogger, CallState } from "../types.js";

/** The 10 normative call states (plan §4.5). */
export const CALL_STATES = [
	"idle",
	"local-pre-offer",
	"local-ring",
	"remote-pre-offer",
	"remote-ring",
	"connecting",
	"connected",
	"pending-reconnect",
	"reconnecting",
	"disconnected",
] as const satisfies readonly CallState[];

/** All 19 FSM events (Appendix C). */
export const CALL_FSM_EVENTS = [
	"send-pre-offer",
	"receive-pre-offer",
	"receive-offer",
	"user-accept",
	"receive-answer",
	"ice-connected",
	"ice-disconnected",
	"restart-attempt",
	"receive-offer-restart",
	"user-decline",
	"inbound-while-busy",
	"user-hangup",
	"receive-end-call",
	"user-ignore",
	"timeout",
	"self-answer",
	"self-end-call",
	"drop-self-signaling",
	"cleanup",
] as const;

export type CallFsmEvent = (typeof CALL_FSM_EVENTS)[number];

/** All effect names referenced by the transition table. */
export const CALL_FSM_EFFECTS = [
	"gen-uuid",
	"send-pre-offer",
	"send-offer",
	"start-call-timeout",
	"boost-poll",
	"freshness-check-60s",
	"ring",
	"force-poll",
	"store-pending-offer",
	"set-remote-offer",
	"create-answer",
	"set-local",
	"send-answer-peer",
	"send-answer-self",
	"set-remote-answer",
	"drain-ice",
	"mark-connected",
	"open-audio",
	"cancel-timeout",
	"schedule-restart-if-initiator",
	"send-offer-icerestart",
	"answer-icerestart",
	"send-end-call-peer",
	"send-end-call-self",
	"record-incoming-rejected",
	"record-missed",
	"datachannel-hangup",
	"reason-from-state",
	"record-missed-local",
	"send-end-call-peer-if-local",
	"reason-timeout",
	"reason-answered-elsewhere",
	"reason-ended-elsewhere",
	"log-drop",
	"dispose-pc",
	"restore-poll",
	"emit-ended",
] as const;

export type CallEffect = (typeof CALL_FSM_EFFECTS)[number];

export interface FsmTransitionRow {
	event: CallFsmEvent;
	from: readonly CallState[];
	/** Target state; "unchanged" keeps the current state. */
	to: CallState | "unchanged";
	effects: readonly CallEffect[];
	/** "initiator": ctx.isInitiator must be true. "non-initiator": must be false. */
	guard?: "initiator" | "non-initiator";
	/** True for the two documented caller-side supplementary rows. */
	supplementary?: boolean;
}

/**
 * The normative transition table — Appendix C of the implementation plan,
 * machine-readable form, plus the two supplementary rows (see file header).
 * 19 events / 21 rows.
 */
export const CALL_FSM_TRANSITIONS: readonly FsmTransitionRow[] = [
	{
		event: "send-pre-offer",
		from: ["idle"],
		to: "local-pre-offer",
		effects: ["gen-uuid", "send-pre-offer", "send-offer", "start-call-timeout", "boost-poll"],
	},
	{
		event: "receive-pre-offer",
		from: ["idle"],
		to: "remote-pre-offer",
		effects: ["freshness-check-60s", "ring", "boost-poll", "force-poll"],
	},
	{
		event: "receive-offer",
		from: ["remote-pre-offer", "reconnecting"],
		to: "remote-ring",
		effects: ["store-pending-offer"],
	},
	{
		event: "user-accept",
		from: ["remote-ring"],
		to: "connecting",
		effects: [
			"set-remote-offer",
			"create-answer",
			"set-local",
			"send-answer-peer",
			"send-answer-self",
		],
	},
	{
		event: "receive-answer",
		from: ["local-ring", "reconnecting"],
		to: "connecting",
		effects: ["set-remote-answer", "drain-ice"],
	},
	{
		// Supplementary row: the caller may receive ANSWER while still in
		// local-pre-offer (OFFER+PRE_OFFER are sent back-to-back; the states
		// local-pre-offer / local-ring are not distinguished on the wire).
		event: "receive-answer",
		from: ["local-pre-offer"],
		to: "connecting",
		effects: ["set-remote-answer", "drain-ice"],
		supplementary: true,
	},
	{
		event: "ice-connected",
		from: ["connecting", "reconnecting"],
		to: "connected",
		effects: ["mark-connected", "open-audio", "cancel-timeout"],
	},
	{
		event: "ice-disconnected",
		from: ["connected"],
		to: "pending-reconnect",
		effects: ["schedule-restart-if-initiator"],
	},
	{
		event: "restart-attempt",
		from: ["pending-reconnect"],
		to: "reconnecting",
		effects: ["send-offer-icerestart"],
		guard: "initiator",
	},
	{
		event: "receive-offer-restart",
		from: ["reconnecting"],
		to: "connecting",
		effects: ["answer-icerestart", "send-answer-peer", "send-answer-self"],
		guard: "non-initiator",
	},
	{
		event: "user-decline",
		from: ["remote-pre-offer", "remote-ring"],
		to: "disconnected",
		effects: ["send-end-call-peer", "send-end-call-self", "record-incoming-rejected"],
	},
	{
		// Appendix C lists [local-*, remote-*, connecting, connected]; the task
		// spec widens this to "any non-idle, non-disconnected" so the busy
		// arbiter stays total during reconnect states (effect is identical).
		event: "inbound-while-busy",
		from: [
			"local-pre-offer",
			"local-ring",
			"remote-pre-offer",
			"remote-ring",
			"connecting",
			"connected",
			"pending-reconnect",
			"reconnecting",
		],
		to: "unchanged",
		effects: ["record-missed", "send-end-call-peer"],
	},
	{
		event: "user-hangup",
		from: [
			"local-pre-offer",
			"local-ring",
			"connecting",
			"connected",
			"pending-reconnect",
			"reconnecting",
		],
		to: "disconnected",
		effects: ["datachannel-hangup", "send-end-call-peer", "send-end-call-self"],
	},
	{
		event: "receive-end-call",
		from: [
			"local-pre-offer",
			"local-ring",
			"remote-pre-offer",
			"remote-ring",
			"connecting",
			"connected",
			"pending-reconnect",
			"reconnecting",
			"disconnected",
		],
		to: "disconnected",
		effects: ["reason-from-state"],
	},
	{
		event: "user-ignore",
		from: ["remote-pre-offer", "remote-ring"],
		to: "idle",
		effects: ["record-missed-local"],
	},
	{
		event: "timeout",
		from: ["local-ring", "remote-ring", "connecting", "reconnecting"],
		to: "disconnected",
		effects: ["send-end-call-peer-if-local", "send-end-call-self", "reason-timeout"],
	},
	{
		// Supplementary row: the caller may hit the call timeout while still
		// in local-pre-offer (ANSWER simply never arrived; same wire reality
		// as the receive-answer supplementary row above).
		event: "timeout",
		from: ["local-pre-offer"],
		to: "disconnected",
		effects: ["send-end-call-peer-if-local", "send-end-call-self", "reason-timeout"],
		supplementary: true,
	},
	{
		event: "self-answer",
		from: ["remote-pre-offer", "remote-ring"],
		to: "disconnected",
		effects: ["reason-answered-elsewhere"],
	},
	{
		event: "self-end-call",
		from: [
			"local-pre-offer",
			"local-ring",
			"remote-pre-offer",
			"remote-ring",
			"connecting",
			"connected",
			"pending-reconnect",
			"reconnecting",
			"disconnected",
		],
		to: "disconnected",
		effects: ["reason-ended-elsewhere"],
	},
	{
		event: "drop-self-signaling",
		from: [
			"idle",
			"local-pre-offer",
			"local-ring",
			"remote-pre-offer",
			"remote-ring",
			"connecting",
			"connected",
			"pending-reconnect",
			"reconnecting",
			"disconnected",
		],
		to: "unchanged",
		effects: ["log-drop"],
	},
	{
		event: "cleanup",
		from: ["disconnected"],
		to: "idle",
		effects: ["dispose-pc", "restore-poll", "emit-ended"],
	},
];

export interface TransitionContext {
	/** True for the call initiator (caller / ICE-restart originator). */
	isInitiator?: boolean;
}

export interface TransitionResult {
	next: CallState;
	effects: CallEffect[];
}

/**
 * Pure transition function — zero I/O. Looks up the (state, event) row in
 * CALL_FSM_TRANSITIONS, checks the guard, and returns the next state plus
 * the effect list the caller (supervisor) must execute.
 *
 * @throws InvalidCallTransitionError for a (state, event) pair with no table
 *   row, or when a guard is unsatisfied. Callers decide tolerance — most
 *   log+ignore, matching Android's guarded posts.
 */
export function transition(
	state: CallState,
	event: CallFsmEvent,
	ctx?: TransitionContext,
): TransitionResult {
	const row = CALL_FSM_TRANSITIONS.find((r) => r.event === event && r.from.includes(state));
	if (!row) {
		throw new InvalidCallTransitionError(state, event);
	}
	if (row.guard === "initiator" && ctx?.isInitiator !== true) {
		throw new InvalidCallTransitionError(state, event);
	}
	if (row.guard === "non-initiator" && ctx?.isInitiator !== false) {
		throw new InvalidCallTransitionError(state, event);
	}
	const next = row.to === "unchanged" ? state : row.to;
	return { next, effects: [...row.effects] };
}

/**
 * Thin stateful wrapper around transition() for convenience. Still pure
 * except for the optional injected logger.
 */
export class StateMachine {
	#state: CallState;
	#logger: CallLogger | undefined;

	constructor(initial: CallState = "idle", logger?: CallLogger) {
		this.#state = initial;
		this.#logger = logger;
	}

	getState(): CallState {
		return this.#state;
	}

	/**
	 * Apply an event; updates internal state and returns the result.
	 * @throws InvalidCallTransitionError on invalid pairs (state unchanged).
	 */
	send(event: CallFsmEvent, ctx?: TransitionContext): TransitionResult {
		const result = transition(this.#state, event, ctx);
		this.#logger?.("debug", `fsm: ${this.#state} --${event}--> ${result.next}`, {
			effects: result.effects,
		});
		this.#state = result.next;
		return result;
	}
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// P2-T1 verification: exhaustive FSM matrix + scenario walks.

import { describe, expect, test } from "bun:test";
import { InvalidCallTransitionError } from "../../src/errors.js";
import {
	CALL_FSM_EFFECTS,
	CALL_FSM_EVENTS,
	CALL_FSM_TRANSITIONS,
	CALL_STATES,
	StateMachine,
	transition,
	type CallFsmEvent,
	type CallState,
	type FsmTransitionRow,
	type TransitionContext,
} from "../../src/fsm/state-machine.js";

function rowsFor(state: CallState, event: CallFsmEvent): FsmTransitionRow[] {
	return CALL_FSM_TRANSITIONS.filter((r) => r.event === event && r.from.includes(state));
}

/** Context that satisfies the guard for guarded events. */
function ctxFor(event: CallFsmEvent): TransitionContext | undefined {
	if (event === "restart-attempt") return { isInitiator: true };
	if (event === "receive-offer-restart") return { isInitiator: false };
	// network-reconnect (restored Appendix C row, P6-T1) is the non-initiator's
	// entry into `reconnecting`; the initiator uses restart-attempt.
	if (event === "network-reconnect") return { isInitiator: false };
	return undefined;
}

describe("transition table integrity", () => {
	test("10 states, 20 events, 22 rows (20 base + 2 supplementary)", () => {
		// P6-T1 restored the normative Appendix C `network-reconnect` event
		// (non-initiator reconnect entry) that the P2 port had omitted:
		// 19 → 20 events, 21 → 22 rows. All other table content unchanged.
		expect(CALL_STATES.length).toBe(10);
		expect(CALL_FSM_EVENTS.length).toBe(20);
		expect(CALL_FSM_TRANSITIONS.length).toBe(22);
		const distinctEvents = new Set(CALL_FSM_TRANSITIONS.map((r) => r.event));
		expect(distinctEvents.size).toBe(20);
		for (const e of CALL_FSM_EVENTS) {
			expect(distinctEvents.has(e)).toBe(true);
		}
	});

	test("exactly two supplementary rows: receive-answer and timeout from local-pre-offer", () => {
		const supplementary = CALL_FSM_TRANSITIONS.filter((r) => r.supplementary);
		expect(supplementary.length).toBe(2);
		const sigs = supplementary.map((r) => `${r.event}:${r.from.join(",")}`).sort();
		expect(sigs).toEqual([
			"receive-answer:local-pre-offer",
			"timeout:local-pre-offer",
		]);
	});

	test("no ambiguous (event, from-state) pairs", () => {
		const seen = new Set<string>();
		for (const row of CALL_FSM_TRANSITIONS) {
			for (const from of row.from) {
				const key = `${row.event}@${from}`;
				expect(seen.has(key)).toBe(false);
				seen.add(key);
			}
		}
	});

	test("all states/effects in the table are members of the normative unions", () => {
		const states = new Set<string>(CALL_STATES);
		const effects = new Set<string>(CALL_FSM_EFFECTS);
		for (const row of CALL_FSM_TRANSITIONS) {
			for (const from of row.from) expect(states.has(from)).toBe(true);
			if (row.to !== "unchanged") expect(states.has(row.to)).toBe(true);
			for (const e of row.effects) expect(effects.has(e)).toBe(true);
		}
	});
});

describe("exhaustive 10 states × 20 events matrix", () => {
	test("every pair: next-state + effects per table, or InvalidCallTransitionError", () => {
		let validCount = 0;
		let invalidCount = 0;
		for (const state of CALL_STATES) {
			for (const event of CALL_FSM_EVENTS) {
				const rows = rowsFor(state, event);
				expect(rows.length).toBeLessThanOrEqual(1);
				if (rows.length === 1) {
					const row = rows[0] as FsmTransitionRow;
					const result = transition(state, event, ctxFor(event));
					expect(result.next).toBe(row.to === "unchanged" ? state : row.to);
					expect(result.effects).toEqual([...row.effects]);
					validCount += 1;
				} else {
					expect(() => transition(state, event, ctxFor(event))).toThrow(
						InvalidCallTransitionError,
					);
					invalidCount += 1;
				}
			}
		}
		expect(validCount + invalidCount).toBe(200);
		// Sanity: the machine is neither total nor degenerate.
		expect(validCount).toBeGreaterThan(40);
		expect(invalidCount).toBeGreaterThan(40);
	});
});

describe("hand-written expectations (spot-checks of Appendix C rows)", () => {
	test("send-pre-offer: idle -> local-pre-offer", () => {
		expect(transition("idle", "send-pre-offer")).toEqual({
			next: "local-pre-offer",
			effects: ["gen-uuid", "send-pre-offer", "send-offer", "start-call-timeout", "boost-poll"],
		});
	});
	test("receive-pre-offer: idle -> remote-pre-offer", () => {
		expect(transition("idle", "receive-pre-offer")).toEqual({
			next: "remote-pre-offer",
			effects: ["freshness-check-60s", "ring", "boost-poll", "force-poll"],
		});
	});
	test("receive-offer: remote-pre-offer -> remote-ring (and from reconnecting)", () => {
		expect(transition("remote-pre-offer", "receive-offer")).toEqual({
			next: "remote-ring",
			effects: ["store-pending-offer"],
		});
		expect(transition("reconnecting", "receive-offer").next).toBe("remote-ring");
	});
	test("user-accept: remote-ring -> connecting", () => {
		expect(transition("remote-ring", "user-accept")).toEqual({
			next: "connecting",
			effects: [
				"set-remote-offer",
				"create-answer",
				"set-local",
				"send-answer-peer",
				"send-answer-self",
			],
		});
	});
	test("receive-answer: local-ring -> connecting", () => {
		expect(transition("local-ring", "receive-answer")).toEqual({
			next: "connecting",
			effects: ["set-remote-answer", "drain-ice"],
		});
	});
	test("ice-connected: connecting -> connected", () => {
		expect(transition("connecting", "ice-connected")).toEqual({
			next: "connected",
			effects: ["mark-connected", "open-audio", "cancel-timeout"],
		});
	});
	test("ice-disconnected: connected -> pending-reconnect", () => {
		expect(transition("connected", "ice-disconnected")).toEqual({
			next: "pending-reconnect",
			effects: ["schedule-restart-if-initiator"],
		});
	});
	test("restart-attempt: pending-reconnect -> reconnecting (guard initiator)", () => {
		expect(transition("pending-reconnect", "restart-attempt", { isInitiator: true })).toEqual({
			next: "reconnecting",
			effects: ["send-offer-icerestart"],
		});
	});
	test("network-reconnect: pending-reconnect -> reconnecting (guard non-initiator, P6-T1)", () => {
		expect(
			transition("pending-reconnect", "network-reconnect", { isInitiator: false }),
		).toEqual({
			next: "reconnecting",
			effects: ["await-restart-offer"],
		});
		// The initiator must use restart-attempt instead.
		expect(() =>
			transition("pending-reconnect", "network-reconnect", { isInitiator: true }),
		).toThrow(InvalidCallTransitionError);
		expect(() => transition("connected", "network-reconnect", { isInitiator: false })).toThrow(
			InvalidCallTransitionError,
		);
	});
	test("receive-offer-restart: reconnecting -> connecting (guard non-initiator)", () => {
		expect(
			transition("reconnecting", "receive-offer-restart", { isInitiator: false }),
		).toEqual({
			next: "connecting",
			effects: ["answer-icerestart", "send-answer-peer", "send-answer-self"],
		});
	});
	test("user-decline: remote-ring -> disconnected", () => {
		expect(transition("remote-ring", "user-decline")).toEqual({
			next: "disconnected",
			effects: ["send-end-call-peer", "send-end-call-self", "record-incoming-rejected"],
		});
	});
	test("inbound-while-busy: unchanged + missed + END_CALL", () => {
		expect(transition("connected", "inbound-while-busy")).toEqual({
			next: "connected",
			effects: ["record-missed", "send-end-call-peer"],
		});
		// Widened validity (documented deviation): also valid while reconnecting.
		expect(transition("reconnecting", "inbound-while-busy").next).toBe("reconnecting");
		expect(transition("pending-reconnect", "inbound-while-busy").next).toBe("pending-reconnect");
	});
	test("user-hangup: connected -> disconnected", () => {
		expect(transition("connected", "user-hangup")).toEqual({
			next: "disconnected",
			effects: ["datachannel-hangup", "send-end-call-peer", "send-end-call-self"],
		});
	});
	test("user-hangup NOT valid from remote-* / idle / disconnected (decline covers remote-*)", () => {
		expect(() => transition("remote-pre-offer", "user-hangup")).toThrow(
			InvalidCallTransitionError,
		);
		expect(() => transition("remote-ring", "user-hangup")).toThrow(InvalidCallTransitionError);
		expect(() => transition("idle", "user-hangup")).toThrow(InvalidCallTransitionError);
		expect(() => transition("disconnected", "user-hangup")).toThrow(InvalidCallTransitionError);
	});
	test("receive-end-call: any non-idle -> disconnected", () => {
		expect(transition("connecting", "receive-end-call")).toEqual({
			next: "disconnected",
			effects: ["reason-from-state"],
		});
		expect(transition("disconnected", "receive-end-call").next).toBe("disconnected");
		expect(() => transition("idle", "receive-end-call")).toThrow(InvalidCallTransitionError);
	});
	test("user-ignore: remote-ring -> idle, record-missed-local", () => {
		expect(transition("remote-ring", "user-ignore")).toEqual({
			next: "idle",
			effects: ["record-missed-local"],
		});
	});
	test("timeout: local-ring -> disconnected", () => {
		expect(transition("local-ring", "timeout")).toEqual({
			next: "disconnected",
			effects: ["send-end-call-peer-if-local", "send-end-call-self", "reason-timeout"],
		});
	});
	test("self-answer: remote-pre-offer -> disconnected, answered-elsewhere", () => {
		expect(transition("remote-pre-offer", "self-answer")).toEqual({
			next: "disconnected",
			effects: ["reason-answered-elsewhere"],
		});
	});
	test("self-end-call: connected -> disconnected, ended-elsewhere", () => {
		expect(transition("connected", "self-end-call")).toEqual({
			next: "disconnected",
			effects: ["reason-ended-elsewhere"],
		});
	});
	test("drop-self-signaling: valid from EVERY state, unchanged, log-drop", () => {
		for (const state of CALL_STATES) {
			expect(transition(state, "drop-self-signaling")).toEqual({
				next: state,
				effects: ["log-drop"],
			});
		}
	});
	test("cleanup: disconnected -> idle", () => {
		expect(transition("disconnected", "cleanup")).toEqual({
			next: "idle",
			effects: ["dispose-pc", "restore-poll", "emit-ended"],
		});
		expect(() => transition("connected", "cleanup")).toThrow(InvalidCallTransitionError);
	});
	test("supplementary rows: caller receive-answer / timeout from local-pre-offer", () => {
		expect(transition("local-pre-offer", "receive-answer")).toEqual({
			next: "connecting",
			effects: ["set-remote-answer", "drain-ice"],
		});
		expect(transition("local-pre-offer", "timeout")).toEqual({
			next: "disconnected",
			effects: ["send-end-call-peer-if-local", "send-end-call-self", "reason-timeout"],
		});
	});
});

describe("guards", () => {
	test("restart-attempt requires isInitiator === true", () => {
		expect(() => transition("pending-reconnect", "restart-attempt")).toThrow(
			InvalidCallTransitionError,
		);
		expect(() => transition("pending-reconnect", "restart-attempt", { isInitiator: false })).toThrow(
			InvalidCallTransitionError,
		);
		expect(() =>
			transition("pending-reconnect", "restart-attempt", { isInitiator: undefined }),
		).toThrow(InvalidCallTransitionError);
	});
	test("receive-offer-restart requires isInitiator === false", () => {
		expect(() => transition("reconnecting", "receive-offer-restart")).toThrow(
			InvalidCallTransitionError,
		);
		expect(() => transition("reconnecting", "receive-offer-restart", { isInitiator: true })).toThrow(
			InvalidCallTransitionError,
		);
	});
	test("network-reconnect requires isInitiator === false (initiator uses restart-attempt)", () => {
		expect(() => transition("pending-reconnect", "network-reconnect")).toThrow(
			InvalidCallTransitionError,
		);
		expect(() =>
			transition("pending-reconnect", "network-reconnect", { isInitiator: true }),
		).toThrow(InvalidCallTransitionError);
	});
});

describe("invalid input handling", () => {
	test("unknown event throws InvalidCallTransitionError", () => {
		expect(() => transition("idle", "bogus-event" as CallFsmEvent)).toThrow(
			InvalidCallTransitionError,
		);
	});
	test("error carries state + event", () => {
		try {
			transition("idle", "user-accept");
			expect.unreachable("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(InvalidCallTransitionError);
			const e = err as InvalidCallTransitionError;
			expect(e.state).toBe("idle");
			expect(e.event).toBe("user-accept");
			expect(e.code).toBe("INVALID_CALL_TRANSITION");
		}
	});
});

describe("scenario walks (StateMachine class)", () => {
	test("full caller flow: idle -> ... -> connected -> cleanup", () => {
		const sm = new StateMachine();
		expect(sm.getState()).toBe("idle");
		expect(sm.send("send-pre-offer").next).toBe("local-pre-offer");
		// Caller receives ANSWER while still in local-pre-offer (supplementary
		// row — PRE_OFFER+OFFER sent back-to-back).
		expect(sm.send("receive-answer").next).toBe("connecting");
		expect(sm.send("ice-connected").next).toBe("connected");
		expect(sm.send("user-hangup").next).toBe("disconnected");
		expect(sm.send("cleanup").next).toBe("idle");
		expect(sm.getState()).toBe("idle");
	});
	test("full callee flow: pre-offer -> offer -> accept -> connected -> hangup -> cleanup", () => {
		const sm = new StateMachine();
		expect(sm.send("receive-pre-offer").next).toBe("remote-pre-offer");
		expect(sm.send("receive-offer").next).toBe("remote-ring");
		expect(sm.send("user-accept").next).toBe("connecting");
		expect(sm.send("ice-connected").next).toBe("connected");
		expect(sm.send("user-hangup").next).toBe("disconnected");
		expect(sm.send("cleanup").next).toBe("idle");
	});
	test("decline flows (from remote-ring and directly from remote-pre-offer)", () => {
		const sm = new StateMachine();
		sm.send("receive-pre-offer");
		sm.send("receive-offer");
		expect(sm.send("user-decline").next).toBe("disconnected");

		const sm2 = new StateMachine();
		sm2.send("receive-pre-offer");
		expect(sm2.send("user-decline").next).toBe("disconnected");
	});
	test("ignore flow (no wire message, back to idle)", () => {
		const sm = new StateMachine();
		sm.send("receive-pre-offer");
		const res = sm.send("user-ignore");
		expect(res.next).toBe("idle");
		expect(res.effects).toEqual(["record-missed-local"]);

		const sm2 = new StateMachine();
		sm2.send("receive-pre-offer");
		sm2.send("receive-offer");
		expect(sm2.send("user-ignore").next).toBe("idle");
	});
	test("initiator reconnect flow: ice-disconnected -> restart-attempt -> ice-connected", () => {
		const sm = new StateMachine();
		sm.send("send-pre-offer");
		sm.send("receive-answer");
		sm.send("ice-connected");
		expect(sm.send("ice-disconnected").next).toBe("pending-reconnect");
		expect(sm.send("restart-attempt", { isInitiator: true }).next).toBe("reconnecting");
		// Initiator may also receive the answer to the restart offer:
		const smAlt = new StateMachine("reconnecting");
		expect(smAlt.send("receive-answer").next).toBe("connecting");
		// ...and ICE reconnects:
		expect(sm.send("ice-connected").next).toBe("connected");
	});
	test("non-initiator reconnect flow: network-reconnect -> receive-offer-restart -> connecting", () => {
		const sm = new StateMachine("connected");
		expect(sm.send("ice-disconnected").next).toBe("pending-reconnect");
		// Non-initiator entry into `reconnecting` (restored Appendix C row, P6-T1).
		expect(sm.send("network-reconnect", { isInitiator: false }).next).toBe("reconnecting");
		expect(sm.send("receive-offer-restart", { isInitiator: false }).next).toBe("connecting");
		expect(sm.send("ice-connected").next).toBe("connected");
	});
	test("self-answer (answered-elsewhere) on inbound call", () => {
		const sm = new StateMachine();
		sm.send("receive-pre-offer");
		const res = sm.send("self-answer");
		expect(res.next).toBe("disconnected");
		expect(res.effects).toEqual(["reason-answered-elsewhere"]);
	});
	test("self-end-call (ended-elsewhere) mid-call", () => {
		const sm = new StateMachine();
		sm.send("send-pre-offer");
		sm.send("receive-answer");
		sm.send("ice-connected");
		const res = sm.send("self-end-call");
		expect(res.next).toBe("disconnected");
		expect(res.effects).toEqual(["reason-ended-elsewhere"]);
	});
	test("timeout from local-pre-offer (supplementary) ends the outbound call", () => {
		const sm = new StateMachine();
		sm.send("send-pre-offer");
		const res = sm.send("timeout");
		expect(res.next).toBe("disconnected");
		expect(res.effects).toEqual([
			"send-end-call-peer-if-local",
			"send-end-call-self",
			"reason-timeout",
		]);
	});
	test("inbound-while-busy leaves state unchanged", () => {
		const sm = new StateMachine();
		sm.send("receive-pre-offer");
		sm.send("receive-offer");
		const res = sm.send("inbound-while-busy");
		expect(res.next).toBe("remote-ring");
		expect(res.effects).toEqual(["record-missed", "send-end-call-peer"]);
	});
	test("invalid send does not change state", () => {
		const sm = new StateMachine();
		expect(() => sm.send("user-accept")).toThrow(InvalidCallTransitionError);
		expect(sm.getState()).toBe("idle");
	});
	test("logger observes transitions", () => {
		const logs: string[] = [];
		const sm = new StateMachine("idle", (level, msg) => {
			logs.push(`${level}:${msg}`);
		});
		sm.send("send-pre-offer");
		sm.send("receive-answer");
		expect(logs.length).toBe(2);
		expect(logs[0]).toContain("idle --send-pre-offer--> local-pre-offer");
		expect(logs[1]).toContain("local-pre-offer --receive-answer--> connecting");
	});
	test("custom initial state", () => {
		const sm = new StateMachine("connected");
		expect(sm.getState()).toBe("connected");
	});
});

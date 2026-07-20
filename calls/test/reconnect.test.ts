// SPDX-License-Identifier: AGPL-3.0-or-later
// P6-T1 verification: mid-call ICE restart & reconnect (spec §3.2).
//
// TIMER STRATEGY (documented choice): the reconnect cadence is fixed by
// policy constants (ICE_RESTART_INTERVAL_MS = 5000, MAX_ATTEMPTS = 5,
// NON_INITIATOR_RECONNECT_WAIT_MS = 60000). Bun's test runner has no
// vitest-style fake-timer API for setTimeout scheduling, so the supervisor
// takes an injectable timer pair (CallSupervisorDeps.timers — threaded
// through CallManagerDeps, a non-normative additive third constructor
// argument). Tests advance a FakeTimers scheduler deterministically; the
// consumer-facing (session, options) surface is unchanged.

import { afterEach, describe, expect, test } from "bun:test";

import { CallManager } from "../src/call-manager.js";
import { IceFailureError } from "../src/errors.js";
import {
	ICE_RESTART_INTERVAL_MS,
	ICE_RESTART_MAX_ATTEMPTS,
	NON_INITIATOR_RECONNECT_WAIT_MS,
} from "../src/policy.js";
import type { Call, CallInfo, CallManagerOptions } from "../src/types.js";
import { CallMessageType } from "../src/types.js";
import { FakeMedia, FakeSession, FakeTimers, PEER, PEER_B, tick } from "./helpers/fakes.js";

interface Env {
	session: FakeSession;
	media: FakeMedia;
	timers: FakeTimers;
	manager: CallManager;
	errors: { call?: Call; error: Error }[];
	ended: CallInfo[];
}

const envs: Env[] = [];

function makeEnv(options?: CallManagerOptions): Env {
	const session = new FakeSession();
	const media = new FakeMedia();
	const timers = new FakeTimers();
	Object.defineProperty(session, "nowValue", {
		get: () => timers.now,
		set: () => undefined,
		configurable: true,
	});
	const manager = new CallManager(session, options, {
		media,
		timers: timers.api,
		now: () => timers.now,
		createUuid: () => "00000000-0000-4000-8000-0000000000ee",
	});
	const env: Env = { session, media, timers, manager, errors: [], ended: [] };
	manager.on("error", (e) => env.errors.push(e));
	manager.on("incoming", (c) => c.on("ended", (i) => env.ended.push(i)));
	manager.on("outgoing", (c) => c.on("ended", (i) => env.ended.push(i)));
	envs.push(env);
	return env;
}

/** Outbound call driven to `connected`. */
async function connectedOutbound(env: Env): Promise<Call> {
	env.manager.approveContact(PEER);
	const callPromise = env.manager.call(PEER);
	const call = await callPromise;
	await tick(); // OFFER sent
	env.session.fireCall(
		env.session.event({
			uuid: call.uuid,
			type: CallMessageType.ANSWER,
			from: PEER,
			sdps: ["answer-sdp"],
		}),
	);
	await tick();
	env.media.last.fireConnectionState("connected");
	expect(call.info.state).toBe("connected");
	return call;
}

/** Inbound call driven to `connected`. */
async function connectedInbound(env: Env, uuid: string): Promise<Call> {
	env.manager.approveContact(PEER);
	const incoming: Call[] = [];
	env.manager.on("incoming", (c) => incoming.push(c));
	env.session.fireCall(env.session.event({ uuid, type: CallMessageType.PRE_OFFER, from: PEER }));
	env.session.fireCall(
		env.session.event({ uuid, type: CallMessageType.OFFER, from: PEER, sdps: ["offer-sdp"] }),
	);
	const call = incoming[0] as Call;
	await call.accept();
	env.media.last.fireConnectionState("connected");
	expect(call.info.state).toBe("connected");
	return call;
}

function restartOffers(env: Env): number {
	// Restart OFFERs are the OFFER sends with an iceRestart-created SDP —
	// FakeMediaSession marks those via the createOffer:iceRestart method
	// call; every such call produced exactly one OFFER send.
	return env.media.sessions.reduce(
		(n, s) => n + s.methodCalls.filter((m) => m === "createOffer:iceRestart").length,
		0,
	);
}

afterEach(async () => {
	while (envs.length > 0) {
		await envs.pop()?.manager.dispose();
	}
});

// ---------------------------------------------------------------------------
// Initiator (outbound) reconnect
// ---------------------------------------------------------------------------

describe("initiator ICE restart (outbound call)", () => {
	test("disconnect → restart OFFER every 5 s; 5 attempts then ice-failed + END_CALL", async () => {
		const env = makeEnv();
		const call = await connectedOutbound(env);
		env.media.last.fireConnectionState("disconnected");
		expect(call.info.state).toBe("pending-reconnect");

		// Each 5 s tick produces one restart OFFER (FSM restart-attempt →
		// reconnecting on the first, staying reconnecting thereafter).
		for (let attempt = 1; attempt <= ICE_RESTART_MAX_ATTEMPTS; attempt++) {
			env.timers.advance(ICE_RESTART_INTERVAL_MS);
			await tick();
			expect(restartOffers(env)).toBe(attempt);
			expect(call.info.state).toBe("reconnecting");
		}
		// Next tick exhausts → ice-failed.
		env.timers.advance(ICE_RESTART_INTERVAL_MS);
		await tick();
		expect(restartOffers(env)).toBe(ICE_RESTART_MAX_ATTEMPTS); // no extra offer
		expect(env.ended).toHaveLength(1);
		expect(env.ended[0]?.endReason).toBe("ice-failed");
		expect(call.info.state).toBe("disconnected");
		// END_CALL peer + self went out.
		expect(env.session.sentTypes("peer")).toContain(CallMessageType.END_CALL);
		expect(env.session.sentTypes("self")).toContain(CallMessageType.END_CALL);
		// IceFailureError surfaced on the error channel with call attribution.
		expect(env.errors.some((e) => e.error instanceof IceFailureError)).toBe(true);
		expect(env.errors[0]?.call).toBe(call);
		// All restart OFFERs carried the SAME uuid with fresh SDPs.
		const offers = env.session.sentToPeer().filter((s) => s.msg.type === CallMessageType.OFFER);
		expect(offers.length).toBe(1 + ICE_RESTART_MAX_ATTEMPTS); // original + restarts
		expect(offers.every((s) => s.msg.uuid === call.uuid)).toBe(true);
		expect(new Set(offers.map((s) => s.msg.sdps?.[0])).size).toBe(offers.length);
	});

	test("success mid-retry: ANSWER after attempt 2 → connected, attempts cancel", async () => {
		const env = makeEnv();
		const call = await connectedOutbound(env);
		env.media.last.fireConnectionState("disconnected");
		expect(call.info.state).toBe("pending-reconnect");

		env.timers.advance(ICE_RESTART_INTERVAL_MS); // attempt 1
		await tick();
		env.timers.advance(ICE_RESTART_INTERVAL_MS); // attempt 2
		await tick();
		expect(restartOffers(env)).toBe(2);
		expect(call.info.state).toBe("reconnecting");

		// Restart ANSWER arrives → setRemoteAnswer → connecting…
		env.session.fireCall(
			env.session.event({
				uuid: call.uuid,
				type: CallMessageType.ANSWER,
				from: PEER,
				sdps: ["restart-answer-sdp"],
			}),
		);
		await tick();
		expect(call.info.state).toBe("connecting");
		expect(env.media.last.remoteAnswer).toBe("restart-answer-sdp");

		// …ICE reconnects → connected; attempt counter resets.
		env.media.last.fireConnectionState("connected");
		expect(call.info.state).toBe("connected");
		expect(env.ended).toEqual([]);

		// Scheduled attempt 3 fires into a healthy call → chain stops, no OFFER.
		env.timers.advance(ICE_RESTART_INTERVAL_MS * 3);
		await tick();
		expect(restartOffers(env)).toBe(2);
		expect(call.info.state).toBe("connected");
		expect(env.errors).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Non-initiator (inbound) reconnect
// ---------------------------------------------------------------------------

describe("non-initiator reconnect wait (inbound call)", () => {
	test("disconnect → awaits restart OFFER → answers it → connected", async () => {
		const env = makeEnv();
		const uuid = "ffffffff-ffff-4fff-8fff-fffffffffff1";
		const call = await connectedInbound(env, uuid);

		env.media.last.fireConnectionState("disconnected");
		// Non-initiator: network-reconnect → reconnecting, 60 s wait armed.
		expect(call.info.state).toBe("reconnecting");

		const answersBefore = env.session.sentTypes("peer").filter(
			(t) => t === CallMessageType.ANSWER,
		).length;

		// The initiator's restarted OFFER arrives within the window.
		env.timers.advance(5000);
		env.session.fireCall(
			env.session.event({
				uuid,
				type: CallMessageType.OFFER,
				from: PEER,
				sdps: ["restart-offer-sdp"],
			}),
		);
		await tick();
		// Answered with a fresh answer (FSM receive-offer-restart → connecting).
		expect(env.media.last.remoteOffer).toBe("restart-offer-sdp");
		expect(call.info.state).toBe("connecting");
		const answersAfter = env.session.sentTypes("peer").filter(
			(t) => t === CallMessageType.ANSWER,
		).length;
		expect(answersAfter).toBe(answersBefore + 1);
		// …and self-synced so other devices observe the re-answer.
		expect(
			env.session.sentTypes("self").filter((t) => t === CallMessageType.ANSWER).length,
		).toBe(2);

		env.media.last.fireConnectionState("connected");
		expect(call.info.state).toBe("connected");
		expect(env.ended).toEqual([]);
		expect(env.errors).toEqual([]);
	});

	test("no restart OFFER within 60 s → ice-failed + END_CALL", async () => {
		const env = makeEnv();
		const uuid = "ffffffff-ffff-4fff-8fff-fffffffffff2";
		const call = await connectedInbound(env, uuid);

		env.media.last.fireConnectionState("disconnected");
		expect(call.info.state).toBe("reconnecting");

		env.timers.advance(NON_INITIATOR_RECONNECT_WAIT_MS - 1);
		await tick();
		expect(env.ended).toEqual([]); // not yet

		env.timers.advance(1); // exactly 60 s
		await tick();
		expect(env.ended).toHaveLength(1);
		expect(env.ended[0]?.endReason).toBe("ice-failed");
		expect(call.info.state).toBe("disconnected");
		expect(env.session.sentTypes("peer")).toContain(CallMessageType.END_CALL);
		expect(env.session.sentTypes("self")).toContain(CallMessageType.END_CALL);
		expect(env.errors.some((e) => e.error instanceof IceFailureError)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Chaos at the public level (extends supervisor chaos)
// ---------------------------------------------------------------------------

describe("chaos: rapid random event barrage into CallManager never throws uncaught", () => {
	let rejections: unknown[] = [];
	const onRejection = (err: unknown): void => {
		rejections.push(err);
	};

	afterEach(() => {
		process.removeListener("unhandledRejection", onRejection);
		rejections = [];
	});

	test("garbage messages + media state flapping + action races", async () => {
		process.on("unhandledRejection", onRejection);
		const env = makeEnv();
		env.manager.approveContact(PEER);
		env.manager.approveContact(PEER_B);

		// One live call to flap around.
		const call = await env.manager.call(PEER);
		await tick();
		env.session.fireCall(
			env.session.event({
				uuid: call.uuid,
				type: CallMessageType.ANSWER,
				from: PEER,
				sdps: ["a"],
			}),
		);
		await tick();
		env.media.last.fireConnectionState("connected");

		const types = [
			CallMessageType.PRE_OFFER,
			CallMessageType.OFFER,
			CallMessageType.ANSWER,
			CallMessageType.PROVISIONAL_ANSWER,
			CallMessageType.ICE_CANDIDATES,
			CallMessageType.END_CALL,
		];
		const states = ["connecting", "connected", "disconnected", "failed"] as const;
		for (let i = 0; i < 200; i++) {
			const type = types[i % types.length] as (typeof types)[number];
			const from =
				i % 4 === 0 ? env.session.ownId : i % 4 === 1 ? PEER : i % 4 === 2 ? PEER_B : "";
			env.session.fireCall({
				uuid: i % 3 === 0 ? call.uuid : `chaos-${i % 7}`,
				type,
				from,
				timestamp: i % 5 === 0 ? env.timers.now - 1_000_000_000 : env.timers.now,
				sdps: i % 2 === 0 ? ["sdp-x", "sdp-y"] : [],
				sdpMLineIndexes: i % 3 === 0 ? [0] : [0, 1], // deliberate mismatch
				sdpMids: ["0", "1"],
			});
			if (i % 6 === 0) {
				env.media.last.fireConnectionState(states[i % states.length] as never);
			}
			if (i % 11 === 0) {
				env.media.last.fireAudio(new Int16Array(960));
			}
			if (i % 13 === 0) {
				call.writeAudio(new Int16Array(960));
			}
			if (i % 17 === 0) {
				env.timers.advance(1234);
			}
		}
		await tick();
		await tick();

		// Action races on the public surface — all reject cleanly.
		await call.hangup().catch(() => undefined);
		await call.hangup().catch(() => undefined);
		await expect(call.accept()).rejects.toBeDefined();
		await env.manager.dispose();
		await env.manager.dispose();

		expect(rejections).toEqual([]);
	});
});

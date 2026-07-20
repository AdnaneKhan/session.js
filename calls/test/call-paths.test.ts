// SPDX-License-Identifier: AGPL-3.0-or-later
// P4-T4 verification: non-happy paths asserted through the PUBLIC CallManager
// surface (supervisor-level equivalents live in test/supervisor.test.ts).
// Offline fakes + injected clock/timers.

import { afterEach, describe, expect, test } from "bun:test";

import { CallManager } from "../src/call-manager.js";
import type { Call, CallInfo, CallManagerOptions, MissedCallRecord } from "../src/types.js";
import { CallMessageType } from "../src/types.js";
import { FakeMedia, FakeSession, FakeTimers, PEER, PEER_B, tick } from "./helpers/fakes.js";

interface Env {
	session: FakeSession;
	media: FakeMedia;
	timers: FakeTimers;
	manager: CallManager;
	incoming: Call[];
	outgoing: Call[];
	missed: MissedCallRecord[];
	ended: CallInfo[];
	errors: { call?: Call; error: Error }[];
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
		createUuid: () => "00000000-0000-4000-8000-0000000000aa",
	});
	const env: Env = {
		session,
		media,
		timers,
		manager,
		incoming: [],
		outgoing: [],
		missed: [],
		ended: [],
		errors: [],
	};
	manager.on("incoming", (c) => env.incoming.push(c));
	manager.on("outgoing", (c) => env.outgoing.push(c));
	manager.on("missed", (m) => env.missed.push(m));
	manager.on("error", (e) => env.errors.push(e));
	// Collect ended from every Call handle emitted.
	manager.on("incoming", (c) => c.on("ended", (info) => env.ended.push(info)));
	manager.on("outgoing", (c) => c.on("ended", (info) => env.ended.push(info)));
	envs.push(env);
	return env;
}

function inboundCall(env: Env, uuid: string, from: string = PEER): Call {
	env.session.fireCall(env.session.event({ uuid, type: CallMessageType.PRE_OFFER, from }));
	env.session.fireCall(
		env.session.event({ uuid, type: CallMessageType.OFFER, from, sdps: ["offer-sdp"] }),
	);
	const call = env.incoming[env.incoming.length - 1];
	if (!call) throw new Error("no incoming call emitted");
	return call;
}

afterEach(async () => {
	while (envs.length > 0) {
		await envs.pop()?.manager.dispose();
	}
});

// ---------------------------------------------------------------------------
// reject / ignore / busy
// ---------------------------------------------------------------------------

describe("reject()", () => {
	test("sends END_CALL to peer AND self; ended remote-declined; not a missed call", async () => {
		const env = makeEnv();
		env.manager.approveContact(PEER);
		const call = inboundCall(env, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1");
		await call.reject();
		expect(env.session.sentTypes("peer")).toEqual([CallMessageType.END_CALL]);
		expect(env.session.sentTypes("self")).toEqual([CallMessageType.END_CALL]);
		expect(env.ended).toHaveLength(1);
		expect(env.ended[0]?.endReason).toBe("remote-declined");
		expect(env.missed).toEqual([]);
		expect(env.manager.activeCall).toBeUndefined();
		expect(env.errors).toEqual([]);
	});
});

describe("ignore()", () => {
	test("sends NOTHING on the wire; missed recorded locally with reason ignored", async () => {
		const env = makeEnv();
		env.manager.approveContact(PEER);
		const call = inboundCall(env, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2");
		call.ignore();
		await tick();
		expect(env.session.sent).toEqual([]); // zero wire messages
		expect(env.missed).toEqual([{ peer: PEER, at: env.timers.now, reason: "ignored" }]);
		expect(env.ended).toEqual([]); // ignore is not an "ended" call
		expect(env.manager.activeCall).toBeUndefined();
	});
});

describe("inbound while busy", () => {
	test("missed busy + END_CALL for the intruder uuid; active call untouched", async () => {
		const env = makeEnv();
		env.manager.approveContact(PEER);
		env.manager.approveContact(PEER_B);

		// Active outbound call.
		const active = await env.manager.call(PEER);
		await tick();
		expect(active.info.state).toBe("local-pre-offer");
		const sentBefore = env.session.sent.length;

		// Intruder rings with a different uuid.
		env.session.fireCall(
			env.session.event({
				uuid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
				type: CallMessageType.PRE_OFFER,
				from: PEER_B,
			}),
		);
		expect(env.missed).toEqual([{ peer: PEER_B, at: env.timers.now, reason: "busy" }]);
		// END_CALL addressed to the INTRUDER, carrying the intruder's uuid.
		const endCall = env.session
			.sentToPeer()
			.find((s) => s.msg.type === CallMessageType.END_CALL);
		expect(endCall?.to).toBe(PEER_B);
		expect(endCall?.msg.uuid).toBe("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
		// The active call is untouched.
		expect(env.manager.activeCall).toBe(active);
		expect(active.info.state).toBe("local-pre-offer");
		expect(env.incoming).toEqual([]); // no incoming emitted for the intruder
		expect(env.session.sent.length).toBe(sentBefore + 1);
	});
});

// ---------------------------------------------------------------------------
// timeout / stale / approval gates / auto-approve
// ---------------------------------------------------------------------------

describe("call timeout", () => {
	test("short callTimeoutMs → ended timeout + END_CALL peer+self", async () => {
		const env = makeEnv({ callTimeoutMs: 30 });
		env.manager.approveContact(PEER);
		const call = await env.manager.call(PEER);
		await tick();
		env.timers.advance(30);
		await tick();
		expect(env.ended).toHaveLength(1);
		expect(env.ended[0]?.endReason).toBe("timeout");
		expect(env.session.sentTypes("peer")).toContain(CallMessageType.END_CALL);
		expect(env.session.sentTypes("self")).toContain(CallMessageType.END_CALL);
		expect(call.info.state).toBe("disconnected");
		expect(env.missed).toEqual([]); // our own call — not a missed call
		expect(env.manager.activeCall).toBeUndefined();
	});
});

describe("stale PRE_OFFER", () => {
	test("61 s old PRE_OFFER → missed stale, no incoming emitted", () => {
		const env = makeEnv();
		env.manager.approveContact(PEER);
		env.timers.advance(61_000);
		env.session.fireCall(
			env.session.event({
				uuid: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
				type: CallMessageType.PRE_OFFER,
				from: PEER,
				timestamp: env.timers.now - 61_000,
			}),
		);
		expect(env.missed).toEqual([{ peer: PEER, at: env.timers.now, reason: "stale" }]);
		expect(env.incoming).toEqual([]);
		expect(env.session.sent).toEqual([]);
	});
});

describe("inbound approval gate", () => {
	test("unapproved inbound PRE_OFFER is dropped with NO missed record", () => {
		const env = makeEnv(); // requireApprovedContact defaults true
		env.session.fireCall(
			env.session.event({
				uuid: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
				type: CallMessageType.PRE_OFFER,
				from: PEER,
			}),
		);
		expect(env.missed).toEqual([]);
		expect(env.incoming).toEqual([]);
		expect(env.session.sent).toEqual([]);
		expect(env.errors).toEqual([]);
	});

	test("requireApprovedContact: false admits unknown peers", () => {
		const env = makeEnv({ requireApprovedContact: false });
		env.session.fireCall(
			env.session.event({
				uuid: "dddddddd-dddd-4ddd-8ddd-ddddddddddde",
				type: CallMessageType.PRE_OFFER,
				from: PEER,
			}),
		);
		expect(env.incoming).toHaveLength(1);
	});
});

describe("autoApproveOnCall", () => {
	test("true (default): acceptConversationRequest runs before any call signaling", async () => {
		const env = makeEnv();
		env.manager.approveContact(PEER);
		const callPromise = env.manager.call(PEER);
		// Action log preserves order: approve BEFORE any call signaling.
		const approveAt = env.session.actions.indexOf(`approve:${PEER}`);
		const preOfferAt = env.session.actions.indexOf("send:peer:PRE_OFFER");
		expect(approveAt).toBeGreaterThanOrEqual(0);
		expect(preOfferAt).toBeGreaterThan(approveAt);
		await callPromise;
	});

	test("false: acceptConversationRequest is never called", async () => {
		const env = makeEnv({ autoApproveOnCall: false });
		env.manager.approveContact(PEER);
		const call = await env.manager.call(PEER);
		expect(env.session.approvedRequests).toEqual([]);
		expect(call.info.peer).toBe(PEER);
	});
});

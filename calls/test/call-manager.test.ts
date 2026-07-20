// SPDX-License-Identifier: AGPL-3.0-or-later
// P4-T3 verification: CallManager public API with fake session + fake media.
// Offline. Timer-driven parts use the injected FakeTimers.

import { afterEach, describe, expect, test } from "bun:test";
import { SignalService } from "@session.js/types/signal-bindings";

import { CallManager } from "../src/call-manager.js";
import {
	CallError,
	CallInProgressError,
	InvalidCallMessageError,
	MediaFailureError,
	PeerNotApprovedError,
} from "../src/errors.js";
import { TrickleIceSender, isRelayCandidate, SessionSignaling } from "../src/signaling.js";
import type { Call, CallInfo, CallManagerOptions } from "../src/types.js";
import { CallMessageType } from "../src/types.js";
import {
	FakeMedia,
	FakeSession,
	FakeSignaling,
	FakeTimers,
	PEER,
	PEER_B,
	tick,
} from "./helpers/fakes.js";

interface Env {
	session: FakeSession;
	media: FakeMedia;
	timers: FakeTimers;
	manager: CallManager;
	errors: { call?: Call; error: Error }[];
}

const envs: Env[] = [];

function makeEnv(options?: CallManagerOptions): Env {
	const session = new FakeSession();
	const media = new FakeMedia();
	const timers = new FakeTimers();
	// Keep the fake session's network-offset clock in lockstep with the
	// injected scheduler so event timestamps and isFresh() agree.
	Object.defineProperty(session, "nowValue", {
		get: () => timers.now,
		set: () => undefined,
		configurable: true,
	});
	const manager = new CallManager(
		session,
		options,
		{
			media,
			timers: timers.api,
			now: () => timers.now,
			createUuid: () => "00000000-0000-4000-8000-000000000001",
		},
	);
	const env: Env = { session, media, timers, manager, errors: [] };
	manager.on("error", (e) => env.errors.push(e));
	envs.push(env);
	return env;
}

afterEach(async () => {
	while (envs.length > 0) {
		await envs.pop()?.manager.dispose();
	}
});

// ---------------------------------------------------------------------------
// 1. Outbound happy path
// ---------------------------------------------------------------------------

describe("outbound happy path (CallManager level)", () => {
	test("call() → outgoing event → PRE_OFFER+OFFER in order → answer → connected → hangup → ended local-hangup", async () => {
		const env = makeEnv();
		env.manager.approveContact(PEER);
		const outgoing: Call[] = [];
		env.manager.on("outgoing", (c) => outgoing.push(c));

		// Do NOT await yet: call()'s synchronous prefix runs placeCall, which
		// sends PRE_OFFER immediately; OFFER waits for the async createOffer.
		const callPromise = env.manager.call(PEER);
		expect(env.session.sentTypes("peer")).toEqual([CallMessageType.PRE_OFFER]);
		expect(env.session.approvedRequests).toEqual([{ from: PEER }]); // autoApproveOnCall
		expect(env.session.pollIntervals).toEqual([500]); // boosted
		const call = await callPromise;
		expect(call).toBe(outgoing[0]);
		expect(call.info.direction).toBe("outbound");
		// OFFER followed — strict order PRE_OFFER → OFFER.
		expect(env.session.sentTypes("peer")).toEqual([
			CallMessageType.PRE_OFFER,
			CallMessageType.OFFER,
		]);
		expect(call.info.state).toBe("local-pre-offer");
		expect(env.manager.activeCall).toBe(call);
		const offer = env.session.sentToPeer()[1]?.msg.sdps?.[0];
		expect(offer).toContain("fake-offer");

		// Remote ANSWER → connecting → ICE connected.
		env.session.fireCall(
			env.session.event({
				uuid: call.uuid,
				type: CallMessageType.ANSWER,
				from: PEER,
				sdps: ["remote-answer-sdp"],
			}),
		);
		expect(call.info.state).toBe("connecting");
		await tick();
		expect(env.media.last.remoteAnswer).toBe("remote-answer-sdp");
		env.media.last.fireConnectionState("connected");
		expect(call.info.state).toBe("connected");
		expect(call.info.connectedAt).toBe(env.timers.now);

		// Trickle ICE is armed by the OFFER trace: a local candidate now
		// batches and ships as ICE_CANDIDATES after the debounce window.
		env.media.last.fireLocalCandidate({ candidate: "cand-1", sdpMLineIndex: 0, sdpMid: "0" });
		env.timers.advance(200);
		await tick();
		expect(env.session.sentTypes("peer")).toContain(CallMessageType.ICE_CANDIDATES);

		// Hangup → END_CALL peer + self, ended local-hangup.
		const ended: CallInfo[] = [];
		call.on("ended", (info) => ended.push(info));
		await call.hangup();
		expect(env.session.sentTypes("peer")).toContain(CallMessageType.END_CALL);
		expect(env.session.sentTypes("self")).toContain(CallMessageType.END_CALL);
		expect(ended).toHaveLength(1);
		expect(ended[0]?.endReason).toBe("local-hangup");
		expect(call.info.state).toBe("disconnected");
		expect(env.manager.activeCall).toBeUndefined();
		expect(env.media.last.closed).toBe(true);
		expect(env.errors).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// 2. Inbound accept flow
// ---------------------------------------------------------------------------

describe("inbound flow (CallManager level)", () => {
	test("PRE_OFFER+OFFER → incoming with Call → accept() → ANSWER peer+self → connected → remote END_CALL → ended remote-hangup", async () => {
		const env = makeEnv();
		env.manager.approveContact(PEER);
		const incoming: Call[] = [];
		env.manager.on("incoming", (c) => incoming.push(c));

		const uuid = "11111111-1111-4111-8111-111111111111";
		env.session.fireCall(
			env.session.event({ uuid, type: CallMessageType.PRE_OFFER, from: PEER }),
		);
		env.session.fireCall(
			env.session.event({
				uuid,
				type: CallMessageType.OFFER,
				from: PEER,
				sdps: ["remote-offer-sdp"],
			}),
		);
		expect(incoming).toHaveLength(1);
		const call = incoming[0] as Call;
		expect(call.info.direction).toBe("inbound");
		expect(call.info.state).toBe("remote-ring");
		expect(env.manager.activeCall).toBe(call);

		await call.accept();
		// ANSWER sent to the caller AND self-synced (so linked devices stop ringing).
		expect(env.session.sentTypes("peer")).toEqual([CallMessageType.ANSWER]);
		expect(env.session.sentTypes("self")).toEqual([CallMessageType.ANSWER]);
		expect(env.media.last.remoteOffer).toBe("remote-offer-sdp");
		expect(call.info.state).toBe("connecting");

		env.media.last.fireConnectionState("connected");
		expect(call.info.state).toBe("connected");

		// Remote hangup.
		const ended: CallInfo[] = [];
		call.on("ended", (info) => ended.push(info));
		env.timers.advance(4000);
		env.session.fireCall(
			env.session.event({ uuid, type: CallMessageType.END_CALL, from: PEER }),
		);
		expect(ended).toHaveLength(1);
		expect(ended[0]?.endReason).toBe("remote-hangup");
		expect(env.manager.activeCall).toBeUndefined();
		expect(env.errors).toEqual([]);
	});

	test("accept()/reject()/ignore() misuse on outbound calls rejects/throws typed errors", async () => {
		const env = makeEnv();
		env.manager.approveContact(PEER);
		const call = await env.manager.call(PEER);
		await expect(call.accept()).rejects.toThrow(InvalidCallMessageError);
		await expect(call.reject()).rejects.toThrow(InvalidCallMessageError);
		expect(() => call.ignore()).toThrow(InvalidCallMessageError);
		// The call is untouched by the misuse.
		expect(call.info.state).toBe("local-pre-offer");
		expect(env.errors).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// 3. Validation & policy rejections
// ---------------------------------------------------------------------------

describe("call() validation", () => {
	test("invalid Session IDs reject with InvalidCallMessageError", async () => {
		const env = makeEnv();
		for (const bad of [
			"not-a-session-id",
			"",
			`06${"a".repeat(64)}`, // wrong prefix
			`05${"a".repeat(63)}`, // too short
			`05${"a".repeat(65)}`, // too long
			`05${"g".repeat(64)}`, // not hex
		]) {
			await expect(env.manager.call(bad)).rejects.toThrow(InvalidCallMessageError);
		}
		expect(env.session.sent.length).toBe(0);
	});

	test("second concurrent call rejects with CallInProgressError", async () => {
		const env = makeEnv();
		env.manager.approveContact(PEER);
		env.manager.approveContact(PEER_B);
		const first = await env.manager.call(PEER);
		await expect(env.manager.call(PEER_B)).rejects.toThrow(CallInProgressError);
		// The first call is untouched.
		expect(env.manager.activeCall).toBe(first);
		expect(first.info.state).toBe("local-pre-offer");
	});

	test("unapproved peer with requireApprovedContact rejects PeerNotApprovedError", async () => {
		const env = makeEnv(); // requireApprovedContact defaults to true
		await expect(env.manager.call(PEER)).rejects.toThrow(PeerNotApprovedError);
		expect(env.session.sent.length).toBe(0);
		// approveContact() unblocks it.
		env.manager.approveContact(PEER);
		expect(env.manager.isContactApproved(PEER)).toBe(true);
		const call = await env.manager.call(PEER);
		expect(call.info.peer).toBe(PEER);
	});
});

// ---------------------------------------------------------------------------
// 4. TrickleIceSender units
// ---------------------------------------------------------------------------

describe("TrickleIceSender", () => {
	const mk = (opts?: { relay?: boolean }) => {
		const timers = new FakeTimers();
		const signaling = new FakeSignaling();
		const sender = new TrickleIceSender({
			peer: PEER,
			uuid: "trickle-uuid",
			signaling,
			batchIntervalMs: 200,
			iceTransportPolicy: opts?.relay ? "relay" : "all",
			timers: timers.batcherHooks,
		});
		return { timers, signaling, sender };
	};
	const HOST = {
		candidate: "candidate:1 1 udp 2130706431 192.0.2.1 50000 typ host",
		sdpMLineIndex: 0,
		sdpMid: "0",
	};
	const SRFLX = {
		candidate: "candidate:2 1 udp 1694498815 198.51.100.7 50000 typ srflx raddr 192.0.2.1 rport 50000",
		sdpMLineIndex: 0,
		sdpMid: "0",
	};
	const RELAY = {
		candidate: "candidate:3 1 udp 92020735 203.0.113.9 3478 typ relay raddr 198.51.100.7 rport 50000",
		sdpMLineIndex: 0,
		sdpMid: "0",
	};

	test("armed: candidates debounce 200 ms into ONE ICE_CANDIDATES with parallel arrays", () => {
		const { timers, signaling, sender } = mk();
		sender.arm();
		sender.feed(HOST);
		timers.advance(100); // inside the quiet window — nothing yet
		expect(signaling.calls).toHaveLength(0);
		sender.feed(SRFLX);
		sender.feed(RELAY);
		expect(signaling.calls).toHaveLength(0);
		timers.advance(200); // quiet period elapsed
		expect(signaling.calls).toHaveLength(1);
		const sent = signaling.calls[0];
		expect(sent?.kind).toBe("peer");
		expect(sent?.peer).toBe(PEER);
		expect(sent?.msg.type).toBe(CallMessageType.ICE_CANDIDATES);
		expect(sent?.msg.uuid).toBe("trickle-uuid");
		const batch = sent?.msg as unknown as {
			sdps: string[];
			sdpMLineIndexes: number[];
			sdpMids: string[];
		};
		expect(batch.sdps).toEqual([HOST.candidate, SRFLX.candidate, RELAY.candidate]);
		expect(batch.sdpMLineIndexes).toEqual([0, 0, 0]);
		expect(batch.sdpMids).toEqual(["0", "0", "0"]);
	});

	test("not armed: nothing is sent; arming releases buffered candidates", () => {
		const { timers, signaling, sender } = mk();
		sender.feed(HOST);
		sender.feed(SRFLX);
		timers.advance(1000); // well past the window — gate is shut
		expect(signaling.calls).toHaveLength(0);
		sender.arm();
		timers.advance(200);
		expect(signaling.calls).toHaveLength(1);
		const batch = signaling.calls[0]?.msg as unknown as { sdps: string[] };
		expect(batch.sdps).toEqual([HOST.candidate, SRFLX.candidate]);
	});

	test("relay mode filters non-relay candidates before batching", () => {
		const { timers, signaling, sender } = mk({ relay: true });
		sender.arm();
		sender.feed(HOST); // dropped
		sender.feed(SRFLX); // dropped
		sender.feed(RELAY); // kept
		timers.advance(200);
		expect(signaling.calls).toHaveLength(1);
		const batch = signaling.calls[0]?.msg as unknown as { sdps: string[] };
		expect(batch.sdps).toEqual([RELAY.candidate]);
		expect(isRelayCandidate(RELAY.candidate)).toBe(true);
		expect(isRelayCandidate(HOST.candidate)).toBe(false);
	});

	test("dispose drops pending candidates and sends nothing", () => {
		const { timers, signaling, sender } = mk();
		sender.arm();
		sender.feed(HOST);
		sender.dispose();
		timers.advance(1000);
		expect(signaling.calls).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// 5. Enum / literal boundary — protobuf-enum-typed payloads
// ---------------------------------------------------------------------------

describe("protobuf enum boundary (@session.js/types SignalService.CallMessage.Type)", () => {
	test("call events carrying the client's protobuf ENUM type are handled identically", async () => {
		const env = makeEnv();
		env.manager.approveContact(PEER);
		const T = SignalService.CallMessage.Type;
		// Sanity: the enum values are exactly our numeric literals.
		expect(T.PRE_OFFER).toBe(CallMessageType.PRE_OFFER);
		expect(T.OFFER).toBe(CallMessageType.OFFER);
		expect(T.ANSWER).toBe(CallMessageType.ANSWER);
		expect(T.ICE_CANDIDATES).toBe(CallMessageType.ICE_CANDIDATES);
		expect(T.END_CALL).toBe(CallMessageType.END_CALL);

		const incoming: Call[] = [];
		env.manager.on("incoming", (c) => incoming.push(c));
		const uuid = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

		// TYPE BRIDGE: the client's `call` event payload types `type` as the
		// protobuf enum; our CallMessageEvent types it as the literal union.
		// Structurally identical at runtime — the cast marks the boundary.
		const enumType = (t: SignalService.CallMessage.Type): never =>
			t as unknown as never;

		env.session.fireCall({
			uuid,
			type: enumType(T.PRE_OFFER),
			from: PEER,
			timestamp: env.timers.now,
			sdps: [],
			sdpMLineIndexes: [],
			sdpMids: [],
		});
		env.session.fireCall({
			uuid,
			type: enumType(T.OFFER),
			from: PEER,
			timestamp: env.timers.now,
			sdps: ["enum-offer-sdp"],
			sdpMLineIndexes: [],
			sdpMids: [],
		});
		expect(incoming).toHaveLength(1);
		const call = incoming[0] as Call;
		expect(call.info.state).toBe("remote-ring");

		await call.accept();
		// SessionSignaling handed our literal-typed ANSWER to the (fake)
		// client send path — the stored type value is the enum's value.
		const answer = env.session.sent.find((s) => !s.isSync);
		expect(answer?.msg.type).toBe(T.ANSWER);
		expect(answer?.msg.type).toBe(2);

		// Enum-typed END_CALL ends the call like the literal one.
		env.session.fireCall({
			uuid,
			type: enumType(T.END_CALL),
			from: PEER,
			timestamp: env.timers.now,
			sdps: [],
			sdpMLineIndexes: [],
			sdpMids: [],
		});
		expect(call.info.endReason).toBe("remote-hangup");
		expect(env.errors).toEqual([]);
	});

	test("SessionSignaling self-send targets own id with isSyncMessage", async () => {
		const session = new FakeSession();
		const signaling = new SessionSignaling(session);
		await signaling.sendToSelf({ type: CallMessageType.END_CALL, uuid: "u-1" });
		expect(session.sent).toHaveLength(1);
		expect(session.sent[0]?.to).toBe(session.ownId);
		expect(session.sent[0]?.isSync).toBe(true);
		expect(session.sent[0]?.msg.type).toBe(CallMessageType.END_CALL);
	});
});

// ---------------------------------------------------------------------------
// 6. Containment (P6-T3) — no unhandled rejection escapes CallManager
// ---------------------------------------------------------------------------

describe("containment: media/signaling failures never crash the host process", () => {
	let rejections: unknown[] = [];
	const onRejection = (err: unknown): void => {
		rejections.push(err);
	};

	afterEach(() => {
		process.removeListener("unhandledRejection", onRejection);
		rejections = [];
	});

	test("createSession throw / onAudio handler throw / sendCallMessage reject → error event, call ended, 0 unhandled rejections", async () => {
		process.on("unhandledRejection", onRejection);

		// (a) media engine createSession throws during call().
		{
			const env = makeEnv();
			env.manager.approveContact(PEER);
			env.media.createFailure = () => new MediaFailureError("forced createSession failure");
			const outgoing: Call[] = [];
			env.manager.on("outgoing", (c) => outgoing.push(c));
			await expect(env.manager.call(PEER)).rejects.toThrow(MediaFailureError);
			await tick();
			expect(env.errors.length).toBeGreaterThanOrEqual(1);
			expect(env.errors.some((e) => e.error instanceof MediaFailureError)).toBe(true);
			// The context was registered before the throw and got failed: ended "error".
			const call = outgoing[0] as Call;
			expect(call.info.state).toBe("disconnected");
			expect(call.info.endReason).toBe("error");
			expect(env.manager.activeCall).toBeUndefined();
			await env.manager.dispose();
		}

		// (b) consumer onAudio handler throws while audio arrives.
		{
			const env = makeEnv();
			env.manager.approveContact(PEER);
			const incoming: Call[] = [];
			env.manager.on("incoming", (c) => incoming.push(c));
			const uuid = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
			env.session.fireCall(
				env.session.event({ uuid, type: CallMessageType.PRE_OFFER, from: PEER }),
			);
			env.session.fireCall(
				env.session.event({
					uuid,
					type: CallMessageType.OFFER,
					from: PEER,
					sdps: ["offer"],
				}),
			);
			const call = incoming[0] as Call;
			await call.accept();
			env.media.last.fireConnectionState("connected");
			const ended: CallInfo[] = [];
			call.on("ended", (info) => ended.push(info));
			call.onAudio(() => {
				throw new Error("consumer audio pipeline exploded");
			});
			env.media.last.fireAudio(new Int16Array(960)); // triggers the throw
			await tick();
			expect(ended).toHaveLength(1);
			expect(ended[0]?.endReason).toBe("error");
			expect(env.errors.length).toBeGreaterThanOrEqual(1);
			expect(env.errors[0]?.call).toBe(call); // attributed
			await env.manager.dispose();
		}

		// (c) session.sendCallMessage rejects (signaling plane down).
		{
			const env = makeEnv();
			env.manager.approveContact(PEER);
			env.session.sendFailure = () => new Error("swarm store rejected");
			const outgoing: Call[] = [];
			env.manager.on("outgoing", (c) => outgoing.push(c));
			// call() itself resolves (PRE_OFFER is fire-and-forget)…
			const call = await env.manager.call(PEER);
			// …the rejection surfaces asynchronously: error event + end.
			await tick();
			await tick();
			expect(env.errors.length).toBeGreaterThanOrEqual(1);
			const outgoingCall = outgoing[0] as Call;
			expect(outgoingCall.info.state).toBe("disconnected");
			expect(outgoingCall.info.endReason).toBe("error");
			expect(env.manager.activeCall).toBeUndefined();
			expect(call).toBe(outgoingCall);
			await env.manager.dispose();
		}

		expect(rejections).toEqual([]);
	});

	test("dispose is idempotent and cleans up (no listeners left on the session)", async () => {
		const env = makeEnv();
		env.manager.approveContact(PEER);
		const call = await env.manager.call(PEER);
		await tick();
		await env.manager.dispose();
		await env.manager.dispose(); // idempotent
		expect(call.info.endReason).toBe("local-hangup");
		expect(env.session.callListeners.size).toBe(0);
		// Post-dispose inbound is inert.
		env.session.fireCall(
			env.session.event({
				uuid: "post-dispose",
				type: CallMessageType.PRE_OFFER,
				from: PEER_B,
			}),
		);
		expect(env.manager.activeCall).toBeUndefined();
		await expect(env.manager.call(PEER)).rejects.toThrow(CallError);
	});
});

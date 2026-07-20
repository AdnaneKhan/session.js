// SPDX-License-Identifier: AGPL-3.0-or-later
// P2-T3 verification: CallSupervisor with fake session/signaling/media.
// All time is injected (now()) except the timeout test, which uses a short
// real callTimeoutMs + await (sanctioned by the task spec).

import { afterEach, describe, expect, test } from "bun:test";
import {
	CallInProgressError,
	InvalidCallMessageError,
	PeerNotApprovedError,
} from "../src/errors.js";
import { ASSUMED_DEFAULT_POLL_INTERVAL_MS, CallContext, CallSupervisor } from "../src/supervisor.js";
import type {
	CallInfo,
	CallManagerOptions,
	CallMessageEvent,
	IceServer,
	MediaSession,
	MissedCallRecord,
	OutgoingCallMessage,
	SessionLike,
	SignalingSender,
} from "../src/types.js";
import { CallMessageType } from "../src/types.js";

const PEER = `05${"a".repeat(64)}`;
const PEER_A = `05${"1".repeat(64)}`;
const PEER_B = `05${"2".repeat(64)}`;
const OWN_ID = `05${"0".repeat(64)}`;

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeSession implements SessionLike {
	readonly ownId = OWN_ID;
	callListeners = new Set<(msg: CallMessageEvent) => void>();
	pollIntervals: number[] = [];
	approvedRequests: { from: string }[] = [];
	nowValue = 1_700_000_000_000;

	getSessionID(): string {
		return this.ownId;
	}
	getNowWithNetworkOffset(): number {
		return this.nowValue;
	}
	on(_event: "call", cb: (msg: CallMessageEvent) => void): void {
		this.callListeners.add(cb);
	}
	off(_event: "call", cb: (msg: CallMessageEvent) => void): void {
		this.callListeners.delete(cb);
	}
	async sendCallMessage(
		_to: string,
		_msg: OutgoingCallMessage,
		_options?: { isSyncMessage?: boolean },
	): Promise<{ messageHash: string; timestamp: number }> {
		return { messageHash: "fake-hash", timestamp: this.nowValue };
	}
	setPollInterval(interval: number): void {
		this.pollIntervals.push(interval);
	}
	async acceptConversationRequest(opts: { from: string }): Promise<unknown> {
		this.approvedRequests.push(opts);
		return {};
	}
	fireCall(msg: CallMessageEvent): void {
		for (const cb of [...this.callListeners]) cb(msg);
	}
}

class FakeSignaling implements SignalingSender {
	calls: { kind: "peer" | "self"; peer?: string; msg: OutgoingCallMessage }[] = [];

	async sendToPeer(peer: string, msg: OutgoingCallMessage): Promise<void> {
		this.calls.push({ kind: "peer", peer, msg });
	}
	async sendToSelf(msg: OutgoingCallMessage): Promise<void> {
		this.calls.push({ kind: "self", msg });
	}
	peerTypes(): number[] {
		return this.calls.filter((c) => c.kind === "peer").map((c) => c.msg.type);
	}
	selfTypes(): number[] {
		return this.calls.filter((c) => c.kind === "self").map((c) => c.msg.type);
	}
	peerCalls(): { peer?: string; msg: OutgoingCallMessage }[] {
		return this.calls.filter((c) => c.kind === "peer");
	}
}

class FakeMediaSession implements MediaSession {
	methodCalls: string[] = [];
	offer = "v=0\r\no=- fake-offer 2 IN IP4 127.0.0.1\r\n";
	answer = "v=0\r\no=- fake-answer 2 IN IP4 127.0.0.1\r\n";
	remoteOffer: string | undefined;
	remoteAnswer: string | undefined;
	remoteCandidates: { candidate: string; sdpMLineIndex: number; sdpMid: string }[] = [];
	dcSent: { hangup?: boolean; video?: boolean }[] = [];
	closed = false;
	offerCounter = 0;

	#connectionStateCb:
		| ((s: "connecting" | "connected" | "disconnected" | "failed") => void)
		| undefined;
	#dcMessageCb:
		| ((msg: { hangup?: boolean; hang_up?: boolean; video?: boolean }) => void)
		| undefined;
	#audioCb: ((pcm: Int16Array) => void)[] = [];
	#videoToggleCbs: ((enabled: boolean) => void)[] = [];

	async createOffer(opts?: { iceRestart?: boolean }): Promise<string> {
		this.methodCalls.push(opts?.iceRestart ? "createOffer:iceRestart" : "createOffer");
		this.offerCounter += 1;
		return `${this.offer}o-session=${this.offerCounter}\r\n`;
	}
	async setRemoteOffer(offer: string): Promise<void> {
		this.methodCalls.push("setRemoteOffer");
		this.remoteOffer = offer;
	}
	async createAnswer(): Promise<string> {
		this.methodCalls.push("createAnswer");
		return this.answer;
	}
	async setRemoteAnswer(answer: string): Promise<void> {
		this.methodCalls.push("setRemoteAnswer");
		this.remoteAnswer = answer;
	}
	async addRemoteCandidate(c: {
		candidate: string;
		sdpMLineIndex: number;
		sdpMid: string;
	}): Promise<void> {
		this.methodCalls.push("addRemoteCandidate");
		this.remoteCandidates.push(c);
	}
	onLocalCandidate(_cb: (c: { candidate: string; sdpMLineIndex: number; sdpMid: string }) => void): void {
		this.methodCalls.push("onLocalCandidate");
	}
	onConnectionState(
		cb: (s: "connecting" | "connected" | "disconnected" | "failed") => void,
	): void {
		this.#connectionStateCb = cb;
	}
	onDataChannelMessage(
		cb: (msg: { hangup?: boolean; hang_up?: boolean; video?: boolean }) => void,
	): void {
		this.methodCalls.push("onDataChannelMessage");
		this.#dcMessageCb = cb;
	}
	sendDataChannelMessage(msg: { hangup?: boolean; video?: boolean }): void {
		this.methodCalls.push("sendDataChannelMessage");
		this.dcSent.push(msg);
	}
	onAudio(cb: (pcm: Int16Array) => void): void {
		this.#audioCb.push(cb);
	}
	writeAudio(_pcm: Int16Array): boolean {
		this.methodCalls.push("writeAudio");
		return true;
	}
	onRemoteVideoToggle(cb: (enabled: boolean) => void): void {
		this.#videoToggleCbs.push(cb);
	}
	close(): void {
		this.closed = true;
		this.methodCalls.push("close");
	}

	// test drivers
	fireConnectionState(s: "connecting" | "connected" | "disconnected" | "failed"): void {
		this.#connectionStateCb?.(s);
	}
	fireDataChannelMessage(m: { hangup?: boolean; hang_up?: boolean; video?: boolean }): void {
		this.#dcMessageCb?.(m);
	}
	fireAudio(pcm: Int16Array): void {
		for (const cb of this.#audioCb) cb(pcm);
	}
	fireVideoToggle(enabled: boolean): void {
		for (const cb of this.#videoToggleCbs) cb(enabled);
	}
}

class FakeMedia {
	sessions: FakeMediaSession[] = [];
	created: { uuid: string; role: "caller" | "callee"; opts: { iceServers: IceServer[]; iceTransportPolicy: "all" | "relay" } }[] = [];

	createSession(
		uuid: string,
		role: "caller" | "callee",
		opts: { iceServers: IceServer[]; iceTransportPolicy: "all" | "relay" },
	): FakeMediaSession {
		const s = new FakeMediaSession();
		this.sessions.push(s);
		this.created.push({ uuid, role, opts });
		return s;
	}
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
	sup: CallSupervisor;
	session: FakeSession;
	signaling: FakeSignaling;
	media: FakeMedia;
	now(): number;
	advance(ms: number): void;
	incoming: CallContext[];
	outgoing: CallContext[];
	missed: MissedCallRecord[];
	ended: { ctx: CallContext; info: CallInfo }[];
	stateChanges: { uuid: string; state: string }[];
	errors: Error[];
}

const harnesses: CallSupervisor[] = [];

function makeHarness(options?: CallManagerOptions): Harness {
	let clockNow = 1_700_000_000_000;
	let uuidCounter = 0;
	const session = new FakeSession();
	session.nowValue = clockNow;
	const signaling = new FakeSignaling();
	const media = new FakeMedia();
	const h: Harness = {
		sup: undefined as never,
		session,
		signaling,
		media,
		now: () => clockNow,
		advance: (ms) => {
			clockNow += ms;
			session.nowValue = clockNow;
		},
		incoming: [],
		outgoing: [],
		missed: [],
		ended: [],
		stateChanges: [],
		errors: [],
	};
	h.sup = new CallSupervisor({
		session,
		signaling,
		media: media as never,
		options,
		now: () => clockNow,
		createUuid: () =>
			`00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, "0")}`,
		logger: () => undefined,
	});
	h.sup.onIncoming((ctx) => h.incoming.push(ctx));
	h.sup.onOutgoing((ctx) => h.outgoing.push(ctx));
	h.sup.onMissed((m) => h.missed.push(m));
	h.sup.onEnded((ctx, info) => h.ended.push({ ctx, info }));
	h.sup.onStateChanged((ctx, state) => h.stateChanges.push({ uuid: ctx.uuid, state }));
	h.sup.onError((err) => h.errors.push(err));
	harnesses.push(h.sup);
	return h;
}

function msg(
	h: Harness,
	partial: Partial<CallMessageEvent> & Pick<CallMessageEvent, "uuid" | "type" | "from">,
): CallMessageEvent {
	return {
		timestamp: h.now(),
		sdps: [],
		sdpMLineIndexes: [],
		sdpMids: [],
		...partial,
	};
}

afterEach(async () => {
	while (harnesses.length > 0) {
		const sup = harnesses.pop();
		await sup?.dispose();
	}
});

// ---------------------------------------------------------------------------
// 1. Outbound happy path
// ---------------------------------------------------------------------------

describe("outbound happy path", () => {
	test("placeCall -> ANSWER -> connected -> hangup with full wire sequence", async () => {
		const h = makeHarness();
		h.sup.markApproved(PEER);
		const ctx = h.sup.placeCall(PEER);

		// autoApprove fired; poll boosted; PRE_OFFER sent immediately.
		expect(h.session.approvedRequests).toEqual([{ from: PEER }]);
		expect(h.session.pollIntervals).toEqual([500]);
		expect(h.signaling.peerTypes()).toEqual([CallMessageType.PRE_OFFER]);
		expect(ctx.state).toBe("local-pre-offer");
		expect(ctx.direction).toBe("outbound");
		expect(h.outgoing.length).toBe(1);

		// OFFER follows after createOffer resolves.
		await tick();
		expect(h.signaling.peerTypes()).toEqual([
			CallMessageType.PRE_OFFER,
			CallMessageType.OFFER,
		]);
		const offerMsg = h.signaling.peerCalls()[1]?.msg;
		expect(offerMsg?.sdps?.[0]).toContain("fake-offer");
		expect(h.media.created[0]?.role).toBe("caller");
		expect(h.media.created[0]?.opts.iceServers.length).toBe(2);
		expect(h.media.created[0]?.opts.iceTransportPolicy).toBe("all");

		// Inbound ANSWER (from local-pre-offer via the supplementary FSM row).
		h.session.fireCall(
			msg(h, {
				uuid: ctx.uuid,
				type: CallMessageType.ANSWER,
				from: PEER,
				sdps: ["remote-answer-sdp"],
			}),
		);
		expect(ctx.state).toBe("connecting");
		await tick();
		expect(h.media.sessions[0]?.remoteAnswer).toBe("remote-answer-sdp");

		// ICE connects.
		h.media.sessions[0]?.fireConnectionState("connected");
		expect(ctx.state).toBe("connected");
		expect(ctx.info.connectedAt).toBe(h.now());

		// Hangup.
		await ctx.hangup();
		expect(h.media.sessions[0]?.dcSent).toEqual([{ hangup: true }]);
		expect(h.signaling.peerTypes()).toEqual([
			CallMessageType.PRE_OFFER,
			CallMessageType.OFFER,
			CallMessageType.END_CALL,
		]);
		expect(h.signaling.selfTypes()).toEqual([CallMessageType.END_CALL]);
		expect(h.ended.length).toBe(1);
		expect(h.ended[0]?.info.endReason).toBe("local-hangup");
		expect(ctx.info.endReason).toBe("local-hangup");
		expect(ctx.info.endedAt).toBe(h.now());
		expect(h.media.sessions[0]?.closed).toBe(true);
		// Poll interval restored (assumed default 3000).
		expect(h.session.pollIntervals).toEqual([500, ASSUMED_DEFAULT_POLL_INTERVAL_MS]);
		expect(h.sup.activeContext).toBeUndefined();
		expect(h.errors).toEqual([]);
	});

	test("policy errors: unapproved peer and call-in-progress", () => {
		const h = makeHarness();
		expect(() => h.sup.placeCall(PEER)).toThrow(PeerNotApprovedError);

		h.sup.markApproved(PEER_A);
		h.sup.markApproved(PEER_B);
		const active = h.sup.placeCall(PEER_A);
		expect(() => h.sup.placeCall(PEER_B)).toThrow(CallInProgressError);
		try {
			h.sup.placeCall(PEER_B);
		} catch (err) {
			expect((err as CallInProgressError).activeUuid).toBe(active.uuid);
		}
	});

	test("requireApprovedContact: false skips the gate; autoApproveOnCall: false skips the request", () => {
		const h = makeHarness({ requireApprovedContact: false, autoApproveOnCall: false });
		const ctx = h.sup.placeCall(PEER);
		expect(ctx.peer).toBe(PEER);
		expect(h.session.approvedRequests).toEqual([]);
		// The outbound call itself still marks the peer approved.
		expect(h.sup.isApproved(PEER)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 2. Inbound accept
// ---------------------------------------------------------------------------

describe("inbound accept flow", () => {
	test("PRE_OFFER -> OFFER -> accept -> connected -> remote END_CALL", async () => {
		const h = makeHarness();
		h.sup.markApproved(PEER);
		const uuid = "11111111-1111-4111-8111-111111111111";

		h.session.fireCall(msg(h, { uuid, type: CallMessageType.PRE_OFFER, from: PEER }));
		expect(h.incoming.length).toBe(1);
		const ctx = h.incoming[0] as CallContext;
		expect(ctx.state).toBe("remote-pre-offer");
		expect(ctx.direction).toBe("inbound");
		expect(h.session.pollIntervals).toEqual([500]);
		expect(h.media.sessions.length).toBe(0); // media waits for the OFFER

		h.advance(100);
		h.session.fireCall(
			msg(h, { uuid, type: CallMessageType.OFFER, from: PEER, sdps: ["remote-offer-sdp"] }),
		);
		expect(ctx.pendingOffer).toBe("remote-offer-sdp");
		expect(ctx.state).toBe("remote-ring");
		expect(h.media.sessions.length).toBe(1);
		expect(h.media.created[0]?.role).toBe("callee");

		await ctx.accept();
		expect(h.media.sessions[0]?.remoteOffer).toBe("remote-offer-sdp");
		expect(h.media.sessions[0]?.methodCalls).toContain("createAnswer");
		expect(h.signaling.peerTypes()).toEqual([CallMessageType.ANSWER]);
		expect(h.signaling.selfTypes()).toEqual([CallMessageType.ANSWER]); // §4.5 self-sync
		const answerSdp = h.signaling.peerCalls()[0]?.msg.sdps?.[0];
		expect(answerSdp).toContain("fake-answer");
		expect(ctx.state).toBe("connecting");

		h.media.sessions[0]?.fireConnectionState("connected");
		expect(ctx.state).toBe("connected");

		h.advance(4000);
		h.session.fireCall(msg(h, { uuid, type: CallMessageType.END_CALL, from: PEER }));
		expect(h.ended.length).toBe(1);
		expect(h.ended[0]?.info.endReason).toBe("remote-hangup");
		expect(ctx.info.state).toBe("disconnected");
		expect(h.media.sessions[0]?.closed).toBe(true);
		expect(h.session.pollIntervals).toEqual([500, ASSUMED_DEFAULT_POLL_INTERVAL_MS]);
		expect(h.errors).toEqual([]);
	});

	test("ICE candidates buffer before media exists, drain on OFFER", () => {
		const h = makeHarness();
		h.sup.markApproved(PEER);
		const uuid = "22222222-2222-4222-8222-222222222222";
		h.session.fireCall(msg(h, { uuid, type: CallMessageType.PRE_OFFER, from: PEER }));
		h.session.fireCall(
			msg(h, {
				uuid,
				type: CallMessageType.ICE_CANDIDATES,
				from: PEER,
				sdps: ["cand-1", "cand-2"],
				sdpMLineIndexes: [0, 1],
				sdpMids: ["0", "1"],
			}),
		);
		expect(h.media.sessions.length).toBe(0);
		h.session.fireCall(
			msg(h, { uuid, type: CallMessageType.OFFER, from: PEER, sdps: ["offer-sdp"] }),
		);
		expect(h.media.sessions[0]?.remoteCandidates).toEqual([
			{ candidate: "cand-1", sdpMLineIndex: 0, sdpMid: "0" },
			{ candidate: "cand-2", sdpMLineIndex: 1, sdpMid: "1" },
		]);
		// Late candidates go straight to the media session.
		h.session.fireCall(
			msg(h, {
				uuid,
				type: CallMessageType.ICE_CANDIDATES,
				from: PEER,
				sdps: ["cand-3"],
				sdpMLineIndexes: [0],
				sdpMids: ["0"],
			}),
		);
		expect(h.media.sessions[0]?.remoteCandidates.length).toBe(3);
	});

	test("OFFER without PRE_OFFER still creates a context (Desktop-tolerant)", () => {
		const h = makeHarness();
		h.sup.markApproved(PEER);
		const uuid = "33333333-3333-4333-8333-333333333333";
		h.session.fireCall(
			msg(h, { uuid, type: CallMessageType.OFFER, from: PEER, sdps: ["offer-sdp"] }),
		);
		expect(h.incoming.length).toBe(1);
		expect((h.incoming[0] as CallContext).state).toBe("remote-ring");
		expect((h.incoming[0] as CallContext).pendingOffer).toBe("offer-sdp");
	});
});

// ---------------------------------------------------------------------------
// 3. Reject
// ---------------------------------------------------------------------------

describe("reject", () => {
	test("sends END_CALL to peer AND self; reason remote-declined (caller view)", async () => {
		const h = makeHarness();
		h.sup.markApproved(PEER);
		const uuid = "44444444-4444-4444-8444-444444444444";
		h.session.fireCall(msg(h, { uuid, type: CallMessageType.PRE_OFFER, from: PEER }));
		h.session.fireCall(
			msg(h, { uuid, type: CallMessageType.OFFER, from: PEER, sdps: ["offer-sdp"] }),
		);
		const ctx = h.incoming[0] as CallContext;
		await ctx.reject();
		expect(h.signaling.peerTypes()).toEqual([CallMessageType.END_CALL]);
		expect(h.signaling.selfTypes()).toEqual([CallMessageType.END_CALL]);
		expect(h.ended[0]?.info.endReason).toBe("remote-declined");
		expect(h.sup.activeContext).toBeUndefined();
		expect(h.missed).toEqual([]); // a reject is not a missed call
	});
});

// ---------------------------------------------------------------------------
// 4. Ignore
// ---------------------------------------------------------------------------

describe("ignore", () => {
	test("NO wire messages; missed recorded locally with reason ignored", () => {
		const h = makeHarness();
		h.sup.markApproved(PEER);
		const uuid = "55555555-5555-4555-8555-555555555555";
		h.session.fireCall(msg(h, { uuid, type: CallMessageType.PRE_OFFER, from: PEER }));
		const ctx = h.incoming[0] as CallContext;
		ctx.ignore();
		expect(h.signaling.calls.length).toBe(0);
		expect(h.missed).toEqual([{ peer: PEER, at: h.now(), reason: "ignored" }]);
		expect(h.sup.activeContext).toBeUndefined();
		expect(h.ended).toEqual([]);
		expect(h.session.pollIntervals).toEqual([500, ASSUMED_DEFAULT_POLL_INTERVAL_MS]);
	});
});

// ---------------------------------------------------------------------------
// 5. Busy
// ---------------------------------------------------------------------------

describe("busy arbitration", () => {
	test("second inbound PRE_OFFER (different uuid) -> missed busy + END_CALL for the NEW uuid", () => {
		const h = makeHarness();
		h.sup.markApproved(PEER_A);
		h.sup.markApproved(PEER_B);
		const active = h.sup.placeCall(PEER_A);
		const snapshotState = active.state;

		h.session.fireCall(
			msg(h, {
				uuid: "99999999-9999-4999-8999-999999999999",
				type: CallMessageType.PRE_OFFER,
				from: PEER_B,
			}),
		);
		// Missed recorded for the inbound caller...
		expect(h.missed).toEqual([{ peer: PEER_B, at: h.now(), reason: "busy" }]);
		// ...END_CALL sent for the INBOUND uuid (not the active call's)...
		const endCall = h.signaling
			.peerCalls()
			.find((c) => c.msg.type === CallMessageType.END_CALL);
		expect(endCall?.peer).toBe(PEER_B);
		expect(endCall?.msg.uuid).toBe("99999999-9999-4999-8999-999999999999");
		// ...and the active call is untouched.
		expect(h.sup.activeContext).toBe(active);
		expect(active.state).toBe(snapshotState);
		expect(h.incoming.length).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// 6. Stale PRE_OFFER
// ---------------------------------------------------------------------------

describe("stale PRE_OFFER", () => {
	test("61s-old PRE_OFFER -> missed stale, no incoming emitted", () => {
		const h = makeHarness();
		h.sup.markApproved(PEER);
		h.advance(61_000);
		h.session.fireCall(
			msg(h, {
				uuid: "66666666-6666-4666-8666-666666666666",
				type: CallMessageType.PRE_OFFER,
				from: PEER,
				timestamp: h.now() - 61_000,
			}),
		);
		expect(h.missed).toEqual([{ peer: PEER, at: h.now(), reason: "stale" }]);
		expect(h.incoming.length).toBe(0);
		expect(h.sup.activeContext).toBeUndefined();
	});

	test("60s-old PRE_OFFER is still fresh (boundary)", () => {
		const h = makeHarness();
		h.sup.markApproved(PEER);
		h.advance(60_000);
		h.session.fireCall(
			msg(h, {
				uuid: "66666666-6666-4666-8666-666666666667",
				type: CallMessageType.PRE_OFFER,
				from: PEER,
				timestamp: h.now() - 60_000,
			}),
		);
		expect(h.incoming.length).toBe(1);
		expect(h.missed).toEqual([]);
	});

	test("stale non-PRE_OFFER is dropped silently (no missed record)", () => {
		const h = makeHarness();
		h.sup.markApproved(PEER);
		h.advance(400_000);
		h.session.fireCall(
			msg(h, {
				uuid: "66666666-6666-4666-8666-666666666668",
				type: CallMessageType.OFFER,
				from: PEER,
				timestamp: h.now() - 400_000,
			}),
		);
		expect(h.missed).toEqual([]);
		expect(h.incoming.length).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// 7. Unapproved inbound
// ---------------------------------------------------------------------------

describe("approval gate", () => {
	test("unapproved inbound PRE_OFFER is dropped silently with NO missed record", () => {
		const h = makeHarness(); // requireApprovedContact defaults true
		h.session.fireCall(
			msg(h, {
				uuid: "77777777-7777-4777-8777-777777777777",
				type: CallMessageType.PRE_OFFER,
				from: PEER,
			}),
		);
		expect(h.missed).toEqual([]);
		expect(h.incoming.length).toBe(0);
		expect(h.signaling.calls.length).toBe(0);
		expect(h.errors).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// 8. Self messages (multi-device sync semantics)
// ---------------------------------------------------------------------------

describe("self-message handling", () => {
	test("self ANSWER on active inbound call -> ended answered-elsewhere", () => {
		const h = makeHarness();
		h.sup.markApproved(PEER);
		const uuid = "88888888-8888-4888-8888-888888888881";
		h.session.fireCall(msg(h, { uuid, type: CallMessageType.PRE_OFFER, from: PEER }));
		const ctx = h.incoming[0] as CallContext;
		h.session.fireCall(
			msg(h, {
				uuid,
				type: CallMessageType.ANSWER,
				from: h.session.ownId,
				sdps: ["other-device-answer"],
			}),
		);
		expect(h.ended.length).toBe(1);
		expect(h.ended[0]?.info.endReason).toBe("answered-elsewhere");
		expect(ctx.info.state).toBe("disconnected");
		expect(h.missed).toEqual([]);
	});

	test("self END_CALL on active inbound call -> ended ended-elsewhere", () => {
		const h = makeHarness();
		h.sup.markApproved(PEER);
		const uuid = "88888888-8888-4888-8888-888888888882";
		h.session.fireCall(msg(h, { uuid, type: CallMessageType.PRE_OFFER, from: PEER }));
		const ctx = h.incoming[0] as CallContext;
		h.session.fireCall(
			msg(h, { uuid, type: CallMessageType.END_CALL, from: h.session.ownId }),
		);
		expect(h.ended[0]?.info.endReason).toBe("ended-elsewhere");
		expect(ctx.info.state).toBe("disconnected");
	});

	test("self PRE_OFFER / OFFER / ICE are dropped without crashing", () => {
		const h = makeHarness();
		for (const type of [
			CallMessageType.PRE_OFFER,
			CallMessageType.OFFER,
			CallMessageType.ICE_CANDIDATES,
			CallMessageType.PROVISIONAL_ANSWER,
		]) {
			h.session.fireCall(
				msg(h, { uuid: `self-drop-${type}`, type, from: h.session.ownId, sdps: ["x"] }),
			);
		}
		expect(h.incoming.length).toBe(0);
		expect(h.missed).toEqual([]);
		expect(h.errors).toEqual([]);
		expect(h.sup.activeContext).toBeUndefined();
	});

	test("self ANSWER / END_CALL with no matching context are ignored", () => {
		const h = makeHarness();
		h.session.fireCall(
			msg(h, {
				uuid: "no-such-call",
				type: CallMessageType.ANSWER,
				from: h.session.ownId,
				sdps: ["x"],
			}),
		);
		h.session.fireCall(
			msg(h, { uuid: "no-such-call", type: CallMessageType.END_CALL, from: h.session.ownId }),
		);
		expect(h.errors).toEqual([]);
		expect(h.ended).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// 9. Timeout
// ---------------------------------------------------------------------------

describe("call timeout", () => {
	test("no ANSWER before callTimeoutMs -> END_CALL peer+self, ended timeout, NO missed", async () => {
		const h = makeHarness({ callTimeoutMs: 20 });
		h.sup.markApproved(PEER);
		const ctx = h.sup.placeCall(PEER);
		await sleep(60);
		expect(h.signaling.peerTypes()).toContain(CallMessageType.END_CALL);
		expect(h.signaling.selfTypes()).toEqual([CallMessageType.END_CALL]);
		expect(h.ended.length).toBe(1);
		expect(h.ended[0]?.info.endReason).toBe("timeout");
		expect(h.ended[0]?.uuid === undefined ? ctx.uuid : h.ended[0]?.ctx.uuid).toBe(ctx.uuid);
		expect(h.missed).toEqual([]); // our own call — not a missed call
		expect(h.sup.activeContext).toBeUndefined();
		expect(h.session.pollIntervals).toEqual([500, ASSUMED_DEFAULT_POLL_INTERVAL_MS]);
	});
});

// ---------------------------------------------------------------------------
// 10. Chaos
// ---------------------------------------------------------------------------

describe("chaos: random/unknown events never throw uncaught", () => {
	test("barrage of garbage inbound messages", () => {
		const h = makeHarness();
		h.sup.markApproved(PEER);
		const uuids = ["known-1", "unknown-2", "", "x".repeat(500)];
		const types = [
			CallMessageType.PRE_OFFER,
			CallMessageType.OFFER,
			CallMessageType.ANSWER,
			CallMessageType.PROVISIONAL_ANSWER,
			CallMessageType.ICE_CANDIDATES,
			CallMessageType.END_CALL,
		];
		for (let i = 0; i < 60; i++) {
			const uuid = uuids[i % uuids.length] as string;
			const type = types[i % types.length] as CallMessageEvent["type"];
			const from = i % 3 === 0 ? h.session.ownId : PEER;
			h.session.fireCall(
				msg(h, {
					uuid,
					type,
					from,
					timestamp: i % 4 === 0 ? h.now() - 1_000_000 : h.now(),
					sdps: i % 2 === 0 ? ["sdp-a", "sdp-b"] : [],
					sdpMLineIndexes: i % 3 === 0 ? [0] : [0, 1], // deliberate mismatch sometimes
					sdpMids: ["0", "1"],
				}),
			);
		}
		// Duplicate END_CALLs for an already-ended call (graveyard path).
		const ended = h.ended[0];
		if (ended) {
			h.session.fireCall(
				msg(h, { uuid: ended.ctx.uuid, type: CallMessageType.END_CALL, from: PEER }),
			);
			h.session.fireCall(
				msg(h, { uuid: ended.ctx.uuid, type: CallMessageType.END_CALL, from: PEER }),
			);
		}
		expect(h.errors).toEqual([]);
	});

	test("user actions on unknown uuids reject cleanly", async () => {
		const h = makeHarness();
		await expect(h.sup.accept("nope")).rejects.toThrow(InvalidCallMessageError);
		await expect(h.sup.reject("nope")).rejects.toThrow(InvalidCallMessageError);
		await expect(h.sup.hangup("nope")).rejects.toThrow(InvalidCallMessageError);
		await expect(h.sup.ignore("nope")).rejects.toThrow(InvalidCallMessageError);
	});
});

// ---------------------------------------------------------------------------
// 11. End-reason heuristic + misc
// ---------------------------------------------------------------------------

describe("end-reason heuristic and events", () => {
	test("outbound END_CALL before connect -> remote-declined; after connect -> remote-hangup", async () => {
		const h = makeHarness();
		h.sup.markApproved(PEER);

		// Declined: END_CALL while still local-pre-offer.
		const ctx1 = h.sup.placeCall(PEER);
		await tick();
		h.session.fireCall(
			msg(h, { uuid: ctx1.uuid, type: CallMessageType.END_CALL, from: PEER }),
		);
		expect(h.ended[0]?.info.endReason).toBe("remote-declined");

		// Hangup: END_CALL after connecting (ANSWER received => everConnected
		// path requires ice; here we reconnect context after the answer).
		const ctx2 = h.sup.placeCall(PEER);
		await tick();
		h.session.fireCall(
			msg(h, {
				uuid: ctx2.uuid,
				type: CallMessageType.ANSWER,
				from: PEER,
				sdps: ["answer"],
			}),
		);
		h.media.sessions[1]?.fireConnectionState("connected");
		h.session.fireCall(
			msg(h, { uuid: ctx2.uuid, type: CallMessageType.END_CALL, from: PEER }),
		);
		expect(h.ended[1]?.info.endReason).toBe("remote-hangup");
	});

	test("state + signaling events fire; audio/video plumbing delegates to media", async () => {
		const h = makeHarness();
		h.sup.markApproved(PEER);
		const ctx = h.sup.placeCall(PEER);
		const signals: { direction: string; type: number }[] = [];
		ctx.on("signaling", (s) => signals.push({ direction: s.direction, type: s.type }));
		await tick();

		// writeAudio/onAudio delegate once media exists.
		const pcm = new Int16Array(960);
		expect(ctx.writeAudio(pcm)).toBe(true);
		expect(h.media.sessions[0]?.methodCalls).toContain("writeAudio");
		const received: Int16Array[] = [];
		ctx.onAudio((frame) => received.push(frame));
		h.media.sessions[0]?.fireAudio(pcm);
		expect(received.length).toBe(1);
		expect(received[0]).toBe(pcm);

		// Remote video toggle is surfaced (informational only).
		const toggles: boolean[] = [];
		ctx.onRemoteVideoToggle((enabled) => toggles.push(enabled));
		h.media.sessions[0]?.fireVideoToggle(true);
		expect(toggles).toEqual([true]);

		// writeAudio before media exists returns false (inbound pre-OFFER).
		// End the outbound call first so the inbound PRE_OFFER is not "busy".
		await ctx.hangup();
		const uuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
		h.session.fireCall(msg(h, { uuid, type: CallMessageType.PRE_OFFER, from: PEER }));
		const inbound = h.incoming[0] as CallContext;
		expect(inbound).toBeDefined();
		expect(inbound.mediaSession).toBeUndefined();
		expect(inbound.writeAudio(pcm)).toBe(false);

		// state changes observed at supervisor level.
		expect(h.stateChanges.some((s) => s.uuid === ctx.uuid && s.state === "local-pre-offer")).toBe(
			true,
		);
		// PRE_OFFER was traced before we subscribed (synchronous in
		// placeCall); the OFFER trace fires post-subscription, after tick().
		expect(signals.some((s) => s.direction === "out" && s.type === CallMessageType.OFFER)).toBe(
			true,
		);
	});
});

// ---------------------------------------------------------------------------
// 12. Dispose
// ---------------------------------------------------------------------------

describe("dispose", () => {
	test("hangs up the active call, unhooks the session listener, restores poll", async () => {
		const h = makeHarness();
		h.sup.markApproved(PEER);
		const ctx = h.sup.placeCall(PEER);
		await tick();
		await h.sup.dispose();

		expect(h.ended[0]?.info.endReason).toBe("local-hangup");
		expect(h.signaling.peerTypes()).toContain(CallMessageType.END_CALL);
		expect(h.signaling.selfTypes()).toContain(CallMessageType.END_CALL);
		expect(h.session.pollIntervals).toEqual([500, ASSUMED_DEFAULT_POLL_INTERVAL_MS]);
		expect(h.session.callListeners.size).toBe(0);
		expect(ctx.info.state).toBe("disconnected");

		// Inbound messages after dispose are inert.
		h.session.fireCall(
			msg(h, {
				uuid: "post-dispose",
				type: CallMessageType.PRE_OFFER,
				from: PEER,
			}),
		);
		expect(h.incoming.length).toBe(0);
		expect(h.sup.activeContext).toBeUndefined();
	});

	test("dispose while inbound ringing declines the call (END_CALL sent)", async () => {
		const h = makeHarness();
		h.sup.markApproved(PEER);
		h.session.fireCall(
			msg(h, {
				uuid: "ringing-at-dispose",
				type: CallMessageType.PRE_OFFER,
				from: PEER,
			}),
		);
		await h.sup.dispose();
		expect(h.ended[0]?.info.endReason).toBe("remote-declined");
		expect(h.signaling.peerTypes()).toEqual([CallMessageType.END_CALL]);
		expect(h.signaling.selfTypes()).toEqual([CallMessageType.END_CALL]);
	});
});

// ---------------------------------------------------------------------------
// 13. Datachannel hangup hint
// ---------------------------------------------------------------------------

describe("datachannel hangup hint", () => {
	test("remote {hangup:true} accelerates teardown as remote-hangup", async () => {
		const h = makeHarness();
		h.sup.markApproved(PEER);
		const uuid = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
		h.session.fireCall(msg(h, { uuid, type: CallMessageType.PRE_OFFER, from: PEER }));
		h.session.fireCall(
			msg(h, { uuid, type: CallMessageType.OFFER, from: PEER, sdps: ["offer"] }),
		);
		const ctx = h.incoming[0] as CallContext;
		await ctx.accept();
		h.media.sessions[0]?.fireConnectionState("connected");
		// Datachannel hint (§3.1: we accept both `hangup` and iOS `hang_up`).
		h.media.sessions[0]?.fireDataChannelMessage({ hangup: true });
		expect(h.ended[0]?.info.endReason).toBe("remote-hangup");
		expect(ctx.info.state).toBe("disconnected");
		expect(h.media.sessions[0]?.closed).toBe(true);
	});

	test("iOS {hang_up:true} variant is accepted too", async () => {
		const h = makeHarness();
		h.sup.markApproved(PEER);
		const uuid = "dddddddd-dddd-4ddd-8ddd-ddddddddddde";
		h.session.fireCall(msg(h, { uuid, type: CallMessageType.PRE_OFFER, from: PEER }));
		h.session.fireCall(
			msg(h, { uuid, type: CallMessageType.OFFER, from: PEER, sdps: ["offer"] }),
		);
		const ctx = h.incoming[0] as CallContext;
		await ctx.accept();
		h.media.sessions[0]?.fireConnectionState("connected");
		h.media.sessions[0]?.fireDataChannelMessage({ hang_up: true });
		expect(h.ended[0]?.info.endReason).toBe("remote-hangup");
		expect(ctx.info.state).toBe("disconnected");
	});
});

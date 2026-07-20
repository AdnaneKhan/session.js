// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Tier-1 E2E suite (plan P7-T2): offline-first, networked variants gated
// behind SESSION_CALLS_NETWORK_TESTS=1. Offline scenarios use the in-process
// SignalingBus + the REAL werift media plane (host-candidate ICE, iceServers
// [] — zero TURN traffic). Semantics mirror calls/test/call-paths.test.ts,
// call-manager.test.ts, reconnect.test.ts and multi-device.test.ts.
//
// Written fresh — no lines copied from GPL/AGPL sources.

import {
	Checks,
	SineSource,
	TimingCollector,
	ToneDetector,
	autoAcceptAtRing,
	logText,
	networkedClient,
	offlineClient,
	pumpAudio,
	sleep,
	tick,
	verifyWireFixtures,
	waitFor,
	withGuard,
	BusSession,
	SignalingBus,
	CallMessageType,
	type ClientKit,
	type Scenario,
	type ScenarioContext,
	type ScenarioOutcome,
} from "./harness.js";
import { CallManager, IceFailureError, type CallInfo } from "../src/index.js";
import { FakeMedia, FakeSession, FakeTimers } from "../test/helpers/fakes.js";

// Deterministic 66-hex Session IDs (05 ed25519-pubkey prefix).
const ID_A = `05${"e1".repeat(32)}`;
const ID_B = `05${"e2".repeat(32)}`;
const ID_C = `05${"e3".repeat(32)}`;

const { PRE_OFFER, OFFER, ANSWER, ICE_CANDIDATES, END_CALL } = CallMessageType;

function busOf(kit: ClientKit): BusSession {
	return kit.session as BusSession;
}

function countTypes(kit: ClientKit, kind: "peer" | "self"): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const s of busOf(kit).sent.filter((x) => (kind === "self" ? x.isSync : !x.isSync))) {
		const name = { 1: "OFFER", 2: "ANSWER", 4: "ICE", 5: "END", 6: "PRE_OFFER" }[s.type] ?? `${s.type}`;
		counts[name] = (counts[name] ?? 0) + 1;
	}
	return counts;
}

// ---------------------------------------------------------------------------
// 1. Full lifecycle — place → ring → accept → 3 s audio BOTH directions
//    (Goertzel-verified) → hangup, correct EndReasons
// ---------------------------------------------------------------------------

function lifecycleFull(): Scenario {
	return {
		name: "lifecycle-full",
		mode: "offline",
		tier: "tier1",
		async run(ctx: ScenarioContext): Promise<ScenarioOutcome> {
			const checks = new Checks();
			const timings = new TimingCollector();
			const bus = new SignalingBus();
			const a = offlineClient(ID_A, bus);
			const b = offlineClient(ID_B, bus);
			const detB = new ToneDetector(440); // callee receives A's 440 Hz
			const detA = new ToneDetector(880); // caller receives B's 880 Hz
			try {
				autoAcceptAtRing(b, timings);
				b.manager.on("incoming", (call) =>
					call.onAudio((pcm) => {
						detB.push(pcm);
						timings.audioFirstFrame();
					}),
				);
				a.manager.approveContact(ID_B);
				b.manager.approveContact(ID_A);

				const callA = await a.manager.call(ID_B);
				callA.onAudio((pcm) => detA.push(pcm));
				await waitFor(() => b.incoming.length > 0, 10_000, "incoming on B");
				const callB = b.incoming[0]!;

				await waitFor(
					() => callA.info.state === "connected" && callB.info.state === "connected",
					20_000,
					"both sides connected",
				);
				timings.connect();

				// 3 s of audio in BOTH directions simultaneously.
				const [sentA, sentB] = await Promise.all([
					pumpAudio(callA, new SineSource(440), 150),
					pumpAudio(callB, new SineSource(880), 150),
				]);
				await sleep(1_500); // drain the pipeline

				const detectB = detB.detect();
				const detectA = detA.detect();
				checks.ok(sentA === 150 && sentB === 150, "both sides wrote 150 frames (3 s)");
				checks.ok(detB.frames >= 100, `callee received ≥100 frames (got ${detB.frames})`);
				checks.ok(detectB.present, `440 Hz tone present at callee (SNR ${detectB.snrDb.toFixed(1)} dB)`);
				checks.ok(detA.frames >= 100, `caller received ≥100 frames (got ${detA.frames})`);
				checks.ok(detectA.present, `880 Hz tone present at caller (SNR ${detectA.snrDb.toFixed(1)} dB)`);

				await callA.hangup();
				await waitFor(() => a.ended.length === 1 && b.ended.length === 1, 10_000, "both ended");
				checks.eq(a.ended[0]?.endReason, "local-hangup", "caller endReason");
				checks.eq(b.ended[0]?.endReason, "remote-hangup", "callee endReason");
				checks.ok(a.manager.activeCall === undefined, "caller drained (no active call)");
				checks.ok(b.manager.activeCall === undefined, "callee drained (no active call)");
				checks.eq(a.errors.length, 0, "caller no error events");
				checks.eq(b.errors.length, 0, "callee no error events");

				// Wire shape: full signaling incl. trickle ICE both ways.
				const wireTypes = bus.wire.map((w) => w.type);
				for (const t of [PRE_OFFER, OFFER, ANSWER, ICE_CANDIDATES, END_CALL]) {
					checks.ok(wireTypes.includes(t), `wire saw message type ${t}`);
				}
				checks.ok(
					busOf(a).pollIntervals.includes(500),
					"poll boost to 500 ms observed on caller session",
				);

				timings.total();
				const detail: Record<string, unknown> = {
					sentFrames: { a: sentA, b: sentB },
					receivedFrames: { calleeB: detB.frames, callerA: detA.frames },
					toneSnrDb: { calleeB440: +detectB.snrDb.toFixed(1), callerA880: +detectA.snrDb.toFixed(1) },
					wireCounts: { fromA: countTypes(a, "peer"), fromASelf: countTypes(a, "self"), fromB: countTypes(b, "peer"), fromBSelf: countTypes(b, "self") },
					pollIntervals: { a: busOf(a).pollIntervals, b: busOf(b).pollIntervals },
					iceMessages: bus.wire.filter((w) => w.type === ICE_CANDIDATES).length,
				};
				const pcm = ctx.capturePcm
					? { "callee-received-440hz": detB.concat(50), "caller-received-880hz": detA.concat(50) }
					: undefined;
				return { checks, timings: timings.timings, detail, pcm };
			} finally {
				await a.manager.dispose();
				await b.manager.dispose();
			}
		},
	};
}

// ---------------------------------------------------------------------------
// 2. Decline / reject — callee rejects after OFFER; caller sees unavailable
// ---------------------------------------------------------------------------

function decline(): Scenario {
	return {
		name: "decline",
		mode: "offline",
		tier: "tier1",
		async run(): Promise<ScenarioOutcome> {
			const checks = new Checks();
			const timings = new TimingCollector();
			const bus = new SignalingBus();
			const a = offlineClient(ID_A, bus);
			const b = offlineClient(ID_B, bus);
			try {
				b.manager.on("incoming", (call) => {
					timings.ring();
					void waitFor(() => call.info.state === "remote-ring", 10_000, "remote-ring before reject")
						.then(() => call.reject())
						.catch(() => undefined);
				});
				a.manager.approveContact(ID_B);
				b.manager.approveContact(ID_A);
				await a.manager.call(ID_B);

				await waitFor(() => a.ended.length === 1 && b.ended.length === 1, 15_000, "both ended");
				checks.eq(a.ended[0]?.endReason, "remote-declined", "caller endReason");
				checks.eq(b.ended[0]?.endReason, "remote-declined", "callee (rejecting side) endReason");
				checks.eq(b.incoming.length, 1, "callee saw incoming");
				checks.eq(a.missed.length, 0, "caller: no missed record");
				checks.eq(b.missed.length, 0, "callee: reject is NOT a missed call");
				checks.eq(a.errors.length + b.errors.length, 0, "no error events");

				// Wire: callee sends END_CALL peer + self; caller sent PRE_OFFER+OFFER,
				// never an END_CALL (it RECEIVED the end).
				const fromB = bus.types({ from: ID_B });
				checks.eq(fromB.filter((t) => t === END_CALL).length, 2, "callee sent END_CALL ×2 (peer+self)");
				checks.eq(fromB.filter((t) => t !== END_CALL).length, 0, "callee sent nothing else");
				const fromA = bus.types({ from: ID_A });
				checks.ok(fromA.includes(PRE_OFFER) && fromA.includes(OFFER), "caller sent PRE_OFFER+OFFER");
				checks.ok(!fromA.includes(END_CALL), "caller sent NO END_CALL (received the decline)");

				timings.total();
				return {
					checks,
					timings: timings.timings,
					detail: { wireFromA: fromA, wireFromB: fromB },
				};
			} finally {
				await a.manager.dispose();
				await b.manager.dispose();
			}
		},
	};
}

// ---------------------------------------------------------------------------
// 3. Ignore — NO wire END_CALL from the callee (bus spy), caller times out
// ---------------------------------------------------------------------------

function ignore(): Scenario {
	return {
		name: "ignore",
		mode: "offline",
		tier: "tier1",
		async run(): Promise<ScenarioOutcome> {
			const checks = new Checks();
			const timings = new TimingCollector();
			const bus = new SignalingBus();
			const a = offlineClient(ID_A, bus, { callTimeoutMs: 3_000 });
			const b = offlineClient(ID_B, bus);
			try {
				b.manager.on("incoming", (call) => {
					timings.ring();
					void waitFor(() => call.info.state === "remote-ring", 10_000, "remote-ring before ignore")
						.then(() => {
							call.ignore();
						})
						.catch(() => undefined);
				});
				a.manager.approveContact(ID_B);
				b.manager.approveContact(ID_A);
				const callA = await a.manager.call(ID_B);

				await waitFor(() => a.ended.length === 1, 12_000, "caller timeout end");
				checks.eq(a.ended[0]?.endReason, "timeout", "caller endReason (callee silent)");
				checks.ok(a.ended[0] !== undefined && (a.ended[0] as CallInfo).endedAt! - callA.info.startedAt < 8_000, "timeout fired near callTimeoutMs (3 s)");

				// THE ignore contract: zero wire messages from the callee.
				checks.eq(bus.types({ from: ID_B }).length, 0, "callee sent NO wire message at all");
				checks.eq(
					b.missed.map((m) => ({ peer: m.peer, reason: m.reason })),
					[{ peer: ID_A, reason: "ignored" }],
					"callee recorded missed (ignored) locally",
				);
				checks.eq(b.ended.length, 0, "ignore produces NO ended event");
				checks.ok(b.manager.activeCall === undefined, "callee drained");

				// Caller emitted END_CALL (peer + self) on timeout.
				const fromA = bus.types({ from: ID_A });
				checks.eq(fromA.filter((t) => t === END_CALL).length, 2, "caller timeout sent END_CALL ×2");
				checks.eq(a.errors.length + b.errors.length, 0, "no error events");

				timings.total();
				return {
					checks,
					timings: timings.timings,
					detail: { wireFromA: fromA, wireFromB: bus.types({ from: ID_B }), missedB: b.missed.map((m) => m.reason) },
				};
			} finally {
				await a.manager.dispose();
				await b.manager.dispose();
			}
		},
	};
}

// ---------------------------------------------------------------------------
// 4. Busy — second inbound while active → missed(busy) + END_CALL intruder
// ---------------------------------------------------------------------------

function busy(): Scenario {
	return {
		name: "busy",
		mode: "offline",
		tier: "tier1",
		async run(): Promise<ScenarioOutcome> {
			const checks = new Checks();
			const timings = new TimingCollector();
			const bus = new SignalingBus();
			const a = offlineClient(ID_A, bus);
			const b = offlineClient(ID_B, bus);
			const c = offlineClient(ID_C, bus);
			try {
				autoAcceptAtRing(b, timings);
				a.manager.approveContact(ID_B);
				b.manager.approveContact(ID_A);
				b.manager.approveContact(ID_C);
				c.manager.approveContact(ID_B);

				const callA = await a.manager.call(ID_B);
				await waitFor(() => b.incoming.length > 0, 10_000, "incoming on B");
				const callB = b.incoming[0]!;
				await waitFor(
					() => callA.info.state === "connected" && callB.info.state === "connected",
					20_000,
					"A↔B connected",
				);
				timings.connect();

				// C calls B while A↔B is active.
				const callC = await c.manager.call(ID_B);
				await waitFor(() => c.ended.length === 1, 10_000, "intruder call ended");
				checks.eq(c.ended[0]?.endReason, "remote-declined", "intruder sees END_CALL (busy response)");

				checks.ok(
					b.missed.some((m) => m.peer === ID_C && m.reason === "busy"),
					"busy side recorded missed(busy) for the intruder",
				);
				const busyEnd = bus
					.records({ from: ID_B, to: ID_C })
					.find((r) => r.type === END_CALL && r.uuid === callC.info.uuid);
				checks.ok(busyEnd !== undefined, "busy side sent END_CALL to the intruder for the intruder's uuid");
				checks.eq(b.incoming.length, 1, "intruder PRE_OFFER never became an incoming call");
				checks.ok(callA.info.state === "connected", "active call untouched (still connected)");
				checks.eq(c.incoming.length, 0, "intruder had no inbound calls");

				// Clean finish of the original call.
				await callA.hangup();
				await waitFor(() => a.ended.length === 1 && b.ended.length === 1, 10_000, "A↔B ended");
				checks.eq(a.ended[0]?.endReason, "local-hangup", "A endReason after hangup");
				checks.eq(b.ended[0]?.endReason, "remote-hangup", "B endReason after hangup");
				checks.eq(a.errors.length + b.errors.length + c.errors.length, 0, "no error events anywhere");

				timings.total();
				return {
					checks,
					timings: timings.timings,
					detail: {
						missedB: b.missed.map((m) => ({ peer: m.peer.slice(0, 8), reason: m.reason })),
						intruderEndReason: c.ended[0]?.endReason,
					},
				};
			} finally {
				await a.manager.dispose();
				await b.manager.dispose();
				await c.manager.dispose();
			}
		},
	};
}

// ---------------------------------------------------------------------------
// 5. Timeout — FAST (3 s) for CI; --real-timeouts runs the true 60 s variant
// ---------------------------------------------------------------------------

function timeout(): Scenario {
	return {
		name: "timeout",
		mode: "offline",
		tier: "tier1",
		guardMs: 100_000,
		async run(ctx: ScenarioContext): Promise<ScenarioOutcome> {
			const checks = new Checks();
			const timings = new TimingCollector();
			const timeoutMs = ctx.realTimeouts ? 60_000 : 3_000;
			const bus = new SignalingBus();
			const a = offlineClient(ID_A, bus, { callTimeoutMs: timeoutMs });
			const b = offlineClient(ID_B, bus); // approved but never accepts
			try {
				a.manager.approveContact(ID_B);
				b.manager.approveContact(ID_A);
				await a.manager.call(ID_B);

				await waitFor(() => b.incoming.length === 1, 10_000, "callee rings (PRE_OFFER gated in)");
				timings.ring();
				await waitFor(() => a.ended.length === 1, timeoutMs + 10_000, "caller timeout end");
				timings.connect(); // not connected — record the end-of-wait marker anyway
				checks.eq(a.ended[0]?.endReason, "timeout", "caller endReason timeout");

				const fromA = bus.types({ from: ID_A });
				checks.eq(fromA.filter((t) => t === END_CALL).length, 2, "timeout sent END_CALL ×2 (peer+self)");

				// Callee receives the timeout END_CALL → heuristic remote-hangup.
				await waitFor(() => b.ended.length === 1, 10_000, "callee ended by END_CALL");
				checks.eq(b.ended[0]?.endReason, "remote-hangup", "callee endReason (END_CALL received)");
				checks.eq(a.errors.length + b.errors.length, 0, "no error events");

				timings.total();
				return {
					checks,
					timings: timings.timings,
					detail: { variant: ctx.realTimeouts ? "real-60s" : "fast-3s", callTimeoutMs: timeoutMs },
				};
			} finally {
				await a.manager.dispose();
				await b.manager.dispose();
			}
		},
	};
}

// ---------------------------------------------------------------------------
// 6/7. Reconnect — initiator 5 s × 5 ICE-restart loop via fake-media state
//      injection (CallManagerDeps), recovery + exhaustion variants
// ---------------------------------------------------------------------------

function reconnectEnv(uuid: string) {
	const timers = new FakeTimers();
	const media = new FakeMedia();
	const session = new FakeSession(`05${"0".repeat(64)}`);
	const ended: CallInfo[] = [];
	const errors: { call?: unknown; error: Error }[] = [];
	const manager = new CallManager(
		session,
		{},
		{
			now: () => timers.now,
			createUuid: () => uuid,
			timers: timers.api,
			media,
		},
	);
	manager.on("outgoing", (call) => call.on("ended", (info) => ended.push(info)));
	manager.on("error", (p) => errors.push(p));
	manager.approveContact(`05${"a".repeat(64)}`);
	const restartOffers = (): number =>
		media.sessions.reduce((n, s) => n + s.methodCalls.filter((m) => m === "createOffer:iceRestart").length, 0);
	return { timers, media, session, manager, ended, errors, restartOffers };
}

async function driveConnected(env: ReturnType<typeof reconnectEnv>, uuid: string): Promise<void> {
	const peer = `05${"a".repeat(64)}`;
	await env.manager.call(peer);
	await tick();
	env.session.fireCall(
		env.session.event({ uuid, type: CallMessageType.ANSWER, from: peer, sdps: ["answer-sdp"] }),
	);
	await tick();
	env.media.last.fireConnectionState("connected");
}

function reconnectRecover(): Scenario {
	return {
		name: "reconnect-recover",
		mode: "offline",
		tier: "tier1",
		async run(): Promise<ScenarioOutcome> {
			const checks = new Checks();
			const timings = new TimingCollector();
			const uuid = "11111111-1111-4111-8111-111111111111";
			const env = reconnectEnv(uuid);
			const peer = `05${"a".repeat(64)}`;
			try {
				await driveConnected(env, uuid);
				const call = env.manager.activeCall!;
				checks.eq(call.info.state, "connected", "precondition: connected");

				// Mid-call ICE disconnect → initiator restart loop.
				env.media.last.fireConnectionState("disconnected");
				checks.eq(call.info.state, "pending-reconnect", "pending-reconnect after ICE drop");

				env.timers.advance(5_000);
				await tick();
				checks.eq(env.restartOffers(), 1, "restart attempt 1 after 5 s");
				checks.eq(call.info.state, "reconnecting", "reconnecting after attempt 1");
				env.timers.advance(5_000);
				await tick();
				checks.eq(env.restartOffers(), 2, "restart attempt 2 after 10 s");

				// Remote answers the restarted offer → recovery.
				env.session.fireCall(
					env.session.event({ uuid, type: CallMessageType.ANSWER, from: peer, sdps: ["restart-answer-sdp"] }),
				);
				await tick();
				checks.eq(call.info.state, "connecting", "connecting after restart ANSWER");
				checks.eq(env.media.last.remoteAnswer, "restart-answer-sdp", "restart answer applied");
				env.media.last.fireConnectionState("connected");
				checks.eq(call.info.state, "connected", "reconnected");
				checks.eq(env.ended.length, 0, "call did NOT end during reconnect");

				// Restart chain cancelled — no further offers.
				env.timers.advance(20_000);
				await tick();
				checks.eq(env.restartOffers(), 2, "restart chain cancelled after recovery");
				checks.eq(call.info.state, "connected", "still connected after 20 s");
				checks.eq(env.errors.length, 0, "no error events");

				// Distinct restart SDPs on the wire.
				const offers = env.session.sentToPeer().filter((s) => s.msg.type === CallMessageType.OFFER);
				checks.ok(offers.length >= 2, "≥2 OFFERs sent (original + restart)");
				checks.eq(new Set(offers.map((o) => o.msg.sdps?.[0])).size, offers.length, "all offer SDPs distinct");

				timings.total();
				return {
					checks,
					timings: timings.timings,
					detail: { restartOffers: env.restartOffers(), offersSent: offers.length },
				};
			} finally {
				await env.manager.dispose();
			}
		},
	};
}

function reconnectExhaust(): Scenario {
	return {
		name: "reconnect-exhaust",
		mode: "offline",
		tier: "tier1",
		async run(): Promise<ScenarioOutcome> {
			const checks = new Checks();
			const timings = new TimingCollector();
			const uuid = "22222222-2222-4222-8222-222222222222";
			const env = reconnectEnv(uuid);
			try {
				await driveConnected(env, uuid);
				const call = env.manager.activeCall!;
				env.media.last.fireConnectionState("disconnected");
				checks.eq(call.info.state, "pending-reconnect", "pending-reconnect after ICE drop");

				for (let attempt = 1; attempt <= 5; attempt++) {
					env.timers.advance(5_000);
					await tick();
					checks.eq(env.restartOffers(), attempt, `restart attempt ${attempt} at ${attempt * 5} s`);
				}
				// Sixth tick: exhausted → ice-failed.
				env.timers.advance(5_000);
				await tick();
				checks.eq(env.restartOffers(), 5, "no restart offer after exhaustion");
				checks.eq(env.ended.length, 1, "call ended");
				checks.eq(env.ended[0]?.endReason, "ice-failed", "endReason ice-failed");
				checks.eq(call.info.state, "disconnected", "disconnected after exhaustion");
				checks.ok(
					env.errors.some((e) => e.error instanceof IceFailureError),
					"IceFailureError surfaced on the error channel",
				);
				const peerEnds = env.session.sentTypes("peer").filter((t) => t === CallMessageType.END_CALL).length;
				const selfEnds = env.session.sentTypes("self").filter((t) => t === CallMessageType.END_CALL).length;
				checks.ok(peerEnds >= 1 && selfEnds >= 1, "END_CALL sent peer + self on ice-failed");

				timings.total();
				return {
					checks,
					timings: timings.timings,
					detail: { restartOffers: env.restartOffers(), endReason: env.ended[0]?.endReason },
				};
			} finally {
				await env.manager.dispose();
			}
		},
	};
}

// ---------------------------------------------------------------------------
// 8. Multi-device — two same-account endpoints; answered-elsewhere on the 2nd
// ---------------------------------------------------------------------------

function multiDevice(): Scenario {
	return {
		name: "multi-device",
		mode: "offline",
		tier: "tier1",
		async run(ctx: ScenarioContext): Promise<ScenarioOutcome> {
			const checks = new Checks();
			const timings = new TimingCollector();
			const bus = new SignalingBus();
			const a = offlineClient(ID_A, bus);
			const b1 = offlineClient(ID_B, bus); // device 1 of account B
			const b2 = offlineClient(ID_B, bus); // device 2 of account B (same id)
			const detB1 = new ToneDetector(440);
			try {
				autoAcceptAtRing(b1, timings); // only device 1 answers
				b1.manager.on("incoming", (call) => call.onAudio((pcm) => detB1.push(pcm)));
				a.manager.approveContact(ID_B);
				b1.manager.approveContact(ID_A);
				b2.manager.approveContact(ID_A);

				const callA = await a.manager.call(ID_B);
				await waitFor(() => b1.incoming.length === 1 && b2.incoming.length === 1, 10_000, "both devices ring");

				// Device 1 accepts → ANSWER peer + self-sync; device 2 must end.
				await waitFor(() => b2.ended.length === 1, 10_000, "device 2 ended via self-sync ANSWER");
				checks.eq(b2.ended[0]?.endReason, "answered-elsewhere", "device 2 endReason answered-elsewhere");
				checks.eq(busOf(b2).sent.length, 0, "device 2 transmitted NOTHING");
				const b1Sends = busOf(b1).sent;
				checks.eq(
					b1Sends.filter((s) => s.type === ANSWER).length,
					2,
					"device 1 sent ANSWER ×2 (peer + self-sync)",
				);
				checks.ok(b1Sends.some((s) => s.type === ANSWER && s.isSync), "device 1 self-sync ANSWER present");

				// Device 1 + A connect; audio flows to device 1.
				const callB1 = b1.incoming[0]!;
				await waitFor(
					() => callA.info.state === "connected" && callB1.info.state === "connected",
					20_000,
					"A↔B1 connected",
				);
				timings.connect();
				await pumpAudio(callA, new SineSource(440), 50);
				await sleep(1_000);
				checks.ok(detB1.frames >= 30, `device 1 received ≥30 frames (got ${detB1.frames})`);
				checks.ok(detB1.detect().present, "440 Hz tone present at device 1");
				checks.eq(b2.ended.length, 1, "device 2 stayed ended");

				await callA.hangup();
				await waitFor(() => b1.ended.length === 1, 10_000, "device 1 ended");
				checks.eq(b1.ended[0]?.endReason, "remote-hangup", "device 1 endReason remote-hangup");
				checks.eq(a.errors.length + b1.errors.length + b2.errors.length, 0, "no error events");

				timings.total();
				return {
					checks,
					timings: timings.timings,
					detail: {
						device2EndReason: b2.ended[0]?.endReason,
						device1ReceivedFrames: detB1.frames,
						device2Sends: busOf(b2).sent.length,
					},
					pcm: ctx.capturePcm ? { "device1-received-440hz": detB1.concat(50) } : undefined,
				};
			} finally {
				await a.manager.dispose();
				await b1.manager.dispose();
				await b2.manager.dispose();
			}
		},
	};
}

// ---------------------------------------------------------------------------
// 9. Wire-golden regression — byte-identical CallMessage encodings
// ---------------------------------------------------------------------------

function wireGolden(): Scenario {
	return {
		name: "wire-golden",
		mode: "offline",
		tier: "tier1",
		async run(): Promise<ScenarioOutcome> {
			const checks = new Checks();
			const timings = new TimingCollector();
			const { pass, output } = verifyWireFixtures();
			checks.ok(pass, "scripts/verify-fixtures.ts exits 0 (5 fixtures byte-identical)");
			checks.ok(output.includes("all 5 fixtures verified"), "all 5 fixtures verified line present");
			timings.total();
			return {
				checks,
				timings: timings.timings,
				detail: { verifyOutput: output.trim().split("\n").slice(0, 12) },
			};
		},
	};
}

// ---------------------------------------------------------------------------
// 10. Redaction — full real-media run; no secrets/SDP in any logger output
//     or event payload
// ---------------------------------------------------------------------------

function redaction(): Scenario {
	return {
		name: "redaction",
		mode: "offline",
		tier: "tier1",
		async run(): Promise<ScenarioOutcome> {
			const checks = new Checks();
			const timings = new TimingCollector();
			const bus = new SignalingBus();
			const a = offlineClient(ID_A, bus);
			const b = offlineClient(ID_B, bus);
			try {
				autoAcceptAtRing(b);
				a.manager.approveContact(ID_B);
				b.manager.approveContact(ID_A);
				const callA = await a.manager.call(ID_B);
				await waitFor(() => b.incoming.length > 0, 10_000, "incoming on B");
				const callB = b.incoming[0]!;
				await waitFor(
					() => callA.info.state === "connected" && callB.info.state === "connected",
					20_000,
					"connected",
				);
				await Promise.all([pumpAudio(callA, new SineSource(440), 50), pumpAudio(callB, new SineSource(880), 50)]);
				await sleep(1_000);
				await callA.hangup();
				await waitFor(() => a.ended.length === 1 && b.ended.length === 1, 10_000, "ended");

				// Real werift SDPs (with real DTLS fingerprints) flowed through both
				// CallManagers. NONE of it may have reached the consumer logger.
				const text = `${logText(a.logs)}\n${logText(b.logs)}`;
				checks.ok(text.length > 0, "logger captured output");
				for (const bad of ["session202111", "053c268164bc7bd7", "a=fingerprint", "v=0", "m=audio", "o=- "]) {
					checks.ok(!text.includes(bad), `no "${bad}" in any log line/meta`);
				}
				// Expected diagnostics ARE present (P5-T3 parity).
				checks.ok(text.includes("fsm: idle --send-pre-offer--> local-pre-offer"), "FSM transition logged");
				checks.ok(text.includes("signaling send peer type=PRE_OFFER"), "signaling send logged");
				checks.ok(text.includes("signaling recv type=ANSWER"), "signaling recv logged");
				checks.ok(text.includes("call ended "), "call summary logged");

				// Event payloads (consumer-visible surfaces) carry no SDP either.
				const payloadText = JSON.stringify([
					a.incoming.map((c) => c.info),
					a.outgoing.map((c) => c.info),
					b.incoming.map((c) => c.info),
					a.ended,
					b.ended,
					a.missed,
					b.missed,
				]);
				checks.ok(!payloadText.includes("v=0"), "no SDP in event payloads");
				checks.ok(!/fingerprint/i.test(payloadText), "no fingerprint in event payloads");
				checks.ok(!payloadText.includes("sdps"), "no sdps key in event payloads");

				timings.total();
				return {
					checks,
					timings: timings.timings,
					detail: { logLines: a.logs.length + b.logs.length, logChars: text.length },
				};
			} finally {
				await a.manager.dispose();
				await b.manager.dispose();
			}
		},
	};
}

// ---------------------------------------------------------------------------
// 11. NETWORKED lifecycle (gated) — S1: connect ≤15 s median, audio both
//     directions over the live swarm, up to N runs
// ---------------------------------------------------------------------------

interface NetworkRunResult {
	run: number;
	connected: boolean;
	ringMs?: number;
	connectMs?: number;
	endReasonA?: string;
	endReasonB?: string;
	framesAtB: number;
	framesAtA: number;
	snrB?: number;
	snrA?: number;
	error?: string;
}

function lifecycleNetworked(): Scenario {
	return {
		name: "lifecycle-networked",
		mode: "networked",
		tier: "tier1",
		guardMs: 600_000,
		async run(ctx: ScenarioContext): Promise<ScenarioOutcome> {
			const checks = new Checks();
			const timings = new TimingCollector();
			const secrets: string[] = [];
			const runs: NetworkRunResult[] = [];

			for (let i = 1; i <= ctx.networkRuns; i++) {
				let run: NetworkRunResult;
				try {
					run = await withGuard(runNetworkedOnce(i, secrets), 150_000, `networked run ${i}`);
				} catch (err) {
					run = {
						run: i,
						connected: false,
						framesAtB: 0,
						framesAtA: 0,
						error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
					};
				}
				runs.push(run);
				console.log(
					`[lifecycle-networked] run ${i}: ${run.connected ? `connected in ${run.connectMs} ms` : "NOT connected"} ` +
						`frames B=${run.framesAtB} A=${run.framesAtA}${run.error ? ` error=${run.error}` : ""}`,
				);
			}

			const connectedRuns = runs.filter((r) => r.connected);
			const fastRuns = connectedRuns.filter((r) => (r.connectMs ?? Infinity) <= 15_000);
			checks.ok(connectedRuns.length >= 1, `≥1 of ${runs.length} networked runs connected`);
			checks.ok(fastRuns.length >= 1, "≥1 run connected ≤15 s (S1)");
			checks.ok(
				connectedRuns.every((r) => r.framesAtB >= 100 && r.framesAtA >= 100),
				"audio verified both directions on every connected run",
			);
			// B hangs up in this scenario → B local-hangup, A remote-hangup.
			checks.ok(
				connectedRuns.every((r) => r.endReasonB === "local-hangup" && r.endReasonA === "remote-hangup"),
				"correct EndReasons on every connected run (B hangs up)",
			);

			if (fastRuns.length > 0) {
				const best = fastRuns.reduce((x, y) => ((x.connectMs ?? 0) <= (y.connectMs ?? 0) ? x : y));
				timings.timings.ringMs = best.ringMs;
				timings.timings.connectMs = best.connectMs;
			}
			timings.total();

			const connectTimes = connectedRuns.map((r) => r.connectMs);
			connectTimes.sort((x, y) => (x ?? 0) - (y ?? 0));
			const median = connectTimes.length > 0 ? connectTimes[Math.floor(connectTimes.length / 2)] : undefined;
			return {
				checks,
				timings: timings.timings,
				secrets,
				detail: {
					runs: runs.map((r) => ({
						run: r.run,
						connected: r.connected,
						connectMs: r.connectMs,
						ringMs: r.ringMs,
						framesAtB: r.framesAtB,
						framesAtA: r.framesAtA,
						snrB: r.snrB === undefined ? undefined : +r.snrB.toFixed(1),
						snrA: r.snrA === undefined ? undefined : +r.snrA.toFixed(1),
						endReasons: r.endReasonA === undefined ? undefined : { a: r.endReasonA, b: r.endReasonB },
						error: r.error,
					})),
					connectMsMedian: median,
					s1BudgetMs: 15_000,
				},
			};
		},
	};
}

async function runNetworkedOnce(run: number, secrets: string[]): Promise<NetworkRunResult> {
	const a = await networkedClient();
	const b = await networkedClient();
	secrets.push(...a.secrets, ...b.secrets);
	const detB = new ToneDetector(440);
	const detA = new ToneDetector(880);
	const timings = new TimingCollector();
	try {
		console.log(`[lifecycle-networked] run ${run}: A=${a.id} B=${b.id} — swarm bootstrap 5 s`);
		await sleep(5_000); // claim swarms + first poll round
		autoAcceptAtRing(b, timings);
		b.manager.on("incoming", (call) => call.onAudio((pcm) => detB.push(pcm)));
		a.manager.approveContact(b.id);
		b.manager.approveContact(a.id);

		const callA = await a.manager.call(b.id);
		callA.onAudio((pcm) => detA.push(pcm));
		await waitFor(() => b.incoming.length > 0, 20_000, "incoming on B");
		const callB = b.incoming[0]!;
		await waitFor(
			() => callA.info.state === "connected" && callB.info.state === "connected",
			25_000,
			"both sides connected",
		);
		timings.connect();
		const connectMs = timings.timings.connectMs ?? Infinity;

		await Promise.all([pumpAudio(callA, new SineSource(440), 150), pumpAudio(callB, new SineSource(880), 150)]);
		await sleep(2_000);

		await callB.hangup();
		await waitFor(() => a.ended.length === 1 && b.ended.length === 1, 20_000, "both ended");
		const detectB = detB.detect();
		const detectA = detA.detect();
		if (detB.frames < 100 || detA.frames < 100 || !detectB.present || !detectA.present) {
			throw new Error(
				`audio verification failed: B frames=${detB.frames} present=${detectB.present}, A frames=${detA.frames} present=${detectA.present}`,
			);
		}
		return {
			run,
			connected: connectMs <= 25_000,
			ringMs: timings.timings.ringMs,
			connectMs: timings.timings.connectMs,
			endReasonA: a.ended[0]?.endReason,
			endReasonB: b.ended[0]?.endReason,
			framesAtB: detB.frames,
			framesAtA: detA.frames,
			snrB: detectB.snrDb,
			snrA: detectA.snrDb,
		};
	} finally {
		await a.manager.dispose();
		await b.manager.dispose();
	}
}

// ---------------------------------------------------------------------------

export function tier1Scenarios(): Scenario[] {
	return [
		lifecycleFull(),
		decline(),
		ignore(),
		busy(),
		timeout(),
		reconnectRecover(),
		reconnectExhaust(),
		multiDevice(),
		wireGolden(),
		redaction(),
		lifecycleNetworked(),
	];
}

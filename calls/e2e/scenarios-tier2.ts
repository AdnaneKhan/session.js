// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Tier-2 fault & stress suite (plan P7-T3, tagged nightly). Offline where
// possible; the networked poll-latency variant is gated behind
// SESSION_CALLS_NETWORK_TESTS=1. Every scenario is timeboxed per-iteration.
//
//   1. signaling-loss     — dropper losing ~30% of swarm stores → calls
//                           connect or time out, NEVER hang
//   2. poll-latency       — 3000 ms poll-cadence simulation → still
//                           connects; degradation vs the 500 ms baseline
//   2n. poll-latency-networked (gated) — real 3000 ms Poller over the swarm
//   3. rapid-cycling      — 20× sequential place→hangup, clean teardown
//                           every time (no leaked contexts/media sessions)
//   4. race-inbound-outbound — A calls B while B calls A simultaneously →
//                           busy semantics both sides, no crash
//
// Written fresh — no lines copied from GPL/AGPL sources.

import {
	CallMessageType,
	Checks,
	SignalingBus,
	SineSource,
	TimingCollector,
	autoAcceptAtRing,
	networkedClient,
	offlineClient,
	pumpAudio,
	sleep,
	tick,
	waitFor,
	type Scenario,
	type ScenarioOutcome,
} from "./harness.js";
import { CallManager } from "../src/index.js";
import { FakeMedia, FakeSession } from "../test/helpers/fakes.js";

const ID_A = `05${"e1".repeat(32)}`;
const ID_B = `05${"e2".repeat(32)}`;
const PEER = `05${"a".repeat(64)}`;
const OWN = `05${"0".repeat(64)}`;

// ---------------------------------------------------------------------------
// 1. Signaling loss — drop ~30% of stores; never hang
// ---------------------------------------------------------------------------

function signalingLoss(): Scenario {
	return {
		name: "signaling-loss",
		mode: "offline",
		tier: "tier2",
		guardMs: 240_000,
		async run(): Promise<ScenarioOutcome> {
			const checks = new Checks();
			const timings = new TimingCollector();
			const DROP_RATE = 0.3;
			const ITERATIONS = 5;
			// Deterministic dropper (seeded LCG) — reproducible loss pattern.
			let seed = 0xc0ffee;
			const rnd = (): number => {
				seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
				return seed / 2 ** 32;
			};
			const outcomes: Record<string, unknown>[] = [];

			for (let i = 1; i <= ITERATIONS; i++) {
				const bus = new SignalingBus();
				bus.drop = () => rnd() < DROP_RATE;
				const a = offlineClient(ID_A, bus, { callTimeoutMs: 8_000 });
				const b = offlineClient(ID_B, bus);
				try {
					autoAcceptAtRing(b);
					a.manager.approveContact(ID_B);
					b.manager.approveContact(ID_A);
					const start = Date.now();
					const callA = await a.manager.call(ID_B);
					let outcome: string;
					try {
						await waitFor(() => b.incoming.length > 0, 12_000, "incoming");
						await waitFor(() => callA.info.state === "connected", 15_000, "connected");
						outcome = "connected";
						await callA.hangup();
						await waitFor(() => a.ended.length === 1, 8_000, "ended after hangup");
					} catch {
						// Did not connect — it must still END (timeout or error), not hang.
						await waitFor(() => a.ended.length === 1, 15_000, "terminated via timeout/error");
						outcome = `ended:${a.ended[0]?.endReason ?? "unknown"}`;
					}
					const dropped = bus.wire.filter((w) => w.dropped);
					const droppedByType: Record<string, number> = {};
					for (const w of dropped) {
						const name = { 1: "OFFER", 2: "ANSWER", 4: "ICE", 5: "END", 6: "PRE_OFFER" }[w.type] ?? `${w.type}`;
						droppedByType[name] = (droppedByType[name] ?? 0) + 1;
					}
					outcomes.push({
						iter: i,
						outcome,
						elapsedMs: Date.now() - start,
						stored: bus.wire.length,
						dropped: dropped.length,
						droppedByType,
						errors: a.errors.length + b.errors.length,
					});
					checks.ok(true, `iteration ${i} terminated (${outcome})`);
					checks.eq(a.errors.length + b.errors.length, 0, `iteration ${i} no error events`);
				} finally {
					await a.manager.dispose();
					await b.manager.dispose();
				}
			}

			const connected = outcomes.filter((o) => o.outcome === "connected").length;
			checks.ok(outcomes.length === ITERATIONS, `all ${ITERATIONS} iterations terminated within budget (never hung)`);
			timings.total();
			return {
				checks,
				timings: timings.timings,
				detail: { dropRate: DROP_RATE, connectedRuns: connected, outcomes },
			};
		},
	};
}

// ---------------------------------------------------------------------------
// 2. Poll latency — 3000 ms cadence simulation; degradation vs ~500 ms
// ---------------------------------------------------------------------------

async function latencyRun(deliveryDelayMs: number): Promise<{
	connected: boolean;
	ringMs?: number;
	connectMs?: number;
	endReasonA?: string;
}> {
	const bus = new SignalingBus();
	bus.deliveryDelayMs = deliveryDelayMs;
	const a = offlineClient(ID_A, bus, { callTimeoutMs: 60_000 });
	const b = offlineClient(ID_B, bus);
	const timings = new TimingCollector();
	try {
		autoAcceptAtRing(b, timings);
		a.manager.approveContact(ID_B);
		b.manager.approveContact(ID_A);
		const callA = await a.manager.call(ID_B);
		await waitFor(() => callA.info.state === "connected", 50_000, "connected");
		timings.connect();
		await pumpAudio(callA, new SineSource(440), 25); // 0.5 s sanity audio
		await sleep(500);
		await callA.hangup();
		await waitFor(() => a.ended.length === 1, 15_000, "ended");
		return {
			connected: true,
			ringMs: timings.timings.ringMs,
			connectMs: timings.timings.connectMs,
			endReasonA: a.ended[0]?.endReason,
		};
	} catch (err) {
		return { connected: false, endReasonA: err instanceof Error ? err.message : String(err) };
	} finally {
		await a.manager.dispose();
		await b.manager.dispose();
	}
}

function pollLatency(): Scenario {
	return {
		name: "poll-latency",
		mode: "offline",
		tier: "tier2",
		guardMs: 180_000,
		async run(): Promise<ScenarioOutcome> {
			const checks = new Checks();
			const timings = new TimingCollector();
			const baseline = await latencyRun(0); // instant delivery ≈ boosted 500 ms cadence floor
			const degraded = await latencyRun(3_000); // default session.js poll interval
			checks.ok(baseline.connected, "baseline (no delivery delay) connects");
			checks.ok(degraded.connected, "3000 ms poll-cadence simulation still connects");
			checks.ok(
				(degraded.connectMs ?? Infinity) < 45_000,
				`degraded connect under 45 s (got ${degraded.connectMs} ms)`,
			);
			checks.eq(degraded.endReasonA, "local-hangup", "clean hangup under latency");
			timings.timings.ringMs = degraded.ringMs;
			timings.timings.connectMs = degraded.connectMs;
			timings.total();
			return {
				checks,
				timings: timings.timings,
				detail: {
					baselineConnectMs: baseline.connectMs,
					degradedConnectMs: degraded.connectMs,
					degradationMs:
						baseline.connectMs !== undefined && degraded.connectMs !== undefined
							? degraded.connectMs - baseline.connectMs
							: undefined,
					note: "offline proxy: every swarm leg delayed by the poll interval (worst case)",
				},
			};
		},
	};
}

function pollLatencyNetworked(): Scenario {
	return {
		name: "poll-latency-networked",
		mode: "networked",
		tier: "tier2",
		guardMs: 240_000,
		async run(): Promise<ScenarioOutcome> {
			const checks = new Checks();
			const timings = new TimingCollector();
			const secrets: string[] = [];
			const a = await networkedClient({ pollIntervalMs: 3_000 });
			const b = await networkedClient({ pollIntervalMs: 3_000 });
			secrets.push(...a.secrets, ...b.secrets);
			try {
				await sleep(5_000); // swarm bootstrap
				autoAcceptAtRing(b, timings);
				a.manager.approveContact(b.id);
				b.manager.approveContact(a.id);
				const callA = await a.manager.call(b.id);
				await waitFor(() => callA.info.state === "connected", 60_000, "connected at 3000 ms poll");
				timings.connect();
				checks.ok(true, `connected in ${timings.timings.connectMs} ms with 3000 ms pollers`);
				await pumpAudio(callA, new SineSource(440), 50);
				await sleep(1_000);
				await callA.hangup();
				await waitFor(() => a.ended.length === 1, 30_000, "ended");
				checks.eq(a.ended[0]?.endReason, "local-hangup", "clean hangup");
				timings.total();
				return {
					checks,
					timings: timings.timings,
					secrets,
					detail: { pollIntervalMs: 3_000, connectMs: timings.timings.connectMs },
				};
			} finally {
				await a.manager.dispose();
				await b.manager.dispose();
			}
		},
	};
}

// ---------------------------------------------------------------------------
// 3. Rapid call/hangup cycling — 20× fake-media + 3× real-media; no leaks
// ---------------------------------------------------------------------------

function rapidCycling(): Scenario {
	return {
		name: "rapid-cycling",
		mode: "offline",
		tier: "tier2",
		guardMs: 180_000,
		async run(): Promise<ScenarioOutcome> {
			const checks = new Checks();
			const timings = new TimingCollector();

			// 20× fast cycles through fake media (signaling-level teardown).
			const media = new FakeMedia();
			const session = new FakeSession(OWN);
			const manager = new CallManager(session, {}, { media });
			manager.approveContact(PEER);
			const endReasons: string[] = [];
			manager.on("outgoing", (call) =>
				call.on("ended", (info) => endReasons.push(info.endReason ?? "unknown")),
			);
			const errors: unknown[] = [];
			manager.on("error", (e) => errors.push(e));
			try {
				for (let i = 1; i <= 20; i++) {
					const call = await manager.call(PEER);
					await tick();
					await call.hangup();
					checks.ok(manager.activeCall === undefined, `cycle ${i}: context drained (no active call)`);
					checks.eq(endReasons.length, i, `cycle ${i}: exactly one end per cycle`);
				}
				checks.eq(
					endReasons.every((r) => r === "local-hangup"),
					true,
					"all 20 cycles ended local-hangup",
				);
				checks.eq(media.sessions.length, 20, "20 media sessions created");
				checks.eq(
					media.sessions.every((s) => s.closed),
					true,
					"all 20 media sessions closed (no leaked handles)",
				);
				checks.eq(errors.length, 0, "no error events across 20 cycles");
				// The 21st call works — no leaked context blocks it (CallInProgressError).
				const extra = await manager.call(PEER);
				await tick();
				await extra.hangup();
				checks.eq(endReasons.length, 21, "21st call succeeds (supervisor context map drained)");
			} finally {
				await manager.dispose();
			}

			// 3× real-media cycles (werift create/teardown before connect).
			const bus = new SignalingBus();
			const a = offlineClient(ID_A, bus);
			const b = offlineClient(ID_B, bus);
			try {
				a.manager.approveContact(ID_B);
				b.manager.approveContact(ID_A);
				for (let i = 1; i <= 3; i++) {
					const call = await a.manager.call(ID_B);
					await sleep(100); // let PRE_OFFER/OFFER flow, then abort
					await call.hangup();
					await waitFor(() => a.ended.length === i, 10_000, `real-media cycle ${i} ended`);
					checks.ok(a.manager.activeCall === undefined, `real-media cycle ${i}: drained`);
				}
				checks.eq(a.errors.length + b.errors.length, 0, "no error events in real-media cycles");
			} finally {
				await a.manager.dispose();
				await b.manager.dispose();
			}

			timings.total();
			return {
				checks,
				timings: timings.timings,
				detail: { fastCycles: 21, realMediaCycles: 3, mediaSessionsClosed: media.sessions.every((s) => s.closed) },
			};
		},
	};
}

// ---------------------------------------------------------------------------
// 4. Concurrent inbound+outbound race — both resolve to busy semantics
// ---------------------------------------------------------------------------

function raceInboundOutbound(): Scenario {
	return {
		name: "race-inbound-outbound",
		mode: "offline",
		tier: "tier2",
		async run(): Promise<ScenarioOutcome> {
			const checks = new Checks();
			const timings = new TimingCollector();
			const bus = new SignalingBus();
			const a = offlineClient(ID_A, bus);
			const b = offlineClient(ID_B, bus);
			try {
				a.manager.approveContact(ID_B);
				b.manager.approveContact(ID_A);

				// Simultaneous place: A→B and B→A.
				const [callAB, callBA] = await Promise.all([a.manager.call(ID_B), b.manager.call(ID_A)]);
				checks.ok(callAB.info.state !== "idle" && callBA.info.state !== "idle", "both outbound calls live");

				await waitFor(() => a.ended.length >= 1 && b.ended.length >= 1, 15_000, "both outbound calls ended");
				checks.eq(a.ended[0]?.endReason, "remote-declined", "A's outbound ended by B's busy END_CALL");
				checks.eq(b.ended[0]?.endReason, "remote-declined", "B's outbound ended by A's busy END_CALL");
				checks.ok(
					a.missed.some((m) => m.peer === ID_B && m.reason === "busy"),
					"A recorded missed(busy) for B's inbound",
				);
				checks.ok(
					b.missed.some((m) => m.peer === ID_A && m.reason === "busy"),
					"B recorded missed(busy) for A's inbound",
				);

				// Each side sent a busy END_CALL for the OTHER's uuid.
				const busyEndFromA = bus
					.records({ from: ID_A, to: ID_B })
					.some((r) => r.type === CallMessageType.END_CALL && r.uuid === callBA.info.uuid);
				const busyEndFromB = bus
					.records({ from: ID_B, to: ID_A })
					.some((r) => r.type === CallMessageType.END_CALL && r.uuid === callAB.info.uuid);
				checks.ok(busyEndFromA, "A sent busy END_CALL for B's uuid");
				checks.ok(busyEndFromB, "B sent busy END_CALL for A's uuid");

				// Ghost inbound contexts (Desktop-tolerant OFFER-after-busy) must
				// not crash anything and must drain on dispose.
				const ghostInbounds = a.incoming.length + b.incoming.length;
				await a.manager.dispose();
				await b.manager.dispose();
				checks.ok(a.manager.activeCall === undefined && b.manager.activeCall === undefined, "both drained after dispose");
				checks.eq(a.errors.length + b.errors.length, 0, "no error events — race contained");

				timings.total();
				return {
					checks,
					timings: timings.timings,
					detail: {
						aEndReason: a.ended[0]?.endReason,
						bEndReason: b.ended[0]?.endReason,
						missedA: a.missed.map((m) => m.reason),
						missedB: b.missed.map((m) => m.reason),
						ghostInboundContexts: ghostInbounds,
					},
				};
			} catch (err) {
				await a.manager.dispose();
				await b.manager.dispose();
				throw err;
			}
		},
	};
}

// ---------------------------------------------------------------------------

export function tier2Scenarios(): Scenario[] {
	return [signalingLoss(), pollLatency(), pollLatencyNetworked(), rapidCycling(), raceInboundOutbound()];
}

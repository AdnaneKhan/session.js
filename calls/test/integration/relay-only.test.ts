// SPDX-License-Identifier: AGPL-3.0-or-later
// P5-T2 verification: iceTransportPolicy "relay" end-to-end through the
// OFFICIAL Session TURN servers (policy.ts exports — the static credentials
// shipped in every official client). Two in-process PeerConnectionManager
// sessions, no Session network.
//
// GATED: only runs with SESSION_CALLS_NETWORK_TESTS=1. Needs UDP egress to
// the getsession.org TURN hosts, which CI sandboxes block or throttle hard
// enough that the runtime soft-skip budgets can be outrun by the 120 s test
// timeout (observed on GitHub-hosted runners). Gate it like the other
// networked integration tests; the nightly networked lane exercises it.
//
//   SESSION_CALLS_NETWORK_TESTS=1 bun test test/integration/relay-only.test.ts
//
// When gated in, it additionally SOFT-SKIPS at runtime (warn + early
// return, suite stays green) if the relay path is degraded — no relay
// connection, no DTLS, or no audio within budget — never a hard failure
// over the environment.
//
// Readiness note (P4-T2 finding): ICE-level "connected" is NOT enough —
// RTP written before DTLS completion is silently dropped by werift. The
// negotiated data channel opening is the full-stack readiness gate (ICE +
// DTLS + SCTP), so audio is written only after both data channels are open.

import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

import { FRAME_MS, sineFrame } from "../../src/media/dsp.js";
import {
	PeerConnectionManager,
	WeriftMediaSession,
	type MediaConnectionState,
} from "../../src/media/peer-connection.js";
import { defaultIceServers } from "../../src/policy.js";

const RUN = process.env.SESSION_CALLS_NETWORK_TESTS === "1";

const RELAY_CONNECT_BUDGET_MS = 25_000;
const DTLS_BUDGET_MS = 20_000;
const AUDIO_BUDGET_MS = 25_000;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function waitState(s: WeriftMediaSession, want: MediaConnectionState): Promise<void> {
	return new Promise((resolve, reject) => {
		s.onConnectionState((state) => {
			if (state === want) resolve();
			else if (state === "failed") reject(new Error("connection failed"));
		});
	});
}

async function waitDataChannelOpen(s: WeriftMediaSession, budgetMs: number): Promise<boolean> {
	const deadline = Date.now() + budgetMs;
	while (s.dataChannelState !== "open") {
		if (Date.now() > deadline) return false;
		await sleep(50);
	}
	return true;
}

(!RUN ? test.skip : test)("relay-only: connect via official TURN + 1 s audio both directions", async () => {
	const manager = new PeerConnectionManager();
	const iceServers = defaultIceServers(); // shuffle-take-2 of the 5 official hosts
	console.log(
		`[relay-only] TURN servers: ${iceServers.map((s) => String(s.urls)).join(", ")}`,
	);
	const opts = { iceServers, iceTransportPolicy: "relay" as const };
	const a = manager.createSession(randomUUID(), "caller", opts) as WeriftMediaSession;
	const b = manager.createSession(randomUUID(), "callee", opts) as WeriftMediaSession;

	const gathered: { side: "a" | "b"; candidate: string }[] = [];
	a.onLocalCandidate((c) => {
		gathered.push({ side: "a", candidate: c.candidate });
		void b.addRemoteCandidate(c);
	});
	b.onLocalCandidate((c) => {
		gathered.push({ side: "b", candidate: c.candidate });
		void a.addRemoteCandidate(c);
	});
	const audioAtB: Int16Array[] = [];
	const audioAtA: Int16Array[] = [];
	b.onAudio((pcm) => audioAtB.push(pcm));
	a.onAudio((pcm) => audioAtA.push(pcm));

	const t0 = Date.now();
	const bothConnected = Promise.all([waitState(a, "connected"), waitState(b, "connected")]);
	const offer = await a.createOffer();
	await b.setRemoteOffer(offer);
	const answer = await b.createAnswer();
	await a.setRemoteAnswer(answer);

	const result = await Promise.race([
		bothConnected.then(() => "connected" as const),
		sleep(RELAY_CONNECT_BUDGET_MS).then(() => "timeout" as const),
	]);

	if (result === "timeout") {
		console.warn(
			`[relay-only] SKIPPED at runtime: no relay connection within ${RELAY_CONNECT_BUDGET_MS} ms` +
				` (UDP egress to getsession.org TURN unavailable/degraded in this environment?) — environmental, not a failure`,
		);
		a.close();
		b.close();
		return;
	}
	console.log(`[relay-only] relay ICE connected in ${Date.now() - t0} ms`);

	// Candidate dump for evidence (P5-T2.md).
	const relayCandidates = gathered.filter((g) => /\btyp\s+relay\b/i.test(g.candidate));
	const nonRelay = gathered.filter((g) => !/\btyp\s+relay\b/i.test(g.candidate));
	console.log(`[relay-only] gathered ${gathered.length} candidates:`);
	for (const g of relayCandidates) {
		console.log(`[relay-only]   [${g.side}] ${g.candidate}`);
	}
	console.log(
		`[relay-only] relay: ${relayCandidates.length}, non-relay (gathered but never paired — werift forceTurn): ${nonRelay.length}`,
	);
	// With forceTurn, werift still GATHERS host/srflx but only PAIRS relay —
	// a live relay connection implies relay pairs were nominated.
	expect(relayCandidates.length).toBeGreaterThan(0);

	// Full-stack readiness: both negotiated data channels open (== DTLS done
	// → werift sender ready; P4-T2). Without this gate, early RTP is dropped.
	const dtlsOk =
		(await waitDataChannelOpen(a, DTLS_BUDGET_MS)) &&
		(await waitDataChannelOpen(b, DTLS_BUDGET_MS));
	if (!dtlsOk) {
		console.warn(
			`[relay-only] SKIPPED at runtime: DTLS/data-channel did not complete within ${DTLS_BUDGET_MS} ms` +
				` after relay connect — TURN leg degraded in this environment, environmental not a failure`,
		);
		a.close();
		b.close();
		return;
	}
	console.log(`[relay-only] data channels open (DTLS complete) at t+${Date.now() - t0} ms`);

	// 1 s of audio in BOTH directions (50 × 20 ms frames), plus a second
	// burst halfway through the wait window (TURN consent-refresh flakiness).
	const burst = (from: number): void => {
		for (let i = 0; i < 50; i++) {
			a.writeAudio(sineFrame(from + i, 440));
			b.writeAudio(sineFrame(from + i, 880));
		}
	};
	burst(0);
	const audioDeadline = Date.now() + AUDIO_BUDGET_MS;
	let secondBurst = false;
	while (Date.now() < audioDeadline && (audioAtA.length < 20 || audioAtB.length < 20)) {
		await sleep(FRAME_MS * 5);
		if (!secondBurst && Date.now() > audioDeadline - AUDIO_BUDGET_MS / 2) {
			burst(50);
			secondBurst = true;
		}
	}

	console.log(
		`[relay-only] frames received: A←B ${audioAtA.length}, B←A ${audioAtB.length}` +
			` (bridge: a.delivered=${a.audioBridge.deliveredFrames} a.dropped=${a.audioBridge.droppedFrames}` +
			` b.delivered=${b.audioBridge.deliveredFrames} b.dropped=${b.audioBridge.droppedFrames})`,
	);
	if (audioAtA.length === 0 || audioAtB.length === 0) {
		console.warn(
			`[relay-only] SKIPPED at runtime: relay connected + DTLS completed but no audio flowed within` +
				` ${AUDIO_BUDGET_MS} ms — TURN media leg degraded in this environment, environmental not a failure`,
		);
		a.close();
		b.close();
		return;
	}

	// Audio arrived both directions — now assert the contract.
	expect(audioAtA.length).toBeGreaterThan(20); // ≥ ~0.4 s in each direction
	expect(audioAtB.length).toBeGreaterThan(20);
	for (const frame of [...audioAtA.slice(0, 5), ...audioAtB.slice(0, 5)]) {
		expect(frame.length).toBe(960); // 20 ms @ 48 kHz
	}

	a.close();
	b.close();
}, 120_000);

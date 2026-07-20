// SPDX-License-Identifier: AGPL-3.0-or-later
//
// P3-T2 — TURN connectivity spike (BEST-EFFORT, never fails the build).
//
// Two werift RTCPeerConnections with iceTransportPolicy "relay" against the
// 5 official Session TURN servers (public constants shipped in every
// official client — calls/src/policy.ts). Attempts a relay-only connection
// + a small audio/data exchange under a hard 30 s timeout.
//
// Outcomes (both exit 0 — this is diagnostics, not a gate):
//   STATUS=CONNECTED — relay candidate pairs logged + data-channel RTT.
//   STATUS=BLOCKED   — environment cannot reach the TURN servers (UDP egress
//     filtered / DNS failure / servers unreachable). Candidate + error dump
//     recorded; documented fallback = local coturn with the same static
//     credentials (plan §3.4/P3-T2 notes).
//
// Run: cd calls && bun spike/turn-connectivity.ts
// (Bun resolves the ../src/policy.ts → ./types.js transitive import chain;
// Node's native type-stripping does not rewrite .js → .ts, so Node runs of
// src-importing spikes are unsupported — P3-T1's standalone spike covers
// the Node runtime validation.)

import { lookup } from "node:dns/promises";

import {
	MediaStreamTrack,
	RTCPeerConnection,
} from "werift";

import {
	SESSION_TURN_CREDENTIALS,
	SESSION_TURN_SERVERS,
} from "../src/policy.ts";

const HARD_TIMEOUT_MS = 30_000;

function runtimeName(): string {
	return typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"
		? `bun ${((globalThis as { Bun?: { version?: string } }).Bun?.version ?? "?")}`
		: `node ${process.version}`;
}

async function main(): Promise<void> {
	const t0 = Date.now();
	console.log(`runtime=${runtimeName()} werift=0.23.0 policy=relay servers=${SESSION_TURN_SERVERS.length}`);

	// --- Stage 1: DNS reachability of the 5 hosts -------------------------
	const dnsResults: string[] = [];
	for (const url of SESSION_TURN_SERVERS) {
		const host = url.replace(/^turn:/, "").replace(/:\d+$/, "");
		try {
			const r = await lookup(host, { all: true });
			dnsResults.push(`${host} → ${r.map((x) => `${x.address}(${x.family})`).join(",")}`);
		} catch (err) {
			dnsResults.push(`${host} → DNS FAILED: ${String(err)}`);
		}
	}
	console.log("--- DNS ---");
	for (const line of dnsResults) console.log(line);
	const anyDns = dnsResults.some((l) => !l.includes("DNS FAILED"));

	// --- Stage 2: relay-only PC pair --------------------------------------
	// werift findings (parseIceServers in utils.js):
	//  1. URLs MUST carry an explicit port — it splits on ":" and parses the
	//     second element; "turn:host" (no port) yields port NaN and the TURN
	//     allocation fails silently. Append the protocol-default 3478.
	//  2. Only the FIRST "turn:" iceServer entry is ever used (.find()), so
	//     the 5-server list is effectively one server for werift. We still
	//     pass all 5 for wire-parity of the config we'll ship.
	const iceServers = SESSION_TURN_SERVERS.map((urls) => ({
		urls: urls.includes(":", urls.indexOf(":") + 1) ? urls : `${urls}:3478`,
		username: SESSION_TURN_CREDENTIALS.username,
		credential: SESSION_TURN_CREDENTIALS.password,
	}));
	const config = { iceServers, iceTransportPolicy: "relay" as const, bundlePolicy: "max-bundle" as const };
	const aPc = new RTCPeerConnection(config);
	const bPc = new RTCPeerConnection(config);

	aPc.addTransceiver(new MediaStreamTrack({ kind: "audio" }), { direction: "sendrecv" });
	bPc.addTransceiver(new MediaStreamTrack({ kind: "audio" }), { direction: "sendrecv" });

	const candDump: string[] = [];
	const errors: string[] = [];
	const wire = (from: RTCPeerConnection, to: RTCPeerConnection, label: string): void => {
		from.onIceCandidate.subscribe((c) => {
			if (c === undefined) {
				candDump.push(`${label}: gathering complete`);
				return;
			}
			candDump.push(`${label}: ${c.candidate ?? "(null)"}`);
			to.addIceCandidate(c).catch((err) => errors.push(`${label} addIceCandidate: ${String(err)}`));
		});
		from.onicecandidateerror = (e: { errorText?: string; url?: string }) => {
			errors.push(`${label} candidateerror: ${e?.errorText ?? "?"} url=${e?.url ?? "?"}`);
		};
	};
	wire(aPc, bPc, "A");
	wire(bPc, aPc, "B");

	// Negotiated data channel on both sides for the RTT probe.
	const aDc = aPc.createDataChannel("signaling", { negotiated: true, id: 548, ordered: true });
	const bDc = bPc.createDataChannel("signaling", { negotiated: true, id: 548, ordered: true });
	// B is the echo responder.
	bDc.onMessage.subscribe((msg) => {
		if (typeof msg === "string") bDc.send(msg);
	});

	const offer = await aPc.createOffer();
	await aPc.setLocalDescription(offer);
	await bPc.setRemoteDescription(offer);
	const answer = await bPc.createAnswer();
	await bPc.setLocalDescription(answer);
	await aPc.setRemoteDescription(answer);

	// --- Stage 3: wait for relay connection (hard 30 s) -------------------
	const connected = await new Promise<boolean>((resolve) => {
		const timer = setTimeout(() => resolve(false), HARD_TIMEOUT_MS);
		const sub1 = aPc.iceConnectionStateChange.subscribe(() => tick());
		const sub2 = bPc.iceConnectionStateChange.subscribe(() => tick());
		const tick = (): void => {
			const a = aPc.iceConnectionState;
			const b = bPc.iceConnectionState;
			if ((a === "connected" || a === "completed") && (b === "connected" || b === "completed")) {
				clearTimeout(timer);
				sub1.unSubscribe();
				sub2.unSubscribe();
				resolve(true);
			} else if (a === "failed" || b === "failed") {
				clearTimeout(timer);
				sub1.unSubscribe();
				sub2.unSubscribe();
				resolve(false);
			}
		};
		tick();
	});

	console.log("--- ICE candidates gathered ---");
	if (candDump.length === 0) console.log("(none — no relay allocation succeeded)");
	for (const line of candDump) console.log(line);
	if (errors.length > 0) {
		console.log("--- errors ---");
		for (const e of errors.slice(0, 10)) console.log(e);
	}
	console.log(`iceConnectionState: A=${aPc.iceConnectionState} B=${bPc.iceConnectionState}`);

	if (connected) {
		console.log(`STATUS=CONNECTED after ${Date.now() - t0} ms`);
		// RTT probe over the relay path: A pings, B echoes.
		const waitOpen = (dc: { readyState: string }): Promise<boolean> =>
			new Promise((resolve) => {
				const deadline = setTimeout(() => {
					clearInterval(iv);
					resolve(false);
				}, 5_000);
				const iv = setInterval(() => {
					if (dc.readyState === "open") {
						clearTimeout(deadline);
						clearInterval(iv);
						resolve(true);
					}
				}, 50);
			});
		if ((await waitOpen(aDc)) && (await waitOpen(bDc))) {
			const rtts: number[] = [];
			for (let i = 0; i < 5; i++) {
				const rtt = await new Promise<number>((resolve) => {
					const start = Date.now();
					const sub = aDc.onMessage.subscribe(() => {
						sub.unSubscribe();
						resolve(Date.now() - start);
					});
					aDc.send(`ping:${i}:${start}`);
					setTimeout(() => {
						sub.unSubscribe();
						resolve(Number.NaN);
					}, 3_000);
				});
				rtts.push(rtt);
			}
			const valid = rtts.filter((r) => Number.isFinite(r));
			const median = [...valid].sort((a, b) => a - b)[Math.floor(valid.length / 2)] ?? Number.NaN;
			console.log(`data channel RTTs over relay (ms): ${rtts.join(", ")}; median: ${median}`);
		} else {
			console.log("data channel did not open within 5 s");
		}
	} else {
		console.log(`STATUS=BLOCKED (relay-only connection not established within ${HARD_TIMEOUT_MS / 1000} s)`);
		console.log(
			!anyDns
				? "diagnosis: DNS resolution failed for all TURN hosts — no outbound resolution from this environment."
				: "diagnosis: DNS resolves but no relay candidates were allocated — UDP/3478 egress filtered, " +
					"or allocations rejected/timed out. Documented fallback: local coturn with the same static " +
					"credentials (plan §3.4).",
		);
	}

	await aPc.close();
	await bPc.close();
	console.log(`elapsed: ${Date.now() - t0} ms`);
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("SPIKE ERROR:", err);
		process.exit(1);
	});

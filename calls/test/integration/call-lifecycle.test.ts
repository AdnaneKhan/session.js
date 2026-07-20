// SPDX-License-Identifier: AGPL-3.0-or-later
// P4-T3 networked integration: full call lifecycle between TWO REAL
// session.js accounts over the Session swarm, using the forked client
// (sendCallMessage + call event + poller control) and the real werift
// media plane (official TURN servers).
//
// GATED: only runs with SESSION_CALLS_NETWORK_TESTS=1. Needs UDP egress to
// seed*.getsession.org (swarm) and the TURN hosts. Total runtime budget 60 s.
//
//   SESSION_CALLS_NETWORK_TESTS=1 bun test test/integration/call-lifecycle.test.ts
//
// Set SESSION_CALLS_VERBOSE=1 for per-side signaling logs.

import { expect, test } from "bun:test";

const RUN = process.env.SESSION_CALLS_NETWORK_TESTS === "1";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!cond()) {
		if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
		await sleep(100);
	}
}

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`timeout waiting for ${what}`)), ms);
	});
	try {
		return await Promise.race([p, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

(!RUN ? test.skip : test)(
	"network: A calls B → accept → connected ≤15 s → 3 s audio A→B → B hangup → correct EndReasons",
	async () => {
		// Dynamic imports so the fork client is never loaded when skipped.
		const { Poller, Session, ready } = await import("../../../src/index");
		const { encode } = await import("@session.js/mnemonic");
		const { generateSeedHex } = await import("@session.js/keypair");
		const { CallManager, sineFrame } = await import("../../src/index.js");
		await ready;

		const verbose = process.env.SESSION_CALLS_VERBOSE === "1";
		const logger =
			(tag: string) =>
			(level: string, msg: string): void => {
				if (verbose) console.log(`[${tag}:${level}] ${msg}`);
			};

		// Two fresh accounts.
		const sessionA = new Session();
		sessionA.setMnemonic(encode(generateSeedHex()));
		const sessionB = new Session();
		sessionB.setMnemonic(encode(generateSeedHex()));
		sessionA.addPoller(new Poller({ interval: 500 }));
		sessionB.addPoller(new Poller({ interval: 500 }));
		const aId = sessionA.getSessionID();
		const bId = sessionB.getSessionID();
		console.log(`[lifecycle] A=${aId}`);
		console.log(`[lifecycle] B=${bId}`);

		// Swarm bootstrap (claim swarms + first poll round).
		await sleep(5000);

		const mgrA = new CallManager(sessionA as never, { logger: logger("A") });
		const mgrB = new CallManager(sessionB as never, { logger: logger("B") });
		mgrA.approveContact(bId);
		mgrB.approveContact(aId);

		try {
			// B: expect an incoming call.
			const incomingPromise = new Promise<import("../../src/types.js").Call>((resolve) => {
				mgrB.on("incoming", resolve);
			});

			const t0 = Date.now();
			const callA = await mgrA.call(bId);
			console.log(`[lifecycle] A placed call uuid=${callA.uuid}`);

			const callB = await withTimeout(incomingPromise, 15_000, "incoming on B");
			// "incoming" fires on PRE_OFFER; the OFFER (with the SDP) arrives as
			// a separate swarm message — accept() requires remote-ring.
			await until(() => callB.info.state === "remote-ring", 10_000, "B remote-ring (OFFER)");
			console.log(`[lifecycle] B incoming after ${Date.now() - t0} ms — accepting`);
			await callB.accept();

			await withTimeout(
				(async () => {
					await until(
						() => callA.info.state === "connected" && callB.info.state === "connected",
						15_000,
						"both sides connected",
					);
				})(),
				16_000,
				"connected state",
			);
			const connectMs = Date.now() - t0;
			console.log(`[lifecycle] connected in ${connectMs} ms (budget 15 000)`);
			expect(connectMs).toBeLessThanOrEqual(15_000);

			// A → B: 3 s of 440 Hz sine (150 × 20 ms frames, paced).
			const framesAtB: Int16Array[] = [];
			callB.onAudio((pcm) => framesAtB.push(pcm));
			for (let i = 0; i < 150; i++) {
				while (!callA.writeAudio(sineFrame(i))) {
					await sleep(10);
				}
				await sleep(20);
			}
			console.log(`[lifecycle] A finished writing 3 s sine — draining`);
			await sleep(2000);
			console.log(`[lifecycle] B received ${framesAtB.length} audio frames (need ≥100)`);
			expect(framesAtB.length).toBeGreaterThanOrEqual(100);

			// B hangs up → B local-hangup, A remote-hangup.
			const endedB = new Promise<import("../../src/types.js").CallInfo>((resolve) =>
				callB.on("ended", resolve),
			);
			const endedA = new Promise<import("../../src/types.js").CallInfo>((resolve) =>
				callA.on("ended", resolve),
			);
			await callB.hangup();
			const [infoB, infoA] = await Promise.all([
				withTimeout(endedB, 15_000, "B ended"),
				withTimeout(endedA, 15_000, "A ended"),
			]);
			console.log(`[lifecycle] ended: B=${infoB.endReason} A=${infoA.endReason}`);
			expect(infoB.endReason).toBe("local-hangup");
			expect(infoA.endReason).toBe("remote-hangup");
		} finally {
			await mgrA.dispose();
			await mgrB.dispose();
		}
	},
	90_000,
);

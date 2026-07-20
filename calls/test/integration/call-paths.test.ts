// SPDX-License-Identifier: AGPL-3.0-or-later
// P4-T4 networked integration: decline and timeout paths between two REAL
// session.js accounts. Same gate as call-lifecycle.test.ts.
//
//   SESSION_CALLS_NETWORK_TESTS=1 bun test test/integration/call-paths.test.ts

import { expect, test } from "bun:test";

const RUN = process.env.SESSION_CALLS_NETWORK_TESTS === "1";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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

interface Pair {
	mgrA: import("../../src/call-manager.js").CallManager;
	mgrB: import("../../src/call-manager.js").CallManager;
	bId: string;
	dispose(): Promise<void>;
}

async function makePair(
	optionsA?: import("../../src/types.js").CallManagerOptions,
	optionsB?: import("../../src/types.js").CallManagerOptions,
): Promise<Pair> {
	const { Poller, Session, ready } = await import("../../../src/index");
	const { encode } = await import("@session.js/mnemonic");
	const { generateSeedHex } = await import("@session.js/keypair");
	const { CallManager } = await import("../../src/index.js");
	await ready;
	const sessionA = new Session();
	sessionA.setMnemonic(encode(generateSeedHex()));
	const sessionB = new Session();
	sessionB.setMnemonic(encode(generateSeedHex()));
	sessionA.addPoller(new Poller({ interval: 500 }));
	sessionB.addPoller(new Poller({ interval: 500 }));
	const bId = sessionB.getSessionID();
	console.log(`[paths] A=${sessionA.getSessionID()} B=${bId}`);
	await sleep(5000); // swarm bootstrap
	const mgrA = new CallManager(sessionA as never, optionsA);
	const mgrB = new CallManager(sessionB as never, optionsB);
	mgrA.approveContact(bId);
	mgrB.approveContact(sessionA.getSessionID());
	return {
		mgrA,
		mgrB,
		bId,
		dispose: async () => {
			await mgrA.dispose();
			await mgrB.dispose();
		},
	};
}

(!RUN ? test.skip : test)(
	"network: B rejects the call → A ends remote-declined",
	async () => {
		const pair = await makePair();
		try {
			const incomingPromise = new Promise<import("../../src/types.js").Call>((resolve) => {
				pair.mgrB.on("incoming", resolve);
			});
			const callA = await pair.mgrA.call(pair.bId);
			const endedA = new Promise<import("../../src/types.js").CallInfo>((resolve) => {
				callA.on("ended", resolve);
			});
			const callB = await withTimeout(incomingPromise, 15_000, "incoming on B");
			console.log(`[paths] B declining`);
			await callB.reject();
			const infoA = await withTimeout(endedA, 15_000, "A ended");
			console.log(`[paths] A ended: ${infoA.endReason}`);
			expect(infoA.endReason).toBe("remote-declined");
		} finally {
			await pair.dispose();
		}
	},
	90_000,
);

(!RUN ? test.skip : test)(
	"network: B ignores the call → A times out (short callTimeoutMs)",
	async () => {
		// The short timeout belongs on A — the caller waiting for an ANSWER.
		const pair = await makePair({ callTimeoutMs: 8_000 });
		try {
			const incomingPromise = new Promise<import("../../src/types.js").Call>((resolve) => {
				pair.mgrB.on("incoming", resolve);
			});
			const callA = await pair.mgrA.call(pair.bId);
			const endedA = new Promise<import("../../src/types.js").CallInfo>((resolve) => {
				callA.on("ended", resolve);
			});
			const callB = await withTimeout(incomingPromise, 15_000, "incoming on B");
			console.log(`[paths] B ignoring (no response)`);
			callB.ignore();
			const t0 = Date.now();
			const infoA = await withTimeout(endedA, 30_000, "A ended");
			console.log(`[paths] A ended after ${Date.now() - t0} ms: ${infoA.endReason}`);
			expect(infoA.endReason).toBe("timeout");
		} finally {
			await pair.dispose();
		}
	},
	90_000,
);

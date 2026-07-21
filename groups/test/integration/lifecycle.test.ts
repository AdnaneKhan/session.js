// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NETWORKED closed-group lifecycle (G8-T2). Gated behind
// SESSION_GROUPS_NETWORK_TESTS=1 — skipped by default. Creates fresh throwaway
// accounts and exercises the full path over the live swarm: create → join →
// group chat → add member → remove+rotate. Run in the nightly workflow with
// continue-on-error (official-infra contact under operator judgment).
//
//   SESSION_GROUPS_NETWORK_TESTS=1 bun test test/integration/lifecycle.test.ts
import { describe, test, expect } from "bun:test";

const RUN = process.env.SESSION_GROUPS_NETWORK_TESTS === "1";
const d = RUN ? describe : describe.skip;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(
	predicate: () => boolean | Promise<boolean>,
	timeoutMs: number,
	stepMs = 500,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return true;
		await sleep(stepMs);
	}
	return await predicate();
}

d("closed groups — networked lifecycle (throwaway accounts)", () => {
	test(
		"create / join / chat / add / remove+rotate over the live swarm",
		async () => {
			// Dynamic imports so the client + groups packages are never loaded when skipped.
			const { Session, Poller, ready } = await import("../../../src/index");
			const { encode } = await import("@session.js/mnemonic");
			const { generateSeedHex } = await import("@session.js/keypair");
			const { GroupManager, InMemoryGroupStorage } = await import("../../src/index.js");
			await ready;

			const mkSession = () => {
				const s = new Session();
				s.setMnemonic(encode(generateSeedHex()));
				s.addPoller(new Poller({ interval: 1000 }));
				return s;
			};
			const a = mkSession();
			const b = mkSession();
			const c = mkSession();
			// Let the swarms register the fresh accounts.
			await sleep(6000);

			const ma = new GroupManager(a as never, undefined, { storage: new InMemoryGroupStorage() });
			const mb = new GroupManager(b as never, undefined, { storage: new InMemoryGroupStorage() });
			const mc = new GroupManager(c as never, undefined, { storage: new InMemoryGroupStorage() });
			await ma.init();
			await mb.init();
			await mc.init();

			const aId = a.getSessionID();
			const bId = b.getSessionID();
			const cId = c.getSessionID();

			try {
				// --- create + join ---
				const group = await ma.createGroup({ name: "net-test", members: [bId] });
				const bJoined = await waitFor(
					() => mb.getGroup(group.publicKey) !== undefined,
					45000,
				);
				expect(bJoined).toBe(true);
				expect(mb.getGroup(group.publicKey)!.members.sort()).toEqual([aId, bId].sort());

				// --- group chat (exercises the real GroupPoller on B) ---
				const bGot: string[] = [];
				mb.on("groupMessage", (m) => bGot.push(m.text ?? ""));
				await ma.sendMessage(group.publicKey, "hello over the swarm");
				const chatted = await waitFor(() => bGot.includes("hello over the swarm"), 45000);
				expect(chatted).toBe(true);

				// --- add member C ---
				await ma.sendAddMembers(group.publicKey, [cId]);
				const cJoined = await waitFor(
					() => mc.getGroup(group.publicKey) !== undefined,
					45000,
				);
				expect(cJoined).toBe(true);

				// --- remove C + rotation; C loses the group, B gets a new key ---
				const bKeysBefore = (await mb.getEncryptionKeyPairs(group.publicKey)).length;
				await ma.sendRemoveMembers(group.publicKey, [cId]);
				const cRemoved = await waitFor(
					() => mc.getGroup(group.publicKey) === undefined,
					45000,
				);
				expect(cRemoved).toBe(true);
				const bRotated = await waitFor(
					async () => (await mb.getEncryptionKeyPairs(group.publicKey)).length > bKeysBefore,
					45000,
				);
				expect(bRotated).toBe(true);
			} finally {
				await ma.dispose();
				await mb.dispose();
				await mc.dispose();
			}
		},
		{ timeout: 240000 },
	);
});

// SPDX-License-Identifier: AGPL-3.0-or-later
//
// @session.js/groups — offline E2E scenario matrix (G8-T1). Multi-manager
// GroupBus scenarios exercising the full lifecycle end-to-end (create / join /
// chat / add / remove+rotate / leave / disband / rename / multi-device /
// concurrent add-remove race). Run via `bun e2e/run-matrix.ts`.
import { GroupManager } from "../src/group-manager";
import type { GroupState } from "../src/types";
import { GroupBus, BusGroupSession, tick } from "../test/helpers/bus";

export type ScenarioResult = { name: string; pass: boolean; detail?: string };

const id = (byte: string): string => "05" + byte.repeat(32);
const A = id("aa");
const B = id("bb");
const C = id("cc");
const D = id("dd");
const E = id("e1");

function setup(ids: string[]) {
	const bus = new GroupBus();
	const sessions = new Map<string, BusGroupSession>();
	const managers = new Map<string, GroupManager>();
	for (const who of ids) {
		const s = new BusGroupSession(who, bus);
		sessions.set(who, s);
		managers.set(who, new GroupManager(s, { now: () => bus.now() }));
	}
	return { bus, sessions, managers, m: (who: string) => managers.get(who)! };
}

function membersSorted(g: GroupState | undefined): string[] {
	return (g?.members ?? []).slice().sort();
}

async function settle(bus: GroupBus, rounds = 3) {
	for (let i = 0; i < rounds; i++) {
		bus.advance(1000);
		await tick();
	}
}

type Scenario = { name: string; run: () => Promise<string | null> }; // null = pass, else failure detail

export const scenarios: Scenario[] = [
	{
		name: "S1 create + join (2 users)",
		run: async () => {
			const { bus, m } = setup([A, B]);
			const g = await m(A).createGroup({ name: "s1", members: [B] });
			await settle(bus);
			if (!m(B).getGroup(g.publicKey)) return "B did not join";
			if (membersSorted(m(A).getGroup(g.publicKey)).join() !== [A, B].sort().join())
				return "A members wrong";
			if (membersSorted(m(B).getGroup(g.publicKey)).join() !== [A, B].sort().join())
				return "B members wrong";
			return null;
		},
	},
	{
		name: "S2 group chat round-trip",
		run: async () => {
			const { bus, m } = setup([A, B]);
			const g = await m(A).createGroup({ name: "s2", members: [B] });
			await settle(bus);
			const got: string[] = [];
			m(B).on("groupMessage", (msg) => got.push(msg.text ?? ""));
			await m(A).sendMessage(g.publicKey, "hello B");
			await settle(bus);
			if (got.join() !== "hello B") return `B got [${got.join()}]`;
			return null;
		},
	},
	{
		name: "S3 bidirectional chat",
		run: async () => {
			const { bus, m } = setup([A, B]);
			const g = await m(A).createGroup({ name: "s3", members: [B] });
			await settle(bus);
			const aGot: string[] = [];
			const bGot: string[] = [];
			m(A).on("groupMessage", (msg) => aGot.push(msg.text ?? ""));
			m(B).on("groupMessage", (msg) => bGot.push(msg.text ?? ""));
			await m(A).sendMessage(g.publicKey, "ping");
			await m(B).sendMessage(g.publicKey, "pong");
			await settle(bus);
			if (bGot.join() !== "ping") return "B did not get ping";
			if (aGot.join() !== "pong") return "A did not get pong";
			return null;
		},
	},
	{
		name: "S4 add member (3 users)",
		run: async () => {
			const { bus, m } = setup([A, B, C]);
			const g = await m(A).createGroup({ name: "s4", members: [B] });
			await settle(bus);
			await m(A).sendAddMembers(g.publicKey, [C]);
			await settle(bus);
			const want = [A, B, C].sort().join();
			for (const who of [A, B, C]) {
				if (membersSorted(m(who).getGroup(g.publicKey)).join() !== want)
					return `${who} members wrong: ${membersSorted(m(who).getGroup(g.publicKey)).join()}`;
			}
			return null;
		},
	},
	{
		name: "S5 remove member + rotation",
		run: async () => {
			const { bus, m } = setup([A, B, C]);
			const g = await m(A).createGroup({ name: "s5", members: [B, C] });
			await settle(bus);
			const keysBefore = (await m(B).getEncryptionKeyPairs(g.publicKey)).length;
			await m(A).sendRemoveMembers(g.publicKey, [C]);
			await settle(bus);
			if (m(C).getGroup(g.publicKey)) return "C still has the group";
			if (membersSorted(m(A).getGroup(g.publicKey)).join() !== [A, B].sort().join())
				return "A members wrong";
			if (membersSorted(m(B).getGroup(g.publicKey)).join() !== [A, B].sort().join())
				return "B members wrong";
			const bKeys = await m(B).getEncryptionKeyPairs(g.publicKey);
			if (bKeys.length <= keysBefore) return "B did not receive a rotated keypair";
			if ((await m(B).getLatestEncryptionKeyPair(g.publicKey))!.publicKey !==
				(await m(A).getLatestEncryptionKeyPair(g.publicKey))!.publicKey)
				return "A/B latest keypair diverged after rotation";
			return null;
		},
	},
	{
		name: "S6 member leave + zombie",
		run: async () => {
			const { bus, m } = setup([A, B, C]);
			const g = await m(A).createGroup({ name: "s6", members: [B, C] });
			await settle(bus);
			await m(C).sendLeave(g.publicKey);
			await settle(bus);
			if (m(C).getGroup(g.publicKey)) return "C still has the group after leave";
			const ag = m(A).getGroup(g.publicKey)!;
			if (membersSorted(ag).join() !== [A, B].sort().join()) return "A members wrong";
			if (ag.zombies.join() !== C) return "C not a zombie";
			return null;
		},
	},
	{
		name: "S7 admin leave disbands",
		run: async () => {
			const { bus, m } = setup([A, B, C]);
			const g = await m(A).createGroup({ name: "s7", members: [B, C] });
			await settle(bus);
			await m(A).sendLeave(g.publicKey); // A is admin
			await settle(bus);
			for (const who of [A, B, C]) {
				if (m(who).getGroup(g.publicKey)) return `${who} still has the group after admin left`;
			}
			return null;
		},
	},
	{
		name: "S8 rename propagates",
		run: async () => {
			const { bus, m } = setup([A, B]);
			const g = await m(A).createGroup({ name: "before", members: [B] });
			await settle(bus);
			await m(B).sendRename(g.publicKey, "after");
			await settle(bus);
			if (m(A).getGroup(g.publicKey)!.name !== "after") return "A name not updated";
			if (m(B).getGroup(g.publicKey)!.name !== "after") return "B name not updated";
			return null;
		},
	},
	{
		name: "S9 multi-device config sync",
		run: async () => {
			const bus = new GroupBus();
			const clock = { now: () => bus.now() };
			const s1 = new BusGroupSession(A, bus);
			const m1 = new GroupManager(s1, clock);
			const g = await m1.createGroup({ name: "s9", members: [B] });
			await settle(bus);
			// Link a second device for A (missed the NEW invite).
			const s2 = new BusGroupSession(A, bus);
			const m2 = new GroupManager(s2, clock);
			if (m2.getGroup(g.publicKey)) return "device2 already had the group";
			await m1.syncGroupsToLinkedDevices();
			await settle(bus);
			if (!m2.getGroup(g.publicKey)) return "device2 did not join via config sync";
			if ((await m2.getLatestEncryptionKeyPair(g.publicKey))!.publicKey !==
				(await m1.getLatestEncryptionKeyPair(g.publicKey))!.publicKey)
				return "device2 keypair mismatch";
			return null;
		},
	},
	{
		name: "S10 concurrent add/remove race converges",
		run: async () => {
			const { bus, m } = setup([A, B, C, D]);
			const g = await m(A).createGroup({ name: "s10", members: [B, C] });
			await settle(bus);
			// Overlap: admin A removes C while member B adds D (no settle between).
			const p1 = m(A).sendRemoveMembers(g.publicKey, [C]);
			const p2 = m(B).sendAddMembers(g.publicKey, [D]);
			await Promise.all([p1, p2]);
			await settle(bus, 4);
			const want = [A, B, D].sort().join();
			const aMembers = membersSorted(m(A).getGroup(g.publicKey)).join();
			const bMembers = membersSorted(m(B).getGroup(g.publicKey)).join();
			if (aMembers !== want) return `A did not converge: ${aMembers}`;
			if (bMembers !== want) return `B did not converge: ${bMembers}`;
			if (m(C).getGroup(g.publicKey)) return "C still present after removal";
			// Group remains usable after the race.
			const got: string[] = [];
			m(B).on("groupMessage", (msg) => got.push(msg.text ?? ""));
			await m(A).sendMessage(g.publicKey, "post-race");
			await settle(bus);
			if (got.join() !== "post-race") return "chat broken after race";
			return null;
		},
	},
	{
		name: "S11 late joiner gets latest keypair via NEW",
		run: async () => {
			const { bus, m } = setup([A, B, C, E]);
			const g = await m(A).createGroup({ name: "s11", members: [B] });
			await settle(bus);
			// Rotate by removing/adding so the latest key differs from the first.
			await m(A).sendAddMembers(g.publicKey, [C]);
			await settle(bus);
			await m(A).sendRemoveMembers(g.publicKey, [C]);
			await settle(bus);
			const latestBefore = (await m(A).getLatestEncryptionKeyPair(g.publicKey))!.publicKey;
			// Now add a brand-new member E; they must receive the LATEST key.
			await m(A).sendAddMembers(g.publicKey, [E]);
			await settle(bus);
			const eKeys = await m(E).getEncryptionKeyPairs(g.publicKey);
			if (eKeys.length === 0) return "E has no keypair";
			if (eKeys[eKeys.length - 1].publicKey !== latestBefore)
				return "E did not receive the latest keypair";
			return null;
		},
	},
	{
		name: "S12 removed member cannot read new chat (no new key)",
		run: async () => {
			const { bus, m } = setup([A, B, C]);
			const g = await m(A).createGroup({ name: "s12", members: [B, C] });
			await settle(bus);
			await m(A).sendRemoveMembers(g.publicKey, [C]);
			await settle(bus);
			// C is deleted; C must not have the post-rotation key.
			if (m(C).getGroup(g.publicKey)) return "C still has the group";
			if ((await m(C).getEncryptionKeyPairs(g.publicKey)).length !== 0)
				return "C retained keypairs after removal";
			return null;
		},
	},
];

export async function runScenarios(): Promise<ScenarioResult[]> {
	const results: ScenarioResult[] = [];
	for (const s of scenarios) {
		try {
			const detail = await s.run();
			results.push({ name: s.name, pass: detail === null, detail: detail ?? undefined });
		} catch (e) {
			results.push({
				name: s.name,
				pass: false,
				detail: `threw: ${e instanceof Error ? e.message : String(e)}`,
			});
		}
	}
	return results;
}

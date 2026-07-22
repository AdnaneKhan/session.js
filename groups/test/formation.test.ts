// SPDX-License-Identifier: AGPL-3.0-or-later
// P4 — formation & join (two-manager offline bus). See docs/evidence/G4-T1..T3.md.
import { expect, test } from "bun:test";
import { GroupManager } from "../src/group-manager";
import { generateEncryptionKeypair } from "../src/keygen";
import { GroupControlMessageType, type GroupState } from "../src/types";
import { GroupBus, BusGroupSession, tick } from "./helpers/bus";
import { hexToBytes } from "@noble/ciphers/utils.js";

const A = "05" + "aa".repeat(32);
const B = "05" + "bb".repeat(32);
const C = "05" + "cc".repeat(32);

function twoManagers(opts?: { bApproved?: (from: string) => boolean }) {
	const bus = new GroupBus();
	const sa = new BusGroupSession(A, bus);
	const sb = new BusGroupSession(B, bus);
	const ma = new GroupManager(sa);
	const mb = new GroupManager(sb, { isSenderApproved: opts?.bApproved });
	return { bus, sa, sb, ma, mb };
}

test("createGroup forms a group, sends NEW to every member incl. self, and the invitee joins", async () => {
	const { sa, sb, ma, mb } = twoManagers();

	const created: GroupState[] = [];
	const joined: GroupState[] = [];
	ma.on("groupCreated", (s) => created.push(s));
	mb.on("groupJoined", (s) => joined.push(s));

	const group = await ma.createGroup({ name: "team", members: [B] });

	expect(created).toHaveLength(1);
	expect(group.admins).toEqual([A]);
	expect(group.members.sort()).toEqual([A, B].sort());
	// A sent one NEW DM to each member (B and itself).
	expect(sa.sentUpdates).toHaveLength(2);
	expect(sa.sentUpdates.every((u) => u.controlMessage.type === GroupControlMessageType.NEW)).toBe(
		true,
	);
	expect(sa.sentUpdates.map((u) => u.to).sort()).toEqual([A, B].sort());
	// A started polling the group.
	expect(sa.addedPollers).toContain(group.publicKey);
	// A stored the encryption keypair.
	expect(await ma.getEncryptionKeyPairs(group.publicKey)).toHaveLength(1);

	await tick();

	// B joined from the invite.
	expect(joined).toHaveLength(1);
	const bGroup = mb.getGroup(group.publicKey)!;
	expect(bGroup.name).toBe("team");
	expect(bGroup.members.sort()).toEqual([A, B].sort());
	expect(bGroup.admins).toEqual([A]);
	expect(bGroup.active).toBe(true);
	// B stored the same encryption keypair A generated (plaintext in the sealed box).
	const bKeys = await mb.getEncryptionKeyPairs(group.publicKey);
	expect(bKeys).toHaveLength(1);
	const aKeys = await ma.getEncryptionKeyPairs(group.publicKey);
	expect(bKeys[0].publicKey).toBe(aKeys[0].publicKey);
	expect(bKeys[0].privateKey).toBe(aKeys[0].privateKey);
	// B started polling too.
	expect(sb.addedPollers).toContain(group.publicKey);
});

test("creator's own NEW (self-sync) does not double-join or duplicate the keypair", async () => {
	const { ma } = twoManagers();
	const group = await ma.createGroup({ name: "solo", members: [B] });
	await tick();
	// A received its own NEW back (delivered to A). The group already exists &
	// active → dedupe path: keypair appended-by-value is a no-op.
	expect(ma.getGroups()).toHaveLength(1);
	expect(await ma.getEncryptionKeyPairs(group.publicKey)).toHaveLength(1);
});

test("invitee not listed in members does not join", async () => {
	const bus = new GroupBus();
	const sa = new BusGroupSession(A, bus);
	const sc = new BusGroupSession(C, bus);
	const ma = new GroupManager(sa);
	const mc = new GroupManager(sc);
	const joined: GroupState[] = [];
	mc.on("groupJoined", (s) => joined.push(s));

	// A creates a group with B — C is not a member.
	await ma.createGroup({ name: "no-c", members: [B] });
	await tick();
	expect(joined).toHaveLength(0);
	expect(mc.getGroups()).toHaveLength(0);
});

test("NEW from an unapproved sender is dropped", async () => {
	const { ma, mb } = twoManagers({ bApproved: () => false });
	const joined: GroupState[] = [];
	mb.on("groupJoined", (s) => joined.push(s));
	await ma.createGroup({ name: "spam", members: [B] });
	await tick();
	expect(joined).toHaveLength(0);
	expect(mb.getGroups()).toHaveLength(0);
});

test("duplicate NEW invite only joins once and dedupes the keypair", async () => {
	const bus = new GroupBus();
	const sa = new BusGroupSession(A, bus);
	const sb = new BusGroupSession(B, bus);
	const ma = new GroupManager(sa);
	const mb = new GroupManager(sb);
	const joined: GroupState[] = [];
	mb.on("groupJoined", (s) => joined.push(s));

	const group = await ma.createGroup({ name: "dup", members: [B] });
	await tick();
	expect(joined).toHaveLength(1);

	// Re-send the identical NEW DM to B.
	await sa.sendClosedGroupUpdate({
		to: B,
		controlMessage: {
			type: GroupControlMessageType.NEW,
			publicKey: new Uint8Array(Buffer.from(group.publicKey, "hex")),
			name: "dup",
			members: [A, B].map((m) => new Uint8Array(Buffer.from(m, "hex"))),
			admins: [A].map((m) => new Uint8Array(Buffer.from(m, "hex"))),
			encryptionKeyPair: {
				publicKey: new Uint8Array(
					Buffer.from((await ma.getLatestEncryptionKeyPair(group.publicKey))!.publicKey, "hex"),
				),
				privateKey: new Uint8Array(
					Buffer.from((await ma.getLatestEncryptionKeyPair(group.publicKey))!.privateKey, "hex"),
				),
			},
		},
	});
	await tick();
	// Still joined once, single keypair (dedupe by value).
	expect(joined).toHaveLength(1);
	expect(mb.getGroups()).toHaveLength(1);
	expect(await mb.getEncryptionKeyPairs(group.publicKey)).toHaveLength(1);
});

test("a forged NEW from an outsider cannot replace an active group's latest keypair", async () => {
	const { sb, ma, mb } = twoManagers();
	const group = await ma.createGroup({ name: "secure", members: [B] });
	await tick();
	const before = await mb.getLatestEncryptionKeyPair(group.publicKey);
	const attackerKey = generateEncryptionKeypair();

	sb.fireGroupUpdate({
		type: GroupControlMessageType.NEW,
		groupId: group.publicKey,
		publicKey: group.publicKey,
		from: C,
		isGroupMessage: false,
		timestamp: Date.now() + 1_000,
		name: "forged",
		members: [B, C],
		admins: [C],
		encryptionKeyPair: {
			publicKey: hexToBytes(attackerKey.publicKey),
			privateKey: hexToBytes(attackerKey.privateKey),
		},
		wrappers: [],
	});
	await tick();

	expect(await mb.getLatestEncryptionKeyPair(group.publicKey)).toEqual(before);
	expect(await mb.getEncryptionKeyPairs(group.publicKey)).toHaveLength(1);
});

test("NEW for a v3 (03-prefixed) group address is rejected", async () => {
	const bus = new GroupBus();
	const sa = new BusGroupSession(A, bus);
	const sb = new BusGroupSession(B, bus);
	new GroupManager(sa);
	const mb = new GroupManager(sb);
	const joined: GroupState[] = [];
	mb.on("groupJoined", (s) => joined.push(s));

	const enc = { publicKey: new Uint8Array(32).fill(2), privateKey: new Uint8Array(32).fill(3) };
	const v3Addr = "03" + "11".repeat(32);
	await sa.sendClosedGroupUpdate({
		to: B,
		controlMessage: {
			type: GroupControlMessageType.NEW,
			publicKey: new Uint8Array(Buffer.from(v3Addr, "hex")),
			name: "v3",
			members: [A, B].map((m) => new Uint8Array(Buffer.from(m, "hex"))),
			admins: [A].map((m) => new Uint8Array(Buffer.from(m, "hex"))),
			encryptionKeyPair: enc,
		},
	});
	await tick();
	expect(joined).toHaveLength(0);
});

test("createGroup enforces the 100-member limit", async () => {
	const { ma } = twoManagers();
	const members = Array.from({ length: 100 }, (_, i) => "05" + i.toString(16).padStart(64, "0"));
	await expect(ma.createGroup({ name: "big", members })).rejects.toThrow();
});

test("createGroup validates name and member ids", async () => {
	const { ma } = twoManagers();
	await expect(ma.createGroup({ name: "", members: [B] })).rejects.toThrow();
	await expect(ma.createGroup({ name: "x", members: ["not-a-session-id"] })).rejects.toThrow();
});

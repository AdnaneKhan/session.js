// SPDX-License-Identifier: AGPL-3.0-or-later
// P6 — member lifecycle (add/remove/leave/rename, rotation, fault tests).
// Two/three-manager offline bus. See docs/evidence/G6-T1..T4.md.
import { expect, test } from "bun:test";
import { hexToBytes } from "@noble/ciphers/utils.js";
import { GroupManager } from "../src/group-manager";
import { GroupControlMessageType } from "../src/types";
import { NotAnAdminError } from "../src/errors";
import { GroupBus, BusGroupSession, tick } from "./helpers/bus";

const A = "05" + "aa".repeat(32);
const B = "05" + "bb".repeat(32);
const C = "05" + "cc".repeat(32);
const D = "05" + "dd".repeat(32);

async function threeManagers() {
	const bus = new GroupBus();
	const sa = new BusGroupSession(A, bus);
	const sb = new BusGroupSession(B, bus);
	const sc = new BusGroupSession(C, bus);
	// Managers share the bus clock so send timestamps and the join watermark agree.
	const clock = { now: () => bus.now() };
	const ma = new GroupManager(sa, clock);
	const mb = new GroupManager(sb, clock);
	const mc = new GroupManager(sc, clock);
	const group = await ma.createGroup({ name: "abc", members: [B, C] });
	await tick(); // B and C join
	bus.advance(1000); // later updates must beat the join watermark
	return { bus, sa, sb, sc, ma, mb, mc, group };
}

test("add member: any member can add; newcomer joins; admins keypair-push", async () => {
	const bus = new GroupBus();
	const sa = new BusGroupSession(A, bus);
	const sb = new BusGroupSession(B, bus);
	const sc = new BusGroupSession(C, bus);
	const clock = { now: () => bus.now() };
	const ma = new GroupManager(sa, clock);
	const mb = new GroupManager(sb, clock);
	const mc = new GroupManager(sc, clock);
	const group = await ma.createGroup({ name: "team", members: [B] });
	await tick();
	bus.advance(1000);

	// B (a member, not admin) adds C.
	await mb.sendAddMembers(group.publicKey, [C]);
	await tick();
	await tick();

	// C joined (NEW DM from B).
	const cGroup = mc.getGroup(group.publicKey);
	expect(cGroup).toBeDefined();
	expect(cGroup!.members.sort()).toEqual([A, B, C].sort());
	// B and A updated members.
	expect(mb.getGroup(group.publicKey)!.members.sort()).toEqual([A, B, C].sort());
	expect(ma.getGroup(group.publicKey)!.members.sort()).toEqual([A, B, C].sort());
	// A (the receiving admin) pushed the latest keypair to C (reply DM, explicit publicKey).
	const pushes = sa.sentUpdates.filter(
		(u) => u.controlMessage.type === GroupControlMessageType.ENCRYPTION_KEY_PAIR && u.to === C,
	);
	expect(pushes.length).toBeGreaterThanOrEqual(1);
	expect(pushes[0].controlMessage.publicKey).toBeDefined();
	// C deduped the pushed keypair (identical to the NEW invite's) → exactly one.
	expect((await mc.getEncryptionKeyPairs(group.publicKey)).length).toBe(1);
});

test("remove member (admin-only): removal + rotation; removed member deleted", async () => {
	const { ma, mb, mc, group } = await threeManagers();
	const originalLatest = await ma.getLatestEncryptionKeyPair(group.publicKey);

	await ma.sendRemoveMembers(group.publicKey, [C]);
	await tick();

	// A rotated: 2 keypairs, latest changed; members = [A, B].
	expect((await ma.getEncryptionKeyPairs(group.publicKey)).length).toBe(2);
	expect((await ma.getLatestEncryptionKeyPair(group.publicKey))!.publicKey).not.toBe(
		originalLatest!.publicKey,
	);
	expect(ma.getGroup(group.publicKey)!.members.sort()).toEqual([A, B].sort());

	// B (remaining) unwrapped its rotation wrapper → 2 keypairs, latest == A's latest.
	expect((await mb.getEncryptionKeyPairs(group.publicKey)).length).toBe(2);
	expect((await mb.getLatestEncryptionKeyPair(group.publicKey))!.publicKey).toBe(
		(await ma.getLatestEncryptionKeyPair(group.publicKey))!.publicKey,
	);
	expect(mb.getGroup(group.publicKey)!.members.sort()).toEqual([A, B].sort());

	// C (removed) deleted the group entirely.
	expect(mc.getGroup(group.publicKey)).toBeUndefined();
	expect((await mc.getEncryptionKeyPairs(group.publicKey)).length).toBe(0);
});

test("non-admin cannot remove (send-side throws; inbound non-admin removal dropped)", async () => {
	const { sa, ma, mb, group } = await threeManagers();

	// Send-side: B (non-admin) cannot remove.
	await expect(mb.sendRemoveMembers(group.publicKey, [C])).rejects.toBeInstanceOf(NotAnAdminError);

	// Inbound: a forged MEMBERS_REMOVED from B (non-admin) removing C is dropped by A.
	const before = ma.getGroup(group.publicKey)!.members.slice().sort();
	sa.fireGroupUpdate({
		type: GroupControlMessageType.MEMBERS_REMOVED,
		groupId: group.publicKey,
		from: B, // a member, but not an admin
		isGroupMessage: true,
		timestamp: Date.now() + 1_000_000,
		members: [C],
		admins: [],
		wrappers: [],
	});
	await tick();
	expect(ma.getGroup(group.publicKey)!.members.slice().sort()).toEqual(before);
});

test("the first admin cannot be removed", async () => {
	const { ma, group } = await threeManagers();
	await expect(ma.sendRemoveMembers(group.publicKey, [A])).rejects.toThrow();
});

test("cannot remove yourself (must leave)", async () => {
	const { ma, group } = await threeManagers();
	await expect(ma.sendRemoveMembers(group.publicKey, [A, C])).rejects.toThrow();
});

test("leave: leaver deletes locally; others remove them and add a zombie", async () => {
	const { ma, mb, mc, group } = await threeManagers();

	await mc.sendLeave(group.publicKey);
	await tick();

	expect(mc.getGroup(group.publicKey)).toBeUndefined();
	expect(ma.getGroup(group.publicKey)!.members.sort()).toEqual([A, B].sort());
	expect(ma.getGroup(group.publicKey)!.zombies).toEqual([C]);
	expect(mb.getGroup(group.publicKey)!.zombies).toEqual([C]);
});

test("admin leaving disbands the group for everyone", async () => {
	const { ma, mb, mc, group } = await threeManagers();

	await ma.sendLeave(group.publicKey); // A is the admin
	await tick();

	expect(ma.getGroup(group.publicKey)).toBeUndefined();
	expect(mb.getGroup(group.publicKey)).toBeUndefined();
	expect(mc.getGroup(group.publicKey)).toBeUndefined();
});

test("rename: any member renames; others update the name", async () => {
	const { ma, mb, group } = await threeManagers();
	await ma.sendRename(group.publicKey, "renamed");
	await tick();
	expect(ma.getGroup(group.publicKey)!.name).toBe("renamed");
	expect(mb.getGroup(group.publicKey)!.name).toBe("renamed");
});

test("re-adding a zombie clears the zombie flag", async () => {
	const { ma, mb, mc, group } = await threeManagers();
	await mc.sendLeave(group.publicKey);
	await tick();
	expect(ma.getGroup(group.publicKey)!.zombies).toEqual([C]);

	await ma.sendAddMembers(group.publicKey, [C]);
	await tick();
	await tick();
	expect(ma.getGroup(group.publicKey)!.zombies).toEqual([]);
	expect(ma.getGroup(group.publicKey)!.members).toContain(C);
	expect(mb.getGroup(group.publicKey)!.zombies).toEqual([]);
});

test("fault: stale update (timestamp <= watermark) is dropped", async () => {
	const { sb, mb, group } = await threeManagers();
	const g = mb.getGroup(group.publicKey)!;
	const membersBefore = g.members.slice().sort();

	sb.fireGroupUpdate({
		type: GroupControlMessageType.MEMBERS_ADDED,
		groupId: group.publicKey,
		from: A,
		isGroupMessage: true,
		timestamp: g.lastJoinedTimestamp, // not strictly newer → stale
		members: [D],
		admins: [],
		wrappers: [],
	});
	await tick();
	expect(mb.getGroup(group.publicKey)!.members.slice().sort()).toEqual(membersBefore);
});

test("fault: update from a non-member is dropped", async () => {
	const { sb, mb, group } = await threeManagers();
	const membersBefore = mb.getGroup(group.publicKey)!.members.slice().sort();
	sb.fireGroupUpdate({
		type: GroupControlMessageType.NAME_CHANGE,
		groupId: group.publicKey,
		from: D, // outsider, not a member
		isGroupMessage: true,
		timestamp: Date.now() + 5_000_000,
		name: "hacked",
		members: [],
		admins: [],
		wrappers: [],
	});
	await tick();
	expect(mb.getGroup(group.publicKey)!.name).toBe("abc");
	expect(mb.getGroup(group.publicKey)!.members.slice().sort()).toEqual(membersBefore);
});

test("fault: duplicate keypair (same value) is ignored", async () => {
	const { sb, mb, group } = await threeManagers();
	const latest = (await mb.getEncryptionKeyPairs(group.publicKey))[0];
	const wrapper = await sb.sealKeypairWrapper(B, {
		publicKey: hexToBytes(latest.publicKey),
		privateKey: hexToBytes(latest.privateKey),
	});
	sb.fireGroupUpdate({
		type: GroupControlMessageType.ENCRYPTION_KEY_PAIR,
		groupId: group.publicKey,
		publicKey: group.publicKey,
		from: A, // admin
		isGroupMessage: false,
		timestamp: Date.now(),
		members: [],
		admins: [],
		wrappers: [{ publicKey: B, encryptedKeyPair: wrapper }],
	});
	await tick();
	expect((await mb.getEncryptionKeyPairs(group.publicKey)).length).toBe(1);
});

test("fault: ENCRYPTION_KEY_PAIR from a non-admin is dropped", async () => {
	const { sb, mb, group } = await threeManagers();
	const fresh = { publicKey: "99".repeat(32), privateKey: "98".repeat(32) };
	const wrapper = await sb.sealKeypairWrapper(B, {
		publicKey: hexToBytes(fresh.publicKey),
		privateKey: hexToBytes(fresh.privateKey),
	});
	sb.fireGroupUpdate({
		type: GroupControlMessageType.ENCRYPTION_KEY_PAIR,
		groupId: group.publicKey,
		publicKey: group.publicKey,
		from: C, // member but NOT admin
		isGroupMessage: false,
		timestamp: Date.now(),
		members: [],
		admins: [],
		wrappers: [{ publicKey: B, encryptedKeyPair: wrapper }],
	});
	await tick();
	expect((await mb.getEncryptionKeyPairs(group.publicKey)).length).toBe(1);
});

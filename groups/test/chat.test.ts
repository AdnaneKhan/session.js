// SPDX-License-Identifier: AGPL-3.0-or-later
// P5 — group chat send/receive (two-manager offline bus). See docs/evidence/G5-T1.md.
import { expect, test } from "bun:test";
import { GroupManager } from "../src/group-manager";
import type { GroupMessageEvent } from "../src/types";
import { GroupNotFoundError, GroupInactiveError } from "../src/errors";
import { GroupBus, BusGroupSession, tick } from "./helpers/bus";

const A = "05" + "aa".repeat(32);
const B = "05" + "bb".repeat(32);

async function joinedPair() {
	const bus = new GroupBus();
	const sa = new BusGroupSession(A, bus);
	const sb = new BusGroupSession(B, bus);
	const ma = new GroupManager(sa);
	const mb = new GroupManager(sb);
	const group = await ma.createGroup({ name: "chat", members: [B] });
	await tick(); // B joins
	return { bus, sa, sb, ma, mb, group };
}

test("sendMessage delivers a group chat message to another member", async () => {
	const { sa, ma, mb, group } = await joinedPair();
	const received: GroupMessageEvent[] = [];
	mb.on("groupMessage", (m) => received.push(m));

	const { messageHash } = await ma.sendMessage(group.publicKey, "hello");
	expect(messageHash).toBeTruthy();
	await tick();

	expect(received).toHaveLength(1);
	expect(received[0].text).toBe("hello");
	expect(received[0].from).toBe(A);
	expect(received[0].groupId).toBe(group.publicKey);
	expect(received[0].type).toBe("group");
});

test("sendMessage seals to the group's latest encryption key", async () => {
	const { sa, ma, group } = await joinedPair();
	await ma.sendMessage(group.publicKey, "hi");
	const latest = await ma.getLatestEncryptionKeyPair(group.publicKey);
	expect(sa.sentMessages).toHaveLength(1);
	expect(sa.sentMessages[0].to).toBe(group.publicKey);
	expect(sa.sentMessages[0].encryptionPublicKey).toBe(latest!.publicKey);
});

test("sendMessage honors the group's deleteAfterSend timer", async () => {
	const bus = new GroupBus();
	const sa = new BusGroupSession(A, bus);
	new BusGroupSession(B, bus);
	const ma = new GroupManager(sa);
	new GroupManager(new BusGroupSession(B, bus));
	const group = await ma.createGroup({ name: "disappearing", members: [B], expirationTimer: 3600 });
	await tick();

	await ma.sendMessage(group.publicKey, "poof");
	expect(sa.sentMessages[0].expirationType).toBe("deleteAfterSend");
	expect(sa.sentMessages[0].expireTimer).toBe(3600);
});

test("sendMessage to an unknown group throws GroupNotFoundError", async () => {
	const { ma } = await joinedPair();
	await expect(ma.sendMessage("05" + "99".repeat(32), "hi")).rejects.toBeInstanceOf(
		GroupNotFoundError,
	);
});

test("sendMessage to an inactive group throws GroupInactiveError", async () => {
	const { ma, group } = await joinedPair();
	// Mark the group inactive (as a leave/remove would).
	await ma.saveGroup({ ...ma.getGroup(group.publicKey)!, active: false });
	await expect(ma.sendMessage(group.publicKey, "hi")).rejects.toBeInstanceOf(GroupInactiveError);
});

test("the sender does not receive its own group chat message back", async () => {
	const { sa, ma } = await joinedPair();
	const received: GroupMessageEvent[] = [];
	ma.on("groupMessage", (m) => received.push(m));
	const group = ma.getGroups()[0];
	await ma.sendMessage(group.publicKey, "echo?");
	await tick();
	// The bus drops the sender's own copy (group-swarm semantics).
	expect(received).toHaveLength(0);
	void sa;
});

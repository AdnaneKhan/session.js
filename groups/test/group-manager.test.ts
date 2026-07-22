// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from "bun:test";
import { GroupManager } from "../src/group-manager";
import { GroupStorage, InMemoryGroupStorage } from "../src/storage";
import type { GroupState, GroupMessageEvent } from "../src/types";
import { FakeGroupSession, GROUP_A, MEMBER_A, MEMBER_B, OWN_ID } from "./helpers/fakes";

function sampleState(overrides: Partial<GroupState> = {}): GroupState {
	return {
		publicKey: GROUP_A,
		name: "g",
		members: [MEMBER_A, OWN_ID],
		admins: [MEMBER_A],
		zombies: [],
		active: true,
		lastJoinedTimestamp: 1,
		formationTimestamp: 1,
		expirationTimer: 0,
		...overrides,
	};
}

test("GroupManager subscribes to the session's group events", () => {
	const session = new FakeGroupSession();
	const manager = new GroupManager(session);
	expect(session.listeners.groupUpdate.size).toBe(1);
	expect(session.listeners.message.size).toBe(1);
	expect(session.listeners.syncClosedGroups.size).toBe(1);
	expect(manager.ourId).toBe(OWN_ID);
});

test("init() loads known groups from storage", async () => {
	const storage = new InMemoryGroupStorage();
	const gs = new GroupStorage(storage);
	await gs.addGroupId(GROUP_A);
	await gs.setState(GROUP_A, sampleState());

	const session = new FakeGroupSession();
	const manager = new GroupManager(session, undefined, { storage });
	expect(manager.isInitialized()).toBe(false);
	await manager.init();
	expect(manager.isInitialized()).toBe(true);
	expect(manager.getGroups()).toHaveLength(1);
	expect(manager.getGroup(GROUP_A)?.name).toBe("g");
	expect(session.addedPollers).toEqual([{ groupPubKey: GROUP_A }]);
	// init is idempotent
	await manager.init();
	expect(manager.getGroups()).toHaveLength(1);
});

test("getActiveGroups filters out inactive groups", async () => {
	const manager = new GroupManager(new FakeGroupSession());
	await manager.saveGroup(sampleState());
	await manager.saveGroup(sampleState({ publicKey: "05" + "22".repeat(32), active: false }));
	expect(manager.getGroups()).toHaveLength(2);
	expect(manager.getActiveGroups()).toHaveLength(1);
});

test("saveGroup persists to storage + index", async () => {
	const storage = new InMemoryGroupStorage();
	const manager = new GroupManager(new FakeGroupSession(), undefined, { storage });
	await manager.saveGroup(sampleState());
	// A fresh manager over the same storage sees it.
	const reloaded = new GroupManager(new FakeGroupSession(), undefined, { storage });
	await reloaded.init();
	expect(reloaded.getGroup(GROUP_A)?.name).toBe("g");
});

test("re-emits group chat messages from the session's `message` event", async () => {
	const session = new FakeGroupSession();
	const manager = new GroupManager(session);
	await manager.saveGroup(sampleState()); // known active group
	const received: GroupMessageEvent[] = [];
	manager.on("groupMessage", (m) => received.push(m));

	session.fireMessage({
		type: "group",
		groupId: GROUP_A,
		from: MEMBER_A,
		id: "msg1",
		text: "hi",
		timestamp: 1,
	});
	expect(received).toHaveLength(1);
	expect(received[0].text).toBe("hi");
	expect(received[0].groupId).toBe(GROUP_A);
});

test("drops group chat for unknown or inactive groups", async () => {
	const session = new FakeGroupSession();
	const manager = new GroupManager(session);
	await manager.saveGroup(sampleState({ publicKey: "05" + "99".repeat(32), active: false }));
	const received: GroupMessageEvent[] = [];
	manager.on("groupMessage", (m) => received.push(m));

	// Unknown group.
	session.fireMessage({ type: "group", groupId: GROUP_A, from: MEMBER_A, id: "1", timestamp: 1 });
	// Known but inactive group.
	session.fireMessage({
		type: "group",
		groupId: "05" + "99".repeat(32),
		from: MEMBER_A,
		id: "2",
		timestamp: 1,
	});
	expect(received).toHaveLength(0);
});

test("ignores non-group (private) messages on the `message` event", () => {
	const session = new FakeGroupSession();
	const manager = new GroupManager(session);
	const received: GroupMessageEvent[] = [];
	manager.on("groupMessage", (m) => received.push(m));
	// A private message lacks type "group".
	session.fireMessage({ type: "private" } as unknown as GroupMessageEvent);
	expect(received).toHaveLength(0);
});

test("keypair accessors delegate to the registry", async () => {
	const manager = new GroupManager(new FakeGroupSession());
	const kp = { publicKey: "22".repeat(32), privateKey: "33".repeat(32) };
	await manager.keypairs.append(GROUP_A, kp);
	expect(await manager.getEncryptionKeyPairs(GROUP_A)).toEqual([kp]);
	expect(await manager.getLatestEncryptionKeyPair(GROUP_A)).toEqual(kp);
});

test("dispose unsubscribes from the session and is idempotent", async () => {
	const session = new FakeGroupSession();
	const manager = new GroupManager(session);
	await manager.dispose();
	expect(session.listeners.groupUpdate.size).toBe(0);
	expect(session.listeners.message.size).toBe(0);
	expect(session.listeners.syncClosedGroups.size).toBe(0);
	expect(manager.isDisposed()).toBe(true);
	// Idempotent.
	await manager.dispose();
	expect(session.listeners.groupUpdate.size).toBe(0);
});

test("a throwing consumer logger is contained", () => {
	const session = new FakeGroupSession();
	const manager = new GroupManager(session, {
		logger: () => {
			throw new Error("consumer logger exploded");
		},
	});
	// Firing an event must not throw even though the logger throws.
	expect(() =>
		session.fireMessage({
			type: "group",
			groupId: GROUP_A,
			from: MEMBER_A,
			id: "x",
			timestamp: 1,
		}),
	).not.toThrow();
	void manager;
});

test("a throwing consumer event listener is contained even without an error listener", async () => {
	const session = new FakeGroupSession();
	const manager = new GroupManager(session);
	await manager.saveGroup(sampleState());
	manager.on("groupMessage", () => {
		throw new Error("consumer exploded");
	});
	expect(() =>
		session.fireMessage({
			type: "group",
			groupId: GROUP_A,
			from: MEMBER_A,
			id: "contained",
			timestamp: 2,
		}),
	).not.toThrow();
});

test("a failed member-add send does not commit local state or suppress a retry", async () => {
	class FlakySession extends FakeGroupSession {
		attempts = 0;
		override async sendClosedGroupUpdate(
			opts: Parameters<FakeGroupSession["sendClosedGroupUpdate"]>[0],
		): Promise<{ messageHash: string; timestamp: number }> {
			this.attempts += 1;
			if (this.attempts === 1) throw new Error("offline");
			return super.sendClosedGroupUpdate(opts);
		}
	}

	const session = new FlakySession();
	const manager = new GroupManager(session);
	await manager.saveGroup(sampleState({ admins: [OWN_ID] }));
	await manager.keypairs.append(GROUP_A, KP);
	await expect(manager.sendAddMembers(GROUP_A, [MEMBER_B])).rejects.toThrow("offline");
	expect(manager.getGroup(GROUP_A)?.members).not.toContain(MEMBER_B);
	await manager.sendAddMembers(GROUP_A, [MEMBER_B]);
	expect(session.attempts).toBeGreaterThan(1);
	expect(manager.getGroup(GROUP_A)?.members).toContain(MEMBER_B);
});

const KP = { publicKey: "22".repeat(32), privateKey: "33".repeat(32) };

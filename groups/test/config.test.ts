// SPDX-License-Identifier: AGPL-3.0-or-later
// P7 — multi-device config reconciliation + config sends. See G7-T1/T2.md.
import { expect, test } from "bun:test";
import { hexToBytes, bytesToHex } from "@noble/ciphers/utils.js";
import { GroupManager } from "../src/group-manager";
import { generateEncryptionKeypair } from "../src/keygen";
import type { GroupState, GroupConfigEvent } from "../src/types";
import { FakeGroupSession, GROUP_A, MEMBER_A, MEMBER_B, OWN_ID } from "./helpers/fakes";
import { GroupBus, BusGroupSession, tick } from "./helpers/bus";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function cfgGroup(
	publicKey: string,
	name: string,
	members: string[],
	admins: string[],
	enc = generateEncryptionKeypair(),
): GroupConfigEvent {
	return {
		publicKey,
		name,
		encryptionKeyPair: {
			publicKey: hexToBytes(enc.publicKey),
			privateKey: hexToBytes(enc.privateKey),
		},
		members,
		admins,
	};
}

test("reconcile: joins a group we don't know from a config sync", async () => {
	const session = new FakeGroupSession();
	const manager = new GroupManager(session);
	const joined: GroupState[] = [];
	manager.on("groupJoined", (s) => joined.push(s));

	session.fireSyncClosedGroups([cfgGroup(GROUP_A, "from-config", [OWN_ID, MEMBER_A], [MEMBER_A])]);
	await flush();

	expect(joined).toHaveLength(1);
	expect(manager.getGroup(GROUP_A)?.name).toBe("from-config");
	expect(manager.getGroup(GROUP_A)?.members).toEqual([OWN_ID, MEMBER_A]);
	expect((await manager.getEncryptionKeyPairs(GROUP_A)).length).toBe(1);
});

test("reconcile: overwrites state of a known group and appends a new keypair", async () => {
	const session = new FakeGroupSession();
	const manager = new GroupManager(session);
	const group = await createLocalGroup(manager, GROUP_A, "old");

	const newEnc = generateEncryptionKeypair();
	session.fireSyncClosedGroups([
		cfgGroup(GROUP_A, "new-name", [OWN_ID, MEMBER_A, MEMBER_B], [MEMBER_A], newEnc),
	]);
	await flush();

	expect(manager.getGroup(GROUP_A)?.name).toBe("new-name");
	expect(manager.getGroup(GROUP_A)?.members).toEqual([OWN_ID, MEMBER_A, MEMBER_B]);
	// Appended the (different) synced keypair → 2 total, latest = synced.
	const keys = await manager.getEncryptionKeyPairs(GROUP_A);
	expect(keys.length).toBe(2);
	expect(keys[1].publicKey).toBe(newEnc.publicKey);
	void group;
});

test("reconcile: deletes active groups absent from an authoritative sync", async () => {
	const session = new FakeGroupSession();
	const manager = new GroupManager(session);
	const G2 = "05" + "77".repeat(32);
	await createLocalGroup(manager, GROUP_A, "keep");
	await createLocalGroup(manager, G2, "drop");
	const removed: Array<{ publicKey: string }> = [];
	manager.on("groupRemoved", (r) => removed.push(r));

	session.fireSyncClosedGroups([cfgGroup(GROUP_A, "keep", [OWN_ID], [OWN_ID])]);
	await flush();

	expect(manager.getGroup(GROUP_A)).toBeDefined();
	expect(manager.getGroup(G2)).toBeUndefined();
	expect(removed).toEqual([{ publicKey: G2 }]);
});

test("reconcile: an authoritative empty config removes the final known group", async () => {
	const session = new FakeGroupSession();
	const manager = new GroupManager(session);
	await createLocalGroup(manager, GROUP_A, "keep");
	session.fireSyncClosedGroups([]);
	await flush();
	expect(manager.getGroup(GROUP_A)).toBeUndefined();
});

test("reconcile: rejects a duplicate-id snapshot without partially applying it", async () => {
	const session = new FakeGroupSession();
	const manager = new GroupManager(session);
	await createLocalGroup(manager, GROUP_A, "original");
	session.fireSyncClosedGroups([
		cfgGroup(GROUP_A, "first", [OWN_ID], [OWN_ID]),
		cfgGroup(GROUP_A, "second", [OWN_ID], [OWN_ID]),
	]);
	await flush();
	expect(manager.getGroup(GROUP_A)?.name).toBe("original");
});

test("syncGroupsToLinkedDevices sends active groups with their latest keypair", async () => {
	const session = new FakeGroupSession();
	const manager = new GroupManager(session);
	await createLocalGroup(manager, GROUP_A, "g1", {
		publicKey: "22".repeat(32),
		privateKey: "33".repeat(32),
	});

	await manager.syncGroupsToLinkedDevices();
	expect(session.sentConfigs).toHaveLength(1);
	const sent = session.sentConfigs[0].activeClosedGroups;
	expect(sent).toHaveLength(1);
	expect(sent[0].publicKey).toBe(GROUP_A);
	expect(sent[0].name).toBe("g1");
	expect(bytesToHex(sent[0].encryptionKeyPair.publicKey)).toBe("22".repeat(32));
});

test("multi-device: a second linked device joins a group via config sync", async () => {
	const D = "05" + "dd".repeat(32);
	const ext = "05" + "ee".repeat(32);
	const bus = new GroupBus();
	const clock = { now: () => bus.now() };

	// Device 1 creates the group (device 2 not attached yet → misses the NEW).
	const s1 = new BusGroupSession(D, bus);
	const m1 = new GroupManager(s1, clock);
	const group = await m1.createGroup({ name: "shared", members: [ext] });
	await tick();

	// Device 2 links in afterwards (knows nothing yet).
	const s2 = new BusGroupSession(D, bus);
	const m2 = new GroupManager(s2, clock);
	expect(m2.getGroup(group.publicKey)).toBeUndefined();

	// Device 1 syncs its config → delivered to both linked devices.
	await m1.syncGroupsToLinkedDevices();
	await tick();

	expect(m2.getGroup(group.publicKey)).toBeDefined();
	expect(m2.getGroup(group.publicKey)!.name).toBe("shared");
	expect(m2.getGroup(group.publicKey)!.members).toContain(D);
	// Device 2 received the latest keypair and can decrypt group traffic.
	expect((await m2.getEncryptionKeyPairs(group.publicKey)).length).toBe(1);
	expect((await m2.getLatestEncryptionKeyPair(group.publicKey))!.publicKey).toBe(
		(await m1.getLatestEncryptionKeyPair(group.publicKey))!.publicKey,
	);

	// Same-account group traffic is suppressed only on the sending device by
	// message hash; the other linked device still receives chat and controls.
	const linkedMessages: string[] = [];
	m2.on("groupMessage", (message) => linkedMessages.push(message.text ?? ""));
	await m1.sendMessage(group.publicKey, "from-device-1");
	await tick();
	expect(linkedMessages).toEqual(["from-device-1"]);

	bus.advance(1_000);
	await m1.sendRename(group.publicKey, "renamed-on-device-1");
	await tick();
	expect(m2.getGroup(group.publicKey)?.name).toBe("renamed-on-device-1");
});

// Seed a group directly into a manager's storage (bypassing the wire).
async function createLocalGroup(
	manager: GroupManager,
	publicKey: string,
	name: string,
	enc = { publicKey: "22".repeat(32), privateKey: "33".repeat(32) },
): Promise<void> {
	await manager.saveGroup({
		publicKey,
		name,
		members: [OWN_ID, MEMBER_A],
		admins: [OWN_ID],
		zombies: [],
		active: true,
		lastJoinedTimestamp: 1,
		formationTimestamp: 1,
		expirationTimer: 0,
	});
	await manager.keypairs.append(publicKey, enc);
}

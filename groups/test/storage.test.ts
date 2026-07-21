// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from "bun:test";
import {
	GroupStorage,
	InMemoryGroupStorage,
	stateKey,
	keypairsKey,
	lastHashesKey,
	undecryptableKey,
	INDEX_KEY,
} from "../src/storage";
import type { GroupState } from "../src/types";
import { GROUP_A, MEMBER_A } from "./helpers/fakes";

function sampleState(): GroupState {
	return {
		publicKey: GROUP_A,
		name: "g",
		members: [MEMBER_A],
		admins: [MEMBER_A],
		zombies: [],
		active: true,
		lastJoinedTimestamp: 1,
		formationTimestamp: 1,
		expirationTimer: 0,
	};
}

test("key schema follows the closed_group:{id}:* convention", () => {
	expect(stateKey(GROUP_A)).toBe(`closed_group:${GROUP_A}:state`);
	expect(keypairsKey(GROUP_A)).toBe(`closed_group:${GROUP_A}:keypairs`);
	expect(lastHashesKey(GROUP_A)).toBe(`closed_group:${GROUP_A}:last_hashes`);
	expect(undecryptableKey(GROUP_A)).toBe(`closed_group:${GROUP_A}:undecryptable`);
	expect(INDEX_KEY).toBe("closed_group_index");
});

test("group index add/remove is idempotent and ordered", async () => {
	const storage = new GroupStorage(new InMemoryGroupStorage());
	expect(await storage.getGroupIds()).toEqual([]);
	await storage.addGroupId(GROUP_A);
	await storage.addGroupId(GROUP_A); // dedupe
	expect(await storage.getGroupIds()).toEqual([GROUP_A]);
	await storage.removeGroupId(GROUP_A);
	expect(await storage.getGroupIds()).toEqual([]);
});

test("state round-trips through JSON", async () => {
	const storage = new GroupStorage(new InMemoryGroupStorage());
	expect(await storage.getState(GROUP_A)).toBeNull();
	const state = sampleState();
	await storage.setState(GROUP_A, state);
	expect(await storage.getState(GROUP_A)).toEqual(state);
});

test("deleteGroup wipes all per-group keys and the index entry", async () => {
	const raw = new InMemoryGroupStorage();
	const storage = new GroupStorage(raw);
	await storage.addGroupId(GROUP_A);
	await storage.setState(GROUP_A, sampleState());
	await storage.setKeypairs(GROUP_A, [{ publicKey: "22".repeat(32), privateKey: "33".repeat(32) }]);

	await storage.deleteGroup(GROUP_A);

	expect(await storage.getGroupIds()).toEqual([]);
	expect(await storage.getState(GROUP_A)).toBeNull();
	expect(await storage.getKeypairs(GROUP_A)).toEqual([]);
	expect(raw.has(stateKey(GROUP_A))).toBe(false);
	expect(raw.has(lastHashesKey(GROUP_A))).toBe(false);
	expect(raw.has(undecryptableKey(GROUP_A))).toBe(false);
});

test("GroupStorage tolerates corrupt JSON by falling back", async () => {
	const raw = new InMemoryGroupStorage();
	raw.set(INDEX_KEY, "{not json");
	const storage = new GroupStorage(raw);
	expect(await storage.getGroupIds()).toEqual([]);
});

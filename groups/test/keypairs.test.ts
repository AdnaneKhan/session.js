// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from "bun:test";
import { GroupStorage, InMemoryGroupStorage } from "../src/storage";
import { KeypairRegistry } from "../src/keypairs";
import { GROUP_A } from "./helpers/fakes";

const KP1 = { publicKey: "22".repeat(32), privateKey: "33".repeat(32) };
const KP2 = { publicKey: "44".repeat(32), privateKey: "55".repeat(32) };

test("registry appends and returns keypairs newest-last", async () => {
	const registry = new KeypairRegistry(new GroupStorage(new InMemoryGroupStorage()));
	expect(await registry.append(GROUP_A, KP1)).toBe(true);
	expect(await registry.append(GROUP_A, KP2)).toBe(true);
	const all = await registry.getAll(GROUP_A);
	expect(all).toEqual([KP1, KP2]);
	expect(await registry.getLatest(GROUP_A)).toEqual(KP2);
});

test("registry dedupes by value (public+private)", async () => {
	const registry = new KeypairRegistry(new GroupStorage(new InMemoryGroupStorage()));
	expect(await registry.append(GROUP_A, KP1)).toBe(true);
	expect(await registry.append(GROUP_A, { ...KP1 })).toBe(false); // duplicate
	expect(await registry.append(GROUP_A, { publicKey: KP1.publicKey, privateKey: KP2.privateKey }))
		.toBe(true); // different value
	expect((await registry.getAll(GROUP_A))).toHaveLength(2);
});

test("registry persists across instances (storage-backed)", async () => {
	const storage = new GroupStorage(new InMemoryGroupStorage());
	const r1 = new KeypairRegistry(storage);
	await r1.append(GROUP_A, KP1);
	await r1.append(GROUP_A, KP2);

	// A fresh registry over the SAME storage sees the persisted keypairs.
	const r2 = new KeypairRegistry(storage);
	expect(await r2.getAll(GROUP_A)).toEqual([KP1, KP2]);
	expect(await r2.getLatest(GROUP_A)).toEqual(KP2);
});

test("registry getLatest returns undefined when empty", async () => {
	const registry = new KeypairRegistry(new GroupStorage(new InMemoryGroupStorage()));
	expect(await registry.getLatest(GROUP_A)).toBeUndefined();
	expect(await registry.getAll(GROUP_A)).toEqual([]);
});

test("registry removeAll clears keypairs (persisted)", async () => {
	const storage = new GroupStorage(new InMemoryGroupStorage());
	const registry = new KeypairRegistry(storage);
	await registry.append(GROUP_A, KP1);
	await registry.removeAll(GROUP_A);
	expect(await registry.getAll(GROUP_A)).toEqual([]);
	// A fresh registry over the same storage agrees.
	expect(await new KeypairRegistry(storage).getAll(GROUP_A)).toEqual([]);
});

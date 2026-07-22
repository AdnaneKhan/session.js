// SPDX-License-Identifier: AGPL-3.0-or-later
//
// @session.js/groups storage schema (plan §3.3). GroupManager takes its OWN
// Storage dependency (the client's core storage is protected). Keys follow the
// dynamic-prefix convention (`message_hash:` precedent):
//   closed_group_index                    — JSON string[] of known group ids
//   closed_group:{groupId}:state          — JSON GroupState
//   closed_group:{groupId}:keypairs       — JSON GroupEncryptionKeypair[] (append order)
//   closed_group:{groupId}:last_hashes    — defensive cleanup for shared/legacy stores
//   closed_group:{groupId}:undecryptable  — defensive cleanup for shared/legacy stores
// The live GroupPoller owns the last two keys in the client's Session storage;
// GroupManager explicitly clears that store through clearGroupPollerState.
// Written fresh.

import type { GroupEncryptionKeypair, GroupState } from "./types.js";

/** Structural string→string KV store (may be sync or async). */
export interface StorageLike {
	get(key: string): string | null | Promise<string | null>;
	set(key: string, value: string): void | Promise<void>;
	delete(key: string): void | Promise<void>;
	has(key: string): boolean | Promise<boolean>;
}

export const INDEX_KEY = "closed_group_index";
export const stateKey = (groupId: string): string => `closed_group:${groupId}:state`;
export const keypairsKey = (groupId: string): string => `closed_group:${groupId}:keypairs`;
export const lastHashesKey = (groupId: string): string => `closed_group:${groupId}:last_hashes`;
export const undecryptableKey = (groupId: string): string =>
	`closed_group:${groupId}:undecryptable`;

function parseJson<T>(raw: string | null, fallback: T): T {
	if (raw === null) return fallback;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return fallback;
	}
}

/** Typed accessors over a StorageLike using the closed_group key schema. */
export class GroupStorage {
	readonly #storage: StorageLike;
	#indexQueue: Promise<void> = Promise.resolve();

	constructor(storage: StorageLike) {
		this.#storage = storage;
	}

	/** The underlying store (advanced use and tests). */
	get raw(): StorageLike {
		return this.#storage;
	}

	async getGroupIds(): Promise<string[]> {
		return parseJson<string[]>(await this.#storage.get(INDEX_KEY), []);
	}

	async addGroupId(groupId: string): Promise<void> {
		const operation = this.#indexQueue.then(async () => {
			const ids = await this.getGroupIds();
			if (!ids.includes(groupId)) {
				ids.push(groupId);
				await this.#storage.set(INDEX_KEY, JSON.stringify(ids));
			}
		});
		this.#indexQueue = operation.catch(() => undefined);
		await operation;
	}

	async removeGroupId(groupId: string): Promise<void> {
		const operation = this.#indexQueue.then(async () => {
			const ids = (await this.getGroupIds()).filter((id) => id !== groupId);
			await this.#storage.set(INDEX_KEY, JSON.stringify(ids));
		});
		this.#indexQueue = operation.catch(() => undefined);
		await operation;
	}

	async getState(groupId: string): Promise<GroupState | null> {
		return parseJson<GroupState | null>(await this.#storage.get(stateKey(groupId)), null);
	}

	async setState(groupId: string, state: GroupState): Promise<void> {
		await this.#storage.set(stateKey(groupId), JSON.stringify(state));
	}

	async getKeypairs(groupId: string): Promise<GroupEncryptionKeypair[]> {
		return parseJson<GroupEncryptionKeypair[]>(await this.#storage.get(keypairsKey(groupId)), []);
	}

	async setKeypairs(groupId: string, keypairs: GroupEncryptionKeypair[]): Promise<void> {
		await this.#storage.set(keypairsKey(groupId), JSON.stringify(keypairs));
	}

	/** Wipe all per-group keys and drop the group from the index. */
	async deleteGroup(groupId: string): Promise<void> {
		await this.#storage.delete(stateKey(groupId));
		await this.#storage.delete(keypairsKey(groupId));
		await this.#storage.delete(lastHashesKey(groupId));
		await this.#storage.delete(undecryptableKey(groupId));
		await this.removeGroupId(groupId);
	}
}

/** A minimal in-memory StorageLike (default for throwaway managers/tests). */
export class InMemoryGroupStorage implements StorageLike {
	readonly #map = new Map<string, string>();
	get(key: string): string | null {
		return this.#map.get(key) ?? null;
	}
	set(key: string, value: string): void {
		this.#map.set(key, value);
	}
	delete(key: string): void {
		this.#map.delete(key);
	}
	has(key: string): boolean {
		return this.#map.has(key);
	}
}

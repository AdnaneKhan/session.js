// SPDX-License-Identifier: AGPL-3.0-or-later
//
// @session.js/groups — group encryption keypair registry.
//
// Ported from session-desktop `ts/receiver/closedGroups.ts` (master @ d86076b,
// AGPLv3): `getAllCachedECKeyPair`, `addKeyPairToCacheAndDBIfNeeded`,
// `removeAllClosedGroupEncryptionKeyPairs` (Kotlin analog: session-android
// `GroupUtil`/`ClosedGroup` keypair storage, GPLv3). Modified: TypeScript,
// backed by GroupStorage instead of the desktop Data layer; keypairs are
// unprefixed hex {publicKey, privateKey}. © of ported portions: Session
// Foundation. Licensed under AGPL-3.0-or-later.
//
// Semantics (plan §2.5): all historical keypairs are kept (needed for
// in-flight / pre-rotation messages and by newly-linked devices); keypairs are
// appended (no timestamp ordering) and deduped by value; "latest" = last
// appended.
import type { GroupStorage } from "./storage";
import type { GroupEncryptionKeypair } from "./types";

export class KeypairRegistry {
	readonly #storage: GroupStorage;
	/** In-memory cache of the persisted keypairs, per group (desktop's cacheOfClosedGroupKeyPairs). */
	readonly #cache = new Map<string, GroupEncryptionKeypair[]>();

	constructor(storage: GroupStorage) {
		this.#storage = storage;
	}

	/** All keypairs for a group, in append order (newest last). Returns a copy. */
	async getAll(groupPubKey: string): Promise<GroupEncryptionKeypair[]> {
		let found = this.#cache.get(groupPubKey);
		if (!found || found.length === 0) {
			found = await this.#storage.getKeypairs(groupPubKey);
			this.#cache.set(groupPubKey, found);
		}
		return found.slice();
	}

	/**
	 * Append a keypair if not already present (dedupe by value).
	 * @returns true if the keypair was newly stored, false if it was a duplicate.
	 */
	async append(groupPubKey: string, keypair: GroupEncryptionKeypair): Promise<boolean> {
		const existing = await this.getAll(groupPubKey);
		const alreadySaved = existing.some(
			(k) => k.publicKey === keypair.publicKey && k.privateKey === keypair.privateKey,
		);
		if (alreadySaved) {
			return false;
		}
		existing.push({ publicKey: keypair.publicKey, privateKey: keypair.privateKey });
		this.#cache.set(groupPubKey, existing);
		await this.#storage.setKeypairs(groupPubKey, existing);
		return true;
	}

	/** The latest keypair (last appended), or undefined if none. */
	async getLatest(groupPubKey: string): Promise<GroupEncryptionKeypair | undefined> {
		const all = await this.getAll(groupPubKey);
		return all[all.length - 1];
	}

	/** Remove all keypairs for a group (used when the group is deleted). */
	async removeAll(groupPubKey: string): Promise<void> {
		this.#cache.set(groupPubKey, []);
		await this.#storage.setKeypairs(groupPubKey, []);
	}

	/** Drop the in-memory cache entry (forces a re-read from storage next time). */
	invalidate(groupPubKey: string): void {
		this.#cache.delete(groupPubKey);
	}
}

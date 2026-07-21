// SPDX-License-Identifier: AGPL-3.0-or-later
//
// @session.js/groups — GroupManager. Lifecycle wiring adapted from
// session-desktop `ts/session/group/closed-group.ts` (master @ d86076b, AGPLv3)
// and session-android `.../messaging/groups/ClosedGroup.kt` (v1.19.1, GPLv3);
// restructured onto a structural GroupSessionLike + GroupStorage +
// KeypairRegistry (the @session.js/calls CallManager/CallSupervisor
// composition). © of ported portions: Session Foundation. Licensed under
// AGPL-3.0-or-later.
//
// Phase coverage: P3 skeleton; P4 formation (createGroup) + join (inbound NEW
// gates) + polling lifecycle; later phases add chat (P5), member ops (P6) and
// config sync (P7) on this scaffold.
import { EventEmitter } from "node:events";
import { bytesToHex, hexToBytes } from "@noble/ciphers/utils.js";
import { GroupStorage, InMemoryGroupStorage, type StorageLike } from "./storage";
import { KeypairRegistry } from "./keypairs";
import { generateEncryptionKeypair, generateGroupAddress } from "./keygen";
import { GroupTooLargeError, InvalidGroupError } from "./errors";
import {
	GroupControlMessageType,
	type GroupSessionLike,
	type GroupManagerOptions,
	type GroupManagerEventMap,
	type GroupLogger,
	type GroupState,
	type GroupUpdateEvent,
	type GroupMessageEvent,
	type GroupConfigEvent,
	type GroupEncryptionKeypair,
	type GroupPollerHandle,
	type OutgoingControlMessage,
} from "./types";

/** VALIDATION.CLOSED_GROUP_SIZE_LIMIT (@session.js/consts). */
const CLOSED_GROUP_SIZE_LIMIT = 100;
const LEGACY_GROUP_ADDRESS = /^05([0-9a-f]{2}){32}$/i;

export interface GroupManagerDeps {
	/** Persistence for group state/keys (default: in-memory). */
	storage?: StorageLike;
}

/** Wrap a consumer logger; the groups package never logs key material. */
function makeLogger(userLogger?: GroupLogger): GroupLogger {
	if (!userLogger) return () => undefined;
	return (level, msg, meta) => {
		try {
			userLogger(level, msg, meta);
		} catch {
			// A throwing consumer logger must never break group handling.
		}
	};
}

function dedupe(values: string[]): string[] {
	return [...new Set(values)];
}

function isLegacyGroupAddress(value: string): boolean {
	return LEGACY_GROUP_ADDRESS.test(value);
}

export class GroupManager extends EventEmitter {
	readonly #session: GroupSessionLike;
	readonly #options: GroupManagerOptions;
	readonly #log: GroupLogger;
	readonly #now: () => number;
	readonly #isSenderApproved: (from: string) => boolean;
	readonly #storage: GroupStorage;
	readonly #keypairs: KeypairRegistry;
	readonly #groups = new Map<string, GroupState>();
	readonly #pollers = new Map<string, GroupPollerHandle>();
	#disposed = false;
	#initialized = false;

	// Bound listeners so off() can remove exactly what on() added.
	readonly #onGroupUpdate = (u: GroupUpdateEvent): void =>
		this.#guardAsync(() => this.#handleGroupUpdate(u));
	readonly #onGroupMessage = (m: GroupMessageEvent): void =>
		this.#guard(() => this.#handleGroupMessage(m));
	readonly #onSyncClosedGroups = (groups: GroupConfigEvent[]): void =>
		this.#guard(() => this.#handleSyncClosedGroups(groups));

	constructor(session: GroupSessionLike, options?: GroupManagerOptions, deps?: GroupManagerDeps) {
		super();
		this.#session = session;
		this.#options = options ?? {};
		this.#now = this.#options.now ?? (() => Date.now());
		this.#log = makeLogger(this.#options.logger);
		this.#isSenderApproved = this.#options.isSenderApproved ?? (() => true);
		this.#storage = new GroupStorage(deps?.storage ?? new InMemoryGroupStorage());
		this.#keypairs = new KeypairRegistry(this.#storage);

		this.#session.on("groupUpdate", this.#onGroupUpdate);
		this.#session.on("message", this.#onGroupMessage);
		this.#session.on("syncClosedGroups", this.#onSyncClosedGroups);
	}

	/** Our own Session ID (05-prefixed). */
	get ourId(): string {
		return this.#session.getSessionID();
	}

	/** The current network-offset-compensated time. */
	now(): number {
		return this.#now();
	}

	/** Typed access to group state/keypair persistence (used by later phases). */
	get storage(): GroupStorage {
		return this.#storage;
	}
	get keypairs(): KeypairRegistry {
		return this.#keypairs;
	}

	/** Load known groups from storage. Idempotent. */
	async init(): Promise<void> {
		if (this.#initialized) return;
		const ids = await this.#storage.getGroupIds();
		for (const id of ids) {
			const state = await this.#storage.getState(id);
			if (state) this.#groups.set(id, state);
		}
		this.#initialized = true;
	}

	isInitialized(): boolean {
		return this.#initialized;
	}

	/** All known groups (including inactive ones we left/were removed from). */
	getGroups(): GroupState[] {
		return [...this.#groups.values()];
	}

	/** Active groups only. */
	getActiveGroups(): GroupState[] {
		return this.getGroups().filter((g) => g.active);
	}

	getGroup(publicKey: string): GroupState | undefined {
		return this.#groups.get(publicKey);
	}

	/** The group's encryption keypairs (append order; newest last). */
	async getEncryptionKeyPairs(publicKey: string): Promise<GroupEncryptionKeypair[]> {
		return this.#keypairs.getAll(publicKey);
	}

	/** The group's latest encryption keypair (the one we send with). */
	async getLatestEncryptionKeyPair(
		publicKey: string,
	): Promise<GroupEncryptionKeypair | undefined> {
		return this.#keypairs.getLatest(publicKey);
	}

	/** Persist a group state (in-memory + storage + index). */
	async saveGroup(state: GroupState): Promise<void> {
		this.#groups.set(state.publicKey, state);
		await this.#storage.addGroupId(state.publicKey);
		await this.#storage.setState(state.publicKey, state);
	}

	// -- Formation (P4) ------------------------------------------------------

	/**
	 * Create a new legacy closed group: generate the group address + first
	 * encryption keypair, then send one NEW invite DM to every member
	 * (including ourselves, for multi-device), store the group + keypair and
	 * start polling the group swarm. Emits `groupCreated`.
	 */
	async createGroup({
		name,
		members,
		expirationTimer = 0,
	}: {
		name: string;
		/** Member Session IDs to invite (ourselves is always included). */
		members: string[];
		/** Disappearing-message timer in seconds (deleteAfterSend); 0 = off. */
		expirationTimer?: number;
	}): Promise<GroupState> {
		if (!name?.length) {
			throw new InvalidGroupError("group name must be non-empty");
		}
		for (const m of members) {
			if (!isLegacyGroupAddress(m)) {
				throw new InvalidGroupError(`invalid member Session ID ${m}`);
			}
		}

		const allMembers = dedupe([this.ourId, ...members]);
		if (allMembers.length > CLOSED_GROUP_SIZE_LIMIT) {
			throw new GroupTooLargeError("(new group)", CLOSED_GROUP_SIZE_LIMIT);
		}

		const groupAddr = generateGroupAddress();
		const encKeypair = generateEncryptionKeypair();
		const now = this.now();

		const state: GroupState = {
			publicKey: groupAddr,
			name,
			members: allMembers,
			admins: [this.ourId],
			zombies: [],
			active: true,
			lastJoinedTimestamp: now,
			formationTimestamp: now,
			expirationTimer,
		};
		await this.saveGroup(state);
		await this.#keypairs.append(groupAddr, encKeypair);

		// One NEW per member (including self), sent 1:1 to each member's swarm,
		// sealed to that member's identity key; the group keypair travels
		// plaintext inside the sealed box (spec §2.2).
		const controlMessage: OutgoingControlMessage = {
			type: GroupControlMessageType.NEW,
			publicKey: hexToBytes(groupAddr),
			name,
			members: allMembers.map(hexToBytes),
			admins: [this.ourId].map(hexToBytes),
			encryptionKeyPair: {
				publicKey: hexToBytes(encKeypair.publicKey),
				privateKey: hexToBytes(encKeypair.privateKey),
			},
			...(expirationTimer > 0 && { expirationTimer }),
		};
		for (const member of allMembers) {
			await this.#session.sendClosedGroupUpdate({
				to: member,
				controlMessage,
				timestamp: now,
			});
		}

		this.#startPolling(groupAddr);
		this.emit("groupCreated", state);
		return state;
	}

	// -- Inbound control dispatch --------------------------------------------

	async #handleGroupUpdate(update: GroupUpdateEvent): Promise<void> {
		switch (update.type) {
			case GroupControlMessageType.NEW:
				await this.#handleNew(update);
				break;
			// P5: ENCRYPTION_KEY_PAIR (rotation + undecryptable retry).
			// P6: MEMBERS_ADDED / MEMBERS_REMOVED / MEMBER_LEFT / NAME_CHANGE.
			default:
				break;
		}
	}

	/**
	 * Inbound NEW invite (spec §2.2 gates): sender approved (or self); we are in
	 * `members`; name/publicKey/members/admins/encryptionKeyPair all present;
	 * publicKey is a legacy (05, non-v3) address; dedupe — if we already know
	 * the group and haven't left, just append the keypair. Then store the group
	 * + keypair, start polling, set the lastJoined watermark and emit
	 * `groupJoined`.
	 */
	async #handleNew(update: GroupUpdateEvent): Promise<void> {
		const { from, name, publicKey, members, admins, encryptionKeyPair, timestamp } = update;

		// Gate: sender approved (or self).
		if (from !== this.ourId && !this.#isSenderApproved(from)) {
			this.#log("info", `dropping NEW invite from unapproved sender ${from}`);
			return;
		}
		// Gate: all required fields present.
		if (!publicKey || !name?.length || !members.length || !admins.length || !encryptionKeyPair) {
			this.#log("info", "dropping NEW invite missing required fields");
			return;
		}
		// Gate: we are a member.
		if (!members.includes(this.ourId)) {
			return;
		}
		// Gate: legacy group address (not 03…/v3).
		if (!isLegacyGroupAddress(publicKey)) {
			this.#log("info", `dropping NEW for non-legacy group address ${publicKey}`);
			return;
		}

		const groupAddr = publicKey;
		const encKeypair: GroupEncryptionKeypair = {
			publicKey: bytesToHex(encryptionKeyPair.publicKey),
			privateKey: bytesToHex(encryptionKeyPair.privateKey),
		};

		// Dedupe: already in the group (and not left) → just append the keypair.
		const existing = this.getGroup(groupAddr);
		if (existing && existing.active) {
			await this.#keypairs.append(groupAddr, encKeypair);
			return;
		}

		// Join: lastJoinedTimestamp = envelope.timestamp watermark.
		const state: GroupState = {
			publicKey: groupAddr,
			name,
			members,
			admins,
			zombies: [],
			active: true,
			lastJoinedTimestamp: timestamp,
			formationTimestamp: timestamp,
			expirationTimer: update.expirationTimer ?? 0,
		};
		await this.saveGroup(state);
		await this.#keypairs.append(groupAddr, encKeypair);
		this.#startPolling(groupAddr);
		this.emit("groupJoined", state);
	}

	#handleGroupMessage(message: GroupMessageEvent): void {
		if (message.type !== "group") return;
		this.emit("groupMessage", message);
	}

	#handleSyncClosedGroups(groups: GroupConfigEvent[]): void {
		// P7: reconcile multi-device config (join missing, delete absent,
		// overwrite state). Skeleton: no-op.
		void groups;
	}

	// -- Polling lifecycle ---------------------------------------------------

	#startPolling(groupPubKey: string): void {
		if (this.#pollers.has(groupPubKey)) return;
		const handle = this.#session.addGroupPoller({
			groupPubKey,
			getEncryptionKeyPairs: () => this.#keypairs.getAll(groupPubKey),
		});
		this.#pollers.set(groupPubKey, handle);
	}

	#stopPolling(groupPubKey: string): void {
		const handle = this.#pollers.get(groupPubKey);
		if (!handle) return;
		try {
			this.#session.removeGroupPoller(handle);
		} catch (e) {
			this.#log("error", "failed to remove group poller", { err: e });
		}
		this.#pollers.delete(groupPubKey);
	}

	// -- Containment ---------------------------------------------------------

	/** No session callback may throw out into the event plumbing. */
	#guard(fn: () => void): void {
		try {
			fn();
		} catch (e) {
			this.#emitError(e);
		}
	}

	#guardAsync(fn: () => Promise<void>): void {
		fn().catch((e) => this.#emitError(e));
	}

	#emitError(e: unknown): void {
		const error = e instanceof Error ? e : new Error(String(e));
		this.#log("error", "group handler error", { err: error.message });
		this.emit("error", { error });
	}

	/** Idempotent teardown: unsubscribe from the session, stop group pollers. */
	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#session.off("groupUpdate", this.#onGroupUpdate);
		this.#session.off("message", this.#onGroupMessage);
		this.#session.off("syncClosedGroups", this.#onSyncClosedGroups);
		for (const groupPubKey of [...this.#pollers.keys()]) {
			this.#stopPolling(groupPubKey);
		}
		this.removeAllListeners();
	}

	isDisposed(): boolean {
		return this.#disposed;
	}

	// -- Typed event surface -------------------------------------------------

	override on<E extends keyof GroupManagerEventMap>(
		event: E,
		listener: (payload: GroupManagerEventMap[E]) => void,
	): this;
	override on(event: string | symbol, listener: (...args: unknown[]) => void): this;
	override on(event: string | symbol, listener: (...args: unknown[]) => void): this {
		return super.on(event, listener);
	}

	override off<E extends keyof GroupManagerEventMap>(
		event: E,
		listener: (payload: GroupManagerEventMap[E]) => void,
	): this;
	override off(event: string | symbol, listener: (...args: unknown[]) => void): this;
	override off(event: string | symbol, listener: (...args: unknown[]) => void): this {
		return super.off(event, listener);
	}

	override once<E extends keyof GroupManagerEventMap>(
		event: E,
		listener: (payload: GroupManagerEventMap[E]) => void,
	): this;
	override once(event: string | symbol, listener: (...args: unknown[]) => void): this;
	override once(event: string | symbol, listener: (...args: unknown[]) => void): this {
		return super.once(event, listener);
	}

	override emit<E extends keyof GroupManagerEventMap>(
		event: E,
		payload: GroupManagerEventMap[E],
	): boolean;
	override emit(event: string | symbol, ...args: unknown[]): boolean;
	override emit(event: string | symbol, ...args: unknown[]): boolean {
		return super.emit(event, ...args);
	}
}

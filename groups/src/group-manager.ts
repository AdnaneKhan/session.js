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
// Phase coverage: P3 storage, P4 formation/join, P5 chat, P6 member lifecycle,
// P7 config sync, and P8 lifecycle verification.
import { EventEmitter } from "node:events";
import { bytesToHex, hexToBytes } from "@noble/ciphers/utils.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { GroupStorage, InMemoryGroupStorage, type StorageLike } from "./storage.js";
import { KeypairRegistry } from "./keypairs.js";
import { generateEncryptionKeypair, generateGroupAddress } from "./keygen.js";
import {
	GroupTooLargeError,
	InvalidGroupError,
	GroupNotFoundError,
	GroupInactiveError,
	InvalidKeypairError,
	NotAMemberError,
	NotAnAdminError,
} from "./errors.js";
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
} from "./types.js";

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

function isValidExpirationTimer(value: number): boolean {
	return Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff;
}

function isValidTimestamp(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 0;
}

function normalizeKeypair(keypair: {
	publicKey: Uint8Array;
	privateKey: Uint8Array;
}): GroupEncryptionKeypair | null {
	if (keypair.publicKey.length !== 32 || keypair.privateKey.length !== 32) return null;
	try {
		const derivedPublicKey = x25519.getPublicKey(keypair.privateKey);
		if (bytesToHex(derivedPublicKey) !== bytesToHex(keypair.publicKey)) return null;
		return {
			publicKey: bytesToHex(keypair.publicKey),
			privateKey: bytesToHex(keypair.privateKey),
		};
	} catch {
		return null;
	}
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
	#mutationQueue: Promise<void> = Promise.resolve();

	// Bound listeners so off() can remove exactly what on() added.
	readonly #onGroupUpdate = (u: GroupUpdateEvent): void =>
		this.#enqueueInbound(() => this.#handleGroupUpdate(u));
	readonly #onGroupMessage = (m: GroupMessageEvent): void =>
		this.#guard(() => this.#handleGroupMessage(m));
	readonly #onSyncClosedGroups = (groups: GroupConfigEvent[]): void =>
		this.#enqueueInbound(() => this.#handleSyncClosedGroups(groups));

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
		return this.#runMutation(() => this.#init());
	}

	async #init(): Promise<void> {
		if (this.#initialized) return;
		const ids = await this.#storage.getGroupIds();
		for (const id of ids) {
			const state = await this.#storage.getState(id);
			if (state) {
				this.#groups.set(id, state);
				if (state.active) this.#startPolling(id);
			}
		}
		await this.#refreshSessionConfigCache();
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
	async getLatestEncryptionKeyPair(publicKey: string): Promise<GroupEncryptionKeypair | undefined> {
		return this.#keypairs.getLatest(publicKey);
	}

	/** Persist a group state (in-memory + storage + index). */
	async saveGroup(state: GroupState): Promise<void> {
		await this.#storage.addGroupId(state.publicKey);
		await this.#storage.setState(state.publicKey, state);
		this.#groups.set(state.publicKey, state);
	}

	// -- Formation (P4) ------------------------------------------------------

	/**
	 * Create a new legacy closed group: generate the group address + first
	 * encryption keypair, then send one NEW invite DM to every member
	 * (including ourselves, for multi-device), store the group + keypair and
	 * start polling the group swarm. Emits `groupCreated`.
	 */
	async createGroup(options: {
		name: string;
		/** Member Session IDs to invite (ourselves is always included). */
		members: string[];
		/** Disappearing-message timer in seconds (deleteAfterSend); 0 = off. */
		expirationTimer?: number;
	}): Promise<GroupState> {
		return this.#runMutation(() => this.#createGroup(options));
	}

	async #createGroup({
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
		if (!isValidExpirationTimer(expirationTimer)) {
			throw new InvalidGroupError("expirationTimer must be a uint32 number of seconds");
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
		await this.#refreshSessionConfigCache();

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

	// -- Group chat (P5) -----------------------------------------------------

	/**
	 * Send a visible chat message to a group we belong to. Sealed to the group's
	 * latest encryption key and stored to the group swarm (namespace −10) with a
	 * `GroupContext` (spec §2.3). Honors the group's deleteAfterSend timer.
	 */
	async sendMessage(
		groupPubKey: string,
		text?: string,
		opts?: { expireTimer?: number },
	): Promise<{ messageHash: string; timestamp: number }> {
		const group = this.getGroup(groupPubKey);
		if (!group) throw new GroupNotFoundError(groupPubKey);
		if (!group.active) throw new GroupInactiveError(groupPubKey);

		const latest = await this.#keypairs.getLatest(groupPubKey);
		if (!latest) {
			throw new InvalidKeypairError(`no encryption keypair for group ${groupPubKey}`, groupPubKey);
		}

		const expireTimer =
			opts?.expireTimer ?? (group.expirationTimer > 0 ? group.expirationTimer : 0);
		return this.#session.sendGroupMessage({
			to: groupPubKey,
			encryptionPublicKey: latest.publicKey,
			text,
			...(expireTimer > 0 && { expirationType: "deleteAfterSend", expireTimer }),
		});
	}

	// -- Member lifecycle (P6) -----------------------------------------------

	/** Fetch-and-guard a group we can act on (known, active, we are a member). */
	#requireActiveMemberGroup(groupPubKey: string): GroupState {
		const group = this.getGroup(groupPubKey);
		if (!group) throw new GroupNotFoundError(groupPubKey);
		if (!group.active) throw new GroupInactiveError(groupPubKey);
		if (!group.members.includes(this.ourId)) throw new NotAMemberError(groupPubKey, this.ourId);
		return group;
	}

	async #requireLatestKeypair(groupPubKey: string) {
		const latest = await this.#keypairs.getLatest(groupPubKey);
		if (!latest) {
			throw new InvalidKeypairError(`no encryption keypair for group ${groupPubKey}`, groupPubKey);
		}
		return latest;
	}

	/**
	 * Add members (any current member may add, spec §2.4). Sends MEMBERS_ADDED to
	 * the group swarm and a NEW invite DM (latest keypair) to each newcomer.
	 * Receiving admins additionally keypair-push (handled inbound).
	 */
	async sendAddMembers(groupPubKey: string, membersToAdd: string[]): Promise<void> {
		return this.#runMutation(() => this.#sendAddMembers(groupPubKey, membersToAdd));
	}

	async #sendAddMembers(groupPubKey: string, membersToAdd: string[]): Promise<void> {
		const group = this.#requireActiveMemberGroup(groupPubKey);
		const candidates = dedupe(membersToAdd);
		for (const member of candidates) {
			if (!isLegacyGroupAddress(member)) {
				throw new InvalidGroupError(`invalid member Session ID ${member}`, groupPubKey);
			}
		}
		const newMembers = candidates.filter((m) => !group.members.includes(m));
		if (newMembers.length === 0) return;
		const allMembers = dedupe([...group.members, ...newMembers]);
		if (allMembers.length > CLOSED_GROUP_SIZE_LIMIT) {
			throw new GroupTooLargeError(groupPubKey, CLOSED_GROUP_SIZE_LIMIT);
		}
		const latest = await this.#requireLatestKeypair(groupPubKey);

		const nextGroup: GroupState = {
			...group,
			members: allMembers,
			zombies: group.zombies.filter((z) => !newMembers.includes(z)),
		};

		await this.#session.sendClosedGroupUpdate({
			to: groupPubKey,
			encryptionPublicKey: latest.publicKey,
			controlMessage: {
				type: GroupControlMessageType.MEMBERS_ADDED,
				members: newMembers.map(hexToBytes),
			},
		});
		await this.#sendNewInvites(nextGroup, newMembers, latest);
		await this.saveGroup(nextGroup);
		await this.#refreshSessionConfigCache();
		this.emit("groupChanged", nextGroup);
	}

	/** Send a NEW invite DM (with the given keypair) to each target member. */
	async #sendNewInvites(
		group: GroupState,
		targetMembers: string[],
		keypair: { publicKey: string; privateKey: string },
	): Promise<void> {
		for (const member of targetMembers) {
			await this.#session.sendClosedGroupUpdate({
				to: member,
				controlMessage: {
					type: GroupControlMessageType.NEW,
					publicKey: hexToBytes(group.publicKey),
					name: group.name,
					members: group.members.map(hexToBytes),
					admins: group.admins.map(hexToBytes),
					encryptionKeyPair: {
						publicKey: hexToBytes(keypair.publicKey),
						privateKey: hexToBytes(keypair.privateKey),
					},
					...(group.expirationTimer > 0 && { expirationTimer: group.expirationTimer }),
				},
			});
		}
	}

	/**
	 * Remove members (admin-only, spec §2.4). Sends MEMBERS_REMOVED to the group
	 * swarm, then — because revocation is weak — rotates the group encryption
	 * keypair (§2.5), wrapping the new key for each remaining member.
	 */
	async sendRemoveMembers(groupPubKey: string, membersToRemove: string[]): Promise<void> {
		return this.#runMutation(() => this.#sendRemoveMembers(groupPubKey, membersToRemove));
	}

	async #sendRemoveMembers(groupPubKey: string, membersToRemove: string[]): Promise<void> {
		const group = this.#requireActiveMemberGroup(groupPubKey);
		if (!group.admins.includes(this.ourId)) {
			throw new NotAnAdminError(groupPubKey, this.ourId);
		}
		const candidates = dedupe(membersToRemove);
		for (const member of candidates) {
			if (!isLegacyGroupAddress(member)) {
				throw new InvalidGroupError(`invalid member Session ID ${member}`, groupPubKey);
			}
		}
		const actualRemoved = candidates.filter((member) => group.members.includes(member));
		if (actualRemoved.length === 0) return;
		if (actualRemoved.includes(this.ourId)) {
			throw new InvalidGroupError("cannot remove yourself; use sendLeave", groupPubKey);
		}
		if (group.admins.length > 0 && actualRemoved.includes(group.admins[0])) {
			throw new InvalidGroupError(
				"the first admin cannot be removed; they can only leave",
				groupPubKey,
			);
		}
		const latest = await this.#requireLatestKeypair(groupPubKey);
		const stillMembers = group.members.filter((m) => !actualRemoved.includes(m));
		const nextGroup: GroupState = {
			...group,
			members: stillMembers,
			admins: group.admins.filter((admin) => stillMembers.includes(admin)),
			zombies: group.zombies.filter((zombie) => stillMembers.includes(zombie)),
		};

		await this.#session.sendClosedGroupUpdate({
			to: groupPubKey,
			encryptionPublicKey: latest.publicKey,
			controlMessage: {
				type: GroupControlMessageType.MEMBERS_REMOVED,
				members: actualRemoved.map(hexToBytes),
			},
		});
		await this.#rotate(groupPubKey, stillMembers);
		await this.saveGroup(nextGroup);
		await this.#refreshSessionConfigCache();
		this.emit("groupChanged", nextGroup);
	}

	/** Rename the group (any member, spec §2.4). */
	async sendRename(groupPubKey: string, newName: string): Promise<void> {
		return this.#runMutation(() => this.#sendRename(groupPubKey, newName));
	}

	async #sendRename(groupPubKey: string, newName: string): Promise<void> {
		const group = this.#requireActiveMemberGroup(groupPubKey);
		if (!newName?.length) {
			throw new InvalidGroupError("group name must be non-empty", groupPubKey);
		}
		const latest = await this.#requireLatestKeypair(groupPubKey);
		const nextGroup: GroupState = { ...group, name: newName };
		await this.#session.sendClosedGroupUpdate({
			to: groupPubKey,
			encryptionPublicKey: latest.publicKey,
			controlMessage: { type: GroupControlMessageType.NAME_CHANGE, name: newName },
		});
		await this.saveGroup(nextGroup);
		await this.#refreshSessionConfigCache();
		this.emit("groupChanged", nextGroup);
	}

	/** Leave the group (any member, spec §2.4). Sends MEMBER_LEFT then deletes locally. */
	async sendLeave(groupPubKey: string): Promise<void> {
		return this.#runMutation(() => this.#sendLeave(groupPubKey));
	}

	async #sendLeave(groupPubKey: string): Promise<void> {
		const group = this.#requireActiveMemberGroup(groupPubKey);
		const latest = await this.#requireLatestKeypair(groupPubKey);
		await this.#session.sendClosedGroupUpdate({
			to: groupPubKey,
			encryptionPublicKey: latest.publicKey,
			controlMessage: { type: GroupControlMessageType.MEMBER_LEFT },
		});
		await this.#deleteClosedGroup(groupPubKey);
	}

	/**
	 * Rotate the group encryption keypair (admin-only, §2.5): fresh x25519 pair,
	 * a wrapper per remaining member sealed to their identity key, sent to the
	 * group swarm sealed to the CURRENT (still-shared) key; the new pair is
	 * appended locally only after the send.
	 */
	async #rotate(groupPubKey: string, targetMembers: string[]): Promise<void> {
		const group = this.getGroup(groupPubKey);
		if (!group || !group.admins.includes(this.ourId)) return;
		const current = await this.#keypairs.getLatest(groupPubKey);
		if (!current) return;

		const newKeypair = generateEncryptionKeypair();
		const wrappers: Array<{ publicKey: Uint8Array; encryptedKeyPair: Uint8Array }> = [];
		for (const member of targetMembers) {
			const encryptedKeyPair = await this.#session.sealKeypairWrapper(member, {
				publicKey: hexToBytes(newKeypair.publicKey),
				privateKey: hexToBytes(newKeypair.privateKey),
			});
			wrappers.push({ publicKey: hexToBytes(member), encryptedKeyPair });
		}

		await this.#session.sendClosedGroupUpdate({
			to: groupPubKey,
			encryptionPublicKey: current.publicKey,
			controlMessage: { type: GroupControlMessageType.ENCRYPTION_KEY_PAIR, wrappers },
		});
		await this.#keypairs.append(groupPubKey, newKeypair);
	}

	/** Admin keypair-push reply (spec §2.4 race fix): DM the latest keypair to targets. */
	async #pushLatestKeypair(group: GroupState, targetMembers: string[]): Promise<void> {
		const latest = await this.#keypairs.getLatest(group.publicKey);
		if (!latest) return;
		for (const member of targetMembers) {
			const encryptedKeyPair = await this.#session.sealKeypairWrapper(member, {
				publicKey: hexToBytes(latest.publicKey),
				privateKey: hexToBytes(latest.privateKey),
			});
			await this.#session.sendClosedGroupUpdate({
				to: member,
				controlMessage: {
					type: GroupControlMessageType.ENCRYPTION_KEY_PAIR,
					publicKey: hexToBytes(group.publicKey), // explicit group pubkey marks a reply
					wrappers: [{ publicKey: hexToBytes(member), encryptedKeyPair }],
				},
			});
		}
	}

	/** Delete a group for ourselves: stop polling, wipe keys + state. */
	async #deleteClosedGroup(groupPubKey: string): Promise<void> {
		this.#stopPolling(groupPubKey);
		await this.#session.clearGroupPollerState?.(groupPubKey);
		await this.#keypairs.removeAll(groupPubKey);
		await this.#storage.deleteGroup(groupPubKey);
		this.#groups.delete(groupPubKey);
		await this.#refreshSessionConfigCache();
		this.emit("groupRemoved", { publicKey: groupPubKey });
	}

	// -- Inbound control dispatch --------------------------------------------

	async #handleGroupUpdate(update: GroupUpdateEvent): Promise<void> {
		switch (update.type) {
			case GroupControlMessageType.NEW:
				await this.#handleNew(update);
				break;
			case GroupControlMessageType.ENCRYPTION_KEY_PAIR:
				await this.#handleEncryptionKeyPair(update);
				break;
			case GroupControlMessageType.NAME_CHANGE:
				await this.#handleNameChange(update);
				break;
			case GroupControlMessageType.MEMBERS_ADDED:
				await this.#handleMembersAdded(update);
				break;
			case GroupControlMessageType.MEMBERS_REMOVED:
				await this.#handleMembersRemoved(update);
				break;
			case GroupControlMessageType.MEMBER_LEFT:
				await this.#handleMemberLeft(update);
				break;
			default:
				// ENCRYPTION_KEY_PAIR_REQUEST (8) is unused by official clients — ignore.
				break;
		}
	}

	/**
	 * Common gate for group-swarm membership/name updates (desktop
	 * `performIfValid`): the group must be known, the update must be newer than
	 * our join watermark, and the sender must be a current member.
	 */
	#validateGroupUpdate(update: GroupUpdateEvent): GroupState | null {
		if (!update.isGroupMessage) return null;
		if (!isValidTimestamp(update.timestamp)) return null;
		const group = this.getGroup(update.groupId);
		if (!group) return null;
		if (update.timestamp <= group.lastJoinedTimestamp) return null; // stale
		if (!group.members.includes(update.from)) return null; // non-member
		return group;
	}

	async #handleNameChange(update: GroupUpdateEvent): Promise<void> {
		const group = this.#validateGroupUpdate(update);
		if (!group || !update.name?.length) return;
		group.name = update.name;
		await this.saveGroup(group);
		await this.#refreshSessionConfigCache();
		this.emit("groupChanged", group);
	}

	async #handleMembersAdded(update: GroupUpdateEvent): Promise<void> {
		const group = this.#validateGroupUpdate(update);
		if (!group) return;
		if (update.members.some((member) => !isLegacyGroupAddress(member))) return;
		const newMembers = update.members.filter((m) => !group.members.includes(m));
		if (dedupe([...group.members, ...newMembers]).length > CLOSED_GROUP_SIZE_LIMIT) return;
		// A re-added zombie is no longer a zombie.
		group.zombies = group.zombies.filter((z) => !update.members.includes(z));
		if (newMembers.length === 0) {
			await this.saveGroup(group);
			await this.#refreshSessionConfigCache();
			return;
		}
		group.members = dedupe([...group.members, ...newMembers]);
		await this.saveGroup(group);
		await this.#refreshSessionConfigCache();
		this.emit("groupChanged", group);
		// Admin race fix (§2.4): a receiving admin pushes the latest keypair to
		// newcomers (covers remove/re-add while the admin was offline).
		if (group.admins.includes(this.ourId)) {
			await this.#pushLatestKeypair(group, newMembers);
		}
	}

	async #handleMembersRemoved(update: GroupUpdateEvent): Promise<void> {
		if (!update.isGroupMessage) return;
		if (!isValidTimestamp(update.timestamp)) return;
		const group = this.getGroup(update.groupId);
		if (!group) return;
		if (update.timestamp <= group.lastJoinedTimestamp) return; // stale
		if (!group.members.includes(update.from)) return; // non-member
		const removed = update.members;
		if (removed.some((member) => !isLegacyGroupAddress(member))) return;
		// The first admin cannot be removed (they can only leave).
		if (group.admins.length > 0 && removed.includes(group.admins[0])) return;
		// Removal is admin-only (enforced on receive).
		if (!group.admins.includes(update.from)) return;

		const membersAfter = group.members.filter((m) => !removed.includes(m));
		if (!membersAfter.includes(this.ourId)) {
			// We were removed: stop polling, wipe keys + state.
			await this.#deleteClosedGroup(group.publicKey);
			return;
		}
		group.members = membersAfter;
		group.admins = group.admins.filter((admin) => membersAfter.includes(admin));
		group.zombies = group.zombies.filter((z) => membersAfter.includes(z));
		await this.saveGroup(group);
		await this.#refreshSessionConfigCache();
		this.emit("groupChanged", group);
	}

	async #handleMemberLeft(update: GroupUpdateEvent): Promise<void> {
		if (!update.isGroupMessage) return;
		if (!isValidTimestamp(update.timestamp)) return;
		const group = this.getGroup(update.groupId);
		if (!group) return;
		if (update.timestamp <= group.lastJoinedTimestamp) return; // stale
		const sender = update.from;
		if (!group.members.includes(sender)) return; // non-member

		// An admin leaving disbands the group for everyone.
		if (group.admins.includes(sender)) {
			await this.#deleteClosedGroup(group.publicKey);
			return;
		}
		const newMembers = group.members.filter((m) => m !== sender);
		// We are no longer a member → our own other device left → delete locally.
		if (!newMembers.includes(this.ourId)) {
			await this.#deleteClosedGroup(group.publicKey);
			return;
		}
		// Another member left: remove them and record a zombie (left-but-not-removed).
		group.members = newMembers;
		if (!group.zombies.includes(sender)) group.zombies.push(sender);
		await this.saveGroup(group);
		await this.#refreshSessionConfigCache();
		this.emit("groupChanged", group);
	}

	async #handleEncryptionKeyPair(update: GroupUpdateEvent): Promise<void> {
		// Rotations on the group swarm omit publicKey; 1:1 keypair replies must
		// carry it. Reject cross-routed messages instead of allowing an explicit
		// field to redirect a group-swarm update to another group's registry.
		if (update.isGroupMessage === (update.publicKey !== undefined)) return;
		// Explicit publicKey (1:1 reply) or the group-swarm envelope source.
		const groupAddr = update.publicKey ?? update.groupId;
		const group = this.getGroup(groupAddr);
		if (!group?.active) return;
		// Only admins distribute keypairs (group swarm) / replies.
		if (!group.members.includes(update.from) || !group.admins.includes(update.from)) return;
		const ourWrapper = update.wrappers.find((w) => w.publicKey === this.ourId);
		if (!ourWrapper) return;
		const openedKeypair = await this.#session.openKeypairWrapper(ourWrapper.encryptedKeyPair);
		if (!openedKeypair) return;
		const keypair = normalizeKeypair(openedKeypair);
		if (!keypair) return;
		const added = await this.#keypairs.append(groupAddr, keypair);
		if (added) {
			// New keypair → cached undecryptables retry on the next poll automatically
			// (the GroupPoller's keypair provider now returns the new pair).
			await this.#refreshSessionConfigCache();
			this.emit("groupChanged", group);
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
		if (update.isGroupMessage) return;
		if (!isValidTimestamp(timestamp)) return;

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
		if (members.length > CLOSED_GROUP_SIZE_LIMIT) return;
		if (members.some((member) => !isLegacyGroupAddress(member))) return;
		if (admins.some((admin) => !isLegacyGroupAddress(admin) || !members.includes(admin))) return;
		if (!members.includes(from)) return;
		if (update.expirationTimer !== undefined && !isValidExpirationTimer(update.expirationTimer))
			return;
		// Gate: legacy group address (not 03…/v3).
		if (!isLegacyGroupAddress(publicKey)) {
			this.#log("info", `dropping NEW for non-legacy group address ${publicKey}`);
			return;
		}

		const groupAddr = publicKey;
		const encKeypair = normalizeKeypair(encryptionKeyPair);
		if (!encKeypair) return;

		// Dedupe: already in the group (and not left) → just append the keypair.
		const existing = this.getGroup(groupAddr);
		if (existing && existing.active) {
			const savedKeys = await this.#keypairs.getAll(groupAddr);
			const alreadySaved = savedKeys.some(
				(k) => k.publicKey === encKeypair.publicKey && k.privateKey === encKeypair.privateKey,
			);
			if (alreadySaved) return;
			// A NEW is an invitation, not a general key-rotation channel. Once the
			// group exists, only ourselves or a currently-authorized admin may add a
			// previously unseen keypair. This prevents an approved former member from
			// replacing our outbound key with one they control.
			if (
				from !== this.ourId &&
				(!existing.members.includes(from) || !existing.admins.includes(from))
			) {
				return;
			}
			await this.#keypairs.append(groupAddr, encKeypair);
			return;
		}

		// Join: lastJoinedTimestamp = envelope.timestamp watermark.
		const state: GroupState = {
			publicKey: groupAddr,
			name,
			members: dedupe(members),
			admins: dedupe(admins),
			zombies: [],
			active: true,
			lastJoinedTimestamp: timestamp,
			formationTimestamp: timestamp,
			expirationTimer: update.expirationTimer ?? 0,
		};
		await this.saveGroup(state);
		await this.#keypairs.append(groupAddr, encKeypair);
		await this.#refreshSessionConfigCache();
		this.#startPolling(groupAddr);
		this.emit("groupJoined", state);
	}

	#handleGroupMessage(message: GroupMessageEvent): void {
		if (message.type !== "group") return;
		// Only surface chat for groups we are an active member of (unknown groups
		// or ones we have left/were removed from are dropped).
		const group = this.getGroup(message.groupId);
		if (!group?.active) return;
		this.emit("groupMessage", message);
	}

	// -- Multi-device config reconciliation (P7) -----------------------------

	/**
	 * Push our active groups (latest keypair each) to our own swarm as a legacy
	 * ConfigurationMessage, so linked devices reconcile (spec §2.6 mechanism (a)).
	 * Only the latest keypair is carried — pre-rotation history is undecryptable
	 * on linked devices (documented limitation).
	 */
	async #buildActiveClosedGroupsConfig(): Promise<GroupConfigEvent[]> {
		const activeClosedGroups: Array<{
			publicKey: string;
			name: string;
			encryptionKeyPair: { publicKey: Uint8Array; privateKey: Uint8Array };
			members: string[];
			admins: string[];
		}> = [];
		for (const group of this.getActiveGroups()) {
			const latest = await this.#keypairs.getLatest(group.publicKey);
			if (!latest) continue;
			activeClosedGroups.push({
				publicKey: group.publicKey,
				name: group.name,
				encryptionKeyPair: {
					publicKey: hexToBytes(latest.publicKey),
					privateKey: hexToBytes(latest.privateKey),
				},
				members: group.members,
				admins: group.admins,
			});
		}
		return activeClosedGroups;
	}

	async #refreshSessionConfigCache(): Promise<void> {
		if (!this.#session.setConfigurationClosedGroups) return;
		this.#session.setConfigurationClosedGroups(await this.#buildActiveClosedGroupsConfig());
	}

	async syncGroupsToLinkedDevices(): Promise<void> {
		return this.#runMutation(() => this.#syncGroupsToLinkedDevices());
	}

	async #syncGroupsToLinkedDevices(): Promise<void> {
		const activeClosedGroups = await this.#buildActiveClosedGroupsConfig();
		this.#session.setConfigurationClosedGroups?.(activeClosedGroups);
		await this.#session.sendConfigurationMessage({ activeClosedGroups });
	}

	/**
	 * Reconcile an inbound config sync (spec §2.6): join groups we don't know,
	 * overwrite the state of ones we do (config is authoritative) and append
	 * their keypair, and delete active groups absent from the authoritative sync (a
	 * linked device left / was removed — no leave message is sent).
	 */
	async #handleSyncClosedGroups(configGroups: GroupConfigEvent[]): Promise<void> {
		const validated: Array<{ group: GroupConfigEvent; keypair: GroupEncryptionKeypair }> = [];
		const seenConfigIds = new Set<string>();
		for (const cg of configGroups) {
			const keypair = normalizeKeypair(cg.encryptionKeyPair);
			const validMembers =
				cg.members.length > 0 &&
				cg.members.length <= CLOSED_GROUP_SIZE_LIMIT &&
				cg.members.every(isLegacyGroupAddress);
			const validAdmins =
				cg.admins.length > 0 &&
				cg.admins.every((admin) => isLegacyGroupAddress(admin) && cg.members.includes(admin));
			if (
				seenConfigIds.has(cg.publicKey) ||
				!isLegacyGroupAddress(cg.publicKey) ||
				!cg.name.length ||
				!validMembers ||
				!validAdmins ||
				!cg.members.includes(this.ourId) ||
				!keypair
			) {
				// A config is a full authoritative snapshot. Never apply a partial
				// snapshot when one entry is malformed, because doing so would delete
				// otherwise-valid local groups that happened to be omitted by validation.
				return;
			}
			seenConfigIds.add(cg.publicKey);
			validated.push({ group: cg, keypair });
		}

		const syncedIds = new Set<string>();
		for (const { group: cg, keypair } of validated) {
			syncedIds.add(cg.publicKey);
			const existing = this.getGroup(cg.publicKey);
			if (existing) {
				existing.name = cg.name;
				existing.members = dedupe(cg.members);
				existing.admins = dedupe(cg.admins);
				existing.zombies = existing.zombies.filter((zombie) => existing.members.includes(zombie));
				existing.active = true;
				await this.saveGroup(existing);
				await this.#keypairs.append(cg.publicKey, keypair);
				this.#startPolling(cg.publicKey);
			} else {
				const state: GroupState = {
					publicKey: cg.publicKey,
					name: cg.name,
					members: dedupe(cg.members),
					admins: dedupe(cg.admins),
					zombies: [],
					active: true,
					lastJoinedTimestamp: this.now(),
					formationTimestamp: this.now(),
					expirationTimer: 0,
				};
				await this.saveGroup(state);
				await this.#keypairs.append(cg.publicKey, keypair);
				this.#startPolling(cg.publicKey);
				this.emit("groupJoined", state);
			}
		}
		for (const group of this.getActiveGroups()) {
			if (!syncedIds.has(group.publicKey)) {
				await this.#deleteClosedGroup(group.publicKey);
			}
		}
		await this.#refreshSessionConfigCache();
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

	#enqueueInbound(fn: () => Promise<void>): void {
		void this.#runMutation(async () => {
			if (!this.#disposed) await fn();
		}).catch((e) => this.#emitError(e));
	}

	/** Serialize every state transition so inbound and local mutations cannot overwrite each other. */
	#runMutation<T>(fn: () => Promise<T>): Promise<T> {
		const operation = this.#mutationQueue.then(fn);
		this.#mutationQueue = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}

	#emitError(e: unknown): void {
		const error = e instanceof Error ? e : new Error(String(e));
		this.#log("error", "group handler error", { err: error.message });
		try {
			this.emit("error", { error });
		} catch (listenerError) {
			// Node's EventEmitter throws when `error` has no listeners, and consumer
			// listeners may throw too. Neither case may escape session event plumbing.
			this.#log("error", "group error listener failed", {
				err: listenerError instanceof Error ? listenerError.message : String(listenerError),
			});
		}
	}

	/** Idempotent teardown: unsubscribe from the session, stop group pollers. */
	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#session.off("groupUpdate", this.#onGroupUpdate);
		this.#session.off("message", this.#onGroupMessage);
		this.#session.off("syncClosedGroups", this.#onSyncClosedGroups);
		await this.#mutationQueue;
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

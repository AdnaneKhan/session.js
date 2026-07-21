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
// P3 delivers the skeleton: structural session dependency, storage schema,
// keypair registry, event surface, containment + disposal. The group lifecycle
// (create/join P4, chat send/receive P5, member ops P6, config sync P7) is
// filled in by later phases on this scaffold.
import { EventEmitter } from "node:events";
import { GroupStorage, InMemoryGroupStorage, type StorageLike } from "./storage";
import { KeypairRegistry } from "./keypairs";
import type {
	GroupSessionLike,
	GroupManagerOptions,
	GroupManagerEventMap,
	GroupLogger,
	GroupState,
	GroupUpdateEvent,
	GroupMessageEvent,
	GroupConfigEvent,
	GroupEncryptionKeypair,
	GroupPollerHandle,
} from "./types";

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

export class GroupManager extends EventEmitter {
	readonly #session: GroupSessionLike;
	readonly #options: GroupManagerOptions;
	readonly #log: GroupLogger;
	readonly #now: () => number;
	readonly #storage: GroupStorage;
	readonly #keypairs: KeypairRegistry;
	readonly #groups = new Map<string, GroupState>();
	readonly #pollers = new Map<string, GroupPollerHandle>();
	#disposed = false;
	#initialized = false;

	// Bound listeners so off() can remove exactly what on() added.
	readonly #onGroupUpdate = (u: GroupUpdateEvent): void =>
		this.#guard(() => this.#handleGroupUpdate(u));
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

	/**
	 * Persist a group state (in-memory + storage + index). Used by the
	 * lifecycle phases (P4–P7).
	 */
	async saveGroup(state: GroupState): Promise<void> {
		this.#groups.set(state.publicKey, state);
		await this.#storage.addGroupId(state.publicKey);
		await this.#storage.setState(state.publicKey, state);
	}

	// -- Inbound handlers (bodies filled in by P4–P7) ------------------------

	#handleGroupUpdate(update: GroupUpdateEvent): void {
		// P4: NEW (formation/join gates); P5: ENCRYPTION_KEY_PAIR (rotation +
		// undecryptable retry); P6: MEMBERS_ADDED/REMOVED, MEMBER_LEFT,
		// NAME_CHANGE. Skeleton: surface nothing yet.
		void update;
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

	/** No session callback may throw out into the event plumbing. */
	#guard(fn: () => void): void {
		try {
			fn();
		} catch (e) {
			const error = e instanceof Error ? e : new Error(String(e));
			this.#log("error", "group handler error", { err: error.message });
			this.emit("error", { error });
		}
	}

	/** Idempotent teardown: unsubscribe from the session, stop group pollers. */
	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#session.off("groupUpdate", this.#onGroupUpdate);
		this.#session.off("message", this.#onGroupMessage);
		this.#session.off("syncClosedGroups", this.#onSyncClosedGroups);
		for (const handle of this.#pollers.values()) {
			try {
				this.#session.removeGroupPoller(handle);
			} catch (e) {
				this.#log("error", "failed to remove group poller", { err: e });
			}
		}
		this.#pollers.clear();
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

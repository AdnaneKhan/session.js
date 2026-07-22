// SPDX-License-Identifier: AGPL-3.0-or-later
//
// @session.js/groups — structural types. This package builds WITHOUT
// @session.js/client installed: everything it needs from a client instance is
// described structurally here (method-style declarations, checked bivariantly),
// so a patched client Session satisfies GroupSessionLike with at most a single
// boundary cast (the same doctrine as @session.js/calls' SessionLike). No
// protobuf bindings are imported — the client delivers already-mapped events.

/**
 * What the groups package needs from a session.js client instance (plan §3.1).
 * A patched @session.js/client Session satisfies this structurally.
 */
export interface GroupSessionLike {
	/** Our own Session ID (05-prefixed, 66 chars). */
	getSessionID(): string;
	/** Clock compensated for swarm/server offset. */
	getNowWithNetworkOffset(): number;

	/** Subscribe/unsubscribe to the client's mapped group events. */
	on(event: "groupUpdate", cb: (update: GroupUpdateEvent) => void): void;
	off(event: "groupUpdate", cb: (update: GroupUpdateEvent) => void): void;
	on(event: "message", cb: (message: GroupMessageEvent) => void): void;
	off(event: "message", cb: (message: GroupMessageEvent) => void): void;
	on(event: "syncClosedGroups", cb: (groups: GroupConfigEvent[]) => void): void;
	off(event: "syncClosedGroups", cb: (groups: GroupConfigEvent[]) => void): void;

	/** Send a closed-group control message (group-swarm or 1:1-DM routing). */
	sendClosedGroupUpdate(opts: {
		to: string;
		controlMessage: OutgoingControlMessage;
		encryptionPublicKey?: string;
		timestamp?: number;
	}): Promise<{ messageHash: string; timestamp: number }>;

	/** Send a visible chat message to a group. */
	sendGroupMessage(opts: {
		to: string;
		encryptionPublicKey: string;
		text?: string;
		timestamp?: number;
		expirationType?: string;
		expireTimer?: number;
	}): Promise<{ messageHash: string; timestamp: number }>;

	/**
	 * Seal a group encryption keypair to a member's identity key, producing a
	 * keypair-wrapper blob (Session-protocol seal, NO message padding; plaintext
	 * is the `KeyPair` proto). Used to build ENCRYPTION_KEY_PAIR wrappers.
	 */
	sealKeypairWrapper(
		memberPubKey: string,
		keypair: { publicKey: Uint8Array; privateKey: Uint8Array },
	): Promise<Uint8Array>;

	/**
	 * Open a keypair-wrapper blob addressed to us with our identity key.
	 * Returns the recovered keypair (unprefixed byte keys), or null if it is not
	 * addressed to us / cannot be opened.
	 */
	openKeypairWrapper(
		encryptedKeyPair: Uint8Array,
	): Promise<{ publicKey: Uint8Array; privateKey: Uint8Array } | null>;

	/**
	 * Send a legacy multi-device `ConfigurationMessage` carrying our closed
	 * groups (latest keypair each) to our own swarm (spec §2.6 mechanism (a),
	 * TTL 30 d). The client fills in its own display name / profile.
	 */
	sendConfigurationMessage(opts: {
		activeClosedGroups: GroupConfigEvent[];
	}): Promise<{ messageHash: string; timestamp: number }>;
	/** Update the full closed-group snapshot included in other future config sends. */
	setConfigurationClosedGroups?(activeClosedGroups: GroupConfigEvent[]): void;

	/**
	 * Attach a poller for one group's swarm (namespace −10). The client decrypts
	 * with the provided keypairs and routes decrypted messages through the
	 * mapped `groupUpdate` / `message` events. Returns a handle to stop it.
	 * (Offline/bus sessions may no-op.)
	 */
	addGroupPoller(opts: {
		groupPubKey: string;
		getEncryptionKeyPairs: () => GroupEncryptionKeypair[] | Promise<GroupEncryptionKeypair[]>;
	}): GroupPollerHandle;
	removeGroupPoller(handle: GroupPollerHandle): void;
	/** Clear the core poller's persisted cursor/retry state for a deleted group. */
	clearGroupPollerState?(groupPubKey: string): void | Promise<void>;
}

/** Opaque handle returned by addGroupPoller. */
export type GroupPollerHandle = { readonly groupPubKey: string };

/**
 * Outgoing closed-group control message body (what gets encoded into
 * DataMessage.closedGroupControlMessage). Keys are raw bytes as the client's
 * schema expects; the wire `type` values are the plain numbers below.
 */
export interface OutgoingControlMessage {
	type: GroupControlMessageTypeValue;
	publicKey?: Uint8Array;
	name?: string;
	encryptionKeyPair?: { publicKey: Uint8Array; privateKey: Uint8Array };
	members?: Uint8Array[];
	admins?: Uint8Array[];
	wrappers?: Array<{ publicKey: Uint8Array; encryptedKeyPair: Uint8Array }>;
	expirationTimer?: number;
}

/** SessionProtos.proto `ClosedGroupControlMessage.Type` values (plain numbers). */
export const GroupControlMessageType = {
	NEW: 1,
	// 2 = removed UPDATE (numbering gap — never reused)
	ENCRYPTION_KEY_PAIR: 3,
	NAME_CHANGE: 4,
	MEMBERS_ADDED: 5,
	MEMBERS_REMOVED: 6,
	MEMBER_LEFT: 7,
	ENCRYPTION_KEY_PAIR_REQUEST: 8, // unused by official clients; ignored on receive
} as const;
export type GroupControlMessageTypeValue =
	(typeof GroupControlMessageType)[keyof typeof GroupControlMessageType];

/**
 * Payload of the client's `groupUpdate` event (a mapped
 * ClosedGroupControlMessage). Mirrors the core mapper output.
 */
export interface GroupUpdateEvent {
	type: GroupControlMessageTypeValue;
	/** Group public key (05…hex). */
	groupId: string;
	/** The actual author (05…hex). */
	from: string;
	/** True if it arrived on the group swarm; false if a 1:1 DM (NEW invite / keypair reply). */
	isGroupMessage: boolean;
	timestamp: number;
	publicKey?: string;
	name?: string;
	encryptionKeyPair?: { publicKey: Uint8Array; privateKey: Uint8Array };
	members: string[];
	admins: string[];
	wrappers: Array<{ publicKey: string; encryptedKeyPair: Uint8Array }>;
	expirationTimer?: number;
}

/** Payload of the client's `message` event for a group chat message (group variant). */
export interface GroupMessageEvent {
	type: "group";
	/** Group public key (05…hex). */
	groupId: string;
	/** Author (05…hex). */
	from: string;
	id: string;
	text?: string;
	timestamp: number;
}

/** A closed group carried in a legacy multi-device config sync. */
export interface GroupConfigEvent {
	publicKey: string;
	name: string;
	encryptionKeyPair: { publicKey: Uint8Array; privateKey: Uint8Array };
	members: string[];
	admins: string[];
}

/** A group encryption x25519 keypair, unprefixed 32-byte hex. */
export interface GroupEncryptionKeypair {
	publicKey: string;
	privateKey: string;
}

/** Persisted closed-group state (JSON-serialized under the group's storage key). */
export interface GroupState {
	/** Group address (05…hex). */
	publicKey: string;
	name: string;
	/** Current members (05…hex). */
	members: string[];
	/** Admins (05…hex). */
	admins: string[];
	/** Members who left but were not removed by an admin (pruned on re-add). */
	zombies: string[];
	/** False once we have left or been removed (stops polling, keeps history). */
	active: boolean;
	/** Envelope timestamp of the NEW/invite that formed/joined us (watermark). */
	lastJoinedTimestamp: number;
	/** When we first formed/joined (Android gates updates on ≥ this). */
	formationTimestamp: number;
	/** Disappearing-message timer in seconds (deleteAfterSend); 0 = off. */
	expirationTimer: number;
}

/** GroupManager options. */
export interface GroupManagerOptions {
	/** Injectable clock (default Date.now) — used for watermarks/cadence. */
	now?: () => number;
	/** Logger; nothing sensitive (keys) is ever passed to it. */
	logger?: GroupLogger;
	/**
	 * Inbound NEW-invite gate (spec §2.2): accept an invite only from ourselves
	 * or an approved sender. Default: accept from anyone (`() => true`) — a
	 * programmatic agent opts into its own approval policy.
	 */
	isSenderApproved?: (from: string) => boolean;
}

/** Logger signature shared across the package. */
export type GroupLogger = (level: string, msg: string, meta?: unknown) => void;

/** Events emitted by GroupManager. */
export interface GroupManagerEventMap {
	/** We created a group (NEW sent to all members incl. self). */
	groupCreated: GroupState;
	/** We joined a group via an inbound NEW invite. */
	groupJoined: GroupState;
	/** A group's state changed (name/members/keys/leave/remove). */
	groupChanged: GroupState;
	/** A group was disbanded/removed for us. */
	groupRemoved: { publicKey: string };
	/** A decrypted group chat message. */
	groupMessage: GroupMessageEvent;
	/** Undecryptable control/chat messages were retried after a new keypair. */
	error: { groupPubKey?: string; error: Error };
}

// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Offline in-process signaling bus for @session.js/groups (the calls package's
// SignalingBus/BusSession pattern). Operates at the MAPPED-EVENT level: a send
// produces the same mapped GroupUpdateEvent / GroupMessageEvent a real client's
// poller would emit, and the bus relays it to member endpoints like a swarm
// poll would deliver it. This exercises lifecycle/routing/gates deterministically
// without a network; the real seal/unseal path is covered at the core (G2) and
// in the gated networked E2E (P8).
import { bytesToHex } from "@noble/ciphers/utils.js";
import type {
	GroupSessionLike,
	GroupUpdateEvent,
	GroupMessageEvent,
	GroupConfigEvent,
	GroupPollerHandle,
	OutgoingControlMessage,
} from "../../src/types";

/** Let queued microtask deliveries run (mimics a poll round-trip). */
export function tick(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

type Listeners = {
	groupUpdate: Set<(u: GroupUpdateEvent) => void>;
	message: Set<(m: GroupMessageEvent) => void>;
	syncClosedGroups: Set<(g: GroupConfigEvent[]) => void>;
};

/** Map an outgoing control message to the mapped event a receiver's poller emits. */
function controlToEvent(
	cm: OutgoingControlMessage,
	from: string,
	groupId: string,
	isGroupMessage: boolean,
	timestamp: number,
): GroupUpdateEvent {
	return {
		type: cm.type,
		groupId,
		from,
		isGroupMessage,
		timestamp,
		...(cm.publicKey?.length && { publicKey: bytesToHex(cm.publicKey) }),
		...(cm.name !== undefined && { name: cm.name }),
		...(cm.encryptionKeyPair && {
			encryptionKeyPair: {
				publicKey: cm.encryptionKeyPair.publicKey,
				privateKey: cm.encryptionKeyPair.privateKey,
			},
		}),
		members: (cm.members ?? []).map((m) => bytesToHex(m)),
		admins: (cm.admins ?? []).map((a) => bytesToHex(a)),
		wrappers: (cm.wrappers ?? []).map((w) => ({
			publicKey: bytesToHex(w.publicKey),
			encryptedKeyPair: w.encryptedKeyPair,
		})),
		...(cm.expirationTimer !== undefined && { expirationTimer: cm.expirationTimer }),
	};
}

export class GroupBus {
	readonly endpoints: BusGroupSession[] = [];
	/** Spy: every relayed group update (DM or group-swarm). */
	readonly wire: Array<{ from: string; to: string; isGroup: boolean; type: number }> = [];
	#clock = 1_751_000_000_000;

	now(): number {
		return this.#clock;
	}
	advance(ms: number): void {
		this.#clock += ms;
	}

	attach(ep: BusGroupSession): void {
		this.endpoints.push(ep);
	}

	/** Deliver a mapped event to every endpoint registered under `id` (multi-device). */
	deliverTo(id: string, fire: (ep: BusGroupSession) => void): void {
		for (const ep of this.endpoints.filter((e) => e.id === id)) {
			queueMicrotask(() => fire(ep));
		}
	}

	/** Deliver to every endpoint except the sender (group-swarm semantics). */
	broadcastExcept(senderId: string, fire: (ep: BusGroupSession) => void): void {
		for (const ep of this.endpoints.filter((e) => e.id !== senderId)) {
			queueMicrotask(() => fire(ep));
		}
	}
}

export class BusGroupSession implements GroupSessionLike {
	readonly listeners: Listeners = {
		groupUpdate: new Set(),
		message: new Set(),
		syncClosedGroups: new Set(),
	};
	readonly sentUpdates: Array<Parameters<GroupSessionLike["sendClosedGroupUpdate"]>[0]> = [];
	readonly sentMessages: Array<Parameters<GroupSessionLike["sendGroupMessage"]>[0]> = [];
	readonly addedPollers: string[] = [];
	removedPollers = 0;

	constructor(
		readonly id: string,
		readonly bus: GroupBus,
	) {
		bus.attach(this);
	}

	getSessionID(): string {
		return this.id;
	}
	getNowWithNetworkOffset(): number {
		return this.bus.now();
	}

	on(event: string, cb: (payload: never) => void): void {
		(this.listeners as Record<string, Set<unknown>>)[event]?.add(cb);
	}
	off(event: string, cb: (payload: never) => void): void {
		(this.listeners as Record<string, Set<unknown>>)[event]?.delete(cb);
	}

	async sendClosedGroupUpdate(
		opts: Parameters<GroupSessionLike["sendClosedGroupUpdate"]>[0],
	): Promise<{ messageHash: string; timestamp: number }> {
		this.sentUpdates.push(opts);
		const timestamp = opts.timestamp ?? this.bus.now();
		const isGroup = opts.encryptionPublicKey !== undefined;
		this.bus.wire.push({ from: this.id, to: opts.to, isGroup, type: opts.controlMessage.type });
		if (isGroup) {
			// Group swarm: every member polls it; the sender's own copy is dropped.
			const event = controlToEvent(opts.controlMessage, this.id, opts.to, true, timestamp);
			this.bus.broadcastExcept(this.id, (ep) => ep.fireGroupUpdate(event));
		} else {
			// 1:1 DM to a member (NEW invite / keypair reply).
			const groupId = opts.controlMessage.publicKey
				? bytesToHex(opts.controlMessage.publicKey)
				: opts.to;
			const event = controlToEvent(opts.controlMessage, this.id, groupId, false, timestamp);
			this.bus.deliverTo(opts.to, (ep) => ep.fireGroupUpdate(event));
		}
		return { messageHash: "bus-u" + this.sentUpdates.length, timestamp };
	}

	async sendGroupMessage(
		opts: Parameters<GroupSessionLike["sendGroupMessage"]>[0],
	): Promise<{ messageHash: string; timestamp: number }> {
		this.sentMessages.push(opts);
		const timestamp = opts.timestamp ?? this.bus.now();
		const event: GroupMessageEvent = {
			type: "group",
			groupId: opts.to,
			from: this.id,
			id: "bus-m" + this.sentMessages.length,
			text: opts.text,
			timestamp,
		};
		this.bus.broadcastExcept(this.id, (ep) => ep.fireMessage(event));
		return { messageHash: "bus-m" + this.sentMessages.length, timestamp };
	}

	addGroupPoller(opts: { groupPubKey: string }): GroupPollerHandle {
		this.addedPollers.push(opts.groupPubKey);
		return { groupPubKey: opts.groupPubKey };
	}
	removeGroupPoller(_handle: GroupPollerHandle): void {
		this.removedPollers += 1;
	}

	// -- test drivers --------------------------------------------------------
	fireGroupUpdate(update: GroupUpdateEvent): void {
		for (const cb of [...this.listeners.groupUpdate]) cb(update);
	}
	fireMessage(message: GroupMessageEvent): void {
		for (const cb of [...this.listeners.message]) cb(message);
	}
	fireSyncClosedGroups(groups: GroupConfigEvent[]): void {
		for (const cb of [...this.listeners.syncClosedGroups]) cb(groups);
	}
}

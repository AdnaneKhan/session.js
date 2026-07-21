// SPDX-License-Identifier: AGPL-3.0-or-later
// Test fakes for @session.js/groups (offline, no network).
import type {
	GroupSessionLike,
	GroupUpdateEvent,
	GroupMessageEvent,
	GroupConfigEvent,
	GroupPollerHandle,
} from "../../src/types";

export const OWN_ID = "05" + "ee".repeat(32);
export const GROUP_A = "05" + "11".repeat(32);
export const MEMBER_A = "05" + "aa".repeat(32);
export const MEMBER_B = "05" + "bb".repeat(32);

type ListenerSets = {
	groupUpdate: Set<(u: GroupUpdateEvent) => void>;
	message: Set<(m: GroupMessageEvent) => void>;
	syncClosedGroups: Set<(g: GroupConfigEvent[]) => void>;
};

/** A recording GroupSessionLike with test drivers to fire inbound events. */
export class FakeGroupSession implements GroupSessionLike {
	readonly listeners: ListenerSets = {
		groupUpdate: new Set(),
		message: new Set(),
		syncClosedGroups: new Set(),
	};
	readonly sentUpdates: Array<Parameters<GroupSessionLike["sendClosedGroupUpdate"]>[0]> = [];
	readonly sentMessages: Array<Parameters<GroupSessionLike["sendGroupMessage"]>[0]> = [];
	readonly addedPollers: Array<{ groupPubKey: string }> = [];
	removedPollers = 0;
	#nowValue = 1_751_000_000_000;

	getSessionID(): string {
		return OWN_ID;
	}
	getNowWithNetworkOffset(): number {
		return this.#nowValue;
	}
	setNow(value: number): void {
		this.#nowValue = value;
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
		return { messageHash: "u" + this.sentUpdates.length, timestamp: opts.timestamp ?? this.#nowValue };
	}
	async sendGroupMessage(
		opts: Parameters<GroupSessionLike["sendGroupMessage"]>[0],
	): Promise<{ messageHash: string; timestamp: number }> {
		this.sentMessages.push(opts);
		return { messageHash: "m" + this.sentMessages.length, timestamp: opts.timestamp ?? this.#nowValue };
	}

	addGroupPoller(opts: { groupPubKey: string }): GroupPollerHandle {
		const handle = { groupPubKey: opts.groupPubKey };
		this.addedPollers.push(handle);
		return handle;
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

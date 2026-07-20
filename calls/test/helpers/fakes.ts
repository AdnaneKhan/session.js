// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared offline fakes for CallManager-level tests (P4-T3/T4, P5-T3, P6-T1/T2).
// Written fresh. Everything is synchronous and clock-injectable so tests are
// deterministic and fast.

import type { CallTimers } from "../../src/supervisor.js";
import type { BatcherTimerHooks } from "../../src/policy.js";
import type {
	CallMessageEvent,
	CallMessageTypeValue,
	IceServer,
	MediaEngine,
	MediaSession,
	SessionLike,
	SignalingSender,
} from "../../src/types.js";

export const PEER = `05${"a".repeat(64)}`;
export const PEER_A = `05${"1".repeat(64)}`;
export const PEER_B = `05${"2".repeat(64)}`;
export const OWN_ID = `05${"0".repeat(64)}`;

export const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
export const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// FakeSession — records EVERY action in order; fans events to listeners
// ---------------------------------------------------------------------------

export interface SentCallMessage {
	to: string;
	msg: {
		type: CallMessageTypeValue;
		uuid: string;
		sdps?: string[];
		sdpMLineIndexes?: number[];
		sdpMids?: string[];
	};
	isSync: boolean;
}

export class FakeSession implements SessionLike {
	readonly ownId: string;
	callListeners = new Set<(msg: CallMessageEvent) => void>();
	/** Ordered record of everything the session was asked to do. */
	actions: string[] = [];
	sent: SentCallMessage[] = [];
	approvedRequests: { from: string }[] = [];
	pollIntervals: number[] = [];
	/** Optional failure injection: return an Error to reject sendCallMessage. */
	sendFailure: (() => Error | undefined) | undefined;
	nowValue = 1_700_000_000_000;

	constructor(ownId: string = OWN_ID) {
		this.ownId = ownId;
	}

	getSessionID(): string {
		return this.ownId;
	}
	getNowWithNetworkOffset(): number {
		return this.nowValue;
	}
	on(_event: "call", cb: (msg: CallMessageEvent) => void): void {
		this.callListeners.add(cb);
	}
	off(_event: "call", cb: (msg: CallMessageEvent) => void): void {
		this.callListeners.delete(cb);
	}
	async sendCallMessage(
		to: string,
		msg: SentCallMessage["msg"],
		options?: { isSyncMessage?: boolean },
	): Promise<{ messageHash: string; timestamp: number }> {
		this.actions.push(
			`send:${options?.isSyncMessage ? "self" : "peer"}:${typeName(msg.type)}`,
		);
		const fail = this.sendFailure?.();
		if (fail) {
			return Promise.reject(fail);
		}
		this.sent.push({ to, msg, isSync: options?.isSyncMessage ?? false });
		return { messageHash: "fake-hash", timestamp: this.nowValue };
	}
	setPollInterval(interval: number): void {
		this.actions.push(`poll:${interval}`);
		this.pollIntervals.push(interval);
	}
	async acceptConversationRequest(opts: { from: string }): Promise<unknown> {
		this.actions.push(`approve:${opts.from}`);
		this.approvedRequests.push(opts);
		return {};
	}

	// --- test drivers ------------------------------------------------------

	fireCall(msg: CallMessageEvent): void {
		for (const cb of [...this.callListeners]) cb(msg);
	}

	/** Build an event stamped with the fake clock. */
	event(
		partial: Partial<CallMessageEvent> & Pick<CallMessageEvent, "uuid" | "type" | "from">,
	): CallMessageEvent {
		return {
			timestamp: this.nowValue,
			sdps: [],
			sdpMLineIndexes: [],
			sdpMids: [],
			...partial,
		};
	}

	sentTypes(kind: "peer" | "self"): CallMessageTypeValue[] {
		return this.sent
			.filter((s) => (kind === "self" ? s.isSync : !s.isSync))
			.map((s) => s.msg.type);
	}
	sentToPeer(): SentCallMessage[] {
		return this.sent.filter((s) => !s.isSync);
	}
}

function typeName(t: CallMessageTypeValue): string {
	return { 1: "OFFER", 2: "ANSWER", 3: "PROVISIONAL", 4: "ICE", 5: "END", 6: "PRE_OFFER" }[
		t
	] ?? String(t);
}

// ---------------------------------------------------------------------------
// FakeSignaling — plain recorder implementing SignalingSender
// ---------------------------------------------------------------------------

export class FakeSignaling implements SignalingSender {
	calls: { kind: "peer" | "self"; peer?: string; msg: { type: CallMessageTypeValue; uuid: string } }[] =
		[];
	/** Optional rejection injection. */
	fail: (() => Error | undefined) | undefined;

	async sendToPeer(peer: string, msg: { type: CallMessageTypeValue; uuid: string }): Promise<void> {
		const f = this.fail?.();
		if (f) throw f;
		this.calls.push({ kind: "peer", peer, msg });
	}
	async sendToSelf(msg: { type: CallMessageTypeValue; uuid: string }): Promise<void> {
		const f = this.fail?.();
		if (f) throw f;
		this.calls.push({ kind: "self", msg });
	}
}

// ---------------------------------------------------------------------------
// FakeMediaSession / FakeMedia — observable MediaEngine stand-ins
// ---------------------------------------------------------------------------

export type MediaState = "connecting" | "connected" | "disconnected" | "failed";
export interface CandidateInfo {
	candidate: string;
	sdpMLineIndex: number;
	sdpMid: string;
}

export class FakeMediaSession implements MediaSession {
	methodCalls: string[] = [];
	offerPrefix: string;
	answer = "v=0\r\no=- fake-answer 2 IN IP4 127.0.0.1\r\n";
	remoteOffer: string | undefined;
	remoteAnswer: string | undefined;
	remoteCandidates: CandidateInfo[] = [];
	dcSent: { hangup?: boolean; video?: boolean }[] = [];
	writtenAudio: Int16Array[] = [];
	closed = false;
	offerCounter = 0;
	/** Inject a createOffer failure (rejection). */
	offerFailure: (() => Error | undefined) | undefined;

	#candidateCbs: Array<(c: CandidateInfo) => void> = [];
	#stateCbs: Array<(s: MediaState) => void> = [];
	#dcMessageCbs: Array<(msg: { hangup?: boolean; hang_up?: boolean; video?: boolean }) => void> =
		[];
	#audioCbs: Array<(pcm: Int16Array) => void> = [];
	#videoToggleCbs: Array<(enabled: boolean) => void> = [];

	constructor(offerPrefix = "v=0\r\no=- fake-offer 2 IN IP4 127.0.0.1\r\n") {
		this.offerPrefix = offerPrefix;
	}

	async createOffer(opts?: { iceRestart?: boolean }): Promise<string> {
		const f = this.offerFailure?.();
		if (f) throw f;
		this.methodCalls.push(opts?.iceRestart ? "createOffer:iceRestart" : "createOffer");
		this.offerCounter += 1;
		return `${this.offerPrefix}o-session=${this.offerCounter}\r\n`;
	}
	async setRemoteOffer(offer: string): Promise<void> {
		this.methodCalls.push("setRemoteOffer");
		this.remoteOffer = offer;
	}
	async createAnswer(): Promise<string> {
		this.methodCalls.push("createAnswer");
		return this.answer;
	}
	async setRemoteAnswer(answer: string): Promise<void> {
		this.methodCalls.push("setRemoteAnswer");
		this.remoteAnswer = answer;
	}
	async addRemoteCandidate(c: CandidateInfo): Promise<void> {
		this.methodCalls.push("addRemoteCandidate");
		this.remoteCandidates.push(c);
	}
	onLocalCandidate(cb: (c: CandidateInfo) => void): void {
		this.#candidateCbs.push(cb);
	}
	onConnectionState(cb: (s: MediaState) => void): void {
		this.#stateCbs.push(cb);
	}
	onDataChannelMessage(
		cb: (msg: { hangup?: boolean; hang_up?: boolean; video?: boolean }) => void,
	): void {
		this.#dcMessageCbs.push(cb);
	}
	sendDataChannelMessage(msg: { hangup?: boolean; video?: boolean }): void {
		this.methodCalls.push("sendDataChannelMessage");
		this.dcSent.push(msg);
	}
	onAudio(cb: (pcm: Int16Array) => void): void {
		this.#audioCbs.push(cb);
	}
	writeAudio(pcm: Int16Array): boolean {
		this.methodCalls.push("writeAudio");
		this.writtenAudio.push(pcm);
		return true;
	}
	onRemoteVideoToggle(cb: (enabled: boolean) => void): void {
		this.#videoToggleCbs.push(cb);
	}
	close(): void {
		this.closed = true;
		this.methodCalls.push("close");
	}

	// --- test drivers --------------------------------------------------------

	fireLocalCandidate(c: CandidateInfo): void {
		for (const cb of [...this.#candidateCbs]) cb(c);
	}
	fireConnectionState(s: MediaState): void {
		for (const cb of [...this.#stateCbs]) cb(s);
	}
	fireDataChannelMessage(m: { hangup?: boolean; hang_up?: boolean; video?: boolean }): void {
		for (const cb of [...this.#dcMessageCbs]) cb(m);
	}
	fireAudio(pcm: Int16Array): void {
		for (const cb of [...this.#audioCbs]) cb(pcm);
	}
	fireVideoToggle(enabled: boolean): void {
		for (const cb of [...this.#videoToggleCbs]) cb(enabled);
	}
}

export class FakeMedia implements MediaEngine {
	sessions: FakeMediaSession[] = [];
	created: {
		uuid: string;
		role: "caller" | "callee";
		opts: { iceServers: IceServer[]; iceTransportPolicy: "all" | "relay" };
	}[] = [];
	/** Inject a synchronous createSession failure (P6-T3 containment test). */
	createFailure: (() => Error | undefined) | undefined;

	get last(): FakeMediaSession {
		const s = this.sessions[this.sessions.length - 1];
		if (!s) throw new Error("no media session created yet");
		return s;
	}

	createSession(
		uuid: string,
		role: "caller" | "callee",
		opts: { iceServers: IceServer[]; iceTransportPolicy: "all" | "relay" },
	): MediaSession {
		const f = this.createFailure?.();
		if (f) throw f;
		const s = new FakeMediaSession();
		this.sessions.push(s);
		this.created.push({ uuid, role, opts });
		return s;
	}
}

// ---------------------------------------------------------------------------
// FakeTimers — manually-advanced scheduler for ICE-restart / timeout tests
// ---------------------------------------------------------------------------

interface Task {
	cb: () => void;
	at: number;
}

export class FakeTimers {
	now = 0;
	#tasks = new Map<number, Task>();
	#nextId = 1;

	/** CallTimers-shaped API for the CallSupervisor / CallManagerDeps. */
	readonly api: CallTimers = {
		setTimeout: (cb, ms) => {
			const id = this.#nextId++;
			this.#tasks.set(id, { cb, at: this.now + ms });
			return id;
		},
		clearTimeout: (handle) => {
			this.#tasks.delete(handle as number);
		},
	};

	/** BatcherTimerHooks-shaped API for the TrickleIceSender. */
	readonly batcherHooks: BatcherTimerHooks = {
		setTimer: (cb, ms) => this.api.setTimeout(cb, ms),
		clearTimer: (handle) => this.api.clearTimeout(handle),
	};

	get pendingCount(): number {
		return this.#tasks.size;
	}

	/**
	 * Advance the clock, firing due tasks in time order (tasks scheduled by
	 * tasks fire in the same advance if their deadline is within ms).
	 */
	advance(ms: number): void {
		const target = this.now + ms;
		for (;;) {
			let nextId: number | undefined;
			let nextTask: Task | undefined;
			for (const [id, task] of this.#tasks) {
				if (task.at <= target && (nextTask === undefined || task.at < nextTask.at)) {
					nextId = id;
					nextTask = task;
				}
			}
			if (nextTask === undefined || nextId === undefined) {
				break;
			}
			this.#tasks.delete(nextId);
			this.now = nextTask.at;
			nextTask.cb();
		}
		this.now = target;
	}
}

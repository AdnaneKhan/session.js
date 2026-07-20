// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Timers, freshness, self-send, ICE-batching and TURN policies for
// @session.js/calls (plan §3.1/§3.2/§3.4, P2-T2). Written fresh from the
// verified protocol facts — no lines copied from GPL/AGPL sources.
// All functions are pure / dependency-free (timers are injectable) so they
// are trivially testable with fake clocks.

import type { CallMessageTypeValue, IceServer } from "./types.js";
import { CallMessageType } from "./types.js";

// ---------------------------------------------------------------------------
// Constants (plan §3.1, §3.2, §3.4, Appendix B)
// ---------------------------------------------------------------------------

/** Swarm TTL for call messages — all three official clients agree (§3.1). */
export const CALL_MESSAGE_TTL_MS = 300_000;

/** 15-minute absolute staleness drop on ANY inbound call message
 *  (Android `VERY_EXPIRED_TIME`, §3.2). Takes precedence over all windows. */
export const VERY_EXPIRED_MS = 15 * 60 * 1000;

/** PRE_OFFER older than this is stale → missed call (Android/iOS, §3.1). */
export const PRE_OFFER_FRESH_MS = 60_000;

/** Ring/setup timeout from PRE_OFFER send (§3.2). */
export const DEFAULT_CALL_TIMEOUT_MS = 60_000;

/** Trickle-ICE debounce window (§3.2/§4.6). */
export const DEFAULT_ICE_BATCH_MS = 200;

/** Poller interval while a call is setting up/active (§4.6). */
export const DEFAULT_BOOSTED_POLL_MS = 500;

/** ICE restart cadence while disconnected (Android: every 5 s, §3.2). */
export const ICE_RESTART_INTERVAL_MS = 5_000;

/** Max ICE restart attempts before giving up (Android, §3.2). */
export const ICE_RESTART_MAX_ATTEMPTS = 5;

// ---------------------------------------------------------------------------
// Freshness (§3.1)
// ---------------------------------------------------------------------------

/**
 * Inbound-message freshness gate.
 *
 * - PRE_OFFER: age ≤ 60 s (PRE_OFFER_FRESH_MS).
 * - other kinds: age ≤ TTL (CALL_MESSAGE_TTL_MS).
 * - ALL kinds: age ≤ 15 min absolute (VERY_EXPIRED_MS) — the very-expired
 *   drop takes precedence over everything.
 *
 * Boundary rule: exactly-at is fresh (`≤`).
 *
 * Clock skew: future timestamps (negative age) count as fresh — the age is
 * clamped to 0 before comparison. Official clients send fresh wall-clock
 * timestamps; small receiver-clock skew must not drop live calls. Documented
 * per task spec.
 */
export function isFresh(
	kind: "pre-offer" | "other",
	sentAtMs: number,
	nowMs: number,
): boolean {
	const age = Math.max(0, nowMs - sentAtMs);
	if (age > VERY_EXPIRED_MS) {
		return false;
	}
	const limit = kind === "pre-offer" ? PRE_OFFER_FRESH_MS : CALL_MESSAGE_TTL_MS;
	return age <= limit;
}

// ---------------------------------------------------------------------------
// Self-send rules (§3.1)
// ---------------------------------------------------------------------------

/**
 * Whether an inbound call message that came FROM OURSELVES (own-swarm sync
 * copy) must be dropped. Only ANSWER and END_CALL are valid self-sends
 * (linked-device race resolution, §4.5); self-sent PRE_OFFER / OFFER /
 * ICE_CANDIDATES / PROVISIONAL_ANSWER are dropped on receipt.
 */
export function shouldDropSelfMessage(type: CallMessageTypeValue): boolean {
	switch (type) {
		case CallMessageType.ANSWER:
		case CallMessageType.END_CALL:
			return false;
		case CallMessageType.PRE_OFFER:
		case CallMessageType.OFFER:
		case CallMessageType.ICE_CANDIDATES:
		case CallMessageType.PROVISIONAL_ANSWER:
			return true;
	}
}

// ---------------------------------------------------------------------------
// Trickle-ICE batching (§3.2/§4.6 — 200 ms debounce, parallel arrays)
// ---------------------------------------------------------------------------

export interface IceCandidate {
	candidate: string;
	sdpMLineIndex: number;
	sdpMid: string;
}

export interface IceCandidateBatch {
	sdps: string[];
	sdpMLineIndexes: number[];
	sdpMids: string[];
}

export interface BatcherTimerHooks {
	/** Injectable timer (default setTimeout). Returns an opaque handle. */
	setTimer?: (cb: () => void, ms: number) => unknown;
	/** Injectable cancel (default clearTimeout). */
	clearTimer?: (handle: unknown) => void;
}

/**
 * Per-call trickle-ICE debounce queue. enqueue() (re)arms a quiet-period
 * timer; when no candidate has arrived for `windowMs` the batch is emitted
 * as parallel arrays matching the ICE_CANDIDATES wire shape.
 */
export class IceCandidateBatcher {
	readonly windowMs: number;
	#queue: IceCandidate[] = [];
	#timer: unknown = undefined;
	#disposed = false;
	#onFlush: (batch: IceCandidateBatch) => void;
	#setTimer: (cb: () => void, ms: number) => unknown;
	#clearTimer: (handle: unknown) => void;

	constructor(
		onFlush: (batch: IceCandidateBatch) => void,
		opts?: { windowMs?: number } & BatcherTimerHooks,
	) {
		this.#onFlush = onFlush;
		this.windowMs = opts?.windowMs ?? DEFAULT_ICE_BATCH_MS;
		this.#setTimer = opts?.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
		this.#clearTimer = opts?.clearTimer ?? ((handle) => clearTimeout(handle as never));
	}

	/** Number of candidates currently buffered. */
	get pending(): number {
		return this.#queue.length;
	}

	/** Buffer a candidate and (re)arm the quiet-period flush timer. */
	enqueue(c: IceCandidate): void {
		if (this.#disposed) {
			return;
		}
		this.#queue.push(c);
		if (this.#timer !== undefined) {
			this.#clearTimer(this.#timer);
		}
		this.#timer = this.#setTimer(() => {
			this.#timer = undefined;
			this.#flush();
		}, this.windowMs);
	}

	/** Flush immediately (e.g. before sending the END_CALL). No-op if empty. */
	flushNow(): void {
		if (this.#timer !== undefined) {
			this.#clearTimer(this.#timer);
			this.#timer = undefined;
		}
		this.#flush();
	}

	/** Stop batching; drops any pending candidates (teardown path). */
	dispose(): void {
		this.#disposed = true;
		if (this.#timer !== undefined) {
			this.#clearTimer(this.#timer);
			this.#timer = undefined;
		}
		this.#queue = [];
	}

	#flush(): void {
		if (this.#queue.length === 0) {
			return;
		}
		const batch: IceCandidateBatch = {
			sdps: this.#queue.map((c) => c.candidate),
			sdpMLineIndexes: this.#queue.map((c) => c.sdpMLineIndex),
			sdpMids: this.#queue.map((c) => c.sdpMid),
		};
		this.#queue = [];
		this.#onFlush(batch);
	}
}

// ---------------------------------------------------------------------------
// TURN servers (Appendix B — public constants shipped in EVERY official
// Session client; these are not secrets. Heavy automated use should
// self-host a coturn with the same static credentials — plan §3.4 ethics.)
// ---------------------------------------------------------------------------

export const SESSION_TURN_SERVERS = [
	"turn:freyr.getsession.org",
	"turn:angus.getsession.org",
	"turn:hereford.getsession.org",
	"turn:holstein.getsession.org",
	"turn:brahman.getsession.org",
] as const;

export const SESSION_TURN_CREDENTIALS = {
	username: "session202111",
	password: "053c268164bc7bd7",
} as const;

/**
 * Pick the ICE servers for a call: Fisher-Yates shuffle of the 5 official
 * TURN hosts, take 2 (Android parity), each with the static credentials.
 * @param rng injectable random source (default Math.random) for tests.
 */
export function pickTurnServers(rng: () => number = Math.random): IceServer[] {
	const hosts: string[] = [...SESSION_TURN_SERVERS];
	for (let i = hosts.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1)) % (i + 1);
		const tmp = hosts[i] as string;
		hosts[i] = hosts[j] as string;
		hosts[j] = tmp;
	}
	return hosts.slice(0, 2).map((url) => ({
		urls: url,
		username: SESSION_TURN_CREDENTIALS.username,
		credential: SESSION_TURN_CREDENTIALS.password,
	}));
}

/** Default ICE config: the shuffle-take-2 TURN selection. */
export function defaultIceServers(): IceServer[] {
	return pickTurnServers();
}

// ---------------------------------------------------------------------------
// Log redaction (preview of P5-T3 — never log TURN creds / DTLS fingerprints)
// ---------------------------------------------------------------------------

const TURN_USER_RE = new RegExp(SESSION_TURN_CREDENTIALS.username, "g");
const TURN_PASS_RE = new RegExp(SESSION_TURN_CREDENTIALS.password, "g");

/**
 * Mask anything sensitive before it hits logs:
 * - the TURN username and password, wherever they appear;
 * - DTLS fingerprint SDP lines (`a=fingerprint:...` → `a=fingerprint:[REDACTED]`).
 */
export function redactSensitive(text: string): string {
	return text
		.replace(TURN_USER_RE, "[REDACTED-TURN-USER]")
		.replace(TURN_PASS_RE, "[REDACTED-TURN-PASS]")
		.replace(/^a=fingerprint:.*$/gm, "a=fingerprint:[REDACTED]");
}

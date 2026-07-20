// SPDX-License-Identifier: AGPL-3.0-or-later
//
// CallImpl — the public Call handle (plan §4.3, P4-T3).
// Call sequencing and edge-case behavior adapted from session-desktop
// `ts/session/utils/calling/CallManager.ts` (AGPLv3), © Session Foundation,
// modified (structural dependency interfaces; werift media plane; headless
// single-device operation). Licensed under AGPL-3.0-or-later.
//
// CallImpl wraps a supervisor CallContext: it is the consumer-facing object
// emitted on CallManager "incoming"/"outgoing" and resolved from call().
// Responsibilities beyond plain delegation:
//  - direction guards: accept()/reject()/ignore() are inbound-only; misuse
//    rejects/throws typed InvalidCallMessageError (never an FSM-level error);
//  - containment (P6-T3): every consumer-supplied callback (onAudio,
//    onRemoteVideoToggle, event listeners) is wrapped so a throwing consumer
//    can NEVER escape into the media/signaling plane — it is escalated to
//    the manager's fatal sink instead (error event + call ends "error");
//  - writeAudio failures are contained and reported as backpressure `false`.
//
// "audio-level" event: registered but NEVER emitted in v1 — werift does not
// cheaply expose RTP audio levels (the ssrc-audio-level extmap is munged OUT
// of our local SDPs for Android parity). Documented; we do not fabricate.

import { InvalidCallMessageError } from "./errors.js";
import type { CallContext } from "./supervisor.js";
import type {
	Call,
	CallDirection,
	CallEventMap,
	CallInfo,
	CallState,
} from "./types.js";

/** Escalation sink for contained consumer/media errors (wired by CallManager). */
export type FatalErrorSink = (err: unknown) => void;

/** Channel tag: a CallEventMap key, or "audio"/"video-toggle" for the
 *  callback-style subscriptions (which have no off() in the Call surface). */
type Registration = { event: string; cb: unknown; wrapped: unknown };

export class CallImpl implements Call {
	readonly #ctx: CallContext;
	readonly #fatal: FatalErrorSink;
	/** user-cb → wrapped-cb registrations, so off() can unsubscribe. */
	readonly #registrations: Registration[] = [];

	constructor(ctx: CallContext, onFatal: FatalErrorSink) {
		this.#ctx = ctx;
		this.#fatal = onFatal;
	}

	// --- Introspection (Call + conveniences) -------------------------------

	/** Live call info — mutated by the supervisor on every transition. */
	get info(): CallInfo {
		return this.#ctx.info;
	}
	get uuid(): string {
		return this.#ctx.uuid;
	}
	get peer(): string {
		return this.#ctx.peer;
	}
	get direction(): CallDirection {
		return this.#ctx.direction;
	}
	get state(): CallState {
		return this.#ctx.state;
	}

	// --- Actions (Call) ------------------------------------------------------

	/** Inbound only. Misuse rejects with InvalidCallMessageError. */
	accept(): Promise<void> {
		if (this.#ctx.direction !== "inbound") {
			return Promise.reject(
				new InvalidCallMessageError(
					"accept() is only valid on inbound calls",
					this.#ctx.uuid,
				),
			);
		}
		return this.#ctx.accept();
	}

	/** Inbound only; sends END_CALL (peer + self). */
	reject(): Promise<void> {
		if (this.#ctx.direction !== "inbound") {
			return Promise.reject(
				new InvalidCallMessageError(
					"reject() is only valid on inbound calls",
					this.#ctx.uuid,
				),
			);
		}
		return this.#ctx.reject();
	}

	/** Inbound only; local only, NO wire message (missed recorded). */
	ignore(): void {
		if (this.#ctx.direction !== "inbound") {
			throw new InvalidCallMessageError(
				"ignore() is only valid on inbound calls",
				this.#ctx.uuid,
			);
		}
		this.#ctx.ignore();
	}

	/** Hangup: datachannel hint best-effort + END_CALL peer+self. */
	hangup(): Promise<void> {
		return this.#ctx.hangup();
	}

	// --- Audio (Call) ----------------------------------------------------------

	/**
	 * Incoming decoded audio: 48 kHz mono 16-bit, 20 ms frames (960 samples).
	 * Consumer exceptions are contained and escalated (never thrown into the
	 * media receive path).
	 */
	onAudio(cb: (pcm: Int16Array) => void): void {
		const wrapped = this.#wrap(cb);
		this.#registrations.push({ event: "audio", cb, wrapped });
		this.#ctx.onAudio(wrapped);
	}

	/**
	 * Queue an outbound PCM frame. Backpressure: false if the bridge queue is
	 * full (or no media session yet). A throwing media layer is contained:
	 * the error is escalated and `false` is returned.
	 */
	writeAudio(pcm: Int16Array): boolean {
		try {
			return this.#ctx.writeAudio(pcm);
		} catch (err) {
			this.#fatal(err);
			return false;
		}
	}

	/** Remote video toggle (v1: informational only). */
	onRemoteVideoToggle(cb: (enabled: boolean) => void): void {
		const wrapped = this.#wrap(cb);
		this.#registrations.push({ event: "video-toggle", cb, wrapped });
		this.#ctx.onRemoteVideoToggle(wrapped);
	}

	// --- Events (Call) -----------------------------------------------------------

	/**
	 * Subscribe to "state" | "ended" | "signaling" | "audio-level".
	 * "audio-level" never fires in v1 (see file header — not fabricated).
	 */
	on<E extends keyof CallEventMap>(event: E, cb: (payload: CallEventMap[E]) => void): void {
		const wrapped = this.#wrap(cb);
		this.#registrations.push({ event, cb, wrapped });
		this.#ctx.on(event, wrapped);
	}

	off<E extends keyof CallEventMap>(event: E, cb: (payload: CallEventMap[E]) => void): void {
		for (let i = this.#registrations.length - 1; i >= 0; i--) {
			const reg = this.#registrations[i] as Registration;
			if (reg.event === event && reg.cb === cb) {
				this.#ctx.off(event, reg.wrapped as (payload: CallEventMap[E]) => void);
				this.#registrations.splice(i, 1);
				return;
			}
		}
	}

	// --- internals ---------------------------------------------------------------

	#wrap<A extends unknown[]>(cb: (...args: A) => unknown): (...args: A) => void {
		return (...args: A): void => {
			try {
				void cb(...args);
			} catch (err) {
				// P6-T3 containment: consumer callback errors must never escape
				// into media/signaling internals — escalate to the CallManager
				// (error event + the call ends with reason "error").
				this.#fatal(err);
			}
		};
	}
}

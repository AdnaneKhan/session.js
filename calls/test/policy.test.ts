// SPDX-License-Identifier: AGPL-3.0-or-later
// P2-T2 verification: freshness windows, self-send matrix, ICE batching
// (injected fake timers — deterministic), TURN selection, redaction.

import { describe, expect, test } from "bun:test";
import {
	BatcherTimerHooks,
	CALL_MESSAGE_TTL_MS,
	DEFAULT_BOOSTED_POLL_MS,
	DEFAULT_CALL_TIMEOUT_MS,
	DEFAULT_ICE_BATCH_MS,
	ICE_RESTART_INTERVAL_MS,
	ICE_RESTART_MAX_ATTEMPTS,
	IceCandidateBatch,
	IceCandidateBatcher,
	PRE_OFFER_FRESH_MS,
	SESSION_TURN_CREDENTIALS,
	SESSION_TURN_SERVERS,
	VERY_EXPIRED_MS,
	defaultIceServers,
	isFresh,
	pickTurnServers,
	redactSensitive,
	shouldDropSelfMessage,
} from "../src/policy.js";
import { CallMessageType } from "../src/types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("constants (plan §3.1/§3.2/§3.4/Appendix B)", () => {
	test("timing constants are exact", () => {
		expect(CALL_MESSAGE_TTL_MS).toBe(300_000);
		expect(VERY_EXPIRED_MS).toBe(900_000);
		expect(PRE_OFFER_FRESH_MS).toBe(60_000);
		expect(DEFAULT_CALL_TIMEOUT_MS).toBe(60_000);
		expect(DEFAULT_ICE_BATCH_MS).toBe(200);
		expect(DEFAULT_BOOSTED_POLL_MS).toBe(500);
		expect(ICE_RESTART_INTERVAL_MS).toBe(5_000);
		expect(ICE_RESTART_MAX_ATTEMPTS).toBe(5);
	});
	test("TURN hosts are the Appendix B five, exact order", () => {
		expect([...SESSION_TURN_SERVERS]).toEqual([
			"turn:freyr.getsession.org",
			"turn:angus.getsession.org",
			"turn:hereford.getsession.org",
			"turn:holstein.getsession.org",
			"turn:brahman.getsession.org",
		]);
	});
	test("TURN static credentials are the public official values", () => {
		// Public constants shipped in every official Session client.
		expect(SESSION_TURN_CREDENTIALS.username).toBe("session202111");
		expect(SESSION_TURN_CREDENTIALS.password).toBe("053c268164bc7bd7");
	});
});

// ---------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------

describe("isFresh", () => {
	const NOW = 1_700_000_000_000;

	test("PRE_OFFER: exactly 60s is fresh, +1ms is stale", () => {
		expect(isFresh("pre-offer", NOW - PRE_OFFER_FRESH_MS, NOW)).toBe(true);
		expect(isFresh("pre-offer", NOW - PRE_OFFER_FRESH_MS - 1, NOW)).toBe(false);
	});
	test("other kinds: exactly TTL is fresh, +1ms is stale", () => {
		expect(isFresh("other", NOW - CALL_MESSAGE_TTL_MS, NOW)).toBe(true);
		expect(isFresh("other", NOW - CALL_MESSAGE_TTL_MS - 1, NOW)).toBe(false);
	});
	test("15-minute absolute drop applies to EVERY kind (Android VERY_EXPIRED_TIME)", () => {
		// The absolute window is a backstop: the kind-specific windows (60 s /
		// 300 s) are stricter, so anything past TTL is stale anyway — and
		// anything past 15 min is stale for all kinds, unconditionally.
		expect(isFresh("other", NOW - VERY_EXPIRED_MS - 1, NOW)).toBe(false);
		expect(isFresh("pre-offer", NOW - VERY_EXPIRED_MS - 1, NOW)).toBe(false);
		expect(isFresh("other", NOW - VERY_EXPIRED_MS, NOW)).toBe(false); // past TTL too
		expect(isFresh("pre-offer", NOW - VERY_EXPIRED_MS, NOW)).toBe(false);
	});
	test("future timestamps (negative age) are fresh — age clamps to 0", () => {
		expect(isFresh("pre-offer", NOW + 30_000, NOW)).toBe(true);
		expect(isFresh("other", NOW + 10_000, NOW)).toBe(true);
		// But even a "future" message cannot outrun the absolute window logic:
		// clamped age 0 ≤ every limit.
		expect(isFresh("other", NOW + VERY_EXPIRED_MS + 1, NOW)).toBe(true);
	});
	test("age 0 is fresh", () => {
		expect(isFresh("pre-offer", NOW, NOW)).toBe(true);
		expect(isFresh("other", NOW, NOW)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Self-send matrix
// ---------------------------------------------------------------------------

describe("shouldDropSelfMessage (§3.1 self-send rules)", () => {
	test("all six wire types", () => {
		expect(shouldDropSelfMessage(CallMessageType.PRE_OFFER)).toBe(true);
		expect(shouldDropSelfMessage(CallMessageType.OFFER)).toBe(true);
		expect(shouldDropSelfMessage(CallMessageType.PROVISIONAL_ANSWER)).toBe(true);
		expect(shouldDropSelfMessage(CallMessageType.ICE_CANDIDATES)).toBe(true);
		expect(shouldDropSelfMessage(CallMessageType.ANSWER)).toBe(false);
		expect(shouldDropSelfMessage(CallMessageType.END_CALL)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// ICE batcher (deterministic fake timers)
// ---------------------------------------------------------------------------

class FakeClock implements BatcherTimerHooks {
	now = 0;
	#timers = new Map<number, { cb: () => void; fireAt: number }>();
	#nextId = 1;
	setCount = 0;
	clearCount = 0;

	setTimer = (cb: () => void, ms: number): unknown => {
		this.setCount += 1;
		const id = this.#nextId++;
		this.#timers.set(id, { cb, fireAt: this.now + ms });
		return id;
	};

	clearTimer = (handle: unknown): void => {
		this.clearCount += 1;
		this.#timers.delete(handle as number);
	};

	/** Advance the clock, firing due timers in order (timers may re-arm). */
	advance(ms: number): void {
		this.now += ms;
		for (;;) {
			const due = [...this.#timers.entries()]
				.filter(([, t]) => t.fireAt <= this.now)
				.sort((a, b) => a[1].fireAt - b[1].fireAt);
			const first = due[0];
			if (!first) break;
			this.#timers.delete(first[0]);
			first[1].cb();
		}
	}

	get activeTimers(): number {
		return this.#timers.size;
	}
}

describe("IceCandidateBatcher", () => {
	const c1 = { candidate: "candidate:1 1 udp 2130706431 10.0.0.1 50000 typ host", sdpMLineIndex: 0, sdpMid: "0" };
	const c2 = { candidate: "candidate:2 1 udp 1694498815 1.2.3.4 50000 typ srflx", sdpMLineIndex: 0, sdpMid: "0" };
	const c3 = { candidate: "candidate:3 1 udp 100 5.6.7.8 3478 typ relay", sdpMLineIndex: 1, sdpMid: "1" };

	test("debounce: flushes after windowMs of quiet, re-armed by new candidates", () => {
		const clock = new FakeClock();
		const flushes: IceCandidateBatch[] = [];
		const b = new IceCandidateBatcher((batch) => flushes.push(batch), {
			windowMs: 200,
			setTimer: clock.setTimer,
			clearTimer: clock.clearTimer,
		});

		b.enqueue(c1);
		clock.advance(199); // 1ms short of the window
		expect(flushes.length).toBe(0);

		b.enqueue(c2); // re-arms at t=199 -> fires at 399
		clock.advance(199); // t=398
		expect(flushes.length).toBe(0);
		clock.advance(1); // t=399
		expect(flushes.length).toBe(1);
		expect(flushes[0]).toEqual({
			sdps: [c1.candidate, c2.candidate],
			sdpMLineIndexes: [0, 0],
			sdpMids: ["0", "0"],
		});
		expect(clock.activeTimers).toBe(0);
	});

	test("coalescing: many candidates within the window -> ONE flush, order preserved", () => {
		const clock = new FakeClock();
		const flushes: IceCandidateBatch[] = [];
		const b = new IceCandidateBatcher((batch) => flushes.push(batch), {
			setTimer: clock.setTimer,
			clearTimer: clock.clearTimer,
		});
		b.enqueue(c1);
		clock.advance(50);
		b.enqueue(c2);
		clock.advance(50);
		b.enqueue(c3);
		clock.advance(200);
		expect(flushes.length).toBe(1);
		expect(flushes[0]).toEqual({
			sdps: [c1.candidate, c2.candidate, c3.candidate],
			sdpMLineIndexes: [0, 0, 1],
			sdpMids: ["0", "0", "1"],
		});
	});

	test("default window is 200ms", () => {
		const b = new IceCandidateBatcher(() => undefined);
		expect(b.windowMs).toBe(DEFAULT_ICE_BATCH_MS);
	});

	test("flushNow emits immediately and cancels the pending timer", () => {
		const clock = new FakeClock();
		const flushes: IceCandidateBatch[] = [];
		const b = new IceCandidateBatcher((batch) => flushes.push(batch), {
			setTimer: clock.setTimer,
			clearTimer: clock.clearTimer,
		});
		b.enqueue(c1);
		b.enqueue(c2);
		b.flushNow();
		expect(flushes.length).toBe(1);
		expect(flushes[0]?.sdps).toEqual([c1.candidate, c2.candidate]);
		expect(clock.activeTimers).toBe(0);
		// Advancing past the window must not produce a second flush.
		clock.advance(1000);
		expect(flushes.length).toBe(1);
	});

	test("flushNow on empty queue is a no-op", () => {
		const flushes: IceCandidateBatch[] = [];
		const b = new IceCandidateBatcher((batch) => flushes.push(batch));
		b.flushNow();
		expect(flushes.length).toBe(0);
	});

	test("pending getter tracks the buffer", () => {
		const clock = new FakeClock();
		const b = new IceCandidateBatcher(() => undefined, {
			setTimer: clock.setTimer,
			clearTimer: clock.clearTimer,
		});
		expect(b.pending).toBe(0);
		b.enqueue(c1);
		b.enqueue(c2);
		expect(b.pending).toBe(2);
		clock.advance(200);
		expect(b.pending).toBe(0);
	});

	test("dispose drops pending candidates and ignores further enqueues", () => {
		const clock = new FakeClock();
		const flushes: IceCandidateBatch[] = [];
		const b = new IceCandidateBatcher((batch) => flushes.push(batch), {
			setTimer: clock.setTimer,
			clearTimer: clock.clearTimer,
		});
		b.enqueue(c1);
		b.dispose();
		expect(b.pending).toBe(0);
		clock.advance(1000);
		expect(flushes.length).toBe(0);
		b.enqueue(c2); // ignored post-dispose
		expect(b.pending).toBe(0);
		clock.advance(1000);
		expect(flushes.length).toBe(0);
	});

	test("second batch after a quiet flush works (re-usable)", () => {
		const clock = new FakeClock();
		const flushes: IceCandidateBatch[] = [];
		const b = new IceCandidateBatcher((batch) => flushes.push(batch), {
			setTimer: clock.setTimer,
			clearTimer: clock.clearTimer,
		});
		b.enqueue(c1);
		clock.advance(200);
		b.enqueue(c3);
		clock.advance(200);
		expect(flushes.length).toBe(2);
		expect(flushes[1]?.sdps).toEqual([c3.candidate]);
	});
});

// ---------------------------------------------------------------------------
// TURN selection
// ---------------------------------------------------------------------------

describe("pickTurnServers (shuffle-take-2, Android parity)", () => {
	test("returns 2 distinct servers from the official set, with credentials", () => {
		const picked = pickTurnServers();
		expect(picked.length).toBe(2);
		const urls = picked.map((s) => s.urls);
		expect(new Set(urls).size).toBe(2);
		for (const s of picked) {
			expect(SESSION_TURN_SERVERS).toContain(s.urls);
			expect(s.username).toBe(SESSION_TURN_CREDENTIALS.username);
			expect(s.credential).toBe(SESSION_TURN_CREDENTIALS.password);
		}
	});
	test("seeded rng (0) -> deterministic [angus, hereford]", () => {
		const picked = pickTurnServers(() => 0);
		expect(picked.map((s) => s.urls)).toEqual([
			"turn:angus.getsession.org",
			"turn:hereford.getsession.org",
		]);
	});
	test("seeded rng (~1) -> deterministic [freyr, angus] (identity shuffle)", () => {
		const picked = pickTurnServers(() => 0.9999999);
		expect(picked.map((s) => s.urls)).toEqual([
			"turn:freyr.getsession.org",
			"turn:angus.getsession.org",
		]);
	});
	test("defaultIceServers == pickTurnServers()", () => {
		expect(defaultIceServers().length).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// Redaction (P5-T3 preview)
// ---------------------------------------------------------------------------

describe("redactSensitive", () => {
	test("masks TURN username and password wherever they appear", () => {
		const line = `ice config user=session202111 pass=053c268164bc7bd7`;
		const out = redactSensitive(line);
		expect(out).not.toContain("session202111");
		expect(out).not.toContain("053c268164bc7bd7");
		expect(out).toContain("[REDACTED-TURN-USER]");
		expect(out).toContain("[REDACTED-TURN-PASS]");
	});
	test("masks DTLS fingerprint SDP lines", () => {
		const sdp = [
			"v=0",
			"a=fingerprint:sha-256 1A:2B:3C:4D:5E:6F:70:81:92:A3:B4:C5:D6:E7:F8:09:1A:2B:3C:4D:5E:6F:70:81:92:A3:B4:C5:D6:E7:F8:09",
			"m=audio 9 UDP/TLS/RTP/SAVPF 111",
			"a=fingerprint:sha-1 AA:BB:CC",
		].join("\r\n");
		const out = redactSensitive(sdp);
		expect(out).not.toContain("1A:2B:3C");
		expect(out).not.toContain("AA:BB:CC");
		expect(out.match(/a=fingerprint:\[REDACTED\]/g)?.length).toBe(2);
		// Non-fingerprint lines survive.
		expect(out).toContain("m=audio 9 UDP/TLS/RTP/SAVPF 111");
		expect(out).toContain("v=0");
	});
	test("leaves clean text untouched", () => {
		const clean = "call started uuid=1234 state=connecting";
		expect(redactSensitive(clean)).toBe(clean);
	});
});

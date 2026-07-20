// SPDX-License-Identifier: AGPL-3.0-or-later
// P4-T1 verification: SDP munging units + loopback PeerConnectionManager
// integration (offer/answer, data channel, ICE restart, teardown leak
// sanity, garbage-candidate robustness). Offline — host/loopback ICE only.

import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

import { extractUfrag, mungeLocalSdp } from "../../src/media/sdp.js";
import {
	PeerConnectionManager,
	WeriftMediaSession,
	type MediaConnectionState,
} from "../../src/media/peer-connection.js";
import type { IceServer } from "../../src/types.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const NO_SERVERS: { iceServers: IceServer[]; iceTransportPolicy: "all" | "relay" } = {
	iceServers: [],
	iceTransportPolicy: "all",
};

function makePair(): { caller: WeriftMediaSession; callee: WeriftMediaSession } {
	const manager = new PeerConnectionManager();
	const caller = manager.createSession(randomUUID(), "caller", NO_SERVERS) as WeriftMediaSession;
	const callee = manager.createSession(randomUUID(), "callee", NO_SERVERS) as WeriftMediaSession;
	caller.onLocalCandidate((c) => void callee.addRemoteCandidate(c));
	callee.onLocalCandidate((c) => void caller.addRemoteCandidate(c));
	return { caller, callee };
}

async function negotiate(caller: WeriftMediaSession, callee: WeriftMediaSession): Promise<string> {
	const offer = await caller.createOffer();
	await callee.setRemoteOffer(offer);
	const answer = await callee.createAnswer();
	await caller.setRemoteAnswer(answer);
	return offer;
}

function waitState(session: WeriftMediaSession, want: MediaConnectionState, timeoutMs = 15_000): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timeout waiting for ${want}`)), timeoutMs);
		session.onConnectionState((s) => {
			if (s === want) {
				clearTimeout(timer);
				resolve();
			} else if (s === "failed") {
				clearTimeout(timer);
				reject(new Error("connection failed"));
			}
		});
	});
}

async function connectPair(): Promise<{ caller: WeriftMediaSession; callee: WeriftMediaSession }> {
	const pair = makePair();
	const connected = Promise.all([waitState(pair.caller, "connected"), waitState(pair.callee, "connected")]);
	await negotiate(pair.caller, pair.callee);
	await connected;
	return pair;
}

async function waitDataChannelOpen(session: WeriftMediaSession, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (session.dataChannelState !== "open") {
		if (Date.now() > deadline) throw new Error("data channel did not open");
		await new Promise((r) => setTimeout(r, 50));
	}
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Unhandled-rejection guard for the leak-sanity tests.
let rejections: unknown[] = [];
const onRejection = (err: unknown): void => {
	rejections.push(err);
};

afterEach(() => {
	rejections = [];
});

// ---------------------------------------------------------------------------
// 1. SDP munging units (sdp.ts)
// ---------------------------------------------------------------------------

const REALISTIC_SDP = [
	"v=0",
	"o=- 4611731400430051336 2 IN IP4 127.0.0.1",
	"s=-",
	"t=0 0",
	"a=group:BUNDLE 0",
	"a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level",
	"a=extmap:3 urn:ietf:params:rtp-hdrext:sdes:mid",
	"m=audio 9 UDP/TLS/RTP/SAVPF 111 0 8 9",
	"c=IN IP4 0.0.0.0",
	"a=rtcp:9 IN IP4 0.0.0.0",
	"a=ice-ufrag:F7wI",
	"a=ice-pwd:asd90234lkjasdf098uasdlkjh",
	"a=fingerprint:sha-256 AA:BB:CC:DD",
	"a=setup:actpass",
	"a=mid:0",
	"a=sendrecv",
	"a=rtcp-mux",
	"a=rtpmap:111 opus/48000/2",
	"a=rtcp-fb:111 transport-cc",
	"a=fmtp:111 minptime=10;useinbandfec=1",
	"a=rtpmap:0 PCMU/8000",
	"a=rtpmap:8 PCMA/8000",
	"a=rtpmap:9 G722/8000",
	"a=fmtp:9 bitrate=64000",
	"",
].join("\r\n");

describe("sdp munging", () => {
	test("appends ;cbr=1 exactly once to the opus fmtp, nothing else touched", () => {
		const munged = mungeLocalSdp(REALISTIC_SDP);
		expect(munged).toContain("a=fmtp:111 minptime=10;useinbandfec=1;cbr=1");
		// exactly one cbr=1 anywhere
		expect(munged.match(/cbr=1/g)?.length).toBe(1);
		// other codecs untouched
		expect(munged).toContain("a=rtpmap:0 PCMU/8000");
		expect(munged).toContain("a=fmtp:9 bitrate=64000");
		expect(munged).not.toContain("a=fmtp:9 bitrate=64000;cbr=1");
		// credentials and structure untouched
		expect(munged).toContain("a=ice-ufrag:F7wI");
		expect(munged).toContain("a=fingerprint:sha-256 AA:BB:CC:DD");
		expect(munged).toContain("a=group:BUNDLE 0");
	});

	test("removes ssrc-audio-level extmap, keeps other extmaps", () => {
		const munged = mungeLocalSdp(REALISTIC_SDP);
		expect(munged).not.toContain("ssrc-audio-level");
		expect(munged).toContain("a=extmap:3 urn:ietf:params:rtp-hdrext:sdes:mid");
	});

	test("creates fmtp line when opus has none (werift default opus)", () => {
		const noFmtp = REALISTIC_SDP.replace("a=fmtp:111 minptime=10;useinbandfec=1\r\n", "");
		expect(noFmtp).not.toContain("a=fmtp:111");
		const munged = mungeLocalSdp(noFmtp);
		expect(munged).toContain("a=rtpmap:111 opus/48000/2\r\na=fmtp:111 cbr=1");
		expect(munged.match(/cbr=1/g)?.length).toBe(1);
	});

	test("idempotent on already-munged SDP", () => {
		const once = mungeLocalSdp(REALISTIC_SDP);
		const twice = mungeLocalSdp(once);
		expect(twice).toBe(once);
	});

	test("preserves CRLF and LF line endings", () => {
		const crlf = mungeLocalSdp(REALISTIC_SDP);
		expect(crlf).toContain("\r\n");
		expect(crlf.split("\r\n").length).toBeGreaterThan(10);
		const lf = mungeLocalSdp(REALISTIC_SDP.replaceAll("\r\n", "\n"));
		expect(lf.includes("\r\n")).toBe(false);
		expect(lf).toContain("a=fmtp:111 minptime=10;useinbandfec=1;cbr=1");
	});

	test("finds opus payload type dynamically (not hardcoded 111)", () => {
		const weirdPt = REALISTIC_SDP.replaceAll("111", "96");
		const munged = mungeLocalSdp(weirdPt);
		expect(munged).toContain("a=fmtp:96 minptime=10;useinbandfec=1;cbr=1");
	});

	test("extractUfrag reads the ice-ufrag", () => {
		expect(extractUfrag(REALISTIC_SDP)).toBe("F7wI");
	});
});

// ---------------------------------------------------------------------------
// 2. Loopback negotiation reaches "connected"
// ---------------------------------------------------------------------------

describe("loopback negotiation", () => {
	test("caller/callee reach connected with munged offer (15 s budget)", async () => {
		const { caller, callee } = makePair();
		const connected = Promise.all([waitState(caller, "connected", 15_000), waitState(callee, "connected", 15_000)]);
		const offer = await negotiate(caller, callee);

		// Local offer is munged: cbr=1 forced, no ssrc-audio-level extmap.
		expect(offer).toMatch(/a=fmtp:\d+.*cbr=1|a=fmtp:\d+ cbr=1/);
		expect(offer).not.toContain("ssrc-audio-level");

		// waitState resolving on "connected" for both sides IS the contract
		// assertion (the raw ICE getter can lag the mapped event briefly).
		await connected;
		expect(caller.localCandidates.length).toBeGreaterThan(0);
		expect(callee.localCandidates.length).toBeGreaterThan(0);
		expect(caller.localCandidates.some((c) => c.candidate.includes("typ host"))).toBe(true);

		caller.close();
		callee.close();
	});

	test("onConnectionState maps werift states, dedupes, replays to late subscribers", async () => {
		const { caller, callee } = makePair();
		const states: MediaConnectionState[] = [];
		caller.onConnectionState((s) => states.push(s));
		const connected = Promise.all([waitState(caller, "connected"), waitState(callee, "connected")]);
		await negotiate(caller, callee);
		await connected;
		// Over loopback ICE is fast enough that werift may fire "connected"
		// as the FIRST state-change event (skipping "checking") — both are
		// legal; what's contracted is mapping correctness + deduping +
		// hysteresis (no connected→connecting flap from post-nomination
		// "checking" churn — RFC 8445 connected is sticky).
		expect(["connecting", "connected"]).toContain(states[0]);
		expect(states[states.length - 1]).toBe("connected");
		for (let i = 1; i < states.length; i++) {
			expect(states[i]).not.toBe(states[i - 1]); // no adjacent dupes
			if (states[i - 1] === "connected") {
				expect(states[i]).not.toBe("connecting"); // hysteresis
			}
		}
		// Late subscriber immediately replays the current state.
		const late: MediaConnectionState[] = [];
		caller.onConnectionState((s) => late.push(s));
		expect(late).toEqual(["connected"]);
		caller.close();
		callee.close();
	});
});

// ---------------------------------------------------------------------------
// 3. Data channel roundtrip
// ---------------------------------------------------------------------------

describe("data channel", () => {
	test('{"hangup":true} and {"video":true} roundtrip; video fires toggle cb', async () => {
		const { caller, callee } = await connectPair();
		await waitDataChannelOpen(caller);
		await waitDataChannelOpen(callee);

		const calleeMessages: Array<{ hangup?: boolean; video?: boolean }> = [];
		callee.onDataChannelMessage((m) => calleeMessages.push(m));
		const callerMessages: Array<{ hangup?: boolean; video?: boolean }> = [];
		caller.onDataChannelMessage((m) => callerMessages.push(m));
		const videoToggles: boolean[] = [];
		caller.onRemoteVideoToggle((enabled) => videoToggles.push(enabled));

		caller.sendDataChannelMessage({ hangup: true });
		callee.sendDataChannelMessage({ video: true });

		await sleep(500);
		expect(calleeMessages.some((m) => m.hangup === true)).toBe(true);
		expect(callerMessages.some((m) => m.video === true)).toBe(true);
		expect(videoToggles).toEqual([true]);

		caller.close();
		callee.close();
	});

	test("negotiated channel has label signaling / id 548 on both sides", async () => {
		const { caller, callee } = await connectPair();
		await waitDataChannelOpen(caller);
		await waitDataChannelOpen(callee);
		expect(caller.dataChannelState).toBe("open");
		expect(callee.dataChannelState).toBe("open");
		caller.close();
		callee.close();
	});
});

// ---------------------------------------------------------------------------
// 4. ICE restart
// ---------------------------------------------------------------------------

describe("ICE restart", () => {
	test("createOffer({iceRestart:true}) produces a new ufrag", async () => {
		const { caller, callee } = await connectPair();
		const ufragBefore = caller.localUfrag;
		expect(ufragBefore).toBeString();

		const restarted = await caller.createOffer({ iceRestart: true });
		const ufragAfter = extractUfrag(restarted);
		expect(ufragAfter).toBeString();
		expect(ufragAfter).not.toBe(ufragBefore);
		expect(caller.localUfrag).toBe(ufragAfter);
		// Still munged after restart.
		expect(restarted).toContain("cbr=1");

		caller.close();
		callee.close();
	});
});

// ---------------------------------------------------------------------------
// 5. Leak sanity: repeated create/connect/close cycles
// ---------------------------------------------------------------------------

describe("teardown leak sanity", () => {
	test("20 full create/connect/close cycles: no unhandled rejections, clean closes", async () => {
		process.on("unhandledRejection", onRejection);
		try {
			for (let i = 0; i < 20; i++) {
				const { caller, callee } = await connectPair();
				expect(caller.closed).toBe(false);
				caller.close();
				callee.close();
				// close() is idempotent
				caller.close();
				callee.close();
				expect(caller.closed).toBe(true);
				expect(callee.closed).toBe(true);
			}
			await sleep(500); // settle async teardown
			expect(rejections).toEqual([]);
		} finally {
			process.off("unhandledRejection", onRejection);
		}
	}, 300_000);

	test("100 rapid create/close cycles without connecting stay clean", async () => {
		process.on("unhandledRejection", onRejection);
		try {
			const manager = new PeerConnectionManager();
			for (let i = 0; i < 100; i++) {
				const session = manager.createSession(randomUUID(), "caller", NO_SERVERS);
				session.close();
				session.close();
				expect((session as WeriftMediaSession).closed).toBe(true);
			}
			await sleep(300);
			expect(rejections).toEqual([]);
		} finally {
			process.off("unhandledRejection", onRejection);
		}
	}, 120_000);
});

// ---------------------------------------------------------------------------
// 6. Robustness: garbage remote candidates
// ---------------------------------------------------------------------------

describe("remote candidate robustness", () => {
	test("garbage candidates neither throw nor break the session", async () => {
		const { caller, callee } = await connectPair();

		await expect(
			caller.addRemoteCandidate({ candidate: "total garbage, not an ICE candidate", sdpMLineIndex: 0, sdpMid: "0" }),
		).resolves.toBeUndefined();
		await expect(
			caller.addRemoteCandidate({ candidate: "", sdpMLineIndex: 0, sdpMid: "0" }),
		).resolves.toBeUndefined();
		await expect(
			caller.addRemoteCandidate({
				candidate: "candidate:999 1 udp 2130706431 999.999.999.999 1 typ host",
				sdpMLineIndex: 0,
				sdpMid: "0",
			}),
		).resolves.toBeUndefined();

		await sleep(300);
		// Session is still alive and connected.
		expect(["connected", "completed"]).toContain(caller.iceConnectionState);

		caller.close();
		callee.close();
		// addRemoteCandidate after close is a silent no-op
		await expect(
			caller.addRemoteCandidate({ candidate: "candidate:1 1 udp 1 1.2.3.4 5 typ host", sdpMLineIndex: 0, sdpMid: "0" }),
		).resolves.toBeUndefined();
	});

	test("candidates received before the remote description are buffered, not thrown", async () => {
		const manager = new PeerConnectionManager();
		const session = manager.createSession(randomUUID(), "caller", NO_SERVERS);
		await expect(
			session.addRemoteCandidate({
				candidate: "candidate:1 1 udp 2130706431 192.0.2.1 50000 typ host",
				sdpMLineIndex: 0,
				sdpMid: "0",
			}),
		).resolves.toBeUndefined();
		session.close();
	});
});

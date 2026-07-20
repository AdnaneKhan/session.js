// SPDX-License-Identifier: AGPL-3.0-or-later
// P5-T3 verification: structured diagnostics — FSM transition logs,
// signaling send/recv logs, end-of-call summary, and redaction (NEVER log
// TURN credentials, DTLS fingerprints, or SDP bodies).

import { afterEach, describe, expect, test } from "bun:test";

import { CallManager } from "../src/call-manager.js";
import type { CallSummary } from "../src/call-manager.js";
import type { Call, CallManagerOptions } from "../src/types.js";
import { CallMessageType } from "../src/types.js";
import { FakeMedia, FakeSession, FakeTimers, PEER, tick } from "./helpers/fakes.js";

interface LogLine {
	level: string;
	msg: string;
	meta?: unknown;
}

const SENSITIVE_STRINGS = [
	"session202111", // TURN username
	"053c268164bc7bd7", // TURN password
	"a=fingerprint", // DTLS fingerprint SDP line
	"v=0", // SDP body start (fake SDPs begin with this)
	"fake-offer",
	"fake-answer",
	"remote-answer-sdp",
];

interface Env {
	session: FakeSession;
	media: FakeMedia;
	timers: FakeTimers;
	manager: CallManager;
	logs: LogLine[];
	allLogText(): string;
}

const envs: Env[] = [];

function makeEnv(options?: Omit<CallManagerOptions, "logger">): Env {
	const session = new FakeSession();
	const media = new FakeMedia();
	const timers = new FakeTimers();
	Object.defineProperty(session, "nowValue", {
		get: () => timers.now,
		set: () => undefined,
		configurable: true,
	});
	const logs: LogLine[] = [];
	const manager = new CallManager(
		session,
		{
			...options,
			logger: (level, msg, meta) => {
				logs.push({ level, msg, meta });
			},
		},
		{
			media,
			timers: timers.api,
			now: () => timers.now,
			createUuid: () => "00000000-0000-4000-8000-0000000000dd",
		},
	);
	const env: Env = {
		session,
		media,
		timers,
		manager,
		logs,
		allLogText: () =>
			logs.map((l) => `${l.level} ${l.msg} ${JSON.stringify(l.meta)}`).join("\n"),
	};
	envs.push(env);
	return env;
}

afterEach(async () => {
	while (envs.length > 0) {
		await envs.pop()?.manager.dispose();
	}
});

describe("diagnostics over a full call lifecycle", () => {
	test("FSM transitions + signaling send/recv + end summary are logged; NOTHING sensitive leaks", async () => {
		const env = makeEnv();
		env.manager.approveContact(PEER);
		const outgoing: Call[] = [];
		env.manager.on("outgoing", (c) => outgoing.push(c));

		// Full outbound lifecycle: call → answer → connected → hangup.
		const callPromise = env.manager.call(PEER);
		const call = await callPromise;
		await tick();
		env.session.fireCall(
			env.session.event({
				uuid: call.uuid,
				type: CallMessageType.ANSWER,
				from: PEER,
				sdps: ["remote-answer-sdp"], // SDP must NEVER reach the logs
			}),
		);
		await tick();
		env.media.last.fireConnectionState("connected");
		env.timers.advance(2500);
		await call.hangup();
		await tick();

		const text = env.allLogText();

		// 1) Every FSM transition is logged (from → to + event).
		expect(text).toContain("fsm: idle --send-pre-offer--> local-pre-offer");
		expect(text).toContain("fsm: local-pre-offer --receive-answer--> connecting");
		expect(text).toContain("fsm: connecting --ice-connected--> connected");
		expect(text).toContain("fsm: connected --user-hangup--> disconnected");

		// 2) Every signaling send/receive is logged with direction/type/uuid.
		expect(text).toContain(`signaling send peer type=PRE_OFFER uuid=${call.uuid}`);
		expect(text).toContain(`type=OFFER uuid=${call.uuid}`);
		expect(text).toContain(`signaling recv type=ANSWER uuid=${call.uuid}`);
		expect(text).toContain(`type=END_CALL uuid=${call.uuid}`);

		// 3) End-of-call summary with all required fields.
		const summaryLine = env.logs.find((l) => l.msg.startsWith("call ended "));
		expect(summaryLine).toBeDefined();
		expect(summaryLine?.msg).toContain(`uuid=${call.uuid}`);
		expect(summaryLine?.msg).toContain("direction=outbound");
		expect(summaryLine?.msg).toContain("endReason=local-hangup");
		expect(summaryLine?.msg).toContain("durationMs=2500");
		expect(summaryLine?.msg).toContain("connectedMs=2500");
		expect(summaryLine?.msg).toContain("icePairType=unknown");
		expect(summaryLine?.msg).toContain("framesDelivered=0");
		expect(summaryLine?.msg).toContain("framesDropped=0");
		const summary = (summaryLine?.meta as { summary?: CallSummary })?.summary;
		expect(summary?.uuid).toBe(call.uuid);
		expect(summary?.peer).toBe(PEER);
		expect(summary?.endReason).toBe("local-hangup");
		expect(summary?.connectedMs).toBe(2500);

		// 4) REDACTION: no credential, fingerprint, or SDP body in ANY log.
		for (const s of SENSITIVE_STRINGS) {
			expect(text).not.toContain(s);
		}
	});

	test("redaction scrubs credentials and fingerprints even inside error meta", async () => {
		const env = makeEnv();
		env.manager.approveContact(PEER);
		// Force a signaling failure whose message embeds secrets — the logger
		// wrapper must scrub them.
		env.session.sendFailure = () =>
			new Error(
				"swarm rejected: user=session202111 pass=053c268164bc7bd7 sdp=a=fingerprint:sha-256 AA:BB:CC",
			);
		await env.manager.call(PEER);
		await tick();
		await tick();

		const text = env.allLogText();
		expect(text).toContain("[REDACTED-TURN-USER]");
		expect(text).toContain("[REDACTED-TURN-PASS]");
		expect(text).toContain("a=fingerprint:[REDACTED]");
		expect(text).not.toContain("session202111");
		expect(text).not.toContain("053c268164bc7bd7");
		expect(text).not.toContain("a=fingerprint:sha-256");
		// The failure still surfaced as an error-level log.
		expect(env.logs.some((l) => l.level === "error")).toBe(true);
	});

	test("no logger configured → zero overhead path does not throw", async () => {
		const session = new FakeSession();
		const media = new FakeMedia();
		const timers = new FakeTimers();
		const manager = new CallManager(session, undefined, {
			media,
			timers: timers.api,
			now: () => timers.now,
		});
		manager.approveContact(PEER);
		const call = await manager.call(PEER);
		await tick();
		await call.hangup();
		expect(call.info.endReason).toBe("local-hangup");
		await manager.dispose();
	});
});

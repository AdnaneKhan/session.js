// SPDX-License-Identifier: AGPL-3.0-or-later
//
// offline-echo.ts — full-stack demo WITHOUT any Session network: two
// CallManagers (A + B) over an in-process signaling bus, using the REAL
// werift PeerConnectionManager media plane (host/loopback ICE).
//
//   A calls B → B auto-accepts and wires the EchoStub→PassthroughTTS voice
//   pipeline → A sends 2 s of 440 Hz sine → B's echo returns the audio →
//   A verifies it received frames back. Proves the P5-T1 pipeline
//   round-trips real Opus audio end-to-end.
//
//   bun examples/offline-echo.ts

import {
	CallManager,
	FRAME_MS,
	sineFrame,
	type CallMessageEvent,
	type CallMessageTypeValue,
	type SessionLike,
} from "../src/index.js";
import { startVoiceAgent } from "./voice-agent.js";

const A_ID = `05${"a".repeat(64)}`;
const B_ID = `05${"b".repeat(64)}`;

/**
 * Minimal in-process SessionLike: sendCallMessage delivers straight into
 * the recipient's "call" listeners (or the sender's own, for self-sync) —
 * the swarm replaced by a function call.
 */
class BusSession implements SessionLike {
	readonly listeners = new Set<(msg: CallMessageEvent) => void>();
	#peers = new Map<string, BusSession>();

	constructor(readonly id: string) {}

	link(peer: BusSession): void {
		this.#peers.set(peer.id, peer);
	}

	getSessionID(): string {
		return this.id;
	}
	getNowWithNetworkOffset(): number {
		return Date.now();
	}
	on(_event: "call", cb: (msg: CallMessageEvent) => void): void {
		this.listeners.add(cb);
	}
	off(_event: "call", cb: (msg: CallMessageEvent) => void): void {
		this.listeners.delete(cb);
	}
	async sendCallMessage(
		to: string,
		msg: {
			type: CallMessageTypeValue;
			uuid: string;
			sdps?: string[];
			sdpMLineIndexes?: number[];
			sdpMids?: string[];
		},
		options?: { isSyncMessage?: boolean },
	): Promise<{ messageHash: string; timestamp: number }> {
		const target = options?.isSyncMessage || to === this.id ? this : this.#peers.get(to);
		const timestamp = Date.now();
		if (target) {
			// Deliver asynchronously like a poll would.
			queueMicrotask(() => {
				for (const cb of [...target.listeners]) {
					cb({
						uuid: msg.uuid,
						type: msg.type,
						from: this.id,
						timestamp,
						sdps: msg.sdps ?? [],
						sdpMLineIndexes: msg.sdpMLineIndexes ?? [],
						sdpMids: msg.sdpMids ?? [],
					});
				}
			});
		}
		return { messageHash: "bus", timestamp };
	}
	setPollInterval(_interval: number): void {
		// no poller in the bus
	}
	async acceptConversationRequest(_opts: { from: string }): Promise<unknown> {
		return {};
	}
}

async function main(): Promise<void> {
	const a = new BusSession(A_ID);
	const b = new BusSession(B_ID);
	a.link(b);
	b.link(a);

	const logA = (level: string, msg: string): void => console.log(`[A:${level}] ${msg}`);
	const logB = (level: string, msg: string): void => console.log(`[B:${level}] ${msg}`);

	const agentA = startVoiceAgent(a, { logger: logA, autoAccept: true });
	const agentB = startVoiceAgent(b, { logger: logB, autoAccept: true });

	// B: count the audio frames the echo pipeline receives (for reporting).
	let bReceived = 0;
	agentB.manager.on("incoming", (call) => {
		call.onAudio(() => {
			bReceived++;
		});
	});

	// A: call B, track the echo coming back. Both sides approve (contacts-only
	// gate is bilateral — B must approve A or B drops the PRE_OFFER).
	agentA.manager.approveContact(B_ID);
	agentB.manager.approveContact(A_ID);
	const call = await agentA.manager.call(B_ID);
	const echoed: Int16Array[] = [];
	call.onAudio((pcm) => echoed.push(pcm));
	call.on("state", (s) => logA("info", `state → ${s}`));

	const deadline = Date.now() + 15_000;
	while (call.info.state !== "connected" && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 50));
	}
	if (call.info.state !== "connected") {
		console.error(`offline-echo FAILED: never connected (state=${call.info.state})`);
		process.exitCode = 1;
		return;
	}
	console.log("offline-echo: connected — sending 2 s of 440 Hz sine");
	const frames = 2000 / FRAME_MS;
	for (let i = 0; i < frames; i++) {
		if (call.writeAudio(sineFrame(i))) {
			await new Promise((r) => setTimeout(r, FRAME_MS));
		} else {
			await new Promise((r) => setTimeout(r, FRAME_MS / 2));
			i--; // retry the frame under backpressure
		}
	}
	// Let the echo come back through B's pipeline.
	await new Promise((r) => setTimeout(r, 3000));

	console.log(`offline-echo: B received ${bReceived} frames, A got ${echoed.length} echo frames back`);
	const ok = bReceived >= 50 && echoed.length >= 20;
	console.log(ok ? "offline-echo: PASS (pipeline round-trips real Opus audio)" : "offline-echo: FAIL");

	await call.hangup().catch(() => undefined);
	await agentA.dispose();
	await agentB.dispose();
	// werift can leave internal timers on the event loop after close; this is
	// a demo script — exit explicitly with the verdict.
	process.exit(ok ? 0 : 1);
}

if (import.meta.main) {
	main().catch((err) => {
		console.error("offline-echo fatal:", err);
		process.exit(1);
	});
}

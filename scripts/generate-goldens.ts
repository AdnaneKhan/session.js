/**
 * scripts/generate-goldens.ts — canonical golden-fixture generator (plan Appendix D).
 *
 * Goldens regenerated ONLY via human-reviewed change (plan Appendix D).
 *
 * Builds each canonical CallMessage shape with the @session.js/types
 * signal-bindings (pbjs static bindings compiled from the vendored
 * signalservice.proto, which carries the full official CallMessage schema),
 * writes the hex of SignalService.Content.encode(...).finish() to
 * test/fixtures/wire/<name>.hex and prints a sha256 per file.
 *
 * Provenance: "computed" — derived from the published SessionProtos.proto
 * field facts; protobuf encoding is deterministic, so any compliant encoder
 * must produce byte-identical output. See test/fixtures/wire/README.md.
 *
 * Usage: bun scripts/generate-goldens.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { SignalService } from "@session.js/types/signal-bindings";

/** Canonical inputs (plan P0-T3). Do not change without human review. */
export const UUID = "11111111-1111-4111-8111-111111111111";
export const SDP_OFFER = "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n";
export const SDP_ANSWER = "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=recvonly\r\n";
export const CAND1 = "candidate:1 1 udp 2130706431 192.168.1.10 50000 typ host";
export const CAND2 =
	"candidate:2 1 udp 1694498815 203.0.113.7 50000 typ srflx raddr 192.168.1.10 rport 50000";

const fixtures: Record<string, SignalService.ICallMessage> = {
	"pre-offer": {
		type: SignalService.CallMessage.Type.PRE_OFFER,
		uuid: UUID,
	},
	offer: {
		type: SignalService.CallMessage.Type.OFFER,
		sdps: [SDP_OFFER],
		uuid: UUID,
	},
	answer: {
		type: SignalService.CallMessage.Type.ANSWER,
		sdps: [SDP_ANSWER],
		uuid: UUID,
	},
	"ice-candidates": {
		type: SignalService.CallMessage.Type.ICE_CANDIDATES,
		sdps: [CAND1, CAND2],
		sdpMLineIndexes: [0, 0],
		sdpMids: ["0", "0"],
		uuid: UUID,
	},
	"end-call": {
		type: SignalService.CallMessage.Type.END_CALL,
		uuid: UUID,
	},
};

/** Encode a fixture to the Content-wrapped hex string. */
export function encodeFixtureHex(callMessage: SignalService.ICallMessage): string {
	return Buffer.from(
		SignalService.Content.encode(new SignalService.Content({ callMessage })).finish(),
	).toString("hex");
}

if (import.meta.main) {
	const outDir = new URL("../test/fixtures/wire/", import.meta.url);
	mkdirSync(outDir, { recursive: true });

	for (const [name, callMessage] of Object.entries(fixtures)) {
		const hex = encodeFixtureHex(callMessage);
		const file = new URL(`${name}.hex`, outDir);
		writeFileSync(file, hex + "\n");
		const sha256 = createHash("sha256").update(hex + "\n").digest("hex");
		console.log(`${name}.hex  sha256=${sha256}`);
		console.log(`  hex=${hex}`);
	}
}

// Written fresh from the published SessionProtos.proto field facts. MIT-licensable for upstream contribution.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SignalService } from "@session.js/types/signal-bindings";
import { SessionValidationError } from "@session.js/errors";
import { CallMessage } from "@/messages/schema/call-message";
import { TTL_DEFAULT } from "@session.js/consts";

// Canonical inputs — see test/fixtures/wire/README.md and scripts/generate-goldens.ts
const UUID = "11111111-1111-4111-8111-111111111111";
const SDP_OFFER = "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n";
const SDP_ANSWER = "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=recvonly\r\n";
const CAND1 = "candidate:1 1 udp 2130706431 192.168.1.10 50000 typ host";
const CAND2 =
	"candidate:2 1 udp 1694498815 203.0.113.7 50000 typ srflx raddr 192.168.1.10 rport 50000";

function readFixture(name: string): string {
	return readFileSync(join(import.meta.dir, "..", "fixtures", "wire", `${name}.hex`), "utf-8").trim();
}

// CallMessage proto has NO timestamp field, so encoding is deterministic regardless of timestamp
const TIMESTAMP = 1751000000000;

const shapes: { name: string; build: () => CallMessage }[] = [
	{
		name: "pre-offer",
		build: () =>
			new CallMessage({
				timestamp: TIMESTAMP,
				type: SignalService.CallMessage.Type.PRE_OFFER,
				uuid: UUID,
			}),
	},
	{
		name: "offer",
		build: () =>
			new CallMessage({
				timestamp: TIMESTAMP,
				type: SignalService.CallMessage.Type.OFFER,
				sdps: [SDP_OFFER],
				uuid: UUID,
			}),
	},
	{
		name: "answer",
		build: () =>
			new CallMessage({
				timestamp: TIMESTAMP,
				type: SignalService.CallMessage.Type.ANSWER,
				sdps: [SDP_ANSWER],
				uuid: UUID,
			}),
	},
	{
		name: "ice-candidates",
		build: () =>
			new CallMessage({
				timestamp: TIMESTAMP,
				type: SignalService.CallMessage.Type.ICE_CANDIDATES,
				sdps: [CAND1, CAND2],
				sdpMLineIndexes: [0, 0],
				sdpMids: ["0", "0"],
				uuid: UUID,
			}),
	},
	{
		name: "end-call",
		build: () =>
			new CallMessage({
				timestamp: TIMESTAMP,
				type: SignalService.CallMessage.Type.END_CALL,
				uuid: UUID,
			}),
	},
];

for (const { name, build } of shapes) {
	test(`CallMessage encoding is byte-identical to golden ${name}.hex`, () => {
		const msg = build();
		const hex = Buffer.from(msg.plainTextBuffer()).toString("hex");
		expect(hex).toBe(readFixture(name));
	});
}

test("CallMessage ttl is TTL_DEFAULT.CALL_MESSAGE (5 minutes)", () => {
	const msg = shapes[0].build();
	expect(msg.ttl()).toBe(TTL_DEFAULT.CALL_MESSAGE);
	expect(msg.ttl()).toBe(300000);
});

test("CallMessage rejects invalid uuid", () => {
	expect(
		() =>
			new CallMessage({
				timestamp: TIMESTAMP,
				type: SignalService.CallMessage.Type.PRE_OFFER,
				uuid: "not-a-uuid",
			}),
	).toThrow(SessionValidationError);
	expect(
		() =>
			new CallMessage({
				timestamp: TIMESTAMP,
				type: SignalService.CallMessage.Type.PRE_OFFER,
				// valid shape but version nibble is 1, not 4
				uuid: "11111111-1111-1111-8111-111111111111",
			}),
	).toThrow(SessionValidationError);
});

test("CallMessage rejects mismatched ICE parallel arrays", () => {
	expect(
		() =>
			new CallMessage({
				timestamp: TIMESTAMP,
				type: SignalService.CallMessage.Type.ICE_CANDIDATES,
				sdps: [CAND1, CAND2],
				sdpMLineIndexes: [0],
				sdpMids: ["0", "0"],
				uuid: UUID,
			}),
	).toThrow(SessionValidationError);
	expect(
		() =>
			new CallMessage({
				timestamp: TIMESTAMP,
				type: SignalService.CallMessage.Type.ICE_CANDIDATES,
				sdps: [],
				sdpMLineIndexes: [],
				sdpMids: [],
				uuid: UUID,
			}),
	).toThrow(SessionValidationError);
});

test("CallMessage rejects OFFER/ANSWER without sdps", () => {
	expect(
		() =>
			new CallMessage({
				timestamp: TIMESTAMP,
				type: SignalService.CallMessage.Type.OFFER,
				uuid: UUID,
			}),
	).toThrow(SessionValidationError);
	expect(
		() =>
			new CallMessage({
				timestamp: TIMESTAMP,
				type: SignalService.CallMessage.Type.ANSWER,
				sdps: [],
				uuid: UUID,
			}),
	).toThrow(SessionValidationError);
});

// Written fresh from the published SessionProtos.proto field facts. MIT-licensable for upstream contribution.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SignalService } from "@session.js/types/signal-bindings";
import { mapCallMessage } from "@/messages";

const UUID = "11111111-1111-4111-8111-111111111111";
const SDP_OFFER = "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n";
const FROM = "05" + "ab".repeat(32);

function readFixture(name: string): string {
	return readFileSync(join(import.meta.dir, "fixtures", "wire", `${name}.hex`), "utf-8").trim();
}

test("mapCallMessage decodes golden OFFER fixture with full signaling fields", () => {
	const content = SignalService.Content.decode(Buffer.from(readFixture("offer"), "hex"));
	const mapped = mapCallMessage({
		hash: "abc",
		envelope: { source: FROM, timestamp: 1751000000000 } as any,
		content,
	});
	expect(mapped.uuid).toBe(UUID);
	expect(mapped.type).toBe(SignalService.CallMessage.Type.OFFER);
	expect(mapped.from).toBe(FROM);
	expect(mapped.timestamp).toBe(1751000000000);
	expect(mapped.sdps).toEqual([SDP_OFFER]);
	expect(mapped.sdps[0]).toBe(SDP_OFFER);
	expect(mapped.sdpMLineIndexes).toEqual([]);
	expect(mapped.sdpMids).toEqual([]);
});

test("mapCallMessage decodes golden PRE_OFFER fixture with empty arrays by default", () => {
	const content = SignalService.Content.decode(Buffer.from(readFixture("pre-offer"), "hex"));
	const mapped = mapCallMessage({
		hash: "abc",
		envelope: { source: FROM, timestamp: 1751000000000 } as any,
		content,
	});
	expect(mapped.uuid).toBe(UUID);
	expect(mapped.type).toBe(SignalService.CallMessage.Type.PRE_OFFER);
	expect(mapped.from).toBe(FROM);
	expect(mapped.timestamp).toBe(1751000000000);
	expect(mapped.sdps).toEqual([]);
	expect(mapped.sdpMLineIndexes).toEqual([]);
	expect(mapped.sdpMids).toEqual([]);
});

test("mapCallMessage converts Long envelope timestamps with toNumber", () => {
	const content = SignalService.Content.decode(Buffer.from(readFixture("pre-offer"), "hex"));
	const mapped = mapCallMessage({
		hash: "abc",
		envelope: { source: FROM, timestamp: { toNumber: () => 123 } } as any,
		content,
	});
	expect(mapped.timestamp).toBe(123);
});

test("mapCallMessage keeps parallel ICE arrays intact", () => {
	const content = SignalService.Content.decode(Buffer.from(readFixture("ice-candidates"), "hex"));
	const mapped = mapCallMessage({
		hash: "abc",
		envelope: { source: FROM, timestamp: 1751000000000 } as any,
		content,
	});
	expect(mapped.type).toBe(SignalService.CallMessage.Type.ICE_CANDIDATES);
	expect(mapped.sdps).toHaveLength(2);
	expect(mapped.sdpMLineIndexes).toEqual([0, 0]);
	expect(mapped.sdpMids).toEqual(["0", "0"]);
	expect(mapped.sdps.length).toBe(mapped.sdpMLineIndexes.length);
	expect(mapped.sdps.length).toBe(mapped.sdpMids.length);
});

/**
 * scripts/verify-fixtures.ts — wire golden fixture verification (plan P0-T3).
 *
 * Reads test/fixtures/wire/*.hex, decodes each with the @session.js/types
 * SignalService.Content bindings, asserts the expected field values per
 * message name (Type enum, uuid, sdps/sdpMLineIndexes/sdpMids matching the
 * canonical inputs), then re-encodes and asserts the hex roundtrip is
 * byte-identical to the file content.
 *
 * Prints per-file OK + sha256. Exits 1 on any mismatch or missing fixture.
 *
 * Usage: bun scripts/verify-fixtures.ts
 */
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { SignalService } from "@session.js/types/signal-bindings";
import {
	UUID,
	SDP_OFFER,
	SDP_ANSWER,
	CAND1,
	CAND2,
} from "./generate-goldens";

const { Type } = SignalService.CallMessage;

type Expected = {
	type: SignalService.CallMessage.Type;
	sdps?: string[];
	sdpMLineIndexes?: number[];
	sdpMids?: string[];
};

const expected: Record<string, Expected> = {
	"pre-offer": { type: Type.PRE_OFFER },
	offer: { type: Type.OFFER, sdps: [SDP_OFFER] },
	answer: { type: Type.ANSWER, sdps: [SDP_ANSWER] },
	"ice-candidates": {
		type: Type.ICE_CANDIDATES,
		sdps: [CAND1, CAND2],
		sdpMLineIndexes: [0, 0],
		sdpMids: ["0", "0"],
	},
	"end-call": { type: Type.END_CALL },
};

const fixturesDir = new URL("../test/fixtures/wire/", import.meta.url);

function fail(message: string): never {
	console.error(`FAIL: ${message}`);
	process.exit(1);
}

let failures = 0;

for (const [name, want] of Object.entries(expected)) {
	const file = new URL(`${name}.hex`, fixturesDir);
	if (!existsSync(file)) {
		console.error(
			`FAIL: missing fixture ${name}.hex — run \`bun scripts/generate-goldens.ts\` first`,
		);
		failures++;
		continue;
	}

	const fileHex = readFileSync(file, "utf8").trim();
	const sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");

	try {
		const bytes = Buffer.from(fileHex, "hex");
		if (bytes.length * 2 !== fileHex.length)
			throw new Error("file content is not valid hex");

		const content = SignalService.Content.decode(bytes);
		const callMessage = content.callMessage;
		if (!callMessage) throw new Error("decoded Content has no callMessage field");

		if (callMessage.type !== want.type)
			throw new Error(
				`type mismatch: got ${callMessage.type} (${Type[callMessage.type]}), ` +
					`want ${want.type} (${Type[want.type]})`,
			);
		if (callMessage.uuid !== UUID)
			throw new Error(`uuid mismatch: got ${callMessage.uuid}, want ${UUID}`);

		const gotSdps = [...(callMessage.sdps ?? [])];
		const wantSdps = want.sdps ?? [];
		if (JSON.stringify(gotSdps) !== JSON.stringify(wantSdps))
			throw new Error(`sdps mismatch: got ${JSON.stringify(gotSdps)}`);

		const gotMLineIndexes = [...(callMessage.sdpMLineIndexes ?? [])];
		const wantMLineIndexes = want.sdpMLineIndexes ?? [];
		if (JSON.stringify(gotMLineIndexes) !== JSON.stringify(wantMLineIndexes))
			throw new Error(`sdpMLineIndexes mismatch: got ${JSON.stringify(gotMLineIndexes)}`);

		const gotMids = [...(callMessage.sdpMids ?? [])];
		const wantMids = want.sdpMids ?? [];
		if (JSON.stringify(gotMids) !== JSON.stringify(wantMids))
			throw new Error(`sdpMids mismatch: got ${JSON.stringify(gotMids)}`);

		const roundtrip = Buffer.from(
			SignalService.Content.encode(content).finish(),
		).toString("hex");
		if (roundtrip !== fileHex)
			throw new Error("re-encode roundtrip differs from file content");

		console.log(
			`OK  ${name}.hex  type=${Type[callMessage.type]}  sha256=${sha256}`,
		);
	} catch (error) {
		console.error(`FAIL: ${name}.hex — ${(error as Error).message}`);
		failures++;
	}
}

if (failures > 0) fail(`${failures} fixture(s) failed verification`);
console.log(`all ${Object.keys(expected).length} fixtures verified`);

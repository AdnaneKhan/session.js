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
	groupFixtures,
	GROUP_PUBKEY,
	GROUP_MEMBER_A,
	GROUP_MEMBER_B,
	GROUP_MEMBER_C,
	GROUP_NAME,
	GROUP_ENC_PUB,
	GROUP_ENC_PRIV,
	GROUP_WRAPPER_CIPHERTEXT,
	GROUP_BODY,
	GROUP_TIMESTAMP,
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

// ---------------------------------------------------------------------------
// Closed-groups fixtures (G1-T2)
// ---------------------------------------------------------------------------
const groupsDir = new URL("../test/fixtures/wire/groups/", import.meta.url);
const CGType = SignalService.DataMessage.ClosedGroupControlMessage.Type;
const b2h = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const toNum = (v: number | Long): number => (typeof v === "number" ? v : v.toNumber());
type Long = { toNumber(): number };

for (const name of Object.keys(groupFixtures)) {
	const file = new URL(`${name}.hex`, groupsDir);
	if (!existsSync(file)) {
		console.error(
			`FAIL: missing groups/${name}.hex — run \`bun scripts/generate-goldens.ts\` first`,
		);
		failures++;
		continue;
	}
	const fileHex = readFileSync(file, "utf8").trim();
	const sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
	try {
		const bytes = Buffer.from(fileHex, "hex");
		if (bytes.length * 2 !== fileHex.length) throw new Error("file content is not valid hex");
		const content = SignalService.Content.decode(bytes);
		const dm = content.dataMessage;
		if (!dm) throw new Error("decoded Content has no dataMessage field");
		const cgcm = dm.closedGroupControlMessage;

		switch (name) {
			case "new": {
				if (!cgcm) throw new Error("no closedGroupControlMessage");
				if (cgcm.type !== CGType.NEW) throw new Error(`type mismatch: ${cgcm.type}`);
				if (b2h(cgcm.publicKey!) !== GROUP_PUBKEY) throw new Error("publicKey mismatch");
				if (cgcm.name !== GROUP_NAME) throw new Error("name mismatch");
				if ((cgcm.members ?? []).map(b2h).join(",") !== [GROUP_MEMBER_A, GROUP_MEMBER_B, GROUP_MEMBER_C].join(","))
					throw new Error("members mismatch");
				if ((cgcm.admins ?? []).map(b2h).join(",") !== GROUP_MEMBER_A) throw new Error("admins mismatch");
				if (toNum(cgcm.expirationTimer as number | Long) !== 3600) throw new Error("expirationTimer mismatch");
				if (b2h(cgcm.encryptionKeyPair!.publicKey) !== GROUP_ENC_PUB) throw new Error("enc publicKey mismatch");
				if (b2h(cgcm.encryptionKeyPair!.privateKey) !== GROUP_ENC_PRIV) throw new Error("enc privateKey mismatch");
				break;
			}
			case "name-change":
				if (cgcm?.type !== CGType.NAME_CHANGE) throw new Error("type mismatch");
				if (cgcm.name !== GROUP_NAME) throw new Error("name mismatch");
				break;
			case "members-added":
				if (cgcm?.type !== CGType.MEMBERS_ADDED) throw new Error("type mismatch");
				if ((cgcm.members ?? []).map(b2h).join(",") !== GROUP_MEMBER_C) throw new Error("members mismatch");
				break;
			case "members-removed":
				if (cgcm?.type !== CGType.MEMBERS_REMOVED) throw new Error("type mismatch");
				if ((cgcm.members ?? []).map(b2h).join(",") !== GROUP_MEMBER_C) throw new Error("members mismatch");
				break;
			case "member-left":
				if (cgcm?.type !== CGType.MEMBER_LEFT) throw new Error("type mismatch");
				break;
			case "encryption-key-pair": {
				if (cgcm?.type !== CGType.ENCRYPTION_KEY_PAIR) throw new Error("type mismatch");
				if ((cgcm.wrappers ?? []).length !== 2) throw new Error("wrappers length mismatch");
				if (b2h(cgcm.wrappers![0].publicKey) !== GROUP_MEMBER_B) throw new Error("wrapper[0].publicKey mismatch");
				if (b2h(cgcm.wrappers![0].encryptedKeyPair) !== GROUP_WRAPPER_CIPHERTEXT)
					throw new Error("wrapper[0].encryptedKeyPair mismatch");
				break;
			}
			case "visible": {
				if (dm.body !== GROUP_BODY) throw new Error("body mismatch");
				if (toNum(dm.timestamp as number | Long) !== GROUP_TIMESTAMP) throw new Error("timestamp mismatch");
				if (!dm.group) throw new Error("no GroupContext");
				if (Buffer.from(dm.group.id!).toString("utf8") !== GROUP_PUBKEY) throw new Error("group.id mismatch");
				if (dm.group.type !== SignalService.GroupContext.Type.DELIVER) throw new Error("group.type mismatch");
				break;
			}
			default:
				throw new Error(`unknown group fixture ${name}`);
		}

		const roundtrip = Buffer.from(SignalService.Content.encode(content).finish()).toString("hex");
		if (roundtrip !== fileHex) throw new Error("re-encode roundtrip differs from file content");

		console.log(`OK  groups/${name}.hex  sha256=${sha256}`);
	} catch (error) {
		console.error(`FAIL: groups/${name}.hex — ${(error as Error).message}`);
		failures++;
	}
}

const totalFixtures = Object.keys(expected).length + Object.keys(groupFixtures).length;
if (failures > 0) fail(`${failures} fixture(s) failed verification`);
console.log(`all ${totalFixtures} fixtures verified`);

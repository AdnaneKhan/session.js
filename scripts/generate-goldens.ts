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

// ---------------------------------------------------------------------------
// Closed-groups goldens (G1-T2). Canonical inputs derived from the pinned
// session-desktop (master @ d86076b) outgoing-message shapes: control messages
// carry ONLY `closedGroupControlMessage` (no GroupContext); group chat messages
// carry a `GroupContext` whose `id` is the UTF-8 of the 05-prefixed hex string.
// Provenance: "computed" (deterministic protobuf encoding).
// ---------------------------------------------------------------------------

/** 05-prefixed 33-byte group/member public keys (hex), canonical (do not change). */
export const GROUP_PUBKEY = "05" + "11".repeat(32);
export const GROUP_MEMBER_A = "05" + "aa".repeat(32);
export const GROUP_MEMBER_B = "05" + "bb".repeat(32);
export const GROUP_MEMBER_C = "05" + "cc".repeat(32);
export const GROUP_NAME = "Test Group";
/** Unprefixed 32-byte group encryption keypair (x25519), canonical. */
export const GROUP_ENC_PUB = "22".repeat(32);
export const GROUP_ENC_PRIV = "33".repeat(32);
/** Deterministic stand-in for a sealed KeyPair-proto blob (wrapper ciphertext). */
export const GROUP_WRAPPER_CIPHERTEXT = "44".repeat(80);
export const GROUP_BODY = "hello group";
export const GROUP_TIMESTAMP = 1751000000000;

const hexToBytes = (hex: string): Uint8Array => new Uint8Array(Buffer.from(hex, "hex"));
const utf8ToBytes = (s: string): Uint8Array => new Uint8Array(new TextEncoder().encode(s));

const CGType = SignalService.DataMessage.ClosedGroupControlMessage.Type;

/** The six sendable control types (ENCRYPTION_KEY_PAIR_REQUEST=8 is unused by official clients — not generated). */
export const groupFixtures: Record<string, SignalService.IDataMessage> = {
	new: {
		closedGroupControlMessage: {
			type: CGType.NEW,
			publicKey: hexToBytes(GROUP_PUBKEY),
			name: GROUP_NAME,
			members: [GROUP_MEMBER_A, GROUP_MEMBER_B, GROUP_MEMBER_C].map(hexToBytes),
			admins: [GROUP_MEMBER_A].map(hexToBytes),
			expirationTimer: 3600,
			encryptionKeyPair: {
				publicKey: hexToBytes(GROUP_ENC_PUB),
				privateKey: hexToBytes(GROUP_ENC_PRIV),
			},
		},
	},
	"name-change": {
		closedGroupControlMessage: { type: CGType.NAME_CHANGE, name: GROUP_NAME },
	},
	"members-added": {
		closedGroupControlMessage: {
			type: CGType.MEMBERS_ADDED,
			members: [GROUP_MEMBER_C].map(hexToBytes),
		},
	},
	"members-removed": {
		closedGroupControlMessage: {
			type: CGType.MEMBERS_REMOVED,
			members: [GROUP_MEMBER_C].map(hexToBytes),
		},
	},
	"member-left": {
		closedGroupControlMessage: { type: CGType.MEMBER_LEFT },
	},
	"encryption-key-pair": {
		closedGroupControlMessage: {
			type: CGType.ENCRYPTION_KEY_PAIR,
			wrappers: [GROUP_MEMBER_B, GROUP_MEMBER_C].map((m) => ({
				publicKey: hexToBytes(m),
				encryptedKeyPair: hexToBytes(GROUP_WRAPPER_CIPHERTEXT),
			})),
		},
	},
	/** A group chat (visible) message: body + GroupContext{ id: utf8("05…hex"), type: DELIVER }. */
	visible: {
		body: GROUP_BODY,
		timestamp: GROUP_TIMESTAMP,
		group: {
			id: utf8ToBytes(GROUP_PUBKEY),
			type: SignalService.GroupContext.Type.DELIVER,
		},
	},
};

/** Encode a closed-group DataMessage fixture to the Content-wrapped hex string. */
export function encodeGroupFixtureHex(dataMessage: SignalService.IDataMessage): string {
	return Buffer.from(
		SignalService.Content.encode(new SignalService.Content({ dataMessage })).finish(),
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

	const groupsDir = new URL("../test/fixtures/wire/groups/", import.meta.url);
	mkdirSync(groupsDir, { recursive: true });

	for (const [name, dataMessage] of Object.entries(groupFixtures)) {
		const hex = encodeGroupFixtureHex(dataMessage);
		const file = new URL(`${name}.hex`, groupsDir);
		writeFileSync(file, hex + "\n");
		const sha256 = createHash("sha256").update(hex + "\n").digest("hex");
		console.log(`groups/${name}.hex  sha256=${sha256}`);
		console.log(`  hex=${hex}`);
	}
}

// Written fresh from the published SessionProtos.proto field facts and the
// pinned session-desktop outgoing-message shapes. MIT-licensable for upstream
// contribution. See docs/evidence/G1-T1.md.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SignalService } from "@session.js/types/signal-bindings";
import { mapClosedGroupControlMessage } from "@/messages";
import { ClosedGroupControlMessage } from "@/messages/schema";
import {
	GROUP_PUBKEY,
	GROUP_MEMBER_A,
	GROUP_MEMBER_B,
	GROUP_MEMBER_C,
	GROUP_NAME,
	GROUP_ENC_PUB,
	GROUP_ENC_PRIV,
	GROUP_WRAPPER_CIPHERTEXT,
} from "../scripts/generate-goldens";

const CGType = SignalService.DataMessage.ClosedGroupControlMessage.Type;
const hexToBytes = (hex: string): Uint8Array => new Uint8Array(Buffer.from(hex, "hex"));
const b2h = (b: Uint8Array): string => Buffer.from(b).toString("hex");

function readFixture(name: string): string {
	return readFileSync(
		join(import.meta.dir, "fixtures", "wire", "groups", `${name}.hex`),
		"utf-8",
	).trim();
}

/** A group-swarm envelope: source = group pubkey, senderIdentity = real author. */
function groupEnvelope(senderIdentity: string) {
	return {
		type: SignalService.Envelope.Type.CLOSED_GROUP_MESSAGE,
		source: GROUP_PUBKEY,
		senderIdentity,
		timestamp: 1751000000000,
	} as any;
}

/** A 1:1 DM envelope (NEW invite / keypair reply): source = sender. */
function dmEnvelope(from: string) {
	return {
		type: SignalService.Envelope.Type.SESSION_MESSAGE,
		source: from,
		timestamp: 1751000000000,
	} as any;
}

test("mapClosedGroupControlMessage decodes NEW invite (1:1 DM) with plaintext keypair", () => {
	const content = SignalService.Content.decode(Buffer.from(readFixture("new"), "hex"));
	const mapped = mapClosedGroupControlMessage({
		hash: "h",
		envelope: dmEnvelope(GROUP_MEMBER_A),
		content,
	});
	expect(mapped.type).toBe(CGType.NEW);
	expect(mapped.isGroupMessage).toBe(false);
	expect(mapped.groupId).toBe(GROUP_PUBKEY); // from explicit publicKey
	expect(mapped.publicKey).toBe(GROUP_PUBKEY);
	expect(mapped.from).toBe(GROUP_MEMBER_A); // envelope.source for a DM
	expect(mapped.name).toBe(GROUP_NAME);
	expect(mapped.members).toEqual([GROUP_MEMBER_A, GROUP_MEMBER_B, GROUP_MEMBER_C]);
	expect(mapped.admins).toEqual([GROUP_MEMBER_A]);
	expect(mapped.expirationTimer).toBe(3600);
	expect(b2h(mapped.encryptionKeyPair!.publicKey)).toBe(GROUP_ENC_PUB);
	expect(b2h(mapped.encryptionKeyPair!.privateKey)).toBe(GROUP_ENC_PRIV);
});

test("mapClosedGroupControlMessage decodes NAME_CHANGE from the group swarm", () => {
	const content = SignalService.Content.decode(Buffer.from(readFixture("name-change"), "hex"));
	const mapped = mapClosedGroupControlMessage({
		hash: "h",
		envelope: groupEnvelope(GROUP_MEMBER_B),
		content,
	});
	expect(mapped.type).toBe(CGType.NAME_CHANGE);
	expect(mapped.isGroupMessage).toBe(true);
	expect(mapped.groupId).toBe(GROUP_PUBKEY); // from envelope.source (no explicit publicKey)
	expect(mapped.publicKey).toBeUndefined();
	expect(mapped.from).toBe(GROUP_MEMBER_B); // senderIdentity for a group message
	expect(mapped.name).toBe(GROUP_NAME);
});

test("mapClosedGroupControlMessage decodes MEMBERS_ADDED / MEMBERS_REMOVED", () => {
	for (const [fixture, type] of [
		["members-added", CGType.MEMBERS_ADDED],
		["members-removed", CGType.MEMBERS_REMOVED],
	] as const) {
		const content = SignalService.Content.decode(Buffer.from(readFixture(fixture), "hex"));
		const mapped = mapClosedGroupControlMessage({
			hash: "h",
			envelope: groupEnvelope(GROUP_MEMBER_A),
			content,
		});
		expect(mapped.type).toBe(type);
		expect(mapped.groupId).toBe(GROUP_PUBKEY);
		expect(mapped.members).toEqual([GROUP_MEMBER_C]);
	}
});

test("mapClosedGroupControlMessage decodes MEMBER_LEFT with no extra fields", () => {
	const content = SignalService.Content.decode(Buffer.from(readFixture("member-left"), "hex"));
	const mapped = mapClosedGroupControlMessage({
		hash: "h",
		envelope: groupEnvelope(GROUP_MEMBER_C),
		content,
	});
	expect(mapped.type).toBe(CGType.MEMBER_LEFT);
	expect(mapped.from).toBe(GROUP_MEMBER_C);
	expect(mapped.members).toEqual([]);
	expect(mapped.admins).toEqual([]);
	expect(mapped.wrappers).toEqual([]);
});

test("mapClosedGroupControlMessage decodes ENCRYPTION_KEY_PAIR wrappers", () => {
	const content = SignalService.Content.decode(
		Buffer.from(readFixture("encryption-key-pair"), "hex"),
	);
	const mapped = mapClosedGroupControlMessage({
		hash: "h",
		envelope: groupEnvelope(GROUP_MEMBER_A),
		content,
	});
	expect(mapped.type).toBe(CGType.ENCRYPTION_KEY_PAIR);
	expect(mapped.wrappers).toHaveLength(2);
	expect(mapped.wrappers[0].publicKey).toBe(GROUP_MEMBER_B);
	expect(b2h(mapped.wrappers[0].encryptedKeyPair)).toBe(GROUP_WRAPPER_CIPHERTEXT);
	expect(mapped.wrappers[1].publicKey).toBe(GROUP_MEMBER_C);
});

test("mapClosedGroupControlMessage converts Long envelope timestamps with toNumber", () => {
	const content = SignalService.Content.decode(Buffer.from(readFixture("member-left"), "hex"));
	const mapped = mapClosedGroupControlMessage({
		hash: "h",
		envelope: { ...groupEnvelope(GROUP_MEMBER_A), timestamp: { toNumber: () => 42 } },
		content,
	});
	expect(mapped.timestamp).toBe(42);
});

// --- Schema class round-trips ---------------------------------------------

test("ClosedGroupControlMessage NEW contentProto is byte-identical to the golden fixture", () => {
	const msg = new ClosedGroupControlMessage({
		timestamp: 1751000000000,
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
	});
	const hex = Buffer.from(
		SignalService.Content.encode(msg.contentProto()).finish(),
	).toString("hex");
	expect(hex).toBe(readFixture("new"));
});

test("ClosedGroupControlMessage round-trips every control type through the mapper", () => {
	const cases: Array<{ msg: ClosedGroupControlMessage; fixture: string }> = [
		{
			msg: new ClosedGroupControlMessage({
				timestamp: 1,
				type: CGType.NAME_CHANGE,
				name: GROUP_NAME,
			}),
			fixture: "name-change",
		},
		{
			msg: new ClosedGroupControlMessage({
				timestamp: 1,
				type: CGType.MEMBERS_ADDED,
				members: [GROUP_MEMBER_C].map(hexToBytes),
			}),
			fixture: "members-added",
		},
		{
			msg: new ClosedGroupControlMessage({
				timestamp: 1,
				type: CGType.MEMBERS_REMOVED,
				members: [GROUP_MEMBER_C].map(hexToBytes),
			}),
			fixture: "members-removed",
		},
		{
			msg: new ClosedGroupControlMessage({ timestamp: 1, type: CGType.MEMBER_LEFT }),
			fixture: "member-left",
		},
		{
			msg: new ClosedGroupControlMessage({
				timestamp: 1,
				type: CGType.ENCRYPTION_KEY_PAIR,
				wrappers: [GROUP_MEMBER_B, GROUP_MEMBER_C].map((m) => ({
					publicKey: hexToBytes(m),
					encryptedKeyPair: hexToBytes(GROUP_WRAPPER_CIPHERTEXT),
				})),
			}),
			fixture: "encryption-key-pair",
		},
	];
	for (const { msg, fixture } of cases) {
		const hex = Buffer.from(
			SignalService.Content.encode(msg.contentProto()).finish(),
		).toString("hex");
		expect(hex).toBe(readFixture(fixture));
	}
});

test("ClosedGroupControlMessage has a 14-day content TTL", () => {
	const msg = new ClosedGroupControlMessage({ timestamp: 1, type: CGType.MEMBER_LEFT });
	expect(msg.ttl()).toBe(14 * 24 * 60 * 60 * 1000);
});

// --- Schema validation -----------------------------------------------------

test("ClosedGroupControlMessage rejects ENCRYPTION_KEY_PAIR_REQUEST (unused)", () => {
	expect(
		() =>
			new ClosedGroupControlMessage({
				timestamp: 1,
				type: CGType.ENCRYPTION_KEY_PAIR_REQUEST,
			}),
	).toThrow();
});

test("ClosedGroupControlMessage NEW requires admins ⊆ members and a keypair", () => {
	const good = {
		timestamp: 1,
		type: CGType.NEW,
		publicKey: hexToBytes(GROUP_PUBKEY),
		name: GROUP_NAME,
		members: [GROUP_MEMBER_A, GROUP_MEMBER_B].map(hexToBytes),
		admins: [GROUP_MEMBER_A].map(hexToBytes),
		encryptionKeyPair: {
			publicKey: hexToBytes(GROUP_ENC_PUB),
			privateKey: hexToBytes(GROUP_ENC_PRIV),
		},
	};
	expect(() => new ClosedGroupControlMessage(good)).not.toThrow();
	// Admin not a member.
	expect(
		() =>
			new ClosedGroupControlMessage({
				...good,
				admins: [GROUP_MEMBER_C].map(hexToBytes),
			}),
	).toThrow();
	// Missing encryption keypair.
	expect(
		() =>
			new ClosedGroupControlMessage({
				...good,
				encryptionKeyPair: undefined,
			}),
	).toThrow();
	// Empty members.
	expect(
		() =>
			new ClosedGroupControlMessage({
				...good,
				members: [],
			}),
	).toThrow();
});

test("ClosedGroupControlMessage NAME_CHANGE requires a name", () => {
	expect(
		() => new ClosedGroupControlMessage({ timestamp: 1, type: CGType.NAME_CHANGE }),
	).toThrow();
});

test("ClosedGroupControlMessage ENCRYPTION_KEY_PAIR requires wrappers", () => {
	expect(
		() => new ClosedGroupControlMessage({ timestamp: 1, type: CGType.ENCRYPTION_KEY_PAIR }),
	).toThrow();
});

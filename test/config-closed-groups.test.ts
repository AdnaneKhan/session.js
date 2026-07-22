// Written fresh from the published protocol facts (docs/closed-groups/
// IMPLEMENTATION.md §2.6). MIT-licensable for upstream contribution. See
// docs/evidence/G2-T4.md.
import { expect, test } from "bun:test";
import { SignalService } from "@session.js/types/signal-bindings";
import { mapCompleteConfigurationClosedGroups, mapConfigurationClosedGroups } from "@/messages";
import {
	ConfigurationMessage,
	ConfigurationMessageClosedGroup,
} from "@/messages/schema/configuration-message";
import { selectNewestConfigurationMessage } from "@/instance/polling";
import { hexToBytes, bytesToHex } from "@noble/ciphers/utils.js";

const GROUP_PUBKEY = "05" + "11".repeat(32);
const MEMBER_A = "05" + "aa".repeat(32);
const MEMBER_B = "05" + "bb".repeat(32);
const ENC_PUB = "22".repeat(32);
const ENC_PRIV = "33".repeat(32);

test("mapConfigurationClosedGroups parses closedGroups from a ConfigurationMessage", () => {
	const content = new SignalService.Content({
		configurationMessage: {
			displayName: "me",
			closedGroups: [
				{
					publicKey: hexToBytes(GROUP_PUBKEY),
					name: "group one",
					encryptionKeyPair: {
						publicKey: hexToBytes(ENC_PUB),
						privateKey: hexToBytes(ENC_PRIV),
					},
					members: [hexToBytes(MEMBER_A), hexToBytes(MEMBER_B)],
					admins: [hexToBytes(MEMBER_A)],
				},
			],
		},
	});
	const parsed = mapConfigurationClosedGroups(content);
	expect(parsed).toHaveLength(1);
	expect(parsed[0].publicKey).toBe(GROUP_PUBKEY);
	expect(parsed[0].name).toBe("group one");
	expect(bytesToHex(parsed[0].encryptionKeyPair.publicKey)).toBe(ENC_PUB);
	expect(bytesToHex(parsed[0].encryptionKeyPair.privateKey)).toBe(ENC_PRIV);
	expect(parsed[0].members).toEqual([MEMBER_A, MEMBER_B]);
	expect(parsed[0].admins).toEqual([MEMBER_A]);
});

test("mapConfigurationClosedGroups returns [] when no closedGroups / missing keypair", () => {
	expect(mapConfigurationClosedGroups(new SignalService.Content({}))).toEqual([]);
	const noKeypair = new SignalService.Content({
		configurationMessage: {
			closedGroups: [{ publicKey: hexToBytes(GROUP_PUBKEY), name: "x" }],
		},
	});
	expect(mapConfigurationClosedGroups(noKeypair)).toEqual([]);
	expect(mapCompleteConfigurationClosedGroups(noKeypair)).toBeNull();
});

test("ConfigurationMessageClosedGroup emit → parse round-trips (legacy config sync)", () => {
	const group = new ConfigurationMessageClosedGroup({
		publicKey: hexToBytes(GROUP_PUBKEY),
		name: "round trip",
		encryptionKeyPair: {
			publicKeyData: hexToBytes(ENC_PUB),
			privateKeyData: hexToBytes(ENC_PRIV),
		},
		members: [MEMBER_A, MEMBER_B],
		admins: [MEMBER_A],
	});
	const configMessage = new ConfigurationMessage({
		timestamp: 1751000000000,
		activeClosedGroups: [group],
		activeOpenGroups: [],
		displayName: "me",
		contacts: [],
	});

	// Encode to wire bytes and decode back, as a linked device would receive.
	const bytes = SignalService.Content.encode(configMessage.contentProto()).finish();
	const decoded = SignalService.Content.decode(bytes);

	const parsed = mapConfigurationClosedGroups(decoded);
	expect(parsed).toHaveLength(1);
	expect(parsed[0].publicKey).toBe(GROUP_PUBKEY);
	expect(parsed[0].name).toBe("round trip");
	expect(bytesToHex(parsed[0].encryptionKeyPair.publicKey)).toBe(ENC_PUB);
	expect(bytesToHex(parsed[0].encryptionKeyPair.privateKey)).toBe(ENC_PRIV);
	expect(parsed[0].members).toEqual([MEMBER_A, MEMBER_B]);
	expect(parsed[0].admins).toEqual([MEMBER_A]);
});

test("ConfigurationMessageClosedGroup validates admins ⊆ members and keypair presence", () => {
	expect(
		() =>
			new ConfigurationMessageClosedGroup({
				publicKey: hexToBytes(GROUP_PUBKEY),
				name: "x",
				encryptionKeyPair: {
					publicKeyData: hexToBytes(ENC_PUB),
					privateKeyData: hexToBytes(ENC_PRIV),
				},
				members: [MEMBER_A],
				admins: [MEMBER_B], // not a member
			}),
	).toThrow();
	expect(
		() =>
			new ConfigurationMessageClosedGroup({
				publicKey: hexToBytes(GROUP_PUBKEY),
				name: "x",
				encryptionKeyPair: {
					publicKeyData: new Uint8Array(0),
					privateKeyData: new Uint8Array(0),
				},
				members: [MEMBER_A],
				admins: [MEMBER_A],
			}),
	).toThrow();
});

test("configuration polling selects the newest message in a batch", () => {
	const older = { envelope: { timestamp: 100 }, id: "older" };
	const newest = { envelope: { timestamp: { toNumber: () => 300 } }, id: "newest" };
	const middle = { envelope: { timestamp: 200 }, id: "middle" };
	expect(selectNewestConfigurationMessage([newest, older, middle])).toBe(newest);
});

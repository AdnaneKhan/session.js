// Written fresh from the published SessionProtos.proto field facts and the
// pinned session-desktop crypto behaviour. MIT-licensable for upstream
// contribution. See docs/evidence/G2-T1.md.
import { expect, test } from "bun:test";
import { SignalService } from "@session.js/types/signal-bindings";
import type { EnvelopePlus } from "@session.js/types/envelope";
import { generateSeedHex, getKeysFromSeed, type SessionKeys } from "@session.js/keypair";
import { x25519 } from "@noble/curves/ed25519.js";
import { bytesToHex } from "@noble/ciphers/utils.js";
import {
	encrypt,
	decryptForClosedGroup,
	decryptMessage,
	decryptWithSessionProtocol,
	encryptUsingSessionProtocol,
} from "@/crypto";

const { CLOSED_GROUP_MESSAGE } = SignalService.Envelope.Type;
const GROUP_ADDR = "05" + "11".repeat(32);
const td = new TextDecoder();
const te = new TextEncoder();

/** A fresh x25519 group encryption keypair wrapped in a SessionKeys shape. */
function groupKeypair(): { keys: SessionKeys; pubHex: string } {
	const priv = x25519.utils.randomSecretKey();
	const pub = x25519.getPublicKey(priv);
	return {
		pubHex: bytesToHex(pub),
		keys: {
			x25519: { keyType: "x25519", privateKey: priv, publicKey: pub },
			ed25519: {
				keyType: "ed25519",
				privateKey: new Uint8Array(32),
				publicKey: new Uint8Array(32),
			},
		},
	};
}

function groupEnvelope(cipherText: Uint8Array): EnvelopePlus {
	return {
		id: "test",
		type: CLOSED_GROUP_MESSAGE,
		source: GROUP_ADDR,
		content: cipherText,
		timestamp: 1751000000000,
		receivedAt: 1751000000000,
		senderIdentity: "",
	} as unknown as EnvelopePlus;
}

test("encrypt(CLOSED_GROUP_MESSAGE) → decryptForClosedGroup round-trips and stamps senderIdentity", async () => {
	const sender = getKeysFromSeed(generateSeedHex());
	const group = groupKeypair();
	const { envelopeType, cipherText } = await encrypt(
		sender,
		group.pubHex,
		te.encode("hello group"),
		CLOSED_GROUP_MESSAGE,
	);
	expect(envelopeType).toBe(CLOSED_GROUP_MESSAGE);

	const env = groupEnvelope(cipherText);
	const decrypted = decryptForClosedGroup([group.keys], env);
	expect(td.decode(decrypted)).toBe("hello group");
	// The real author is recovered from the sealed box (ed25519 → x25519, 05-prefixed),
	// not from the envelope source (which is the group address).
	// (getKeysFromSeed stores prefixed 33-byte x25519 pubkeys.)
	expect(env.senderIdentity).toBe(bytesToHex(sender.x25519.publicKey));
	expect(env.source).toBe(GROUP_ADDR);
});

test("decryptMessage dispatches CLOSED_GROUP_MESSAGE envelopes to decryptForClosedGroup", async () => {
	const sender = getKeysFromSeed(generateSeedHex());
	const group = groupKeypair();
	const { cipherText } = await encrypt(
		sender,
		group.pubHex,
		te.encode("dispatch"),
		CLOSED_GROUP_MESSAGE,
	);
	const decrypted = decryptMessage([group.keys], groupEnvelope(cipherText));
	expect(td.decode(decrypted)).toBe("dispatch");
});

test("decryptForClosedGroup falls back to older (rotated-out) keypairs", async () => {
	const sender = getKeysFromSeed(generateSeedHex());
	const older = groupKeypair();
	const newer = groupKeypair();
	// Encrypted to the OLDER keypair (an in-flight message from before rotation).
	const { cipherText } = await encrypt(
		sender,
		older.pubHex,
		te.encode("old key still works"),
		CLOSED_GROUP_MESSAGE,
	);
	const registry = [older.keys, newer.keys];
	const decrypted = decryptForClosedGroup(registry, groupEnvelope(cipherText));
	expect(td.decode(decrypted)).toBe("old key still works");
});

test("decryptForClosedGroup does NOT mutate the caller's keypair array (upstream .pop() bug)", async () => {
	const sender = getKeysFromSeed(generateSeedHex());
	const older = groupKeypair();
	const newer = groupKeypair();
	const { cipherText } = await encrypt(
		sender,
		newer.pubHex,
		te.encode("newest"),
		CLOSED_GROUP_MESSAGE,
	);
	const registry = [older.keys, newer.keys];
	decryptForClosedGroup(registry, groupEnvelope(cipherText));
	expect(registry).toHaveLength(2);
	expect(registry[0]).toBe(older.keys);
	expect(registry[1]).toBe(newer.keys);
	// And it is repeatable with the same array (not drained by the first call).
	const again = decryptForClosedGroup(registry, groupEnvelope(cipherText));
	expect(td.decode(again)).toBe("newest");
});

test("decryptForClosedGroup throws when no keypair matches", async () => {
	const sender = getKeysFromSeed(generateSeedHex());
	const group = groupKeypair();
	const wrong = groupKeypair();
	const { cipherText } = await encrypt(
		sender,
		group.pubHex,
		te.encode("x"),
		CLOSED_GROUP_MESSAGE,
	);
	expect(() => decryptForClosedGroup([wrong.keys], groupEnvelope(cipherText))).toThrow();
});

test("keypair wrapper: encryptUsingSessionProtocol (no padding) ↔ decryptWithSessionProtocol", async () => {
	const admin = getKeysFromSeed(generateSeedHex());
	const member = getKeysFromSeed(generateSeedHex()); // member's identity keys

	// Wrapper plaintext = KeyPair proto bytes, NO message padding (spec §2.5).
	const newGroupKey = groupKeypair();
	const keyPairProto = new SignalService.KeyPair({
		publicKey: newGroupKey.keys.x25519.publicKey,
		privateKey: newGroupKey.keys.x25519.privateKey,
	});
	const plaintext = SignalService.KeyPair.encode(keyPairProto).finish();

	const ciphertext = await encryptUsingSessionProtocol(
		admin,
		bytesToHex(member.x25519.publicKey),
		plaintext,
	);

	// The member unseals with their identity key; result is NOT unpadded.
	const syntheticEnvelope = {
		id: "w",
		type: CLOSED_GROUP_MESSAGE,
		source: GROUP_ADDR,
		content: ciphertext,
		timestamp: 1,
		receivedAt: 1,
		senderIdentity: "",
	} as unknown as EnvelopePlus;
	const recovered = decryptWithSessionProtocol(member, syntheticEnvelope, false);
	expect(bytesToHex(recovered)).toBe(bytesToHex(plaintext));

	const decoded = SignalService.KeyPair.decode(recovered);
	expect(bytesToHex(decoded.publicKey)).toBe(newGroupKey.pubHex);
	expect(bytesToHex(decoded.privateKey)).toBe(bytesToHex(newGroupKey.keys.x25519.privateKey));
	// The admin's identity is recovered from the wrapper's signature
	// (admin's x25519 pubkey from getKeysFromSeed is already 05-prefixed).
	expect(syntheticEnvelope.source).toBe(bytesToHex(admin.x25519.publicKey));
});

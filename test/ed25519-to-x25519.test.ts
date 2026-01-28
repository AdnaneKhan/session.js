import { expect, test } from "bun:test";
import { sha512 } from "@noble/hashes/sha2.js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { ed25519PublicKeyToX25519PublicKey } from "@/crypto/ed25519-to-x25519";
import { ready } from "@/index";

await ready;

function ed25519SeedToX25519PrivateKey(seed: Uint8Array): Uint8Array {
	const h = sha512(seed);
	const k = h.slice(0, 32);
	k[0] &= 248;
	k[31] &= 127;
	k[31] |= 64;
	return k;
}

test("ed25519PublicKeyToX25519PublicKey matches seed-derived x25519 pubkey", () => {
	// Deterministic seed (32 bytes)
	const seed = Uint8Array.from(Array.from({ length: 32 }, (_, i) => i));
	const edPub = ed25519.getPublicKey(seed);

	const xPriv = ed25519SeedToX25519PrivateKey(seed);
	const xPubExpected = x25519.getPublicKey(xPriv);

	const xPubFromEdPub = ed25519PublicKeyToX25519PublicKey(edPub);
	expect(xPubFromEdPub).not.toBeNull();
	expect(xPubFromEdPub!).toEqual(xPubExpected);
});

test("ed25519PublicKeyToX25519PublicKey rejects wrong length", () => {
	expect(ed25519PublicKeyToX25519PublicKey(new Uint8Array(31))).toBeNull();
	expect(ed25519PublicKeyToX25519PublicKey(new Uint8Array(33))).toBeNull();
});

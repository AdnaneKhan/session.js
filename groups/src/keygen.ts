// SPDX-License-Identifier: AGPL-3.0-or-later
//
// @session.js/groups — group key generation (plan §2.1).
//
// - Group ADDRESS: a random ed25519 keypair whose public key is converted
//   ed→x25519 and 05-prefixed (33 bytes → 66-char hex). The ed25519 secret is
//   DISCARDED — a legacy closed group cannot sign (no cryptographic membership
//   proof; the v1 protocol weakness the v3 rewrite addresses).
// - Group ENCRYPTION keypair: a fresh x25519 pair, stored UNPREFIXED (32-byte
//   hex). This is what group messages are sealed to and what gets rotated.
//
// Written fresh from the published address/key facts. Uses noble directly.
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { bytesToHex } from "@noble/ciphers/utils.js";
import type { GroupEncryptionKeypair } from "./types.js";

/** Generate a new legacy closed-group address (05-prefixed, 66 chars). */
export function generateGroupAddress(): string {
	const edSecret = ed25519.utils.randomSecretKey();
	const edPublic = ed25519.getPublicKey(edSecret);
	const x25519Public = ed25519.utils.toMontgomery(edPublic);
	// The ed25519 secret is intentionally discarded (the group cannot sign).
	return "05" + bytesToHex(x25519Public);
}

/** Generate a fresh x25519 group encryption keypair (unprefixed 32-byte hex). */
export function generateEncryptionKeypair(): GroupEncryptionKeypair {
	const privateKey = x25519.utils.randomSecretKey();
	const publicKey = x25519.getPublicKey(privateKey);
	return {
		publicKey: bytesToHex(publicKey),
		privateKey: bytesToHex(privateKey),
	};
}

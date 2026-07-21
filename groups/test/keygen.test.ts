// SPDX-License-Identifier: AGPL-3.0-or-later
// P4 — group key generation (plan §2.1). See docs/evidence/G4-T1.md.
import { expect, test } from "bun:test";
import { generateGroupAddress, generateEncryptionKeypair } from "../src/keygen";

const HEX66 = /^05([0-9a-f]{2}){32}$/i;
const HEX64 = /^([0-9a-f]{2}){32}$/i;

test("generateGroupAddress returns a 05-prefixed 33-byte (66-char) address", () => {
	const addr = generateGroupAddress();
	expect(addr).toHaveLength(66);
	expect(HEX66.test(addr)).toBe(true);
});

test("generateGroupAddress is random per call", () => {
	expect(generateGroupAddress()).not.toBe(generateGroupAddress());
});

test("generateEncryptionKeypair returns unprefixed 32-byte x25519 keys", () => {
	const kp = generateEncryptionKeypair();
	expect(kp.publicKey).toHaveLength(64);
	expect(kp.privateKey).toHaveLength(64);
	expect(HEX64.test(kp.publicKey)).toBe(true);
	expect(HEX64.test(kp.privateKey)).toBe(true);
	// Unprefixed (no 05 prefix).
	expect(kp.publicKey.startsWith("05")).toBe(false);
});

test("generateEncryptionKeypair is random per call", () => {
	const a = generateEncryptionKeypair();
	const b = generateEncryptionKeypair();
	expect(a.publicKey).not.toBe(b.publicKey);
	expect(a.privateKey).not.toBe(b.privateKey);
});

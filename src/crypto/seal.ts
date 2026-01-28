import { x25519 } from '@noble/curves/ed25519.js';
import { xsalsa20poly1305 } from '@noble/ciphers/salsa.js';
import { blake2b } from '@noble/hashes/blake2.js';

export const CRYPTO_BOX_PUBLICKEYBYTES = 32;
export const CRYPTO_BOX_SECRETKEYBYTES = 32;
export const CRYPTO_BOX_MACBYTES = 16;
export const CRYPTO_BOX_SEALBYTES = CRYPTO_BOX_PUBLICKEYBYTES + CRYPTO_BOX_MACBYTES; // 48
export const CRYPTO_BOX_NONCEBYTES = 24;

function concatBytes(...parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((sum, p) => sum + p.length, 0);
	const out = new Uint8Array(total);
	let pos = 0;
	for (const p of parts) {
		out.set(p, pos);
		pos += p.length;
	}
	return out;
}

function assertLen(name: string, bytes: Uint8Array, len: number): void {
	if (bytes.length !== len) throw new Error(`${name} must be ${len} bytes`);
}

function u32LE(b: Uint8Array, i: number): number {
	return (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
}
function writeU32LE(out: Uint8Array, i: number, v: number): void {
	out[i] = v & 0xff;
	out[i + 1] = (v >>> 8) & 0xff;
	out[i + 2] = (v >>> 16) & 0xff;
	out[i + 3] = (v >>> 24) & 0xff;
}
const rotl = (x: number, n: number) => ((x << n) | (x >>> (32 - n))) >>> 0;

function salsaQuarterRound(a: number, b: number, c: number, d: number): [number, number, number, number] {
	b ^= rotl((a + d) >>> 0, 7);
	c ^= rotl((b + a) >>> 0, 9);
	d ^= rotl((c + b) >>> 0, 13);
	a ^= rotl((d + c) >>> 0, 18);
	return [a >>> 0, b >>> 0, c >>> 0, d >>> 0];
}

// HSalsa20(key32, nonce16) -> 32-byte subkey (used by libsodium crypto_box_beforenm)
function hsalsa20(key32: Uint8Array, nonce16: Uint8Array): Uint8Array {
	assertLen('hsalsa20 key', key32, 32);
	assertLen('hsalsa20 nonce', nonce16, 16);

	// "expand 32-byte k"
	let x0 = 0x61707865;
	let x5 = 0x3320646e;
	let x10 = 0x79622d32;
	let x15 = 0x6b206574;

	let x1 = u32LE(key32, 0);
	let x2 = u32LE(key32, 4);
	let x3 = u32LE(key32, 8);
	let x4 = u32LE(key32, 12);
	let x11 = u32LE(key32, 16);
	let x12 = u32LE(key32, 20);
	let x13 = u32LE(key32, 24);
	let x14 = u32LE(key32, 28);

	let x6 = u32LE(nonce16, 0);
	let x7 = u32LE(nonce16, 4);
	let x8 = u32LE(nonce16, 8);
	let x9 = u32LE(nonce16, 12);

	for (let i = 0; i < 10; i++) {
		// column rounds
		[x0, x4, x8, x12] = salsaQuarterRound(x0, x4, x8, x12);
		[x5, x9, x13, x1] = salsaQuarterRound(x5, x9, x13, x1);
		[x10, x14, x2, x6] = salsaQuarterRound(x10, x14, x2, x6);
		[x15, x3, x7, x11] = salsaQuarterRound(x15, x3, x7, x11);
		// row rounds
		[x0, x1, x2, x3] = salsaQuarterRound(x0, x1, x2, x3);
		[x5, x6, x7, x4] = salsaQuarterRound(x5, x6, x7, x4);
		[x10, x11, x8, x9] = salsaQuarterRound(x10, x11, x8, x9);
		[x15, x12, x13, x14] = salsaQuarterRound(x15, x12, x13, x14);
	}

	const out = new Uint8Array(32);
	// HSalsa20 output: x0,x5,x10,x15,x6,x7,x8,x9
	writeU32LE(out, 0, x0);
	writeU32LE(out, 4, x5);
	writeU32LE(out, 8, x10);
	writeU32LE(out, 12, x15);
	writeU32LE(out, 16, x6);
	writeU32LE(out, 20, x7);
	writeU32LE(out, 24, x8);
	writeU32LE(out, 28, x9);
	return out;
}

function crypto_box_beforenm(recipientPk: Uint8Array, senderSk: Uint8Array): Uint8Array {
	assertLen('crypto_box recipientPk', recipientPk, CRYPTO_BOX_PUBLICKEYBYTES);
	assertLen('crypto_box senderSk', senderSk, CRYPTO_BOX_SECRETKEYBYTES);

	const shared = x25519.getSharedSecret(senderSk, recipientPk);
	// libsodium: beforenm = HSalsa20(shared, 0^16)
	return hsalsa20(shared, new Uint8Array(16));
}

// libsodium: nonce = BLAKE2b(epk || recipientPk, outlen=24)
function sealNonce(ephemeralPk: Uint8Array, recipientPk: Uint8Array): Uint8Array {
	assertLen('ephemeralPk', ephemeralPk, CRYPTO_BOX_PUBLICKEYBYTES);
	assertLen('recipientPk', recipientPk, CRYPTO_BOX_PUBLICKEYBYTES);
	return blake2b(concatBytes(ephemeralPk, recipientPk), { dkLen: CRYPTO_BOX_NONCEBYTES });
}

// libsodium-compatible sealed box: epk(32) || box(mac+ciphertext)
export function cryptoBoxSeal(message: Uint8Array, recipientPk: Uint8Array): Uint8Array {
	assertLen('recipientPk', recipientPk, CRYPTO_BOX_PUBLICKEYBYTES);

	const esk = x25519.utils.randomSecretKey();
	const epk = x25519.getPublicKey(esk);

	const key = crypto_box_beforenm(recipientPk, esk);
	const nonce = sealNonce(epk, recipientPk);

	const box = xsalsa20poly1305(key, nonce).encrypt(message); // NaCl/secretbox format (MAC first)
	return concatBytes(epk, box);
}

export function cryptoBoxSealOpen(
	sealed: Uint8Array,
	recipientPk: Uint8Array,
	recipientSk: Uint8Array
): Uint8Array | null {
	assertLen('recipientPk', recipientPk, CRYPTO_BOX_PUBLICKEYBYTES);
	assertLen('recipientSk', recipientSk, CRYPTO_BOX_SECRETKEYBYTES);
	if (sealed.length < CRYPTO_BOX_SEALBYTES) return null;

	const epk = sealed.subarray(0, CRYPTO_BOX_PUBLICKEYBYTES);
	const box = sealed.subarray(CRYPTO_BOX_PUBLICKEYBYTES);

	const key = crypto_box_beforenm(epk, recipientSk);
	const nonce = sealNonce(epk, recipientPk);

	try {
		return xsalsa20poly1305(key, nonce).decrypt(box);
	} catch {
		return null;
	}
}
import { ed25519 } from "@noble/curves/ed25519.js";

const P = (1n << 255n) - 19n;

function mod(a: bigint): bigint {
	const res = a % P;
	return res >= 0n ? res : res + P;
}

function modPow(base: bigint, exponent: bigint): bigint {
	let result = 1n;
	let b = mod(base);
	let e = exponent;

	while (e > 0n) {
		if (e & 1n) result = mod(result * b);
		b = mod(b * b);
		e >>= 1n;
	}

	return result;
}

function invert(a: bigint): bigint {
	// Fermat's little theorem for prime field: a^(p-2) mod p
	if (a === 0n) throw new Error("Cannot invert 0");
	return modPow(a, P - 2n);
}

function bigintToBytesLE(num: bigint, length: number): Uint8Array {
	let n = num;
	const out = new Uint8Array(length);
	for (let i = 0; i < length; i++) {
		out[i] = Number(n & 0xffn);
		n >>= 8n;
	}
	return out;
}

/**
 * Convert an Ed25519 public key to an X25519 public key.
 *
 * Equivalent to libsodium `crypto_sign_ed25519_pk_to_curve25519()`.
 * Returns `null` if the input cannot be parsed / converted.
 */
export function ed25519PublicKeyToX25519PublicKey(ed25519PublicKey: Uint8Array): Uint8Array | null {
	try {
		if (!(ed25519PublicKey instanceof Uint8Array) || ed25519PublicKey.length !== 32) {
			return null;
		}

		// Decode the Ed25519 point from its 32-byte compressed form.
		const ExtendedPoint = (ed25519 as unknown as { ExtendedPoint?: any }).ExtendedPoint;
		if (!ExtendedPoint?.fromHex) return null;
		const point = ExtendedPoint.fromHex(ed25519PublicKey);
		const affine = point.toAffine() as { y: bigint };
		const y = mod(affine.y);

		// Convert Edwards y-coordinate to Montgomery u-coordinate:
		// u = (1 + y) / (1 - y) mod p
		const one = 1n;
		const denom = mod(one - y);
		if (denom === 0n) return null;

		const u = mod((one + y) * invert(denom));
		return bigintToBytesLE(u, 32);
	} catch {
		return null;
	}
}

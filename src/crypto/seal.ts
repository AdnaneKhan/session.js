import { x25519 } from "@noble/curves/ed25519.js";
import { xsalsa20poly1305 } from "@noble/ciphers/salsa.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { concatBytes } from "@noble/hashes/utils.js";

export const CRYPTO_BOX_PUBLICKEYBYTES = 32;
export const CRYPTO_BOX_SECRETKEYBYTES = 32;
export const CRYPTO_BOX_MACBYTES = 16;
export const CRYPTO_BOX_SEALBYTES = CRYPTO_BOX_PUBLICKEYBYTES + CRYPTO_BOX_MACBYTES; // 48
export const CRYPTO_BOX_NONCEBYTES = 24;

function assertLen(name: string, bytes: Uint8Array, len: number): void {
	if (!(bytes instanceof Uint8Array)) throw new TypeError(`${name} must be a Uint8Array`);
	if (bytes.length !== len) throw new Error(`${name} must be ${len} bytes`);
}

function sealNonce(ephemeralPk: Uint8Array, recipientPk: Uint8Array): Uint8Array {
	return blake2b(concatBytes(ephemeralPk, recipientPk), {
		dkLen: CRYPTO_BOX_NONCEBYTES,
	});
}

export function cryptoBoxSeal(message: Uint8Array, recipientPublicKey: Uint8Array): Uint8Array {
	assertLen("recipientPublicKey", recipientPublicKey, CRYPTO_BOX_PUBLICKEYBYTES);

	const ephemeralSecretKey = x25519.utils.randomSecretKey();
	const ephemeralPublicKey = x25519.getPublicKey(ephemeralSecretKey);

	const nonce = sealNonce(ephemeralPublicKey, recipientPublicKey);
	const sharedKey = x25519.getSharedSecret(ephemeralSecretKey, recipientPublicKey);

	const cipher = xsalsa20poly1305(sharedKey, nonce);
	const boxed = cipher.encrypt(message);

	return concatBytes(ephemeralPublicKey, boxed);
}

export function cryptoBoxSealOpen(
	sealed: Uint8Array,
	recipientPublicKey: Uint8Array,
	recipientSecretKey: Uint8Array,
): Uint8Array {
	assertLen("recipientPublicKey", recipientPublicKey, CRYPTO_BOX_PUBLICKEYBYTES);
	assertLen("recipientSecretKey", recipientSecretKey, CRYPTO_BOX_SECRETKEYBYTES);

	if (!(sealed instanceof Uint8Array)) throw new TypeError("sealed must be a Uint8Array");
	if (sealed.length < CRYPTO_BOX_SEALBYTES) {
		throw new Error(`sealed must be at least ${CRYPTO_BOX_SEALBYTES} bytes`);
	}

	const ephemeralPublicKey = sealed.subarray(0, CRYPTO_BOX_PUBLICKEYBYTES);
	const boxed = sealed.subarray(CRYPTO_BOX_PUBLICKEYBYTES);

	const nonce = sealNonce(ephemeralPublicKey, recipientPublicKey);
	const sharedKey = x25519.getSharedSecret(recipientSecretKey, ephemeralPublicKey);

	const cipher = xsalsa20poly1305(sharedKey, nonce);
	try {
		return cipher.decrypt(boxed);
	} catch {
		throw new Error("cryptoBoxSealOpen: decryption failed");
	}
}

import { cbc } from "@noble/ciphers/aes.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
	SessionCryptoError,
	SessionCryptoErrorCode,
	SessionValidationError,
	SessionValidationErrorCode,
} from "@session.js/errors";

export async function decryptAttachment(
	data: Uint8Array,
	{
		size,
		key,
		digest,
	}: {
		size?: number;
		key: Uint8Array;
		digest: Uint8Array;
	},
) {
	if (key.byteLength !== 64) {
		throw new SessionCryptoError({
			code: SessionCryptoErrorCode.AttachmentDecryptionFailed,
			message: "Got invalid length attachment keys",
		});
	}
	if (data.byteLength < 16 + 32) {
		throw new SessionCryptoError({
			code: SessionCryptoErrorCode.AttachmentDecryptionFailed,
			message: "Got invalid length attachment",
		});
	}

	const aesKey = key.slice(0, 32);
	const macKey = key.slice(32, 64);

	const iv = data.slice(0, 16);
	const ciphertext = data.slice(16, data.byteLength - 32);
	const ivAndCiphertext = data.slice(0, data.byteLength - 32);
	const mac = data.slice(data.byteLength - 32, data.byteLength);

	verifyMAC(ivAndCiphertext, macKey, mac, 32);
	verifyDigest(data, digest);
	let decryptedData = decrypt(aesKey, ciphertext, iv);

	if (size !== undefined && size !== data.byteLength) {
		if (size < data.byteLength) {
			decryptedData = decryptedData.slice(0, size);
		} else {
			throw new SessionValidationError({
				code: SessionValidationErrorCode.InvalidAttachment,
				message: "Decrypted attachment size does not match expected size",
			});
		}
	}

	return decryptedData;
}

function verifyMAC(data: Uint8Array, key: Uint8Array, mac: Uint8Array, length: number) {
	const calculatedMac = hmac(sha256, key, data);
	if (mac.byteLength !== length || calculatedMac.byteLength < length) {
		throw new SessionCryptoError({
			code: SessionCryptoErrorCode.MessageDecryptionFailed,
			message: "Bad attachment MAC",
		});
	}
	const a = new Uint8Array(calculatedMac);
	const b = new Uint8Array(mac);
	let result = 0;
	for (let i = 0; i < mac.byteLength; ++i) {
		result |= a[i] ^ b[i];
	}
	if (result !== 0) {
		throw new SessionCryptoError({
			code: SessionCryptoErrorCode.MessageDecryptionFailed,
			message: "Bad attachment MAC",
		});
	}
}

function verifyDigest(data: Uint8Array, theirDigest: Uint8Array) {
	const ourDigest = sha256(data);
	const b = theirDigest;
	let result = 0;
	for (let i = 0; i < theirDigest.byteLength; i += 1) {
		result |= ourDigest[i] ^ b[i];
	}
	if (result !== 0) {
		throw new SessionCryptoError({
			code: SessionCryptoErrorCode.MessageDecryptionFailed,
			message: "Bad attachment digest",
		});
	}
}

function decrypt(key: Uint8Array, data: Uint8Array, iv: Uint8Array) {
	return cbc(key, iv).decrypt(data);
}

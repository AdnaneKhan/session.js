import { PROFILE_IV_LENGTH, PROFILE_KEY_LENGTH, PROFILE_TAG_LENGTH } from "@/profile";
import { gcm } from "@noble/ciphers/aes.js";
import { randomBytes } from "@noble/ciphers/utils.js";
import { SessionCryptoError, SessionCryptoErrorCode } from "@session.js/errors";

export async function encryptProfile(data: Uint8Array, key: Uint8Array): Promise<Uint8Array> {
	const iv = randomBytes(PROFILE_IV_LENGTH);
	if (key.byteLength !== PROFILE_KEY_LENGTH) {
		throw new SessionCryptoError({
			code: SessionCryptoErrorCode.AttachmentEncryptionFailed,
			message: "Got invalid length profile key",
		});
	}
	if (iv.byteLength !== PROFILE_IV_LENGTH) {
		throw new SessionCryptoError({
			code: SessionCryptoErrorCode.AttachmentEncryptionFailed,
			message: "Got invalid length profile iv",
		});
	}

	const cipher = gcm(key, iv, new Uint8Array(0));
	const ciphertext = cipher.encrypt(data);

	const ivAndCiphertext = new Uint8Array(PROFILE_IV_LENGTH + ciphertext.byteLength);
	ivAndCiphertext.set(iv);
	ivAndCiphertext.set(ciphertext, PROFILE_IV_LENGTH);

	return ivAndCiphertext;
}

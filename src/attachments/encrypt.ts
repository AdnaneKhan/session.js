import { cbc } from "@noble/ciphers/aes.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/ciphers/utils.js";
import { MAX_ATTACHMENT_FILESIZE_BYTES } from "@session.js/consts";
import { SessionCryptoError, SessionCryptoErrorCode } from "@session.js/errors";

export async function encryptFileAttachment(file: File) {
	return await encryptAttachment(new Uint8Array(await file.arrayBuffer()), true);
}

export async function encryptLinkPreview() {
	// TODO: encryptAttachment with addPadding = false
}

export async function encryptQuote() {
	// TODO: encryptAttachment with addPadding = false
}

const PADDING_BYTE = 0x00;
async function encryptAttachment(data: Uint8Array, addPadding = false) {
	const pointerKey = randomBytes(64);
	const iv = randomBytes(16);
	const padded = addPadding ? addAttachmentPadding(data) : data;
	const encrypted = await encryptAttachmentData(padded, pointerKey, iv);
	return { ...encrypted, key: pointerKey };
}

function addAttachmentPadding(data: Uint8Array): Uint8Array {
	const originalUInt = new Uint8Array(data);

	let paddedSize = Math.max(
		541,
		Math.floor(Math.pow(1.05, Math.ceil(Math.log(originalUInt.length) / Math.log(1.05)))),
	);

	if (
		paddedSize > MAX_ATTACHMENT_FILESIZE_BYTES &&
		originalUInt.length <= MAX_ATTACHMENT_FILESIZE_BYTES
	) {
		paddedSize = MAX_ATTACHMENT_FILESIZE_BYTES;
	}
	const paddedData = new Uint8Array(paddedSize);

	paddedData.fill(PADDING_BYTE, originalUInt.length);
	paddedData.set(originalUInt);

	return paddedData;
}

export async function encryptAttachmentData(
	plaintext: Uint8Array,
	keys: Uint8Array,
	iv: Uint8Array,
) {
	if (!(plaintext instanceof Uint8Array)) {
		throw new TypeError(`\`plaintext\` must be an \`Uint8Array\`; got: ${typeof plaintext}`);
	}

	if (keys.byteLength !== 64) {
		throw new SessionCryptoError({
			code: SessionCryptoErrorCode.AttachmentEncryptionFailed,
			message: "Got invalid length attachment keys",
		});
	}
	if (iv.byteLength !== 16) {
		throw new SessionCryptoError({
			code: SessionCryptoErrorCode.AttachmentEncryptionFailed,
			message: "Got invalid length attachment iv",
		});
	}

	const aesKey = keys.slice(0, 32);
	const macKey = keys.slice(32, 64);

	const ciphertext = cbc(aesKey, iv).encrypt(plaintext);
	const ivAndCiphertext = new Uint8Array(16 + ciphertext.byteLength);
	ivAndCiphertext.set(new Uint8Array(iv));
	ivAndCiphertext.set(new Uint8Array(ciphertext), 16);

	const mac = hmac(sha256, new Uint8Array(macKey), ivAndCiphertext);

	const encryptedBin = new Uint8Array(16 + ciphertext.byteLength + 32);
	encryptedBin.set(ivAndCiphertext);
	encryptedBin.set(new Uint8Array(mac), 16 + ciphertext.byteLength);

	const digest = sha256(encryptedBin);

	return {
		ciphertext: encryptedBin,
		digest,
	};
}

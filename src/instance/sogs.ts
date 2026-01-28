import type { Session } from "@/instance";
import { VisibleMessage } from "@/messages/schema/visible-message";
import { SessionRuntimeError, SessionRuntimeErrorCode } from "@session.js/errors";
import type { Keypair, SodiumKeypair } from "@session.js/keypair";
import { sign } from "curve25519-js";
import { RequestType, type RequestSogs } from "@session.js/types/network/request";
import type { ResponseSogsRequest } from "@session.js/types/network/response";
import { blake2b } from "@noble/hashes/blake2.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex, hexToBytes, randomBytes, concatBytes } from "@noble/ciphers/utils.js";
import { base64 } from "@scure/base";
import { utf8ToBytes } from "@noble/hashes/utils.js";

export function blindSessionId(this: Session, serverPk: string): string {
	if (!this.sessionID || !this.keypair)
		throw new SessionRuntimeError({
			code: SessionRuntimeErrorCode.EmptyUser,
			message: "Instance is not initialized; use setMnemonic first",
		});
	const blindedKeyPair = getBlindingValues(hexToBytes(serverPk), this.keypair.ed25519);
	const blindedSessionId = "15" + bytesToHex(blindedKeyPair.publicKey);
	return blindedSessionId;
}

export function encodeSogsMessage(
	this: Session,
	{
		serverPk,
		message,
		blind,
	}: {
		serverPk: string;
		message: VisibleMessage;
		blind: boolean;
	},
): { data: string; signature: string } {
	if (!this.sessionID || !this.keypair)
		throw new SessionRuntimeError({
			code: SessionRuntimeErrorCode.EmptyUser,
			message: "Instance is not initialized; use setMnemonic first",
		});

	const paddedBody = addMessagePadding(message.plainTextBuffer());
	const data = base64.encode(paddedBody);

	let signature: string;
	if (blind) {
		const blindedKeyPair = getBlindingValues(hexToBytes(serverPk), this.keypair.ed25519);
		signature = getSignatureWithBlinding({
			data: paddedBody,
			keypair: this.keypair,
			blindedKeyPair,
		});
	} else {
		signature = getSignatureWithoutBlinding({
			data: paddedBody,
			keypair: this.keypair,
		});
	}

	return { data, signature };
}

export function addMessagePadding(messageBuffer: Uint8Array): Uint8Array {
	const plaintext = new Uint8Array(getPaddedMessageLength(messageBuffer.byteLength + 1) - 1);
	plaintext.set(new Uint8Array(messageBuffer));
	plaintext[messageBuffer.byteLength] = 0x80;

	return plaintext;
}

function getPaddedMessageLength(originalLength: number): number {
	const messageLengthWithTerminator = originalLength + 1;
	let messagePartCount = Math.floor(messageLengthWithTerminator / 160);

	if (messageLengthWithTerminator % 160 !== 0) {
		messagePartCount += 1;
	}

	return messagePartCount * 160;
}

function getSignatureWithoutBlinding({ data, keypair }: { data: Uint8Array; keypair: Keypair }) {
	const signature = sign(keypair.x25519.privateKey, data, null);
	return base64.encode(signature);
}

function getSignatureWithBlinding({
	data,
	keypair,
	blindedKeyPair,
}: {
	data: Uint8Array;
	blindedKeyPair: {
		a: Uint8Array;
		secretKey: Uint8Array;
		publicKey: Uint8Array;
	};
	keypair: Keypair;
}): string {
	const signature = blindedED25519Signature(
		data,
		keypair.ed25519,
		blindedKeyPair.secretKey,
		blindedKeyPair.publicKey,
	);
	if (!signature || signature.length === 0) {
		throw new Error("Couldn't sign message");
	}

	return base64.encode(signature);
}

export function getBlindingValues(
	serverPK: Uint8Array,
	signingKeys: SodiumKeypair,
): {
	a: Uint8Array;
	secretKey: Uint8Array;
	publicKey: Uint8Array;
} {
	const k = sodium.crypto_core_ed25519_scalar_reduce(
		blake2b(serverPK, {
			dkLen: 64,
		}),
	);

	let a = sodium.crypto_sign_ed25519_sk_to_curve25519(signingKeys.privateKey);

	if (a.length > 32) {
		a = a.slice(0, 32);
	}

	const ka = sodium.crypto_core_ed25519_scalar_mul(k, a);
	const kA = sodium.crypto_scalarmult_ed25519_base_noclamp(ka);

	return {
		a,
		secretKey: ka,
		publicKey: kA,
	};
}

function blindedED25519Signature(
	messageParts: Uint8Array,
	ourKeyPair: SodiumKeypair,
	ka: Uint8Array,
	kA: Uint8Array,
): Uint8Array {
	const sEncode = ourKeyPair.privateKey.slice(0, 32);
	const shaFullLength = sha512(sEncode);
	const Hrh = shaFullLength.slice(32);
	const r = sodium.crypto_core_ed25519_scalar_reduce(sha512(concatBytes(Hrh, kA, messageParts)));
	const sigR = sodium.crypto_scalarmult_ed25519_base_noclamp(r);
	const HRAM = sodium.crypto_core_ed25519_scalar_reduce(
		sha512(concatBytes(sigR, kA, messageParts)),
	);
	const sigS = sodium.crypto_core_ed25519_scalar_add(
		r,
		sodium.crypto_core_ed25519_scalar_mul(HRAM, ka),
	);

	const fullSig = concatBytes(sigR, sigS);
	return fullSig;
}

export async function signSogsRequest(
	this: Session,
	{
		blind,
		serverPk,
		timestamp,
		endpoint,
		nonce,
		method,
		body,
	}: {
		blind: boolean;
		serverPk: string;
		timestamp: number;
		endpoint: string;
		nonce: Uint8Array;
		method: string;
		body?: string | Uint8Array;
	},
) {
	if (!this.sessionID || !this.keypair)
		throw new SessionRuntimeError({
			code: SessionRuntimeErrorCode.EmptyUser,
			message: "Instance is not initialized; use setMnemonic first",
		});
	const pk = hexToBytes(serverPk);
	let toSign = concatBytes(
		pk,
		nonce,
		utf8ToBytes(String(timestamp)),
		utf8ToBytes(method),
		utf8ToBytes(endpoint),
	);
	if (body) {
		const bodyHashed = blake2b(typeof body === "string" ? new TextEncoder().encode(body) : body, {
			dkLen: 64,
		});
		toSign = concatBytes(toSign, bodyHashed);
	}
	if (blind) {
		const blindingValues = getBlindingValues(pk, this.keypair.ed25519);
		const ka = blindingValues.secretKey;
		const kA = blindingValues.publicKey;
		const signature = await blindedED25519Signature(toSign, this.keypair.ed25519, ka, kA);
		return signature;
	} else {
		return ed25519.sign(toSign, this.keypair.ed25519.privateKey);
	}
}

export async function sendSogsRequest(
	this: Session,
	{
		host,
		serverPk,
		endpoint,
		method,
		body,
		blind,
	}: {
		host: string;
		serverPk: string;
		endpoint: string;
		method: string;
		body?: string | Uint8Array;
		blind: boolean;
	},
) {
	if (!this.sessionID || !this.keypair)
		throw new SessionRuntimeError({
			code: SessionRuntimeErrorCode.EmptyUser,
			message: "Instance is not initialized; use setMnemonic first",
		});

	const nonce = randomBytes(16);
	const timestamp = Math.floor(Date.now() / 1000);
	const reqSignature = await this.signSogsRequest({
		blind,
		serverPk,
		timestamp,
		endpoint,
		nonce,
		method,
		body,
	});
	let pubkey: string;
	if (blind) {
		pubkey = this.blindSessionId(serverPk);
	} else {
		pubkey = "00" + bytesToHex(this.keypair.ed25519.publicKey);
	}

	const contentType =
		body !== undefined
			? body instanceof Uint8Array
				? "application/octet-stream"
				: "application/json"
			: null;
	const bodyProcessed = body && body !== undefined ? body : null;

	return await this._request<ResponseSogsRequest, RequestSogs>({
		type: RequestType.SOGSRequest,
		body: {
			host,
			endpoint,
			method,
			body: bodyProcessed,
			headers: {
				...(contentType !== null && { "Content-Type": contentType }),
				"X-SOGS-Pubkey": pubkey,
				"X-SOGS-Timestamp": String(timestamp),
				"X-SOGS-Nonce": base64.encode(nonce),
				"X-SOGS-Signature": base64.encode(reqSignature),
			},
		},
	});
}

// SPDX-License-Identifier: MIT
// Fork addition (closed-groups support): build/open legacy closed-group keypair
// wrappers. A wrapper is the group encryption `KeyPair` proto sealed to a
// member's identity key with the Session protocol and NO message padding
// (verified against pinned session-desktop buildEncryptionKeyPairWrappers /
// handleClosedGroupEncryptionKeyPair). Written fresh — (c) 2026 AdnaneKhan,
// upstreamable. See docs/evidence/G2-T1.md.
import { SignalService } from "@session.js/types/signal-bindings";
import type { EnvelopePlus } from "@session.js/types/envelope";
import type { Session } from "@/instance";
import { encryptUsingSessionProtocol } from "@/crypto/message-encrypt";
import { decryptWithSessionProtocol } from "@/crypto/message-decrypt";
import {
	SessionRuntimeError,
	SessionRuntimeErrorCode,
} from "@session.js/errors";

/**
 * Seal a group encryption keypair to a member's identity key (wrapper blob,
 * no message padding; plaintext is the `KeyPair` proto).
 */
export async function sealKeypairWrapper(
	this: Session,
	memberPubKey: string,
	keypair: { publicKey: Uint8Array; privateKey: Uint8Array },
): Promise<Uint8Array> {
	if (!this.sessionID || !this.keys)
		throw new SessionRuntimeError({
			code: SessionRuntimeErrorCode.EmptyUser,
			message: "Instance is not initialized; use setMnemonic first",
		});
	const proto = SignalService.KeyPair.encode(
		new SignalService.KeyPair({
			publicKey: keypair.publicKey,
			privateKey: keypair.privateKey,
		}),
	).finish();
	return encryptUsingSessionProtocol(this.keys, memberPubKey, proto);
}

/**
 * Open a keypair-wrapper blob addressed to us with our identity key. Returns
 * the recovered keypair (unprefixed byte keys), or null if it is not addressed
 * to us / cannot be opened or parsed.
 */
export async function openKeypairWrapper(
	this: Session,
	encryptedKeyPair: Uint8Array,
): Promise<{ publicKey: Uint8Array; privateKey: Uint8Array } | null> {
	if (!this.sessionID || !this.keys)
		throw new SessionRuntimeError({
			code: SessionRuntimeErrorCode.EmptyUser,
			message: "Instance is not initialized; use setMnemonic first",
		});
	const envelope = { content: encryptedKeyPair } as unknown as EnvelopePlus;
	try {
		const plaintext = decryptWithSessionProtocol(this.keys, envelope, false);
		const proto = SignalService.KeyPair.decode(plaintext);
		if (!proto.publicKey?.length || !proto.privateKey?.length) return null;
		return {
			publicKey: new Uint8Array(proto.publicKey),
			privateKey: new Uint8Array(proto.privateKey),
		};
	} catch {
		return null;
	}
}

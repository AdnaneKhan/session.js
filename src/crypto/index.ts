// SPDX-License-Identifier: MIT
// Fork addition (closed-groups support): public `./crypto` package export.
// These primitives were previously internal-only; the `@session.js/groups`
// package needs them to seal/unseal group keypair wrappers and (de)serialize
// group messages without depending on client internals. Re-exports existing
// MIT code plus the fresh closed-group decrypt fix — (c) 2026 AdnaneKhan,
// upstreamable. See docs/evidence/G2-T1.md.
export {
	encrypt,
	wrap,
	encryptUsingSessionProtocol,
	type EncryptResult,
	type EncryptAndWrapMessageResults,
} from "./message-encrypt";
export {
	extractContent,
	decodeMessage,
	decryptMessage,
	decryptEnvelopeWithOurKey,
	decryptForClosedGroup,
	decryptWithSessionProtocol,
} from "./message-decrypt";
export { addMessagePadding, removeMessagePadding } from "./message-padding";
export {
	cryptoBoxSeal,
	cryptoBoxSealOpen,
	CRYPTO_BOX_PUBLICKEYBYTES,
	CRYPTO_BOX_SECRETKEYBYTES,
	CRYPTO_BOX_MACBYTES,
	CRYPTO_BOX_SEALBYTES,
	CRYPTO_BOX_NONCEBYTES,
} from "./seal";
export { getSnodeSignatureParams } from "./signature";

import type { SnodeSignatureResult } from "@session.js/types/snode-signature-result";
import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex } from "@noble/ciphers/utils.js";
import type { SodiumKeypair } from "@session.js/keypair";
import { base64 } from "@scure/base";

export function getSnodeSignatureParams(params: {
	ed25519Key: SodiumKeypair;
	namespace: number | null | "all"; // 'all' can be used to clear all namespaces (during account deletion)
	method: "retrieve" | "store" | "delete_all";
}): SnodeSignatureResult {
	const namespace = params.namespace || 0;

	const signatureTimestamp = Date.now(); // TODO: replace with getNowWithNetworkOffset

	const withoutNamespace = `${params.method}${signatureTimestamp}`;
	const withNamespace = `${params.method}${namespace}${signatureTimestamp}`;
	const verificationData = namespace === 0 ? withoutNamespace : withNamespace;
	const message = new TextEncoder().encode(verificationData);
	const signature = ed25519.sign(message, params.ed25519Key.privateKey);
	const signatureBase64 = base64.encode(signature);

	return {
		// sig_timestamp: signatureTimestamp,
		timestamp: signatureTimestamp,
		signature: signatureBase64,
		pubkeyEd25519: bytesToHex(params.ed25519Key.publicKey),
	};
}

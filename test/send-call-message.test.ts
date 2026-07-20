// Written fresh from the published SessionProtos.proto field facts. MIT-licensable for upstream contribution.
import { expect, test } from "bun:test";
import { encode } from "@session.js/mnemonic";
import { generateSeedHex } from "@session.js/keypair";
import { SignalService } from "@session.js/types/signal-bindings";
import { SnodeNamespaces } from "@session.js/types";
import { RequestType } from "@session.js/types/network/request";
import type { Network } from "@session.js/types";
import { SessionRuntimeError, SessionValidationError } from "@session.js/errors";
import { Session } from "@/index";
import { wrap } from "@/crypto/message-encrypt";
import { decodeMessage, decryptMessage, extractContent } from "@/crypto/message-decrypt";
import { CallMessage } from "@/messages/schema/call-message";

const UUID = "11111111-1111-4111-8111-111111111111";
const SDP_OFFER = "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n";
const PEER = "05" + "ab".repeat(32);

const offlineNetwork: Network = {
	onRequest: async () => {
		throw new Error("offline test: no network calls allowed");
	},
};

function createAuthorizedSession(network: Network = offlineNetwork): Session {
	const session = new Session({ network });
	// Replicates src/instance/get-set-mnemomic.ts derivation: decode(mnemonic) -> getKeysFromSeed
	session.setMnemonic(encode(generateSeedHex()));
	return session;
}

test("wrap() does not rewrite CallMessage content or timestamps", async () => {
	const session = createAuthorizedSession();
	const keys = session.getKeys()!;
	const ownID = session.getSessionID();
	expect(keys).toBeDefined();

	const msg = new CallMessage({
		timestamp: 1751000000000,
		type: SignalService.CallMessage.Type.OFFER,
		sdps: [SDP_OFFER],
		uuid: UUID,
	});
	const plainTextBuffer = msg.plainTextBuffer();

	// Intentionally different from the CallMessage construction timestamp
	const networkTimestamp = 1751000099999;
	const [wrapped] = await wrap(
		keys,
		[
			{
				destination: ownID,
				plainTextBuffer,
				namespace: SnodeNamespaces.UserMessages,
				ttl: 300000,
				identifier: "x",
				isSyncMessage: false,
				isGroup: false,
			},
		],
		{ networkTimestamp },
	);

	// Decode the wrapped envelope exactly like the poller's receive path does
	const envelopeBytes = extractContent(wrapped.data64);
	expect(envelopeBytes).not.toBeNull();
	const envelope = decodeMessage(envelopeBytes!)!;
	const decrypted = decryptMessage([keys], envelope);
	const content = SignalService.Content.decode(new Uint8Array(decrypted));

	// CallMessage passes through wrap() untouched
	expect(content.callMessage).toBeDefined();
	expect(content.callMessage!.uuid).toBe(UUID);
	expect(content.callMessage!.type).toBe(SignalService.CallMessage.Type.OFFER);
	expect([...(content.callMessage!.sdps ?? [])]).toEqual([SDP_OFFER]);
	expect(content.callMessage!.sdpMLineIndexes ?? []).toEqual([]);
	expect(content.callMessage!.sdpMids ?? []).toEqual([]);

	// Byte-identical: wrap() re-encodes Content after its timestamp-rewrite pass, which must
	// be a no-op for CallMessage (it has no timestamp field and no data/typing/extraction fields)
	expect(Buffer.from(SignalService.Content.encode(content).finish()).toString("hex")).toBe(
		Buffer.from(plainTextBuffer).toString("hex"),
	);

	// Envelope carries the network timestamp
	let envelopeTimestamp = envelope.timestamp as number | { toNumber(): number };
	if (typeof envelopeTimestamp !== "number") {
		envelopeTimestamp = envelopeTimestamp.toNumber();
	}
	expect(envelopeTimestamp).toBe(networkTimestamp);

	// wrap() metadata passthrough
	expect(wrapped.namespace).toBe(SnodeNamespaces.UserMessages);
	expect(wrapped.ttl).toBe(300000);
	expect(wrapped.identifier).toBe("x");
	expect(wrapped.isSyncMessage).toBe(false);
});

test("sendCallMessage stores the message via the swarm with call TTL (offline stub network)", async () => {
	const requests: { type: RequestType; body: any }[] = [];
	const stubNetwork: Network = {
		onRequest: async (type, body) => {
			requests.push({ type, body });
			switch (type) {
				case RequestType.GetSnodes:
					return {
						snodes: [
							{
								public_ip: "192.0.2.1",
								storage_port: 22023,
								pubkey_x25519: "aa".repeat(32),
								pubkey_ed25519: "bb".repeat(32),
							},
						],
					};
				case RequestType.GetSwarms:
					return {
						swarms: [
							{
								ip: "192.0.2.2",
								port: "22023",
								pubkey_ed25519: "cc".repeat(32),
								pubkey_x25519: "dd".repeat(32),
							},
						],
					};
				case RequestType.Store:
					return { hash: "0123456789abcdef" };
				default:
					throw new Error("unexpected request type " + type);
			}
		},
	};
	const session = createAuthorizedSession(stubNetwork);
	const result = await session.sendCallMessage(PEER, {
		type: SignalService.CallMessage.Type.PRE_OFFER,
		uuid: UUID,
	});
	expect(result.messageHash).toBe("0123456789abcdef");
	expect(typeof result.timestamp).toBe("number");

	const storeRequest = requests.find((r) => r.type === RequestType.Store);
	expect(storeRequest).toBeDefined();
	expect(storeRequest!.body.destination).toBe(PEER);
	expect(storeRequest!.body.ttl).toBe(300000);
	expect(storeRequest!.body.namespace).toBe(SnodeNamespaces.UserMessages);
	expect(typeof storeRequest!.body.data64).toBe("string");
	expect(storeRequest!.body.timestamp).toBe(result.timestamp);
});

test("sendCallMessage self-sync stores to own swarm (isSyncMessage flag)", async () => {
	const requests: { type: RequestType; body: any }[] = [];
	const stubNetwork: Network = {
		onRequest: async (type, body) => {
			requests.push({ type, body });
			switch (type) {
				case RequestType.GetSnodes:
					return {
						snodes: [
							{
								public_ip: "192.0.2.1",
								storage_port: 22023,
								pubkey_x25519: "aa".repeat(32),
								pubkey_ed25519: "bb".repeat(32),
							},
						],
					};
				case RequestType.GetSwarms:
					return {
						swarms: [
							{
								ip: "192.0.2.2",
								port: "22023",
								pubkey_ed25519: "cc".repeat(32),
								pubkey_x25519: "dd".repeat(32),
							},
						],
					};
				case RequestType.Store:
					return { hash: "selfsync" };
				default:
					throw new Error("unexpected request type " + type);
			}
		},
	};
	const session = createAuthorizedSession(stubNetwork);
	const ownID = session.getSessionID();
	const result = await session.sendCallMessage(
		ownID,
		{ type: SignalService.CallMessage.Type.END_CALL, uuid: UUID },
		{ isSyncMessage: true },
	);
	expect(result.messageHash).toBe("selfsync");
	const storeRequest = requests.find((r) => r.type === RequestType.Store);
	// Self-sync destination is our own Session ID (own swarm)
	expect(storeRequest!.body.destination).toBe(ownID);
});

test("sendCallMessage validates recipient and initialization state", async () => {
	const uninitialized = new Session({ network: offlineNetwork });
	await expect(
		uninitialized.sendCallMessage(PEER, {
			type: SignalService.CallMessage.Type.PRE_OFFER,
			uuid: UUID,
		}),
	).rejects.toThrow(SessionRuntimeError);

	const session = createAuthorizedSession();
	await expect(
		session.sendCallMessage("tooshort", {
			type: SignalService.CallMessage.Type.PRE_OFFER,
			uuid: UUID,
		}),
	).rejects.toThrow(SessionValidationError);
	await expect(
		session.sendCallMessage("06" + "ab".repeat(32), {
			type: SignalService.CallMessage.Type.PRE_OFFER,
			uuid: UUID,
		}),
	).rejects.toThrow(SessionValidationError);
	await expect(
		session.sendCallMessage("05" + "zz".repeat(32), {
			type: SignalService.CallMessage.Type.PRE_OFFER,
			uuid: UUID,
		}),
	).rejects.toThrow(SessionValidationError);
	// Invalid call payloads are rejected by the schema class validation
	await expect(
		session.sendCallMessage(PEER, {
			type: SignalService.CallMessage.Type.OFFER,
			uuid: "not-a-uuid",
		}),
	).rejects.toThrow(SessionValidationError);
});

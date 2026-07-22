// Written fresh from the published protocol facts (docs/closed-groups/
// IMPLEMENTATION.md §2.3/§2.4). MIT-licensable for upstream contribution. See
// docs/evidence/G2-T3.md.
import { expect, test } from "bun:test";
import { SignalService } from "@session.js/types/signal-bindings";
import { SnodeNamespaces } from "@session.js/types/namespaces";
import { RequestType, type RequestStoreBody } from "@session.js/types/network/request";
import type { Network } from "@session.js/types";
import { Session, ready } from "@/index";
import { InMemoryStorage } from "@/storage";
import { extractContent, decodeMessage, decryptMessage } from "@/crypto";
import { encode } from "@session.js/mnemonic";
import { generateSeedHex, getKeysFromSeed, type SessionKeys } from "@session.js/keypair";
import { x25519 } from "@noble/curves/ed25519.js";
import { bytesToHex, hexToBytes } from "@noble/ciphers/utils.js";

await ready;

const GROUP_ADDR = "05" + "11".repeat(32);
const td = new TextDecoder();

const SNODE = {
	public_ip: "10.0.0.1",
	storage_port: 22024,
	pubkey_x25519: "aa",
	pubkey_ed25519: "bb",
};
const SWARM = { ip: "10.0.0.1", port: "22024", pubkey_ed25519: "bb", pubkey_x25519: "aa" };

/** A stub network that records every Store request. */
function stubNetwork(): { network: Network; stores: RequestStoreBody[] } {
	const stores: RequestStoreBody[] = [];
	const network: Network = {
		onRequest: async (type, body) => {
			switch (type) {
				case RequestType.GetSnodes:
					return { snodes: [SNODE] };
				case RequestType.GetSwarms:
					return { swarms: [SWARM] };
				case RequestType.Store:
					stores.push(body as RequestStoreBody);
					return { hash: "hash" + stores.length };
				default:
					throw new Error("unexpected request type " + type);
			}
		},
	};
	return { network, stores };
}

function makeSession(network: Network): Session {
	const session = new Session({ storage: new InMemoryStorage(), network });
	session.setMnemonic(encode(generateSeedHex()));
	return session;
}

function groupEncryptionKeys(): { keys: SessionKeys; pubHex: string } {
	const priv = x25519.utils.randomSecretKey();
	const pub = x25519.getPublicKey(priv);
	return {
		pubHex: bytesToHex(pub),
		keys: {
			x25519: { keyType: "x25519", privateKey: priv, publicKey: pub },
			ed25519: {
				keyType: "ed25519",
				privateKey: new Uint8Array(32),
				publicKey: new Uint8Array(32),
			},
		},
	};
}

/** Decode a stored data64 payload into its envelope (no decryption). */
function decodeStored(data64: string) {
	const body = extractContent(data64)!;
	const envelope = decodeMessage(body)!;
	return { body, envelope };
}

test("sendGroupMessage stores a CLOSED_GROUP_MESSAGE to ns −10, sealed to the group key", async () => {
	const { network, stores } = stubNetwork();
	const session = makeSession(network);
	const group = groupEncryptionKeys();

	const { messageHash } = await session.sendGroupMessage({
		to: GROUP_ADDR,
		encryptionPublicKey: group.pubHex,
		text: "hi group",
	});
	expect(messageHash).toBe("hash1");
	expect(stores).toHaveLength(1);
	expect(stores[0].destination).toBe(GROUP_ADDR);
	expect(stores[0].namespace).toBe(SnodeNamespaces.ClosedGroupMessage); // −10
	expect(
		await (session as unknown as { storage: InMemoryStorage }).storage.has("message_hash:hash1"),
	).toBe(true);

	// The envelope is a CLOSED_GROUP_MESSAGE whose source is the group address.
	const { envelope } = decodeStored(stores[0].data64);
	expect(envelope.type).toBe(SignalService.Envelope.Type.CLOSED_GROUP_MESSAGE);
	expect(envelope.source).toBe(GROUP_ADDR);

	// It decrypts with the group encryption key to the chat message + GroupContext.
	const content = SignalService.Content.decode(
		new Uint8Array(decryptMessage([group.keys], envelope)),
	);
	expect(content.dataMessage?.body).toBe("hi group");
	expect(content.dataMessage?.group?.type).toBe(SignalService.GroupContext.Type.DELIVER);
	expect(td.decode(content.dataMessage!.group!.id ?? undefined)).toBe(GROUP_ADDR);
});

test("sendClosedGroupUpdate (group mode) stores a control message to ns −10", async () => {
	const { network, stores } = stubNetwork();
	const session = makeSession(network);
	const group = groupEncryptionKeys();

	await session.sendClosedGroupUpdate({
		to: GROUP_ADDR,
		encryptionPublicKey: group.pubHex,
		controlMessage: {
			type: SignalService.DataMessage.ClosedGroupControlMessage.Type.NAME_CHANGE,
			name: "renamed",
		},
	});
	expect(stores).toHaveLength(1);
	expect(stores[0].destination).toBe(GROUP_ADDR);
	expect(stores[0].namespace).toBe(SnodeNamespaces.ClosedGroupMessage);

	const { envelope } = decodeStored(stores[0].data64);
	expect(envelope.type).toBe(SignalService.Envelope.Type.CLOSED_GROUP_MESSAGE);
	const content = SignalService.Content.decode(
		new Uint8Array(decryptMessage([group.keys], envelope)),
	);
	const cgcm = content.dataMessage?.closedGroupControlMessage;
	expect(cgcm?.type).toBe(SignalService.DataMessage.ClosedGroupControlMessage.Type.NAME_CHANGE);
	expect(cgcm?.name).toBe("renamed");
});

test("sendClosedGroupUpdate (DM mode) stores a NEW invite to ns 0, sealed to the member", async () => {
	const { network, stores } = stubNetwork();
	const session = makeSession(network);
	const selfId = session.getSessionID();
	const group = groupEncryptionKeys();

	await session.sendClosedGroupUpdate({
		to: selfId, // NEW invite DM to ourselves (a member)
		controlMessage: {
			type: SignalService.DataMessage.ClosedGroupControlMessage.Type.NEW,
			publicKey: hexToBytes(GROUP_ADDR),
			name: "new group",
			members: [hexToBytes(selfId)],
			admins: [hexToBytes(selfId)],
			encryptionKeyPair: {
				publicKey: group.keys.x25519.publicKey,
				privateKey: group.keys.x25519.privateKey,
			},
		},
	});
	expect(stores).toHaveLength(1);
	expect(stores[0].destination).toBe(selfId);
	expect(stores[0].namespace).toBe(SnodeNamespaces.UserMessages); // 0

	// Envelope is a 1:1 SESSION_MESSAGE; decrypts with our own identity key.
	const { envelope } = decodeStored(stores[0].data64);
	expect(envelope.type).toBe(SignalService.Envelope.Type.SESSION_MESSAGE);
	const keys = session.getKeys()!;
	const content = SignalService.Content.decode(new Uint8Array(decryptMessage([keys], envelope)));
	const cgcm = content.dataMessage?.closedGroupControlMessage;
	expect(cgcm?.type).toBe(SignalService.DataMessage.ClosedGroupControlMessage.Type.NEW);
	expect(bytesToHex(cgcm!.publicKey!)).toBe(GROUP_ADDR);
	expect(cgcm?.name).toBe("new group");
	expect(bytesToHex(cgcm!.encryptionKeyPair!.publicKey)).toBe(group.pubHex);
});

test("sendGroupMessage rejects a non-05 group address and a bad encryption key", async () => {
	const { network } = stubNetwork();
	const session = makeSession(network);
	const group = groupEncryptionKeys();
	await expect(
		session.sendGroupMessage({
			to: "03" + "11".repeat(32),
			encryptionPublicKey: group.pubHex,
			text: "x",
		}),
	).rejects.toThrow();
	await expect(
		session.sendGroupMessage({
			to: GROUP_ADDR,
			encryptionPublicKey: "nothex",
			text: "x",
		}),
	).rejects.toThrow();
	await expect(
		session.sendGroupMessage({
			to: GROUP_ADDR,
			encryptionPublicKey: group.pubHex,
			text: "x",
			expirationType: "deleteAfterRead",
			expireTimer: 60,
		}),
	).rejects.toThrow();
});

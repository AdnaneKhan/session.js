import { expect, test } from "bun:test";
import type { Network } from "@session.js/types";
import { SignalService } from "@session.js/types/signal-bindings";
import { RequestType, type RequestStoreBody } from "@session.js/types/network/request";
import { encode } from "@session.js/mnemonic";
import { generateSeedHex } from "@session.js/keypair";
import { x25519 } from "@noble/curves/ed25519.js";
import { Session, ready } from "@/index";
import { InMemoryStorage } from "@/storage";
import { decodeMessage, decryptMessage, extractContent } from "@/crypto";

await ready;

const SNODE = {
	public_ip: "10.0.0.1",
	storage_port: 22024,
	pubkey_x25519: "aa",
	pubkey_ed25519: "bb",
};
const SWARM = { ip: "10.0.0.1", port: "22024", pubkey_ed25519: "bb", pubkey_x25519: "aa" };

function recordingNetwork(): { network: Network; stores: RequestStoreBody[] } {
	const stores: RequestStoreBody[] = [];
	return {
		stores,
		network: {
			onRequest: async (type, body) => {
				switch (type) {
					case RequestType.GetSnodes:
						return { snodes: [SNODE] };
					case RequestType.GetSwarms:
						return { swarms: [SWARM] };
					case RequestType.Store:
						stores.push(body as RequestStoreBody);
						return { hash: "config-hash" };
					default:
						throw new Error(`unexpected request type ${type}`);
				}
			},
		},
	};
}

test("other configuration sends retain the full closed-group snapshot and avatar", async () => {
	const { network, stores } = recordingNetwork();
	const session = new Session({ storage: new InMemoryStorage(), network });
	session.setMnemonic(encode(generateSeedHex()));
	const self = session.getSessionID();
	const groupId = "05" + "19".repeat(32);
	const privateKey = x25519.utils.randomSecretKey();
	const publicKey = x25519.getPublicKey(privateKey);
	const avatar = { key: new Uint8Array(32).fill(7), url: "https://example.invalid/avatar" };
	(session as unknown as { avatar: typeof avatar }).avatar = avatar;
	session.setConfigurationClosedGroups([
		{
			publicKey: groupId,
			name: "persisted group",
			encryptionKeyPair: { publicKey, privateKey },
			members: [self],
			admins: [self],
		},
	]);

	await session.setDisplayName("Alice");
	expect(stores).toHaveLength(1);
	const body = extractContent(stores[0].data64)!;
	const envelope = decodeMessage(body)!;
	const content = SignalService.Content.decode(
		new Uint8Array(decryptMessage([session.getKeys()!], envelope)),
	);
	const config = content.configurationMessage!;
	expect(config.closedGroups).toHaveLength(1);
	expect(config.closedGroups[0].name).toBe("persisted group");
	expect(config.profilePicture).toBe(avatar.url);
	expect(config.profileKey).toEqual(avatar.key);
});

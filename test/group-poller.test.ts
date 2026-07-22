// Written fresh from the published protocol facts (docs/closed-groups/
// IMPLEMENTATION.md §2.3). MIT-licensable for upstream contribution. See
// docs/evidence/G2-T2.md.
import { expect, test } from "bun:test";
import { SignalService } from "@session.js/types/signal-bindings";
import { SnodeNamespaces } from "@session.js/types/namespaces";
import type { ResponsePoll } from "@session.js/types/network/response";
import type { RequestPollBody } from "@session.js/types/network/request";
import type { Swarm } from "@session.js/types/swarm";
import type { SessionKeys } from "@session.js/keypair";
import { generateSeedHex, getKeysFromSeed } from "@session.js/keypair";
import { x25519 } from "@noble/curves/ed25519.js";
import { bytesToHex } from "@noble/ciphers/utils.js";
import { base64 } from "@scure/base";
import { wrap } from "@/crypto";
import { GroupPoller, type GroupPollerMessage } from "@/polling";
import { InMemoryStorage } from "@/storage";

const GROUP_ADDR = "05" + "11".repeat(32);
const td = new TextDecoder();
const te = new TextEncoder();

const SWARM: Swarm = { ip: "10.0.0.1", port: "22024", pubkey_ed25519: "aa", pubkey_x25519: "bb" };

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

/** Build a real wire-format group message (sealed to the group encryption key). */
async function buildGroupMessage(
	sender: SessionKeys,
	groupEncPubHex: string,
	body: string,
	timestamp: number,
): Promise<{ data: string; hash: string }> {
	const content = new SignalService.Content({
		dataMessage: {
			body,
			timestamp,
			group: {
				id: new Uint8Array(te.encode(GROUP_ADDR)),
				type: SignalService.GroupContext.Type.DELIVER,
			},
		},
	});
	const [wrapped] = await wrap(
		sender,
		[
			{
				destination: GROUP_ADDR,
				encryptionPublicKey: groupEncPubHex,
				plainTextBuffer: SignalService.Content.encode(content).finish(),
				namespace: SnodeNamespaces.ClosedGroupMessage,
				ttl: 14 * 24 * 60 * 60 * 1000,
				identifier: "id-" + body,
				isSyncMessage: false,
				isGroup: true,
			},
		],
		{ networkTimestamp: timestamp },
	);
	return { data: wrapped.data64, hash: "hash-" + body };
}

type Harness = {
	poller: GroupPoller;
	received: GroupPollerMessage[];
	lastRequest: RequestPollBody | undefined;
	storage: InMemoryStorage;
	setItems: (items: { hash: string; data: string }[]) => void;
};

function makeHarness(
	groupKeys: SessionKeys,
	ourPubKey: string,
	now?: () => number,
	onMessagesReceived?: (messages: GroupPollerMessage[]) => void,
): Harness {
	let items: { hash: string; data: string }[] = [];
	const received: GroupPollerMessage[] = [];
	let lastRequest: RequestPollBody | undefined;
	const storage = new InMemoryStorage();

	const poller = new GroupPoller({
		groupPubKey: GROUP_ADDR,
		ourPubKey,
		getEncryptionKeyPairs: () => [groupKeys],
		request: async (body: RequestPollBody): Promise<ResponsePoll> => {
			lastRequest = body;
			return {
				messages: [
					{
						namespace: SnodeNamespaces.ClosedGroupMessage,
						messages: items.map((i) => ({
							hash: i.hash,
							data: i.data,
							expiration: 0,
							timestamp: 0,
						})),
					},
				],
			};
		},
		getSwarmsFor: async () => [SWARM],
		storage,
		onMessagesReceived: onMessagesReceived ?? ((msgs) => received.push(...msgs)),
		now,
	});

	return {
		poller,
		received,
		storage,
		get lastRequest() {
			return lastRequest;
		},
		setItems: (next) => {
			items = next;
		},
	};
}

test("GroupPoller polls ns −10 unauthenticated and decrypts a group message", async () => {
	const sender = getKeysFromSeed(generateSeedHex());
	const group = groupEncryptionKeys();
	const ourKeys = getKeysFromSeed(generateSeedHex());
	const ourPubKey = bytesToHex(ourKeys.x25519.publicKey);

	const h = makeHarness(group.keys, ourPubKey);
	const msg = await buildGroupMessage(sender, group.pubHex, "hello", 1751000000000);
	h.setItems([msg]);

	const out = await h.poller.poll();
	expect(out).toHaveLength(1);
	expect(h.received).toHaveLength(1);
	expect(h.received[0].content.dataMessage?.body).toBe("hello");
	// Real author recovered from the sealed box.
	expect(h.received[0].envelope.senderIdentity).toBe(bytesToHex(sender.x25519.publicKey));
	// Envelope source is the group address.
	expect(h.received[0].envelope.source).toBe(GROUP_ADDR);

	// The retrieve request targeted the group's swarm over namespace −10,
	// unauthenticated (isOurPubkey false, 05-prefixed pubkey).
	const ns = h.lastRequest!.namespaces[0];
	expect(ns.namespace).toBe(SnodeNamespaces.ClosedGroupMessage);
	expect(ns.pubkey).toBe(GROUP_ADDR);
	expect(ns.isOurPubkey).toBe(false);
	expect(h.lastRequest!.swarm).toEqual(SWARM);
});

test("GroupPoller uses hash dedupe so linked devices receive same-account messages", async () => {
	const ourKeys = getKeysFromSeed(generateSeedHex());
	const ourPubKey = bytesToHex(ourKeys.x25519.publicKey);
	const group = groupEncryptionKeys();

	const linkedDevice = makeHarness(group.keys, ourPubKey);
	// We are the author of this one.
	const own = await buildGroupMessage(ourKeys, group.pubHex, "mine", 1751000000000);
	const other = getKeysFromSeed(generateSeedHex());
	const theirs = await buildGroupMessage(other, group.pubHex, "theirs", 1751000000001);
	linkedDevice.setItems([own, theirs]);

	// A linked device has separate storage, so it receives both the same-account
	// message and the other member's message.
	const linkedOut = await linkedDevice.poller.poll();
	expect(linkedOut).toHaveLength(2);
	expect(linkedOut.map((m) => m.content.dataMessage?.body)).toEqual(["mine", "theirs"]);

	// The sending device records the returned store hash before polling, so only
	// its local network echo is suppressed.
	const sendingDevice = makeHarness(group.keys, ourPubKey);
	await sendingDevice.storage.set("message_hash:" + own.hash, "1");
	sendingDevice.setItems([own, theirs]);
	const out = await sendingDevice.poller.poll();
	expect(out).toHaveLength(1);
	expect(out[0].content.dataMessage?.body).toBe("theirs");
});

test("GroupPoller skips a malformed envelope without losing valid messages in the page", async () => {
	const sender = getKeysFromSeed(generateSeedHex());
	const group = groupEncryptionKeys();
	const ourPubKey = bytesToHex(getKeysFromSeed(generateSeedHex()).x25519.publicKey);
	const h = makeHarness(group.keys, ourPubKey);
	const good = await buildGroupMessage(sender, group.pubHex, "survives", 1751000000000);
	const malformed = base64.encode(
		SignalService.WebSocketMessage.encode(
			new SignalService.WebSocketMessage({
				type: SignalService.WebSocketMessage.Type.REQUEST,
				request: { body: new Uint8Array([0xff]) },
			}),
		).finish(),
	);
	h.setItems([{ hash: "poison", data: malformed }, good]);

	const out = await h.poller.poll();
	expect(out).toHaveLength(1);
	expect(out[0].content.dataMessage?.body).toBe("survives");

	// The page was fully handled, so only now is its final cursor committed.
	h.setItems([]);
	await h.poller.poll();
	expect(h.lastRequest!.namespaces[0].lastHash).toBe(good.hash);
});

test("GroupPoller does not commit hashes or cursor when consumer delivery fails", async () => {
	const sender = getKeysFromSeed(generateSeedHex());
	const group = groupEncryptionKeys();
	const ourPubKey = bytesToHex(getKeysFromSeed(generateSeedHex()).x25519.publicKey);
	let failDelivery = true;
	const delivered: GroupPollerMessage[] = [];
	const h = makeHarness(group.keys, ourPubKey, undefined, (messages) => {
		if (failDelivery) throw new Error("consumer failed");
		delivered.push(...messages);
	});
	const message = await buildGroupMessage(sender, group.pubHex, "retry-me", 1751000000000);
	h.setItems([message]);

	await expect(h.poller.poll()).rejects.toThrow("consumer failed");
	expect(await h.storage.has("message_hash:" + message.hash)).toBe(false);
	expect(await h.storage.get(`closed_group:${GROUP_ADDR}:last_hashes`)).toBeNull();

	failDelivery = false;
	const retried = await h.poller.poll();
	expect(retried).toHaveLength(1);
	expect(delivered[0].content.dataMessage?.body).toBe("retry-me");
});

test("GroupPoller advances lastHash and dedupes by message_hash across polls", async () => {
	const sender = getKeysFromSeed(generateSeedHex());
	const group = groupEncryptionKeys();
	const ourPubKey = bytesToHex(getKeysFromSeed(generateSeedHex()).x25519.publicKey);

	const h = makeHarness(group.keys, ourPubKey);
	const msg = await buildGroupMessage(sender, group.pubHex, "once", 1751000000000);
	h.setItems([msg]);

	await h.poller.poll();
	expect(h.received).toHaveLength(1);
	expect(h.lastRequest!.namespaces[0].lastHash).toBeUndefined();

	// Second poll: server still returns the same message, but lastHash advanced
	// and message_hash dedupe suppresses re-delivery.
	await h.poller.poll();
	expect(h.lastRequest!.namespaces[0].lastHash).toBe("hash-once");
	expect(h.received).toHaveLength(1); // not re-emitted
});

test("GroupPoller cadence scales with last activity", () => {
	let now = 10_000_000;
	const group = groupEncryptionKeys();
	const h = makeHarness(group.keys, "05" + "ab".repeat(32), () => now);
	// Just created → active window → 5 s.
	expect(h.poller.computeInterval()).toBe(5_000);
	// 3 days idle → medium → 60 s.
	now += 3 * 24 * 60 * 60 * 1000;
	expect(h.poller.computeInterval()).toBe(60_000);
	// 8 days idle (from creation) → inactive → 120 s.
	now += 5 * 24 * 60 * 60 * 1000;
	expect(h.poller.computeInterval()).toBe(120_000);
});

test("GroupPoller requires a 05-prefixed group pubkey", () => {
	const group = groupEncryptionKeys();
	expect(
		() =>
			new GroupPoller({
				groupPubKey: "03" + "11".repeat(32),
				ourPubKey: "05" + "ab".repeat(32),
				getEncryptionKeyPairs: () => [group.keys],
				request: async () => ({ messages: [] }),
				getSwarmsFor: async () => [SWARM],
				storage: new InMemoryStorage(),
				onMessagesReceived: () => {},
			}),
	).toThrow();
});

test("GroupPoller caches undecryptable messages and retries them once a new keypair arrives", async () => {
	const sender = getKeysFromSeed(generateSeedHex());
	const oldKey = groupEncryptionKeys();
	const newKey = groupEncryptionKeys();
	const ourPubKey = bytesToHex(getKeysFromSeed(generateSeedHex()).x25519.publicKey);

	// Message encrypted to the NEW key, but we only hold the OLD key at first.
	const msg = await buildGroupMessage(sender, newKey.pubHex, "future", 1751000000000);

	let keys: SessionKeys[] = [oldKey.keys];
	let items = [msg];
	const delivered: GroupPollerMessage[] = [];
	const poller = new GroupPoller({
		groupPubKey: GROUP_ADDR,
		ourPubKey,
		getEncryptionKeyPairs: () => keys,
		request: async () => ({
			messages: [
				{
					namespace: SnodeNamespaces.ClosedGroupMessage,
					messages: items.map((i) => ({ hash: i.hash, data: i.data, expiration: 0, timestamp: 0 })),
				},
			],
		}),
		getSwarmsFor: async () => [SWARM],
		storage: new InMemoryStorage(),
		onMessagesReceived: (m) => delivered.push(...m),
	});

	// First poll: can't decrypt → cached, nothing delivered.
	expect(await poller.poll()).toHaveLength(0);
	expect(delivered).toHaveLength(0);

	// The NEW keypair arrives (rotation). Nothing new on the swarm this round.
	keys = [oldKey.keys, newKey.keys];
	items = [];
	const retried = await poller.poll();
	expect(retried).toHaveLength(1);
	expect(retried[0].content.dataMessage?.body).toBe("future");
	expect(retried[0].envelope.senderIdentity).toBe(bytesToHex(sender.x25519.publicKey));
	expect(delivered).toHaveLength(1);

	// Cache is now drained: a further empty poll delivers nothing.
	expect(await poller.poll()).toHaveLength(0);
});

test("GroupPoller decrypts an in-flight message with a historical (rotated-out) key", async () => {
	const sender = getKeysFromSeed(generateSeedHex());
	const oldKey = groupEncryptionKeys();
	const newKey = groupEncryptionKeys();
	const ourPubKey = bytesToHex(getKeysFromSeed(generateSeedHex()).x25519.publicKey);

	// Encrypted to the OLD key (sent before the rotation landed).
	const msg = await buildGroupMessage(sender, oldKey.pubHex, "inflight", 1751000000000);
	const items = [msg];
	const delivered: GroupPollerMessage[] = [];
	const poller = new GroupPoller({
		groupPubKey: GROUP_ADDR,
		ourPubKey,
		getEncryptionKeyPairs: () => [oldKey.keys, newKey.keys],
		request: async () => ({
			messages: [
				{
					namespace: SnodeNamespaces.ClosedGroupMessage,
					messages: items.map((i) => ({ hash: i.hash, data: i.data, expiration: 0, timestamp: 0 })),
				},
			],
		}),
		getSwarmsFor: async () => [SWARM],
		storage: new InMemoryStorage(),
		onMessagesReceived: (m) => delivered.push(...m),
	});

	const out = await poller.poll();
	expect(out).toHaveLength(1);
	expect(out[0].content.dataMessage?.body).toBe("inflight");
});

test("GroupPoller with no keypairs delivers nothing (undecryptable path)", async () => {
	const sender = getKeysFromSeed(generateSeedHex());
	const group = groupEncryptionKeys();
	const ourPubKey = bytesToHex(getKeysFromSeed(generateSeedHex()).x25519.publicKey);

	const msg = await buildGroupMessage(sender, group.pubHex, "locked", 1751000000000);
	// A poller with an empty keypair registry cannot decrypt → delivers nothing.
	const emptyPoller = new GroupPoller({
		groupPubKey: GROUP_ADDR,
		ourPubKey,
		getEncryptionKeyPairs: () => [],
		request: async () => ({
			messages: [
				{
					namespace: SnodeNamespaces.ClosedGroupMessage,
					messages: [{ hash: msg.hash, data: msg.data, expiration: 0, timestamp: 0 }],
				},
			],
		}),
		getSwarmsFor: async () => [SWARM],
		storage: new InMemoryStorage(),
		onMessagesReceived: () => {
			throw new Error("should not be called");
		},
	});
	const out = await emptyPoller.poll();
	expect(out).toHaveLength(0);
});

import { SignalService } from "@session.js/types/signal-bindings";
import type { EnvelopePlus } from "@session.js/types/envelope";
import { bytesToHex } from "@noble/ciphers/utils.js";
import { deserializeProfile, type Profile } from "@/profile";
import { getPlaceholderDisplayName } from "@/utils";

export type PrivateMessage = {
	type: "private";
};

export type ClosedGroupMessage = {
	type: "group";
	groupId: string;
};

export type MessageAttachment = {
	id: string;
	caption?: string;
	metadata: {
		width?: number;
		height?: number;
		contentType?: string;
	};
	/** Size of attached file in bytes */
	size?: number;
	/** Filename including extension */
	name?: string;
	/** For internal decryption purposes */
	_key?: Uint8Array;
	/** For internal decryption purposes */
	_digest?: Uint8Array;
};

export type Message = (PrivateMessage | ClosedGroupMessage) & {
	id: string;
	from: string;
	author: Profile;
	text?: string;
	attachments: MessageAttachment[];
	replyToMessage?: {
		timestamp: number;
		author: string;
		text?: string;
		attachments?: QuotedAttachment[];
	};
	timestamp: number;
	getEnvelope: () => EnvelopePlus;
	getContent: () => SignalService.Content;
	getReplyToMessage: () => Message["replyToMessage"];
};

export type SyncMessage = Omit<Message, "from"> & { to: string };

export type QuotedAttachment = {
	contentType?: string;
	fileName?: string;
};

type Content = {
	hash: string;
	envelope: EnvelopePlus;
	content: SignalService.Content;
};

export function mapDataMessage({ hash, envelope, content }: Content): Message {
	const isGroup = envelope.type === SignalService.Envelope.Type.CLOSED_GROUP_MESSAGE;
	let groupId: string | undefined;
	let from: string;
	if (isGroup) {
		groupId = envelope.source;
		from = envelope.senderIdentity;
	} else {
		from = envelope.source;
	}
	let timestamp = envelope.timestamp;
	if (typeof timestamp !== "number") {
		timestamp = timestamp.toNumber();
	}
	const attachments = content.dataMessage?.attachments
		? parseAttachments(content.dataMessage.attachments)
		: [];
	const author = deserializeProfile({
		lokiProfile: content.dataMessage!.profile ?? undefined,
		profileKey: content.dataMessage!.profileKey ?? undefined,
	});
	author.displayName ||= getPlaceholderDisplayName(from);
	return {
		id: hash,
		...(isGroup
			? {
					type: "group",
					groupId: groupId as string,
				}
			: {
					type: "private",
				}),
		from,
		author,
		...(content.dataMessage!.syncTarget && {
			to: content.dataMessage!.syncTarget,
		}),
		...(typeof content.dataMessage?.body === "string" && { text: content.dataMessage.body }),
		attachments,
		...(content.dataMessage?.quote && { replyToMessage: parseQuote(content.dataMessage.quote) }),
		timestamp,
		getEnvelope: () => envelope,
		getContent: () => content,
		getReplyToMessage: () => ({
			author: from,
			timestamp: timestamp,
			attachments: attachments.map((a) => ({
				...(a.metadata.contentType && { contentType: a.metadata.contentType }),
				...(a.name && { fileName: a.name }),
			})),
			...(typeof content.dataMessage?.body === "string" && { text: content.dataMessage?.body }),
		}),
	};
}

export function parseAttachments(
	attachments: SignalService.IAttachmentPointer[],
): Message["attachments"] {
	return attachments.map((attachment) => ({
		id: attachment.id.toString(),
		...(attachment.caption && { caption: attachment.caption }),
		metadata: {
			...(typeof attachment.width === "number" && { width: attachment.width }),
			...(typeof attachment.height === "number" && { height: attachment.height }),
			...(attachment.contentType && { contentType: attachment.contentType }),
		},
		...(typeof attachment.size === "number" && { size: attachment.size }),
		...(attachment.fileName && { name: attachment.fileName }),
		...(attachment.key && { _key: attachment.key }),
		...(attachment.digest && { _digest: attachment.digest }),
	}));
}

export function parseQuote(quote: SignalService.DataMessage.IQuote): Message["replyToMessage"] {
	let id = quote.id;
	if (typeof id !== "number") {
		id = id.toNumber();
	}
	return {
		timestamp: id,
		author: quote.author,
		...(quote.text && { text: quote.text }),
		...(quote.attachments && {
			attachments: quote.attachments.map((a) => ({
				...(a.contentType && { contentType: a.contentType }),
				...(a.fileName && { fileName: a.fileName }),
			})),
		}),
	};
}

export type MessageDeleted = {
	/** Timestamp of deleted message sent in that message constructor. Lookup message by timestamp in saved messages */
	timestamp: number;
	/** Sender of message that deleted it */
	from: string;
};
export function mapUnsendMessage({ content }: Content): MessageDeleted {
	let timestamp = content.unsendMessage!.timestamp;
	if (typeof timestamp !== "number") {
		timestamp = timestamp.toNumber();
	}
	return {
		timestamp,
		from: content.unsendMessage!.author,
	};
}

export type MessageReadEvent = {
	/** Timestamp of read message sent in this message constructor. Lookup message by timestamp among locally saved messages */
	timestamp: number;
	/** Timestamp when recipient of message read it */
	// readAt: number, TODO: ReadReceiptMessage has timestamp property, but it does not exist in Signal bindings
	/** Session ID of conversation where message was read */
	conversation: string;
};
export function mapReceiptMessage({ content, envelope }: Content): MessageReadEvent[] {
	const timestamps = content.receiptMessage!.timestamp;
	if (timestamps === null || timestamps === undefined) {
		return [];
	}
	const timestampsNumbers = timestamps.map((t) => {
		if (typeof t !== "number") {
			return t.toNumber();
		}
		return t;
	});
	return timestampsNumbers.map((t) => ({ timestamp: t, conversation: envelope.source }));
}

export type MessageTypingIndicator = {
	/** If true, you should countdown from 20 and then treat it like recipient stopped typing */
	isTyping: boolean;
	/** Session ID of conversation where typing indicator appeared or disappeared */
	conversation: string;
};
export function mapTypingMessage({ content, envelope }: Content): MessageTypingIndicator {
	const isTyping = content.typingMessage!.action === SignalService.TypingMessage.Action.STARTED;
	return {
		isTyping,
		conversation: envelope.source,
	};
}

export type ScreenshotTakenNotification = {
	/** Timestamp when screenshot was taken */
	timestamp: number;
	/** Session ID of conversation where notification appeared */
	conversation: string;
};
export function mapScreenshotTakenMessage({
	content,
	envelope,
}: Content): ScreenshotTakenNotification {
	let timestamp = content.dataExtractionNotification!.timestamp;
	if (timestamp === null || timestamp === undefined) {
		timestamp = 0;
	} else {
		if (typeof timestamp !== "number") {
			timestamp = timestamp.toNumber();
		}
	}
	return {
		timestamp,
		conversation: envelope.source,
	};
}

export type MediaSavedNotification = {
	/** Message's timestamp which has attachment that was downloaded */
	timestamp: number;
	/** Session ID of conversation where notification appeared */
	conversation: string;
};
export function mapMediaSavedMessage({ content, envelope }: Content): MediaSavedNotification {
	let timestamp = content.dataExtractionNotification!.timestamp;
	if (timestamp === null || timestamp === undefined) {
		timestamp = 0;
	} else {
		if (typeof timestamp !== "number") {
			timestamp = timestamp.toNumber();
		}
	}
	return {
		timestamp,
		conversation: envelope.source,
	};
}

export type MessageRequestResponse = {
	profile: Profile;
	conversation: string;
};
export function mapMessageRequestResponseMessage({
	content,
	envelope,
}: Content): MessageRequestResponse {
	const profile = deserializeProfile({
		lokiProfile: content.messageRequestResponse!.profile ?? undefined,
		profileKey: content.messageRequestResponse!.profileKey ?? undefined,
	});
	profile.displayName ||= getPlaceholderDisplayName(envelope.source);
	return {
		profile,
		conversation: envelope.source,
	};
}

// Fork addition (calls support): CallMessage type + mapCallMessage mapper.
// Written fresh from the published SessionProtos.proto field facts —
// SPDX-License-Identifier: MIT, (c) 2026 AdnaneKhan, upstreamable.
export type CallMessage = {
	uuid: string;
	type: SignalService.CallMessage.Type;
	from: string;
	/** Envelope timestamp in milliseconds */
	timestamp: number;
	/** SDP offers/answers for OFFER/ANSWER or ICE candidates for ICE_CANDIDATES */
	sdps: string[];
	/** Parallel array to `sdps`, only set for ICE_CANDIDATES */
	sdpMLineIndexes: number[];
	/** Parallel array to `sdps`, only set for ICE_CANDIDATES */
	sdpMids: string[];
};
export function mapCallMessage({ content, envelope }: Content): CallMessage {
	const c = content.callMessage!;
	let timestamp = envelope.timestamp;
	if (typeof timestamp !== "number") {
		timestamp = timestamp.toNumber();
	}
	return {
		uuid: c.uuid,
		type: c.type,
		from: envelope.source,
		timestamp,
		sdps: [...(c.sdps ?? [])],
		sdpMLineIndexes: [...(c.sdpMLineIndexes ?? [])],
		sdpMids: [...(c.sdpMids ?? [])],
	};
}

// Fork addition (closed-groups support): ClosedGroupUpdate type +
// mapClosedGroupControlMessage mapper. Written fresh from the published
// SessionProtos.proto field facts — SPDX-License-Identifier: MIT,
// (c) 2026 AdnaneKhan, upstreamable.
export type ClosedGroupUpdate = {
	type: SignalService.DataMessage.ClosedGroupControlMessage.Type;
	/** Group public key (05…hex). From the explicit `publicKey` field when present (NEW invites / keypair replies), else the group-swarm envelope `source`. */
	groupId: string;
	/** The actual author (05…hex). `senderIdentity` for group-swarm messages, envelope `source` for 1:1 DMs. */
	from: string;
	/** True when this arrived as a CLOSED_GROUP_MESSAGE envelope (group swarm, ns −10); false for a 1:1 DM (NEW invite / keypair reply, ns 0). */
	isGroupMessage: boolean;
	/** Envelope timestamp in milliseconds. */
	timestamp: number;
	/** Explicit group public key (05…hex) — NEW and ENCRYPTION_KEY_PAIR replies only. */
	publicKey?: string;
	/** Group display name — NEW and NAME_CHANGE. */
	name?: string;
	/** Plaintext group encryption keypair — NEW only (travels inside the sealed box). */
	encryptionKeyPair?: { publicKey: Uint8Array; privateKey: Uint8Array };
	/** Member public keys (05…hex) — NEW / MEMBERS_ADDED / MEMBERS_REMOVED. */
	members: string[];
	/** Admin public keys (05…hex) — NEW. */
	admins: string[];
	/** Per-member wrapped keypairs — ENCRYPTION_KEY_PAIR. `publicKey` is 05…hex; `encryptedKeyPair` is the sealed, unpadded KeyPair-proto bytes. */
	wrappers: Array<{ publicKey: string; encryptedKeyPair: Uint8Array }>;
	/** Disappearing-message timer in seconds (deleteAfterSend) — NEW. */
	expirationTimer?: number;
};
export function mapClosedGroupControlMessage({ content, envelope }: Content): ClosedGroupUpdate {
	const c = content.dataMessage!.closedGroupControlMessage!;
	const isGroupMessage = envelope.type === SignalService.Envelope.Type.CLOSED_GROUP_MESSAGE;
	let timestamp = envelope.timestamp;
	if (typeof timestamp !== "number") {
		timestamp = timestamp.toNumber();
	}
	const explicitGroupKey = c.publicKey?.length ? bytesToHex(c.publicKey) : undefined;
	return {
		type: c.type,
		groupId: explicitGroupKey ?? envelope.source,
		from: isGroupMessage ? envelope.senderIdentity : envelope.source,
		isGroupMessage,
		timestamp,
		...(explicitGroupKey && { publicKey: explicitGroupKey }),
		...(c.name !== undefined && c.name !== null && { name: c.name }),
		...(c.encryptionKeyPair && {
			encryptionKeyPair: {
				publicKey: new Uint8Array(c.encryptionKeyPair.publicKey),
				privateKey: new Uint8Array(c.encryptionKeyPair.privateKey),
			},
		}),
		members: (c.members ?? []).map((m) => bytesToHex(m)),
		admins: (c.admins ?? []).map((a) => bytesToHex(a)),
		wrappers: (c.wrappers ?? []).map((w) => ({
			publicKey: bytesToHex(w.publicKey),
			encryptedKeyPair: new Uint8Array(w.encryptedKeyPair),
		})),
		...(c.expirationTimer !== undefined &&
			c.expirationTimer !== null && { expirationTimer: c.expirationTimer }),
	};
}

// Fork addition (closed-groups support): parse the legacy
// ConfigurationMessage.closedGroups carried in a multi-device config sync
// (each entry = { publicKey, name, encryptionKeyPair } plus members/admins).
// Written fresh — SPDX-License-Identifier: MIT, (c) 2026 AdnaneKhan, upstreamable.
export type ClosedGroupConfig = {
	/** Group public key (05…hex). */
	publicKey: string;
	name: string;
	/** Latest group encryption keypair (unprefixed 32-byte keys). */
	encryptionKeyPair: { publicKey: Uint8Array; privateKey: Uint8Array };
	/** Member public keys (05…hex). */
	members: string[];
	/** Admin public keys (05…hex). */
	admins: string[];
};
export function mapConfigurationClosedGroups(content: SignalService.Content): ClosedGroupConfig[] {
	const groups = content.configurationMessage?.closedGroups ?? [];
	return groups
		.filter((g) => g.publicKey?.length && g.encryptionKeyPair)
		.map((g) => ({
			publicKey: bytesToHex(g.publicKey!),
			name: g.name ?? "",
			encryptionKeyPair: {
				publicKey: new Uint8Array(g.encryptionKeyPair!.publicKey),
				privateKey: new Uint8Array(g.encryptionKeyPair!.privateKey),
			},
			members: (g.members ?? []).map((m) => bytesToHex(m)),
			admins: (g.admins ?? []).map((a) => bytesToHex(a)),
		}));
}

/**
 * Map an authoritative closed-group snapshot without silently dropping malformed
 * wire entries. Field-level validation remains with GroupManager; null means the
 * mapper had to omit an entry and the snapshot must not be reconciled.
 */
export function mapCompleteConfigurationClosedGroups(
	content: SignalService.Content,
): ClosedGroupConfig[] | null {
	const encodedCount = content.configurationMessage?.closedGroups?.length ?? 0;
	const mapped = mapConfigurationClosedGroups(content);
	return mapped.length === encodedCount ? mapped : null;
}

export type ReactionMessage = {
	messageTimestamp: number;
	messageAuthor: string;
	reactionFrom: string;
	/** Emoji as string. Any unicode character(s) may be in this field, length is practically unlimited, validation is not performed by the @session.js/client library. You should probably only display the reaction, if it's a single valid emoji */
	emoji: string;
};
export function mapReactionMessage({ content, envelope }: Content): ReactionMessage | null {
	let messageTimestamp = content.dataMessage?.reaction!.id;
	if (messageTimestamp === null || messageTimestamp === undefined) return null;
	const emoji = content.dataMessage?.reaction?.emoji;
	if (!emoji) return null;
	const author = content.dataMessage?.reaction?.author;
	if (!author) return null;
	if (typeof messageTimestamp !== "number") {
		messageTimestamp = messageTimestamp.toNumber();
	}
	return {
		messageTimestamp,
		messageAuthor: author,
		emoji,
		reactionFrom: envelope.source,
	};
}

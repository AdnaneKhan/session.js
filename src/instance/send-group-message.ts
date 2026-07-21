// SPDX-License-Identifier: MIT
// Fork addition (closed-groups support): public instance methods to send legacy
// closed-group chat messages and control messages. Written fresh from the
// published protocol facts (docs/closed-groups/IMPLEMENTATION.md §2.3/§2.4) —
// (c) 2026 AdnaneKhan, upstreamable. See docs/evidence/G2-T3.md.
import { wrap } from "@/crypto/message-encrypt";
import type { Session } from "@/instance";
import {
	ClosedGroupControlMessage,
	type ClosedGroupControlMessageParams,
} from "@/messages/schema/closed-group-control-message";
import { VisibleMessage } from "@/messages/schema/visible-message";
import { toRawMessage } from "@/messages/signal-message";
import { SnodeNamespaces } from "@session.js/types";
import type { DisappearingMessageType } from "@session.js/types/disappearing-message";
import {
	SessionRuntimeError,
	SessionRuntimeErrorCode,
	SessionValidationError,
	SessionValidationErrorCode,
} from "@session.js/errors";

const HEX_66 = /^05([0-9a-f]{2}){32}$/i;
const HEX_64 = /^([0-9a-f]{2}){32}$/i;

function assertSessionId(to: string): void {
	if (to.length !== 66 || !HEX_66.test(to)) {
		throw new SessionValidationError({
			code: SessionValidationErrorCode.InvalidSessionID,
			message: "Group/member public key must be a 05-prefixed 66-char hex string",
		});
	}
}

function assertEncryptionKey(encryptionPublicKey: string): void {
	if (!HEX_64.test(encryptionPublicKey)) {
		throw new SessionValidationError({
			code: SessionValidationErrorCode.InvalidOptions,
			message: "Group encryption public key must be an unprefixed 32-byte (64-char) hex string",
		});
	}
}

/**
 * Send a visible chat message to a legacy closed group. The message is sealed
 * to the group's latest encryption key, wrapped in a CLOSED_GROUP_MESSAGE
 * envelope whose `source` is the group address, and stored to the group's swarm
 * at namespace −10. Carries a `GroupContext` (id = utf8(group id), DELIVER).
 */
export async function sendGroupMessage(
	this: Session,
	{
		to,
		encryptionPublicKey,
		text,
		timestamp,
		expirationType,
		expireTimer,
	}: {
		/** Group public key (05-prefixed, 66 chars) — the swarm to store to. */
		to: string;
		/** Group's latest encryption x25519 public key (unprefixed 64-char hex) to seal to. */
		encryptionPublicKey: string;
		text?: string;
		timestamp?: number;
		/** Closed groups only support `deleteAfterSend` (or none). */
		expirationType?: DisappearingMessageType;
		expireTimer?: number;
	},
): Promise<{ messageHash: string; timestamp: number }> {
	if (!this.sessionID || !this.keys)
		throw new SessionRuntimeError({
			code: SessionRuntimeErrorCode.EmptyUser,
			message: "Instance is not initialized; use setMnemonic first",
		});
	assertSessionId(to);
	assertEncryptionKey(encryptionPublicKey);

	const ts = timestamp ?? this.getNowWithNetworkOffset();
	const msg = new VisibleMessage({
		body: text,
		profile: this.getMyProfile(),
		timestamp: ts,
		expirationType: expirationType ?? "unknown",
		expireTimer: expireTimer ?? 0,
		groupContext: { groupId: to },
	});

	const rawMessage = toRawMessage(to, msg, SnodeNamespaces.ClosedGroupMessage, true);
	const [wrappedMessage] = await wrap(
		this.keys,
		[
			{
				destination: to,
				encryptionPublicKey,
				plainTextBuffer: rawMessage.plainTextBuffer,
				namespace: rawMessage.namespace,
				ttl: rawMessage.ttl,
				identifier: rawMessage.identifier,
				isSyncMessage: false,
				isGroup: true,
			},
		],
		{ networkTimestamp: ts },
	);
	const messageHash = await this._storeMessage({ message: rawMessage, data: wrappedMessage });
	return { messageHash, timestamp: ts };
}

/**
 * Send a legacy closed-group control message (NEW / NAME_CHANGE / MEMBERS_* /
 * MEMBER_LEFT / ENCRYPTION_KEY_PAIR).
 *
 * Routing:
 * - **Group swarm** (`encryptionPublicKey` provided): sealed to the group
 *   encryption key, CLOSED_GROUP_MESSAGE envelope (source = `to` = group
 *   address), namespace −10. Used for NAME_CHANGE / MEMBERS_* / MEMBER_LEFT /
 *   rotation ENCRYPTION_KEY_PAIR.
 * - **1:1 DM** (`encryptionPublicKey` omitted): sealed to the member identity
 *   key `to`, SESSION_MESSAGE envelope, namespace 0. Used for NEW invites and
 *   ENCRYPTION_KEY_PAIR replies (which carry an explicit `publicKey`).
 */
export async function sendClosedGroupUpdate(
	this: Session,
	{
		to,
		controlMessage,
		encryptionPublicKey,
		timestamp,
	}: {
		/** Destination: group address (group mode) or member public key (DM mode), 05-prefixed. */
		to: string;
		controlMessage: Omit<ClosedGroupControlMessageParams, "timestamp">;
		/** If set → group-swarm mode (seal to this group encryption key, ns −10). If omitted → 1:1 DM mode (ns 0). */
		encryptionPublicKey?: string;
		timestamp?: number;
	},
): Promise<{ messageHash: string; timestamp: number }> {
	if (!this.sessionID || !this.keys)
		throw new SessionRuntimeError({
			code: SessionRuntimeErrorCode.EmptyUser,
			message: "Instance is not initialized; use setMnemonic first",
		});
	assertSessionId(to);

	const isGroup = encryptionPublicKey !== undefined;
	if (isGroup) {
		assertEncryptionKey(encryptionPublicKey);
	}

	const ts = timestamp ?? this.getNowWithNetworkOffset();
	const msg = new ClosedGroupControlMessage({ ...controlMessage, timestamp: ts });

	const namespace = isGroup
		? SnodeNamespaces.ClosedGroupMessage
		: SnodeNamespaces.UserMessages;
	const rawMessage = toRawMessage(to, msg, namespace, isGroup);
	const [wrappedMessage] = await wrap(
		this.keys,
		[
			{
				destination: to,
				...(isGroup && { encryptionPublicKey }),
				plainTextBuffer: rawMessage.plainTextBuffer,
				namespace: rawMessage.namespace,
				ttl: rawMessage.ttl,
				identifier: rawMessage.identifier,
				isSyncMessage: false,
				isGroup,
			},
		],
		{ networkTimestamp: ts },
	);
	const messageHash = await this._storeMessage({ message: rawMessage, data: wrappedMessage });
	return { messageHash, timestamp: ts };
}

// Written fresh from the published SessionProtos.proto field facts. MIT-licensable for upstream contribution.
import { wrap } from "@/crypto/message-encrypt";
import type { Session } from "@/instance";
import { CallMessage } from "@/messages/schema/call-message";
import { toRawMessage } from "@/messages/signal-message";
import { SnodeNamespaces } from "@session.js/types";
import { SignalService } from "@session.js/types/signal-bindings";
import {
	SessionRuntimeError,
	SessionRuntimeErrorCode,
	SessionValidationError,
	SessionValidationErrorCode,
} from "@session.js/errors";

/**
 * Sends a Session call signaling message (PRE_OFFER, OFFER, ANSWER, ICE_CANDIDATES, END_CALL)
 * to another Session ID and stores it in the recipient's swarm with the call TTL (5 minutes).
 *
 * **Self-sync**: pass `options.isSyncMessage: true` to store the message to the caller's OWN
 * swarm instead of a peer's. This is used for ANSWER and END_CALL so linked devices of the
 * sender observe the accept/hangup and stop ringing. When `isSyncMessage` is true, `to`
 * MUST be your own Session ID (see Session.sendMessage's sync-copy mechanism). The calls
 * package calls this method twice for those messages: once to the peer (isSyncMessage
 * false) and once to self (isSyncMessage true).
 *
 * Might throw SessionFetchError if there is a connection issue
 * @param to — Session ID of the recipient (or own Session ID when isSyncMessage is true)
 * @param callMessage — Call signaling payload: type, call uuid (stringified UUIDv4) and SDP/ICE fields
 * @param options.isSyncMessage — Store to own swarm (self-sync) instead of sending to a peer. Default false
 * @returns `Promise<{ messageHash: string, timestamp: number }>` — hash (identifier) of the stored message and its timestamp
 */
export async function sendCallMessage(
	this: Session,
	to: string,
	callMessage: {
		type: SignalService.CallMessage.Type;
		uuid: string;
		sdps?: string[];
		sdpMLineIndexes?: number[];
		sdpMids?: string[];
	},
	options?: { isSyncMessage?: boolean },
): Promise<{ messageHash: string; timestamp: number }> {
	if (!this.sessionID || !this.keys)
		throw new SessionRuntimeError({
			code: SessionRuntimeErrorCode.EmptyUser,
			message: "Instance is not initialized; use setMnemonic first",
		});
	if (to.length !== 66)
		throw new SessionValidationError({
			code: SessionValidationErrorCode.InvalidSessionID,
			message: "Invalid session ID length",
		});
	if (!to.startsWith("05") || !/^([0-9a-f]{2})+$/i.test(to))
		throw new SessionValidationError({
			code: SessionValidationErrorCode.InvalidSessionID,
			message: "Session ID must be a hex string starting from 05",
		});

	const timestamp = this.getNowWithNetworkOffset();
	const msg = new CallMessage({
		timestamp: timestamp,
		type: callMessage.type,
		uuid: callMessage.uuid,
		sdps: callMessage.sdps,
		sdpMLineIndexes: callMessage.sdpMLineIndexes,
		sdpMids: callMessage.sdpMids,
	});
	const rawMessage = toRawMessage(to, msg, SnodeNamespaces.UserMessages);
	const [wrappedMessage] = await wrap(
		this.keys,
		[
			{
				destination: to,
				plainTextBuffer: rawMessage.plainTextBuffer,
				namespace: rawMessage.namespace,
				ttl: rawMessage.ttl,
				identifier: rawMessage.identifier,
				isSyncMessage: options?.isSyncMessage ?? false,
				isGroup: false,
			},
		],
		{ networkTimestamp: timestamp },
	);
	const messageHash = await this._storeMessage({ message: rawMessage, data: wrappedMessage });
	return { messageHash, timestamp };
}

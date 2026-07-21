import type { Session } from "@/instance";
import {
	SessionFetchError,
	SessionFetchErrorCode,
	SessionRuntimeError,
	SessionRuntimeErrorCode,
} from "@session.js/errors";
import { UnsendMessage } from "@/messages/schema/delete-message";
import { type RequestDeleteMessages, RequestType } from "@session.js/types/network/request";
import type { Swarm } from "@session.js/types/swarm";
import pRetry from "p-retry";
import { toRawMessage } from "@/messages/signal-message";
import { SnodeNamespaces } from "@session.js/types";
import { wrap } from "@/crypto/message-encrypt";
import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex } from "@noble/ciphers/utils.js";
import { base64 } from "@scure/base";
import lodash from "lodash";
const { sample } = lodash;

export async function deleteMessage(
	this: Session,
	{
		to,
		timestamp,
		hash,
	}: {
		to: string;
		timestamp: number;
		hash: string;
	},
) {
	return await deleteMessages.call(this, [{ to, timestamp, hash }]);
}

export async function deleteMessages(
	this: Session,
	messages: { to: string; timestamp: number; hash: string }[],
) {
	const keypair = this.keys;
	if (!keypair)
		throw new SessionRuntimeError({
			code: SessionRuntimeErrorCode.EmptyUser,
			message: "Instance is not initialized; use setMnemonic first",
		});
	const hashes = messages.map((m) => m.hash);

	await deleteMessagesFromSwarm.call(this, { hashes });
	await propagateUnsendMessages.call(this, { messages });
}

/** This method sends request to our swarm to delete specified messages so that
 * they are permanently erased and won't be received by recipient if they haven't
 * retrieved them yet */
async function deleteMessagesFromSwarm(this: Session, { hashes }: { hashes: string[] }) {
	const keypair = this.keys!;
	const verificationData = new TextEncoder().encode(`delete${hashes.join("")}`);
	const message = new Uint8Array(verificationData);
	const signature = ed25519.sign(message, keypair.ed25519.privateKey);
	const signatureBase64 = base64.encode(signature);

	let swarms = [await this.getOurSwarm()];
	return await pRetry(
		async () => {
			let swarm: Swarm | undefined;
			if (swarms.length) {
				swarm = sample(swarms);
			} else {
				swarm = sample(this.ourSwarms);
				this.ourSwarm = swarm;
			}
			if (!swarm)
				throw new SessionFetchError({
					code: SessionFetchErrorCode.NoSwarmsAvailable,
					message: "No swarms available",
				});
			try {
				await this._request<Record<string, never>, RequestDeleteMessages>({
					type: RequestType.DeleteMessages,
					body: {
						hashes,
						pubkey: bytesToHex(keypair.x25519.publicKey),
						pubkey_ed25519: bytesToHex(keypair.ed25519.publicKey),
						signature: signatureBase64,
						swarm,
					},
				});
			} catch (e) {
				if (
					e instanceof SessionFetchError &&
					e.code === SessionFetchErrorCode.RetryWithOtherNode421Error
				) {
					swarms = swarms.filter((s) => s !== swarm);
					this.ourSwarms = this.ourSwarms!.filter((s) => s !== swarm);
				}
				throw e;
			}
		},
		{
			retries: 5,
			shouldRetry: (e) =>
				e instanceof SessionFetchError &&
				e.code === SessionFetchErrorCode.RetryWithOtherNode421Error,
		},
	);
}

/** This method stores UnsendMessages to our swarm to instruct clients
 * which already received these messages to delete them locally
 */
async function propagateUnsendMessages(
	this: Session,
	{ messages }: { messages: { to: string; timestamp: number; hash: string }[] },
) {
	const unsendMessages = messages.map(
		(m) =>
			new UnsendMessage({
				author: this.getSessionID(),
				timestamp: m.timestamp,
			}),
	);
	const timestamp = this.getNowWithNetworkOffset();

	const rawMessages = unsendMessages.map((m, i) =>
		toRawMessage(messages[i].to, m, SnodeNamespaces.UserMessages),
	);
	const wrappedMessages = await wrap(
		this.keys!,
		rawMessages.map((rawMessage, i) => {
			return {
				destination: messages[i].to,
				plainTextBuffer: rawMessage.plainTextBuffer,
				namespace: rawMessage.namespace,
				ttl: rawMessage.ttl,
				identifier: rawMessage.identifier,
				isSyncMessage: false,
				isGroup: false,
			};
		}),
		{ networkTimestamp: timestamp },
	);
	for (let i = 0; i < wrappedMessages.length; i++) {
		await this._storeMessage({ message: rawMessages[i], data: wrappedMessages[i] });
	}

	const rawSyncMessages = unsendMessages.map((m) =>
		toRawMessage(this.getSessionID(), m, SnodeNamespaces.UserMessages),
	);
	const wrappedSyncMessages = await wrap(
		this.keys!,
		unsendMessages.map((m, i) => {
			return {
				destination: this.getSessionID(),
				plainTextBuffer: rawSyncMessages[i].plainTextBuffer,
				namespace: rawSyncMessages[i].namespace,
				ttl: rawSyncMessages[i].ttl,
				identifier: rawSyncMessages[i].identifier,
				isSyncMessage: true,
				isGroup: false,
			};
		}),
		{ networkTimestamp: timestamp },
	);
	for (let i = 0; i < wrappedSyncMessages.length; i++) {
		await this._storeMessage({ message: rawSyncMessages[i], data: wrappedSyncMessages[i] });
	}
}

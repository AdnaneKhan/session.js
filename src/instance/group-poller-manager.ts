// SPDX-License-Identifier: MIT
// Fork addition (closed-groups support): attach/detach a per-group poller on a
// Session. The core GroupPoller polls one 05-prefixed group pubkey over
// namespace −10 (unauthenticated), decrypts newest-first with the provided
// keypairs, and routes decrypted messages through the instance's mapped
// `groupUpdate` (control) / `message` (chat) events — the same events the
// @session.js/groups GroupManager listens to. Written fresh — (c) 2026
// AdnaneKhan, upstreamable. See docs/evidence/G8-T2.md.
import { GroupPoller } from "@/polling";
import { mapClosedGroupControlMessage, mapDataMessage } from "@/messages";
import { RequestType, type RequestPollBody } from "@session.js/types/network/request";
import type { ResponsePoll } from "@session.js/types/network/response";
import type { SessionKeys } from "@session.js/keypair";
import { hexToBytes } from "@noble/ciphers/utils.js";
import type { Session } from "@/instance";

/** A group encryption keypair as the groups package holds it (unprefixed hex). */
export type GroupEncryptionKeypairHex = { publicKey: string; privateKey: string };

export type GroupPollerHandle = { readonly groupPubKey: string };

/** Convert a hex group keypair into the SessionKeys shape the decryptor wants. */
function toSessionKeys(kp: GroupEncryptionKeypairHex): SessionKeys {
	return {
		x25519: {
			keyType: "x25519",
			publicKey: hexToBytes(kp.publicKey),
			privateKey: hexToBytes(kp.privateKey),
		},
		// Only the x25519 half is used for group decryption.
		ed25519: {
			keyType: "ed25519",
			publicKey: new Uint8Array(32),
			privateKey: new Uint8Array(32),
		},
	};
}

export function addGroupPoller(
	this: Session,
	opts: {
		groupPubKey: string;
		getEncryptionKeyPairs: () =>
			| GroupEncryptionKeypairHex[]
			| Promise<GroupEncryptionKeypairHex[]>;
	},
): GroupPollerHandle {
	// Reuse an existing poller for this group if present.
	if (this.groupPollers.has(opts.groupPubKey)) {
		return { groupPubKey: opts.groupPubKey };
	}

	const poller = new GroupPoller({
		groupPubKey: opts.groupPubKey,
		ourPubKey: this.getSessionID(),
		getEncryptionKeyPairs: async () =>
			(await opts.getEncryptionKeyPairs()).map(toSessionKeys),
		request: (body: RequestPollBody) =>
			this._request<ResponsePoll, RequestPollBody>({ type: RequestType.Poll, body }),
		getSwarmsFor: (pubkey: string) => this.getSwarmsFor(pubkey),
		storage: this.storage,
		onMessagesReceived: (messages) => {
			// A group swarm only carries chat (DataMessage) and control
			// (closedGroupControlMessage) messages — dispatch those.
			for (const m of messages) {
				if (m.content.dataMessage?.closedGroupControlMessage) {
					this._emit("groupUpdate", mapClosedGroupControlMessage(m));
				} else if (m.content.dataMessage) {
					this._emit("message", mapDataMessage(m));
				}
			}
		},
	});

	this.groupPollers.set(opts.groupPubKey, poller);
	poller.startPolling();
	return { groupPubKey: opts.groupPubKey };
}

export function removeGroupPoller(this: Session, handle: GroupPollerHandle): void {
	const poller = this.groupPollers.get(handle.groupPubKey);
	if (!poller) return;
	poller.stopPolling();
	this.groupPollers.delete(handle.groupPubKey);
}

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 AdnaneKhan
// Written fresh from the published SessionProtos.proto field facts and the
// pinned session-desktop (master @ d86076b) outgoing-message shapes — see
// docs/closed-groups/IMPLEMENTATION.md §2.1 and docs/evidence/G1-T1.md.
// No GPL/AGPL code copied. MIT-licensable for upstream contribution.
import * as Constants from "@session.js/consts";
import { SignalService } from "@session.js/types/signal-bindings";
import { SessionValidationError, SessionValidationErrorCode } from "@session.js/errors";
import { bytesToHex } from "@noble/ciphers/utils.js";
import { ContentMessage, type MessageParams } from "../signal-message";

const ControlType = SignalService.DataMessage.ClosedGroupControlMessage.Type;

/** A per-member wrapped group encryption keypair (keypair rotation). */
export type KeyPairWrapperParams = {
	/** The member this wrapper is for — prefixed (33-byte, 05…) public key. */
	publicKey: Uint8Array;
	/** `KeyPair` proto bytes sealed to the member's identity key, NO message padding. */
	encryptedKeyPair: Uint8Array;
};

/** The plaintext group encryption keypair carried inside a NEW message's sealed box. */
export type GroupEncryptionKeyPairParams = {
	/** Unprefixed 32-byte x25519 public key. */
	publicKey: Uint8Array;
	/** Unprefixed 32-byte x25519 private key. */
	privateKey: Uint8Array;
};

export interface ClosedGroupControlMessageParams extends MessageParams {
	type: SignalService.DataMessage.ClosedGroupControlMessage.Type;
	/**
	 * Explicit group public key (prefixed 33-byte, 05…). Set for NEW invites
	 * and ENCRYPTION_KEY_PAIR replies; omitted for group-swarm control messages
	 * (the group id then rides in the envelope `source`).
	 */
	publicKey?: Uint8Array;
	/** Group display name — required for NEW and NAME_CHANGE. */
	name?: string;
	/** Plaintext group encryption keypair — required for NEW. */
	encryptionKeyPair?: GroupEncryptionKeyPairParams;
	/** Member public keys (prefixed 33-byte) — NEW / MEMBERS_ADDED / MEMBERS_REMOVED. */
	members?: Uint8Array[];
	/** Admin public keys (prefixed 33-byte) — NEW. */
	admins?: Uint8Array[];
	/** Per-member wrapped keypairs — ENCRYPTION_KEY_PAIR (rotation / newcomer push). */
	wrappers?: KeyPairWrapperParams[];
	/** Disappearing-message timer in seconds — `deleteAfterSend` only; NEW. */
	expirationTimer?: number;
}

/**
 * A legacy closed-group control message, carried in
 * `DataMessage.closedGroupControlMessage` (field 104). Covers all seven wire
 * types: NEW, ENCRYPTION_KEY_PAIR, NAME_CHANGE, MEMBERS_ADDED,
 * MEMBERS_REMOVED, MEMBER_LEFT (ENCRYPTION_KEY_PAIR_REQUEST is unused by the
 * official clients and cannot be constructed here).
 *
 * Control messages carry **only** `closedGroupControlMessage` — no
 * `GroupContext`. On the group swarm (namespace −10) the group id is the
 * envelope `source`; the author is recovered from the sealed box
 * (`senderIdentity`). NEW invites and ENCRYPTION_KEY_PAIR replies are sent
 * 1:1 to member swarms (namespace 0) and carry the explicit `publicKey`.
 */
export class ClosedGroupControlMessage extends ContentMessage {
	public readonly type: SignalService.DataMessage.ClosedGroupControlMessage.Type;
	public readonly publicKey?: Uint8Array;
	public readonly name?: string;
	public readonly encryptionKeyPair?: GroupEncryptionKeyPairParams;
	public readonly members?: Uint8Array[];
	public readonly admins?: Uint8Array[];
	public readonly wrappers?: KeyPairWrapperParams[];
	public readonly expirationTimer?: number;

	constructor(params: ClosedGroupControlMessageParams) {
		super({ timestamp: params.timestamp, identifier: params.identifier });

		if (params.type === ControlType.ENCRYPTION_KEY_PAIR_REQUEST) {
			throw new SessionValidationError({
				code: SessionValidationErrorCode.InvalidOptions,
				message: "ENCRYPTION_KEY_PAIR_REQUEST is unused by official clients and cannot be sent",
			});
		}

		switch (params.type) {
			case ControlType.NEW: {
				if (!params.publicKey?.length) {
					throw invalid("NEW requires the group publicKey");
				}
				if (!params.name?.length) {
					throw invalid("NEW requires a non-empty name");
				}
				if (!params.members?.length) {
					throw invalid("NEW requires a non-empty members list");
				}
				if (!params.admins?.length) {
					throw invalid("NEW requires a non-empty admins list");
				}
				if (!areAdminsMembers(params.admins, params.members)) {
					throw invalid("NEW admins must all be members of the group");
				}
				if (
					!params.encryptionKeyPair?.publicKey?.length ||
					!params.encryptionKeyPair?.privateKey?.length
				) {
					throw invalid("NEW requires a plaintext encryptionKeyPair");
				}
				break;
			}
			case ControlType.NAME_CHANGE: {
				if (!params.name?.length) {
					throw invalid("NAME_CHANGE requires a non-empty name");
				}
				break;
			}
			case ControlType.MEMBERS_ADDED:
			case ControlType.MEMBERS_REMOVED: {
				if (!params.members?.length) {
					throw invalid(`${ControlType[params.type]} requires a non-empty members list`);
				}
				break;
			}
			case ControlType.ENCRYPTION_KEY_PAIR: {
				if (!params.wrappers?.length) {
					throw invalid("ENCRYPTION_KEY_PAIR requires a non-empty wrappers list");
				}
				break;
			}
			case ControlType.MEMBER_LEFT: {
				// No additional fields.
				break;
			}
		}

		this.type = params.type;
		this.publicKey = params.publicKey;
		this.name = params.name;
		this.encryptionKeyPair = params.encryptionKeyPair;
		this.members = params.members;
		this.admins = params.admins;
		this.wrappers = params.wrappers;
		this.expirationTimer = params.expirationTimer;
	}

	/**
	 * Control messages are stored with the 14-day content TTL on the swarm but
	 * never carry an expiration type (they are not disappearing messages).
	 */
	public ttl(): number {
		return Constants.TTL_DEFAULT.CONTENT_MESSAGE;
	}

	public contentProto(): SignalService.Content {
		const closedGroupControlMessage: SignalService.DataMessage.IClosedGroupControlMessage = {
			type: this.type,
		};
		if (this.publicKey?.length) {
			closedGroupControlMessage.publicKey = this.publicKey;
		}
		if (this.name !== undefined) {
			closedGroupControlMessage.name = this.name;
		}
		if (this.encryptionKeyPair) {
			closedGroupControlMessage.encryptionKeyPair = {
				publicKey: this.encryptionKeyPair.publicKey,
				privateKey: this.encryptionKeyPair.privateKey,
			};
		}
		if (this.members?.length) {
			closedGroupControlMessage.members = this.members;
		}
		if (this.admins?.length) {
			closedGroupControlMessage.admins = this.admins;
		}
		if (this.wrappers?.length) {
			closedGroupControlMessage.wrappers = this.wrappers.map((w) => ({
				publicKey: w.publicKey,
				encryptedKeyPair: w.encryptedKeyPair,
			}));
		}
		if (this.expirationTimer !== undefined) {
			closedGroupControlMessage.expirationTimer = this.expirationTimer;
		}

		return new SignalService.Content({
			dataMessage: {
				closedGroupControlMessage,
			},
		});
	}
}

function invalid(message: string): SessionValidationError {
	return new SessionValidationError({
		code: SessionValidationErrorCode.InvalidOptions,
		message,
	});
}

/** Every admin public key (compared as bytes) must appear in the members list. */
function areAdminsMembers(admins: Uint8Array[], members: Uint8Array[]): boolean {
	const memberHexes = new Set(members.map(bytesToKey));
	return admins.every((a) => memberHexes.has(bytesToKey(a)));
}

function bytesToKey(bytes: Uint8Array): string {
	return bytesToHex(bytes);
}

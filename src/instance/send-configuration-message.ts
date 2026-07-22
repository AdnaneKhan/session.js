// SPDX-License-Identifier: MIT
// Fork addition (closed-groups support): send a legacy multi-device
// ConfigurationMessage carrying our closed groups (spec §2.6 mechanism (a)).
// Stored to our OWN swarm (namespace 0) with the 30-day config TTL so linked
// devices reconcile group state. Written fresh — (c) 2026 AdnaneKhan,
// upstreamable. See docs/evidence/G7-T2.md.
import { wrap } from "@/crypto/message-encrypt";
import type { Session } from "@/instance";
import {
	ConfigurationMessage,
	ConfigurationMessageClosedGroup,
} from "@/messages/schema/configuration-message";
import { toRawMessage } from "@/messages/signal-message";
import { SnodeNamespaces } from "@session.js/types";
import { getPlaceholderDisplayName } from "@/utils";
import { hexToBytes } from "@noble/ciphers/utils.js";
import { SessionRuntimeError, SessionRuntimeErrorCode } from "@session.js/errors";

/** A closed group to carry in a config sync (latest keypair only, spec §2.6). */
export type ConfigurationClosedGroupInput = {
	/** Group public key (05-prefixed hex). */
	publicKey: string;
	name: string;
	/** Latest group encryption keypair (unprefixed byte keys). */
	encryptionKeyPair: { publicKey: Uint8Array; privateKey: Uint8Array };
	/** Member public keys (05-prefixed hex). */
	members: string[];
	/** Admin public keys (05-prefixed hex). */
	admins: string[];
};

function cloneConfigurationGroup(g: ConfigurationClosedGroupInput): ConfigurationClosedGroupInput {
	return {
		publicKey: g.publicKey,
		name: g.name,
		encryptionKeyPair: {
			publicKey: new Uint8Array(g.encryptionKeyPair.publicKey),
			privateKey: new Uint8Array(g.encryptionKeyPair.privateKey),
		},
		members: [...g.members],
		admins: [...g.admins],
	};
}

/** Update the full closed-group snapshot included in subsequent legacy configs. */
export function setConfigurationClosedGroups(
	this: Session,
	activeClosedGroups: ConfigurationClosedGroupInput[],
): void {
	this.configurationClosedGroups = activeClosedGroups.map(cloneConfigurationGroup);
}

export function buildConfigurationClosedGroups(
	activeClosedGroups: ConfigurationClosedGroupInput[],
): ConfigurationMessageClosedGroup[] {
	return activeClosedGroups.map(
		(g) =>
			new ConfigurationMessageClosedGroup({
				publicKey: hexToBytes(g.publicKey),
				name: g.name,
				encryptionKeyPair: {
					publicKeyData: g.encryptionKeyPair.publicKey,
					privateKeyData: g.encryptionKeyPair.privateKey,
				},
				members: g.members,
				admins: g.admins,
			}),
	);
}

export async function sendConfigurationMessage(
	this: Session,
	opts: { activeClosedGroups: ConfigurationClosedGroupInput[] },
): Promise<{ messageHash: string; timestamp: number }> {
	if (!this.sessionID || !this.keys)
		throw new SessionRuntimeError({
			code: SessionRuntimeErrorCode.EmptyUser,
			message: "Instance is not initialized; use setMnemonic first",
		});

	const timestamp = this.getNowWithNetworkOffset();
	setConfigurationClosedGroups.call(this, opts.activeClosedGroups ?? []);
	const activeClosedGroups = buildConfigurationClosedGroups(this.configurationClosedGroups);

	const msg = new ConfigurationMessage({
		timestamp,
		activeClosedGroups,
		activeOpenGroups: [],
		displayName: this.displayName || getPlaceholderDisplayName(this.sessionID),
		profilePicture: this.avatar?.url,
		profileKey: this.avatar?.key,
		contacts: [],
	});

	const rawMessage = toRawMessage(this.sessionID, msg, SnodeNamespaces.UserMessages, false);
	const [wrappedMessage] = await wrap(
		this.keys,
		[
			{
				destination: this.sessionID,
				plainTextBuffer: rawMessage.plainTextBuffer,
				namespace: rawMessage.namespace,
				ttl: rawMessage.ttl,
				identifier: rawMessage.identifier,
				isSyncMessage: true,
				isGroup: false,
			},
		],
		{ networkTimestamp: timestamp },
	);
	const messageHash = await this._storeMessage({ message: rawMessage, data: wrappedMessage });
	return { messageHash, timestamp };
}

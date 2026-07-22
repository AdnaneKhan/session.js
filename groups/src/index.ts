// SPDX-License-Identifier: AGPL-3.0-or-later
//
// @session.js/groups — legacy closed groups (05-prefixed) for the patched
// session.js client. See docs/closed-groups/IMPLEMENTATION.md and
// COPYING.provenance.
export { GroupManager, type GroupManagerDeps } from "./group-manager.js";
export { KeypairRegistry } from "./keypairs.js";
export { generateGroupAddress, generateEncryptionKeypair } from "./keygen.js";
export {
	GroupStorage,
	InMemoryGroupStorage,
	type StorageLike,
	INDEX_KEY,
	stateKey,
	keypairsKey,
	lastHashesKey,
	undecryptableKey,
} from "./storage.js";
export {
	GroupError,
	GroupErrorCode,
	type GroupErrorCodeValue,
	GroupNotFoundError,
	NotAMemberError,
	NotAnAdminError,
	GroupTooLargeError,
	InvalidGroupError,
	InvalidKeypairError,
	GroupInactiveError,
	StaleUpdateError,
} from "./errors.js";
export {
	GroupControlMessageType,
	type GroupControlMessageTypeValue,
	type GroupSessionLike,
	type GroupPollerHandle,
	type OutgoingControlMessage,
	type GroupUpdateEvent,
	type GroupMessageEvent,
	type GroupConfigEvent,
	type GroupEncryptionKeypair,
	type GroupState,
	type GroupManagerOptions,
	type GroupManagerEventMap,
	type GroupLogger,
} from "./types.js";

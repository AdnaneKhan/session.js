// SPDX-License-Identifier: AGPL-3.0-or-later
//
// @session.js/groups — legacy closed groups (05-prefixed) for the patched
// session.js client. See docs/closed-groups/IMPLEMENTATION.md and
// COPYING.provenance.
export { GroupManager, type GroupManagerDeps } from "./group-manager";
export { KeypairRegistry } from "./keypairs";
export { generateGroupAddress, generateEncryptionKeypair } from "./keygen";
export {
	GroupStorage,
	InMemoryGroupStorage,
	type StorageLike,
	INDEX_KEY,
	stateKey,
	keypairsKey,
	lastHashesKey,
	undecryptableKey,
} from "./storage";
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
} from "./errors";
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
} from "./types";

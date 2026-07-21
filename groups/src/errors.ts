// SPDX-License-Identifier: AGPL-3.0-or-later
//
// @session.js/groups error taxonomy (mirrors @session.js/calls' pattern).
// Written fresh. Stable string codes; one subclass per failure mode.

export const GroupErrorCode = {
	GroupNotFound: "group_not_found",
	NotAMember: "not_a_member",
	NotAnAdmin: "not_an_admin",
	GroupTooLarge: "group_too_large",
	InvalidGroup: "invalid_group",
	InvalidKeypair: "invalid_keypair",
	GroupInactive: "group_inactive",
	StaleUpdate: "stale_update",
	DuplicateKeypair: "duplicate_keypair",
	Runtime: "runtime",
} as const;
export type GroupErrorCodeValue = (typeof GroupErrorCode)[keyof typeof GroupErrorCode];

export class GroupError extends Error {
	public readonly code: GroupErrorCodeValue;
	public readonly groupPubKey?: string;

	constructor(params: { code: GroupErrorCodeValue; message: string; groupPubKey?: string }) {
		super(params.message);
		// Restore the prototype chain for downlevel `instanceof` correctness.
		Object.setPrototypeOf(this, new.target.prototype);
		this.name = new.target.name;
		this.code = params.code;
		this.groupPubKey = params.groupPubKey;
	}
}

export class GroupNotFoundError extends GroupError {
	constructor(groupPubKey: string) {
		super({
			code: GroupErrorCode.GroupNotFound,
			message: `No known group ${groupPubKey}`,
			groupPubKey,
		});
	}
}

export class NotAMemberError extends GroupError {
	constructor(groupPubKey: string, who?: string) {
		super({
			code: GroupErrorCode.NotAMember,
			message: `${who ?? "actor"} is not a member of group ${groupPubKey}`,
			groupPubKey,
		});
	}
}

export class NotAnAdminError extends GroupError {
	constructor(groupPubKey: string, who?: string) {
		super({
			code: GroupErrorCode.NotAnAdmin,
			message: `${who ?? "actor"} is not an admin of group ${groupPubKey}`,
			groupPubKey,
		});
	}
}

export class GroupTooLargeError extends GroupError {
	constructor(groupPubKey: string, limit: number) {
		super({
			code: GroupErrorCode.GroupTooLarge,
			message: `Group ${groupPubKey} would exceed the ${limit}-member limit`,
			groupPubKey,
		});
	}
}

export class InvalidGroupError extends GroupError {
	constructor(message: string, groupPubKey?: string) {
		super({ code: GroupErrorCode.InvalidGroup, message, groupPubKey });
	}
}

export class InvalidKeypairError extends GroupError {
	constructor(message: string, groupPubKey?: string) {
		super({ code: GroupErrorCode.InvalidKeypair, message, groupPubKey });
	}
}

export class GroupInactiveError extends GroupError {
	constructor(groupPubKey: string) {
		super({
			code: GroupErrorCode.GroupInactive,
			message: `Group ${groupPubKey} is inactive (we left or were removed)`,
			groupPubKey,
		});
	}
}

export class StaleUpdateError extends GroupError {
	constructor(groupPubKey: string, message?: string) {
		super({
			code: GroupErrorCode.StaleUpdate,
			message: message ?? `Stale group update for ${groupPubKey} (older than watermark)`,
			groupPubKey,
		});
	}
}

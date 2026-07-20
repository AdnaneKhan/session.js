// SPDX-License-Identifier: AGPL-3.0-or-later
// Error taxonomy (P6-T3) verification.

import { describe, expect, test } from "bun:test";
import {
	CallError,
	CallErrorCode,
	CallInProgressError,
	IceFailureError,
	InvalidCallMessageError,
	InvalidCallTransitionError,
	MediaFailureError,
	PeerNotApprovedError,
	RuntimeUnsupportedError,
	SignalingTimeoutError,
} from "../src/errors.js";

describe("error taxonomy", () => {
	test("CallError base carries code, message, optional callUuid", () => {
		const e = new CallError(CallErrorCode.SIGNALING_TIMEOUT, "boom", "uuid-1");
		expect(e).toBeInstanceOf(Error);
		expect(e.name).toBe("CallError");
		expect(e.code).toBe("SIGNALING_TIMEOUT");
		expect(e.message).toBe("boom");
		expect(e.callUuid).toBe("uuid-1");
		expect(new CallError("X", "y").callUuid).toBeUndefined();
	});

	test("PeerNotApprovedError", () => {
		const e = new PeerNotApprovedError("05abc");
		expect(e.code).toBe("PEER_NOT_APPROVED");
		expect(e.peer).toBe("05abc");
		expect(e.name).toBe("PeerNotApprovedError");
		expect(e).toBeInstanceOf(CallError);
	});

	test("CallInProgressError carries the active uuid", () => {
		const e = new CallInProgressError("active-uuid");
		expect(e.code).toBe("CALL_IN_PROGRESS");
		expect(e.activeUuid).toBe("active-uuid");
		expect(e.callUuid).toBe("active-uuid");
	});

	test("SignalingTimeoutError carries the timeout", () => {
		const e = new SignalingTimeoutError(60_000, "uuid-2");
		expect(e.code).toBe("SIGNALING_TIMEOUT");
		expect(e.timeoutMs).toBe(60_000);
		expect(e.callUuid).toBe("uuid-2");
	});

	test("IceFailureError", () => {
		const e = new IceFailureError("restarts exhausted", "uuid-3");
		expect(e.code).toBe("ICE_FAILURE");
		expect(e.message).toBe("restarts exhausted");
	});

	test("MediaFailureError", () => {
		const e = new MediaFailureError("dtls handshake failed", "uuid-4");
		expect(e.code).toBe("MEDIA_FAILURE");
		expect(e.callUuid).toBe("uuid-4");
	});

	test("RuntimeUnsupportedError (no call uuid)", () => {
		const e = new RuntimeUnsupportedError("werift requires Node >= 22");
		expect(e.code).toBe("RUNTIME_UNSUPPORTED");
		expect(e.callUuid).toBeUndefined();
	});

	test("InvalidCallTransitionError carries state + event", () => {
		const e = new InvalidCallTransitionError("idle", "user-accept", "uuid-5");
		expect(e.code).toBe("INVALID_CALL_TRANSITION");
		expect(e.state).toBe("idle");
		expect(e.event).toBe("user-accept");
		expect(e.message).toContain("user-accept");
		expect(e.message).toContain("idle");
	});

	test("InvalidCallMessageError carries reason", () => {
		const e = new InvalidCallMessageError("parallel-array length mismatch", "uuid-6");
		expect(e.code).toBe("INVALID_CALL_MESSAGE");
		expect(e.reason).toBe("parallel-array length mismatch");
		expect(e.callUuid).toBe("uuid-6");
	});

	test("subclass prototype chains survive (instanceof works)", () => {
		const errors: CallError[] = [
			new PeerNotApprovedError("p"),
			new CallInProgressError("u"),
			new SignalingTimeoutError(1),
			new IceFailureError("m"),
			new MediaFailureError("m"),
			new RuntimeUnsupportedError("m"),
			new InvalidCallTransitionError("idle", "cleanup"),
			new InvalidCallMessageError("r"),
		];
		for (const e of errors) {
			expect(e).toBeInstanceOf(CallError);
			expect(e).toBeInstanceOf(Error);
		}
		expect(new PeerNotApprovedError("p")).not.toBeInstanceOf(CallInProgressError);
	});
});

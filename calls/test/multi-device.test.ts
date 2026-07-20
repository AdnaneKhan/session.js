// SPDX-License-Identifier: AGPL-3.0-or-later
// P6-T2 verification: multi-device race semantics via self-sync.
//
// SharedFakeSession models TWO devices of the same account: ONE SessionLike
// whose "call" listener list fans every emitted message to BOTH supervisors
// B1 and B2 (same getSessionID — like two linked devices polling the same
// swarm). Self-sync copies (isSyncMessage / to own id) are fanned back into
// the listener list, exactly as the own-swarm poll would deliver them to a
// second device. Offline fakes.

import { afterEach, describe, expect, test } from "bun:test";

import { CallManager } from "../src/call-manager.js";
import type { Call, CallInfo } from "../src/types.js";
import { CallMessageType } from "../src/types.js";
import { FakeMedia, PEER_A, tick } from "./helpers/fakes.js";
import { FakeSession } from "./helpers/fakes.js";

const OWN_B = `05${"b".repeat(64)}`;

interface Rig {
	session: FakeSession;
	media1: FakeMedia;
	media2: FakeMedia;
	b1: CallManager;
	b2: CallManager;
	incoming1: Call[];
	incoming2: Call[];
	ended1: CallInfo[];
	ended2: CallInfo[];
	errors: Error[];
}

const rigs: Rig[] = [];

function makeRig(): Rig {
	// ONE fake session shared by both "devices" of account B. These
	// supervisors use the REAL clock (default deps), so the fake envelope
	// timestamps must be real wall-clock too (freshness gates!).
	const session = new FakeSession(OWN_B);
	session.nowValue = Date.now();
	const origSend = session.sendCallMessage.bind(session);
	// Fan self-sync sends back into the call listeners (own-swarm delivery
	// to every linked device, including the other supervisor).
	session.sendCallMessage = async (to, msg, options) => {
		const result = await origSend(to, msg, options);
		if (options?.isSyncMessage || to === session.ownId) {
			session.fireCall({
				uuid: msg.uuid,
				type: msg.type,
				from: session.ownId, // arrives FROM OURSELVES on the other device
				timestamp: session.nowValue,
				sdps: msg.sdps ? [...msg.sdps] : [],
				sdpMLineIndexes: msg.sdpMLineIndexes ? [...msg.sdpMLineIndexes] : [],
				sdpMids: msg.sdpMids ? [...msg.sdpMids] : [],
			});
		}
		return result;
	};

	const media1 = new FakeMedia();
	const media2 = new FakeMedia();
	const b1 = new CallManager(session, undefined, { media: media1 });
	const b2 = new CallManager(session, undefined, { media: media2 });
	b1.approveContact(PEER_A);
	b2.approveContact(PEER_A);

	const rig: Rig = {
		session,
		media1,
		media2,
		b1,
		b2,
		incoming1: [],
		incoming2: [],
		ended1: [],
		ended2: [],
		errors: [],
	};
	b1.on("incoming", (c) => {
		rig.incoming1.push(c);
		c.on("ended", (info) => rig.ended1.push(info));
	});
	b2.on("incoming", (c) => {
		rig.incoming2.push(c);
		c.on("ended", (info) => rig.ended2.push(info));
	});
	b1.on("error", (e) => rig.errors.push(e.error));
	b2.on("error", (e) => rig.errors.push(e.error));
	rigs.push(rig);
	return rig;
}

afterEach(async () => {
	while (rigs.length > 0) {
		const rig = rigs.pop();
		await rig?.b1.dispose();
		await rig?.b2.dispose();
	}
});

describe("multi-device race semantics (two supervisors, one account)", () => {
	test("both devices ring; device-1 accept self-syncs; device-2 ends answered-elsewhere and sends NO wire messages", async () => {
		const rig = makeRig();
		const uuid = "99999999-9999-4999-8999-999999999991";

		// Caller A rings account B: PRE_OFFER + OFFER fan out to BOTH devices.
		rig.session.fireCall({
			uuid,
			type: CallMessageType.PRE_OFFER,
			from: PEER_A,
			timestamp: rig.session.nowValue,
			sdps: [],
			sdpMLineIndexes: [],
			sdpMids: [],
		});
		rig.session.fireCall({
			uuid,
			type: CallMessageType.OFFER,
			from: PEER_A,
			timestamp: rig.session.nowValue,
			sdps: ["offer-from-A"],
			sdpMLineIndexes: [],
			sdpMids: [],
		});
		expect(rig.incoming1).toHaveLength(1);
		expect(rig.incoming2).toHaveLength(1);
		expect((rig.incoming1[0] as Call).info.state).toBe("remote-ring");
		expect((rig.incoming2[0] as Call).info.state).toBe("remote-ring");

		const wireCountBeforeAccept = rig.session.sent.length;

		// Device 1 accepts → ANSWER to the caller + ANSWER self-sync. The
		// self-sync fans into device 2.
		await (rig.incoming1[0] as Call).accept();
		await tick();

		// Exactly two new wire messages: ANSWER(peer A) + ANSWER(self).
		const newSends = rig.session.sent.slice(wireCountBeforeAccept);
		expect(newSends).toHaveLength(2);
		expect(newSends.map((s) => [s.isSync, s.msg.type])).toEqual([
			[false, CallMessageType.ANSWER],
			[true, CallMessageType.ANSWER],
		]);
		expect(newSends.every((s) => s.msg.uuid === uuid)).toBe(true);

		// Device 2 observed the self-ANSWER → ended answered-elsewhere…
		expect(rig.ended2).toHaveLength(1);
		expect(rig.ended2[0]?.endReason).toBe("answered-elsewhere");
		expect((rig.incoming2[0] as Call).info.state).toBe("disconnected");
		expect(rig.media2.last.closed).toBe(true);

		// …and device 2 sent NOTHING on the wire after being silenced
		// (no duplicate ANSWER, no END_CALL — the fanned self-syncs from
		// device 1 must not make device 2 transmit).
		const sendsAfterAnsweredElsewhere = rig.session.sent.slice(wireCountBeforeAccept + 2);
		expect(sendsAfterAnsweredElsewhere).toEqual([]);

		// Device 1 is happily connecting.
		expect((rig.incoming1[0] as Call).info.state).toBe("connecting");
		expect(rig.ended1).toEqual([]);
		expect(rig.errors).toEqual([]);
	});

	test("self END_CALL silences the other device with ended-elsewhere", async () => {
		const rig = makeRig();
		const uuid = "99999999-9999-4999-8999-999999999992";
		rig.session.fireCall({
			uuid,
			type: CallMessageType.PRE_OFFER,
			from: PEER_A,
			timestamp: rig.session.nowValue,
			sdps: [],
			sdpMLineIndexes: [],
			sdpMids: [],
		});
		rig.session.fireCall({
			uuid,
			type: CallMessageType.OFFER,
			from: PEER_A,
			timestamp: rig.session.nowValue,
			sdps: ["offer-from-A"],
			sdpMLineIndexes: [],
			sdpMids: [],
		});
		expect(rig.incoming1).toHaveLength(1);
		expect(rig.incoming2).toHaveLength(1);

		const before = rig.session.sent.length;
		// Device 1 declines → END_CALL to A + END_CALL self-sync → device 2.
		await (rig.incoming1[0] as Call).reject();
		await tick();

		expect(rig.ended2).toHaveLength(1);
		expect(rig.ended2[0]?.endReason).toBe("ended-elsewhere");
		// Only the reject's two messages went out — device 2 stayed silent.
		const newSends = rig.session.sent.slice(before);
		expect(newSends.map((s) => [s.isSync, s.msg.type])).toEqual([
			[false, CallMessageType.END_CALL],
			[true, CallMessageType.END_CALL],
		]);
		expect(rig.session.sent.slice(before + 2)).toEqual([]);
		expect(rig.errors).toEqual([]);
	});

	test("self-sent PRE_OFFER / OFFER / ICE from the own swarm are dropped by BOTH devices without crashing", async () => {
		const rig = makeRig();
		// Simulate B's own swarm delivering B's own earlier signaling
		// (e.g. a stale self-copy) — must be dropped per §3.1.
		for (const type of [
			CallMessageType.PRE_OFFER,
			CallMessageType.OFFER,
			CallMessageType.ICE_CANDIDATES,
			CallMessageType.PROVISIONAL_ANSWER,
		]) {
			rig.session.fireCall({
				uuid: `self-swarm-${type}`,
				type,
				from: OWN_B, // from ourselves
				timestamp: rig.session.nowValue,
				sdps: ["x"],
				sdpMLineIndexes: [0],
				sdpMids: ["0"],
			});
		}
		await tick();
		expect(rig.incoming1).toEqual([]);
		expect(rig.incoming2).toEqual([]);
		expect(rig.ended1).toEqual([]);
		expect(rig.ended2).toEqual([]);
		expect(rig.session.sent).toEqual([]); // neither device transmitted
		expect(rig.errors).toEqual([]);
	});
});

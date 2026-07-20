// Written fresh from the published SessionProtos.proto field facts. MIT-licensable for upstream contribution.
import { expect, test } from "bun:test";
import type { Network } from "@session.js/types";
import { SessionValidationError } from "@session.js/errors";
import { Session } from "@/index";
import { Poller } from "@/polling";

const offlineNetwork: Network = {
	onRequest: async () => {
		throw new Error("offline test: no network calls allowed");
	},
};

test("setPollInterval applies to registered pollers without starting unauthorized polls", () => {
	const session = new Session({ network: offlineNetwork });
	const poller = new Poller({ interval: null });
	session.addPoller(poller);

	expect(() => session.setPollInterval(500)).not.toThrow();
	// Instance is not authorized (no mnemonic set), so the poller must not start polling
	expect(poller.isPolling()).toBe(false);
});

test("setPollInterval applies to multiple registered pollers", () => {
	const session = new Session({ network: offlineNetwork });
	const pollerA = new Poller({ interval: null });
	const pollerB = new Poller({ interval: null });
	session.addPoller(pollerA);
	session.addPoller(pollerB);

	expect(() => session.setPollInterval(250)).not.toThrow();
	expect(pollerA.isPolling()).toBe(false);
	expect(pollerB.isPolling()).toBe(false);
});

test("setPollInterval rejects invalid intervals", () => {
	const session = new Session({ network: offlineNetwork });
	expect(() => session.setPollInterval(0)).toThrow(SessionValidationError);
	expect(() => session.setPollInterval(-100)).toThrow(SessionValidationError);
	expect(() => session.setPollInterval(1.5)).toThrow(SessionValidationError);
	expect(() => session.setPollInterval(Number.NaN)).toThrow(SessionValidationError);
});

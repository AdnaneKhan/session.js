/**
 * scripts/smoke-message.ts — two-account text message smoke test (plan P0-T2).
 *
 * Boots two Session instances (separate InMemoryStorage) from the
 * TEST_ACCOUNT_A / TEST_ACCOUNT_B mnemonic env vars. A sends a text message
 * with a random nonce to B; B polls (Poller interval 500 ms) until the
 * message arrives (30 s timeout), asserts the text matches, and prints the
 * message hash + delivery latency. Exits 0 on success, 1 on any failure.
 *
 * @network — skipped in offline CI lane. Requires the Session swarm to be
 * reachable and both test accounts to be registered (scripts/register-account.ts).
 *
 * Usage:
 *   TEST_ACCOUNT_A="<13 words>" TEST_ACCOUNT_B="<13 words>" bun scripts/smoke-message.ts
 */
import { Session, Poller, ready } from "@/index";
import { InMemoryStorage } from "@/storage";
import type { Message } from "@/messages";

await ready;

const TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;

const mnemonicA = process.env.TEST_ACCOUNT_A;
const mnemonicB = process.env.TEST_ACCOUNT_B;

if (!mnemonicA || !mnemonicB) {
	console.error(
		"error: TEST_ACCOUNT_A and TEST_ACCOUNT_B env vars (mnemonics) are required\n" +
			"usage: TEST_ACCOUNT_A=\"<13 words>\" TEST_ACCOUNT_B=\"<13 words>\" bun scripts/smoke-message.ts",
	);
	process.exit(1);
}

const sessionA = new Session({ storage: new InMemoryStorage() });
sessionA.setMnemonic(mnemonicA);
const idA = sessionA.getSessionID();

const sessionB = new Session({ storage: new InMemoryStorage() });
sessionB.setMnemonic(mnemonicB);
const idB = sessionB.getSessionID();

console.log(`A: ${idA}`);
console.log(`B: ${idB}`);

const pollerB = new Poller({ interval: POLL_INTERVAL_MS });
sessionB.addPoller(pollerB);

const nonce = `smoke-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

const received = new Promise<Message>((resolve, reject) => {
	const timer = setTimeout(() => {
		reject(new Error(`timed out after ${TIMEOUT_MS} ms waiting for message from A`));
	}, TIMEOUT_MS);
	sessionB.on("message", (message) => {
		if (message.from === idA && message.text === nonce) {
			clearTimeout(timer);
			resolve(message);
		}
	});
});

const sentAt = Date.now();
const response = await sessionA.sendMessage({ to: idB, text: nonce });
console.log(`sent nonce=${nonce} messageHash=${response.messageHash}`);

try {
	const message = await received;
	const latencyMs = Date.now() - sentAt;
	console.log(
		`received messageHash=${message.id} latencyMs=${latencyMs} text matches: true`,
	);
	console.log("smoke-message: PASS");
	process.exit(0);
} catch (error) {
	console.error(`smoke-message: FAIL — ${(error as Error).message}`);
	process.exit(1);
}

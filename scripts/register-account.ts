/**
 * scripts/register-account.ts — register a fresh Session test account (plan P0-T2).
 *
 * Generates a fresh mnemonic (or takes one via --mnemonic), boots a Session
 * instance (bun-network), sets a display name, and registers the identity on
 * the swarm by sending a self-message. Prints the Session ID, the mnemonic,
 * and the resulting message hashes.
 *
 * NOTE: requires network access to the Session swarm (seed*.getsession.org).
 * NEVER commit mnemonics — CI stores them as TEST_ACCOUNT_A / TEST_ACCOUNT_B
 * secrets. Treat any mnemonic printed here as sensitive; rotate quarterly
 * (plan R11).
 *
 * Usage:
 *   bun scripts/register-account.ts [--mnemonic "<13 words>"] [--name "TestBot 1"]
 */
import { Session, ready } from "@/index";
import { encode } from "@session.js/mnemonic";
import { generateSeedHex } from "@session.js/keypair";

await ready;

const args = process.argv.slice(2);

function flagValue(name: string): string | undefined {
	const index = args.indexOf(name);
	if (index === -1) return undefined;
	const value = args[index + 1];
	if (value === undefined || value.startsWith("--")) {
		console.error(`error: ${name} requires a value`);
		process.exit(1);
	}
	return value;
}

const existingMnemonic = flagValue("--mnemonic");
const randomSuffix = Math.floor(Math.random() * 10000)
	.toString()
	.padStart(4, "0");
const displayName = flagValue("--name") ?? `TestBot ${randomSuffix}`;

const mnemonic = existingMnemonic ?? encode(generateSeedHex());

const session = new Session();
session.setMnemonic(mnemonic);
const sessionID = session.getSessionID();

console.log(`sessionID:  ${sessionID}`);
console.log(`mnemonic:   ${mnemonic}`);
console.log(`displayName: ${displayName}`);

// Sets the profile display name and stores a self-sync ConfigurationMessage,
// which also first-touches the account's swarm.
await session.setDisplayName(displayName);

// Register on the swarm explicitly: a self-message makes the identity visible
// to lookup/poll paths and confirms store/retrieve round-trip works.
const response = await session.sendMessage({
	to: sessionID,
	text: `session.js test account registration ${new Date().toISOString()}`,
});

console.log(`messageHash:     ${response.messageHash}`);
console.log(`syncMessageHash: ${response.syncMessageHash}`);
console.log(`timestamp:       ${response.timestamp}`);
console.log("registration complete");
process.exit(0);

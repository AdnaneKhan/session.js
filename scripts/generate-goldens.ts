// Written fresh from the published SessionProtos.proto field facts. MIT-licensable for upstream contribution.
/**
 * Generates the canonical CallMessage Content encodings (wire goldens) and writes
 * them as hex files to test/fixtures/wire/.
 *
 * Goldens are regenerated ONLY by human-reviewed change (IMPLEMENTATION.MD Appendix D);
 * tests compare live encoding output against the committed hex.
 *
 * Run: bun run scripts/generate-goldens.ts
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SignalService } from "@session.js/types/signal-bindings";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(scriptDir, "..", "test", "fixtures", "wire");

// CANONICAL INPUTS — do not vary (IMPLEMENTATION.MD P1-T2)
const UUID = "11111111-1111-4111-8111-111111111111";
const SDP_OFFER = "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n";
const SDP_ANSWER = "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=recvonly\r\n";
const CAND1 = "candidate:1 1 udp 2130706431 192.168.1.10 50000 typ host";
const CAND2 =
	"candidate:2 1 udp 1694498815 203.0.113.7 50000 typ srflx raddr 192.168.1.10 rport 50000";

const goldens: { name: string; callMessage: SignalService.ICallMessage }[] = [
	{
		name: "pre-offer",
		callMessage: { type: SignalService.CallMessage.Type.PRE_OFFER, uuid: UUID },
	},
	{
		name: "offer",
		callMessage: {
			type: SignalService.CallMessage.Type.OFFER,
			sdps: [SDP_OFFER],
			uuid: UUID,
		},
	},
	{
		name: "answer",
		callMessage: {
			type: SignalService.CallMessage.Type.ANSWER,
			sdps: [SDP_ANSWER],
			uuid: UUID,
		},
	},
	{
		name: "ice-candidates",
		callMessage: {
			type: SignalService.CallMessage.Type.ICE_CANDIDATES,
			sdps: [CAND1, CAND2],
			sdpMLineIndexes: [0, 0],
			sdpMids: ["0", "0"],
			uuid: UUID,
		},
	},
	{
		name: "end-call",
		callMessage: { type: SignalService.CallMessage.Type.END_CALL, uuid: UUID },
	},
];

mkdirSync(fixturesDir, { recursive: true });

for (const { name, callMessage } of goldens) {
	const content = new SignalService.Content({ callMessage });
	const bytes = SignalService.Content.encode(content).finish();
	const hex = Buffer.from(bytes).toString("hex");
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	writeFileSync(join(fixturesDir, `${name}.hex`), hex + "\n");
	console.log(`${name}.hex  sha256=${sha256}`);
	console.log(`  ${hex}`);
}

const readme = `# CallMessage wire goldens

Provenance: **computed** from the published SessionProtos.proto field facts
(\`session-foundation/libsession-util\`, proto/SessionProtos.proto, proto2):

- \`CallMessage\`: type=1 (enum varint), sdps=2 (repeated string), sdpMLineIndexes=3
  (repeated uint32, packed), sdpMids=4 (repeated string), uuid=5 (string, 36-char UUIDv4).
- \`Content.callMessage\` = field 3 (length-delimited). NOTE: Signal uses 6; Session uses 3.

Canonical inputs (see scripts/generate-goldens.ts, do not vary):

- UUID = \`11111111-1111-4111-8111-111111111111\`
- SDP_OFFER = \`v=0\\r\\no=- 0 0 IN IP4 127.0.0.1\\r\\ns=-\\r\\nt=0 0\\r\\n\`
- SDP_ANSWER = SDP_OFFER + \`a=recvonly\\r\\n\`
- CAND1 = \`candidate:1 1 udp 2130706431 192.168.1.10 50000 typ host\`
- CAND2 = \`candidate:2 1 udp 1694498815 203.0.113.7 50000 typ srflx raddr 192.168.1.10 rport 50000\`

| File | CallMessage shape |
|---|---|
| pre-offer.hex | {type: PRE_OFFER(6), uuid} |
| offer.hex | {type: OFFER(1), sdps: [SDP_OFFER], uuid} |
| answer.hex | {type: ANSWER(2), sdps: [SDP_ANSWER], uuid} |
| ice-candidates.hex | {type: ICE_CANDIDATES(4), sdps: [CAND1, CAND2], sdpMLineIndexes: [0, 0], sdpMids: ["0", "0"], uuid} |
| end-call.hex | {type: END_CALL(5), uuid} |

Hex = \`Buffer.from(SignalService.Content.encode(new SignalService.Content({ callMessage })).finish()).toString("hex")\`
using the \`@session.js/types\` pbjs static bindings (compiled from the vendored signalservice.proto,
which already carries the full official CallMessage schema).

Regenerated ONLY via human-reviewed change: \`bun run scripts/generate-goldens.ts\`.
Tests (test/wire/call-message-encode.test.ts) compare live encoding output to the committed hex.
`;
writeFileSync(join(fixturesDir, "README.md"), readme);
console.log("README.md written");

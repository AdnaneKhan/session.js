#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# scripts/consumer-smoke.sh — S9 consumer smoke test (plan P8-T2).
#
# Packs @session.js/calls, @session.js/groups, and the patched
# @session.js/client fork into tarballs, installs all three into a scratch
# consumer project, imports
# { CallManager, PeerConnectionManager } from the PACKED calls package,
# instantiates CallManager over a duck-typed SessionLike fake (structural
# contract — no real network), asserts construction + approval round-trip +
# dispose, and verifies the packed client tarball installs and imports.
# Prints tarball sizes + sha256s.
#
#   bash scripts/consumer-smoke.sh     # EXIT 0 required for release DoD
#
# Written fresh — no lines copied from GPL/AGPL sources.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "[smoke] repo root:  $REPO_ROOT"
echo "[smoke] scratch:    $WORK"

# --- 1. Build both packages fresh ------------------------------------------
echo "[smoke] building @session.js/client (fork) ..."
(cd "$REPO_ROOT" && bun run build)
echo "[smoke] building @session.js/calls ..."
(cd "$REPO_ROOT/calls" && bun run build)
echo "[smoke] building @session.js/groups ..."
(cd "$REPO_ROOT/groups" && bun run build)

# --- 2. Pack tarballs --------------------------------------------------------
echo "[smoke] packing tarballs ..."
(cd "$REPO_ROOT" && npm pack --pack-destination "$WORK" >/dev/null)
(cd "$REPO_ROOT/calls" && npm pack --pack-destination "$WORK" >/dev/null)
(cd "$REPO_ROOT/groups" && npm pack --pack-destination "$WORK" >/dev/null)
CLIENT_TGZ="$(ls "$WORK"/session.js-client-*.tgz)"
CALLS_TGZ="$(ls "$WORK"/session.js-calls-*.tgz)"
GROUPS_TGZ="$(ls "$WORK"/session.js-groups-*.tgz)"

echo "[smoke] tarball sizes:"
wc -c "$CLIENT_TGZ" "$CALLS_TGZ" "$GROUPS_TGZ" | sed 's/^/[smoke]   /'
echo "[smoke] sha256:"
shasum -a 256 "$CLIENT_TGZ" "$CALLS_TGZ" "$GROUPS_TGZ" | sed 's/^/[smoke]   /'

echo "[smoke] calls tarball contents (files-field effect — no docs/evidence/test/spike):"
tar -tzf "$CALLS_TGZ" | head -12 | sed 's/^/[smoke]   /'

# Unpacked size of the calls package (no node_modules — not in the tarball).
mkdir -p "$WORK/inspect"
tar -xzf "$CALLS_TGZ" -C "$WORK/inspect"
echo "[smoke] calls unpacked: $(du -sk "$WORK/inspect/package" | cut -f1) kB"

# --- 3. Scratch consumer -----------------------------------------------------
mkdir -p "$WORK/consumer"
cd "$WORK/consumer"
cat > package.json <<EOF
{
	"name": "consumer-smoke",
	"private": true,
	"type": "module",
	"dependencies": {
		"@session.js/calls": "file:$CALLS_TGZ",
		"@session.js/client": "file:$CLIENT_TGZ",
		"@session.js/groups": "file:$GROUPS_TGZ"
	}
}
EOF

cat > consumer.mjs <<'EOF'
import assert from "node:assert";
import { CallManager, PeerConnectionManager } from "@session.js/calls";

// Duck-typed SessionLike — the structural contract (src/types.ts). No real
// network; a patched @session.js/client Session satisfies the same shape.
const listeners = new Set();
const session = {
	getSessionID: () => `05${"c".repeat(64)}`,
	getNowWithNetworkOffset: () => Date.now(),
	on: (_e, cb) => listeners.add(cb),
	off: (_e, cb) => listeners.delete(cb),
	sendCallMessage: async () => ({ messageHash: "smoke", timestamp: Date.now() }),
	setPollInterval: () => undefined,
	acceptConversationRequest: async () => ({}),
};

const calls = new CallManager(session, { logger: () => undefined });
assert.strictEqual(calls.activeCall, undefined, "no active call after construction");
assert.strictEqual(typeof calls.call, "function", "call() on the surface");
assert.strictEqual(typeof calls.approveContact, "function", "approveContact() on the surface");
const peer = `05${"d".repeat(64)}`;
calls.approveContact(peer);
assert.strictEqual(calls.isContactApproved(peer), true, "approval round-trip");
const media = new PeerConnectionManager(); // advanced export; no session created here
assert.ok(media, "PeerConnectionManager constructs");
await calls.dispose();
console.log("[consumer] CallManager construct + approve + dispose: OK");
console.log("[consumer] PeerConnectionManager construct: OK");

// The packed fork client must install AND import.
const client = await import("@session.js/client");
assert.strictEqual(typeof client.Session, "function", "client Session export present");
console.log("[consumer] @session.js/client import: OK (Session export present)");

// The packed groups package must retain Node-compatible relative ESM imports.
const groups = await import("@session.js/groups");
assert.strictEqual(typeof groups.GroupManager, "function", "groups GroupManager export present");
console.log("[consumer] @session.js/groups import: OK (GroupManager export present)");
console.log("CONSUMER-SMOKE-PASS");
EOF

echo "[smoke] installing consumer dependencies (bun) ..."
bun install >/dev/null 2>&1 || bun install
echo "[smoke] running consumer script ..."
bun consumer.mjs
echo "[smoke] checking packed groups import under Node ..."
node -e "import('@session.js/groups').then(m => { if (typeof m.GroupManager !== 'function') throw new Error('no GroupManager export'); console.log('[consumer] @session.js/groups Node import: OK'); })"

echo "[smoke] CONSUMER SMOKE: EXIT 0"

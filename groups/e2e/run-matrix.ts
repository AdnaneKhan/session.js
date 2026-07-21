// SPDX-License-Identifier: AGPL-3.0-or-later
//
// @session.js/groups — offline E2E matrix runner (G8-T1).
// Usage: bun e2e/run-matrix.ts [--only <substring>]
// Exits 0 iff every scenario passes.
import { runScenarios } from "./scenarios";

const onlyArg = process.argv.includes("--only")
	? process.argv[process.argv.indexOf("--only") + 1]
	: undefined;

const results = await runScenarios();
const filtered = onlyArg ? results.filter((r) => r.name.includes(onlyArg)) : results;

let failures = 0;
console.log("Offline closed-groups E2E matrix");
console.log("=".repeat(60));
for (const r of filtered) {
	const mark = r.pass ? "PASS" : "FAIL";
	console.log(`  [${mark}] ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
	if (!r.pass) failures++;
}
console.log("=".repeat(60));
console.log(`${filtered.length - failures}/${filtered.length} scenarios passed`);

if (failures > 0) process.exit(1);

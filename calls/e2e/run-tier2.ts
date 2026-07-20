// SPDX-License-Identifier: AGPL-3.0-or-later
//
// run-tier2.ts — Tier-2 fault & stress suite CLI (plan P7-T3, tagged
// nightly; does NOT block Tier-1).
//
//   bun e2e/run-tier2.ts                     # offline fault/stress suite
//   SESSION_CALLS_NETWORK_TESTS=1 bun e2e/run-tier2.ts   # + networked poll-latency
//   bun e2e/run-tier2.ts --only <substr>     # run matching scenarios only
//
// Writes a SANITIZED JSON report to calls/e2e/reports/<run-id>/, prints a
// table, exits 0 iff everything passes and no unhandled rejections were
// observed. Per-scenario timeboxes live in the scenario definitions.
//
// Written fresh — no lines copied from GPL/AGPL sources.

import {
	NETWORK_TESTS_ENABLED,
	printTable,
	runScenarios,
	trackRejections,
	writeRunReport,
	type ScenarioContext,
} from "./harness.js";
import { tier2Scenarios } from "./scenarios-tier2.js";

function argValue(args: string[], flag: string): string | undefined {
	const i = args.indexOf(flag);
	return i >= 0 ? args[i + 1] : undefined;
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const network = NETWORK_TESTS_ENABLED || args.includes("--network");
	const ctx: ScenarioContext = {
		realTimeouts: args.includes("--real-timeouts"),
		capturePcm: args.includes("--capture-pcm"),
		networkRuns: 1,
		verbose: args.includes("--verbose") || process.env.SESSION_CALLS_VERBOSE === "1",
	};
	const only = argValue(args, "--only");

	let scenarios = tier2Scenarios();
	if (!network) scenarios = scenarios.filter((s) => s.mode !== "networked");
	if (only) scenarios = scenarios.filter((s) => s.name.includes(only));

	console.log(`[tier2] ${scenarios.length} scenarios — mode: ${network ? "offline + NETWORKED" : "offline only"}`);
	const rejections = trackRejections();

	const { report, allSecrets, pcmByScenario } = await runScenarios(scenarios, ctx, {
		tier: "tier2",
		onResult: (r) =>
			console.log(
				`[tier2] ${r.skipped ? "SKIP" : r.pass ? "PASS" : "FAIL"} ${r.name} ` +
					`(${r.checks} checks${r.checkFailures.length ? `, ${r.checkFailures.length} failed` : ""}, ` +
					`${Math.round(r.durationMs / 100) / 10}s)${r.error ? ` — ${r.error}` : ""}`,
			),
	});

	const { reportPath } = writeRunReport({
		runId: report.runId,
		report,
		secrets: allSecrets,
		pcmByScenario: ctx.capturePcm ? pcmByScenario : undefined,
	});
	console.log(`[tier2] report: ${reportPath}`);

	printTable(report);

	if (rejections.length > 0) {
		console.log(`[tier2] UNHANDLED REJECTIONS (${rejections.length}):`);
		for (const r of rejections) console.log(`  - ${r}`);
	}

	const ok = report.totals.fail === 0 && rejections.length === 0;
	console.log(`[tier2] ${ok ? "EXIT 0 (all green)" : "EXIT 1 (failures present)"}`);
	process.exit(ok ? 0 : 1);
}

main().catch((err) => {
	console.error("[tier2] fatal:", err);
	process.exit(1);
});

// SPDX-License-Identifier: AGPL-3.0-or-later
//
// run-tier1.ts — Tier-1 E2E suite CLI (plan P7-T2).
//
//   bun e2e/run-tier1.ts                     # offline suite (default)
//   SESSION_CALLS_NETWORK_TESTS=1 bun e2e/run-tier1.ts   # + networked lifecycle
//   bun e2e/run-tier1.ts --real-timeouts     # true 60 s timeout variant (nightly)
//   bun e2e/run-tier1.ts --capture-pcm       # write raw PCM captures
//   bun e2e/run-tier1.ts --only <substr>     # run matching scenarios only
//   bun e2e/run-tier1.ts --runs <n>          # networked repetition count (default 3)
//   bun e2e/run-tier1.ts --sample            # also write a sanitized copy to e2e/reports-sample/
//
// Prints a results table, writes a SANITIZED JSON report (+ optional PCM
// captures) to calls/e2e/reports/<run-id>/, exits 0 iff all scenarios pass
// and no unhandled rejections were observed.
//
// Written fresh — no lines copied from GPL/AGPL sources.

import path from "node:path";

import {
	CALLS_ROOT,
	NETWORK_TESTS_ENABLED,
	printTable,
	runScenarios,
	trackRejections,
	writeRunReport,
	type ScenarioContext,
} from "./harness.js";
import { tier1Scenarios } from "./scenarios-tier1.js";

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
		networkRuns: Math.max(1, Number.parseInt(argValue(args, "--runs") ?? "3", 10) || 3),
		verbose: args.includes("--verbose") || process.env.SESSION_CALLS_VERBOSE === "1",
	};
	const only = argValue(args, "--only");

	let scenarios = tier1Scenarios();
	if (!network) scenarios = scenarios.filter((s) => s.mode !== "networked");
	if (only) scenarios = scenarios.filter((s) => s.name.includes(only));

	console.log(`[tier1] ${scenarios.length} scenarios — mode: ${network ? "offline + NETWORKED" : "offline only"}` +
		`${ctx.realTimeouts ? " — REAL 60 s timeouts" : ""}${ctx.capturePcm ? " — PCM captures on" : ""}`);
	const rejections = trackRejections();

	const { report, allSecrets, pcmByScenario } = await runScenarios(scenarios, ctx, {
		tier: "tier1",
		onResult: (r) =>
			console.log(
				`[tier1] ${r.skipped ? "SKIP" : r.pass ? "PASS" : "FAIL"} ${r.name} ` +
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
	console.log(`[tier1] report: ${reportPath}`);

	if (args.includes("--sample")) {
		const sample = writeRunReport({
			reportsRoot: path.join(CALLS_ROOT, "e2e", "reports-sample"),
			runId: report.runId,
			report,
			secrets: allSecrets,
		});
		console.log(`[tier1] sanitized sample: ${sample.reportPath}`);
	}

	printTable(report);

	if (rejections.length > 0) {
		console.log(`[tier1] UNHANDLED REJECTIONS (${rejections.length}):`);
		for (const r of rejections) console.log(`  - ${r}`);
	}

	const ok = report.totals.fail === 0 && rejections.length === 0;
	console.log(`[tier1] ${ok ? "EXIT 0 (all green)" : "EXIT 1 (failures present)"}`);
	process.exit(ok ? 0 : 1);
}

main().catch((err) => {
	console.error("[tier1] fatal:", err);
	process.exit(1);
});

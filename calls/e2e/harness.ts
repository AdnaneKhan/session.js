// SPDX-License-Identifier: AGPL-3.0-or-later
//
// e2e harness framework for @session.js/calls (plan P7-T1).
//
// Spins up N in-process clients with TWO backends:
//
//   OFFLINE   — SignalingBus: an in-process signaling bus (the swarm
//               replaced by a function call, BusSession pattern from
//               examples/offline-echo.ts) + the REAL werift
//               PeerConnectionManager media plane (host-candidate ICE over
//               real UDP + DTLS-SRTP, iceServers: [] — zero TURN traffic).
//   NETWORKED — real patched-client Session instances (fresh mnemonics via
//               @session.js/mnemonic encode(generateSeedHex()), Poller
//               500 ms) talking over the live Session swarm. Gated behind
//               SESSION_CALLS_NETWORK_TESTS=1.
//
// Deterministic audio: SineSource (default 440 Hz, 48 kHz mono Int16,
// 960-sample / 20 ms frames) + ToneDetector (Goertzel tone presence).
// Timing collection per scenario (ring / connect / audio-first-frame /
// total). Evidence writer: sanitized JSON report (+ optional raw PCM
// captures) under e2e/reports/<run-id>/.
//
// SANITIZATION IS MANDATORY: every report passes through redactSensitive +
// a forbidden-token scan + caller-supplied secret scrubbing (mnemonics) and
// is asserted clean BEFORE it touches disk. Reports never contain
// mnemonics, TURN credentials, DTLS fingerprints, or SDP bodies.
//
// Written fresh — no lines copied from GPL/AGPL sources.

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
	CallManager,
	redactSensitive,
	CallMessageType,
	FRAME_MS,
	FRAME_SAMPLES,
	SAMPLE_RATE,
	goertzel,
	sineFrame,
	toneSnrDb,
	type Call,
	type CallInfo,
	type CallLogger,
	type CallManagerDeps,
	type CallManagerOptions,
	type CallMessageEvent,
	type CallMessageTypeValue,
	type MissedCallRecord,
	type OutgoingCallMessage,
	type SessionLike,
} from "../src/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** calls/ package root. */
export const CALLS_ROOT = path.resolve(HERE, "..");
/** Fork client repo root (contains scripts/, test/fixtures/wire/). */
export const REPO_ROOT = path.resolve(HERE, "../..");

export const NETWORK_TESTS_ENABLED = process.env.SESSION_CALLS_NETWORK_TESTS === "1";

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
export const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// ---------------------------------------------------------------------------
// Small assertion accumulator
// ---------------------------------------------------------------------------

export class Checks {
	readonly failures: string[] = [];
	count = 0;

	ok(cond: boolean, label: string): void {
		this.count++;
		if (!cond) this.failures.push(label);
	}
	eq<T>(actual: T, expected: T, label: string): void {
		this.count++;
		const a = JSON.stringify(actual);
		const e = JSON.stringify(expected);
		if (a !== e) this.failures.push(`${label} (got ${a}, want ${e})`);
	}
	get pass(): boolean {
		return this.failures.length === 0;
	}
}

export async function waitFor(
	cond: () => boolean,
	timeoutMs: number,
	what: string,
	pollMs = 50,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!cond()) {
		if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
		await sleep(pollMs);
	}
}

// ---------------------------------------------------------------------------
// Deterministic audio: SineSource + ToneDetector (Goertzel)
// ---------------------------------------------------------------------------

/** Deterministic PCM source: 48 kHz mono Int16, 960-sample (20 ms) frames. */
export class SineSource {
	#index = 0;
	constructor(
		readonly freq = 440,
		readonly amplitude = 8000,
	) {}
	/** Next 20 ms frame (phase-continuous across frames). */
	frame(): Int16Array {
		return sineFrame(this.#index++, this.freq, this.amplitude);
	}
	get framesGenerated(): number {
		return this.#index;
	}
}

/** Accumulates received PCM and detects a single tone via Goertzel. */
export class ToneDetector {
	readonly #chunks: Int16Array[] = [];
	#firstFrameAt: number | undefined;

	constructor(
		readonly freq = 440,
		readonly sampleRate = SAMPLE_RATE,
	) {}

	push(pcm: Int16Array): void {
		if (this.#firstFrameAt === undefined) this.#firstFrameAt = Date.now();
		this.#chunks.push(pcm.slice());
	}

	get frames(): number {
		return this.#chunks.length;
	}
	get samples(): number {
		return this.#chunks.length * FRAME_SAMPLES;
	}
	get firstFrameAt(): number | undefined {
		return this.#firstFrameAt;
	}

	/** Concatenate all received frames (optionally only the last N frames). */
	concat(lastFrames?: number): Int16Array {
		const chunks = lastFrames === undefined ? this.#chunks : this.#chunks.slice(-lastFrames);
		const out = new Int16Array(chunks.length * FRAME_SAMPLES);
		let off = 0;
		for (const c of chunks) {
			out.set(c, off);
			off += c.length;
		}
		return out;
	}

	/**
	 * Tone presence: Goertzel power at `freq` vs the rest of the spectrum.
	 * snrDb ≥ snrThresholdDb (default 20 dB — the P3-T1 spike measured
	 * ~198 dB for a clean path, so 20 dB is a conservative "tone present").
	 */
	detect(snrThresholdDb = 20): { present: boolean; snrDb: number; magnitude: number } {
		const all = this.concat();
		if (all.length < FRAME_SAMPLES * 5) {
			return { present: false, snrDb: Number.NEGATIVE_INFINITY, magnitude: 0 };
		}
		const snrDb = toneSnrDb(all, this.freq, this.sampleRate);
		const magnitude = goertzel(all, this.freq, this.sampleRate).magnitude;
		return { present: Number.isFinite(snrDb) && snrDb >= snrThresholdDb, snrDb, magnitude };
	}
}

/** Pump `frames` frames from a SineSource into a call at real-time pace. */
export async function pumpAudio(call: Call, source: SineSource, frames: number): Promise<number> {
	let sent = 0;
	for (let i = 0; i < frames; i++) {
		const frame = source.frame();
		// Backpressure: the bridge queue is ~1 s; retry the SAME frame.
		while (!call.writeAudio(frame)) {
			await sleep(FRAME_MS / 2);
		}
		sent++;
		await sleep(FRAME_MS);
	}
	return sent;
}

// ---------------------------------------------------------------------------
// Timing collection
// ---------------------------------------------------------------------------

export interface ScenarioTimings {
	/** call() → callee `incoming` event (PRE_OFFER processed). */
	ringMs?: number;
	/** call() → both sides `connected`. */
	connectMs?: number;
	/** call() → first decoded audio frame at the callee. */
	audioFirstFrameMs?: number;
	/** call() → scenario fully settled (final end + asserts). */
	totalMs?: number;
}

export class TimingCollector {
	readonly t0 = Date.now();
	readonly timings: ScenarioTimings = {};

	ring(): void {
		this.timings.ringMs ??= Date.now() - this.t0;
	}
	connect(): void {
		this.timings.connectMs ??= Date.now() - this.t0;
	}
	audioFirstFrame(): void {
		this.timings.audioFirstFrameMs ??= Date.now() - this.t0;
	}
	total(): void {
		this.timings.totalMs = Date.now() - this.t0;
	}
}

// ---------------------------------------------------------------------------
// OFFLINE backend — in-process signaling bus + real werift media
// ---------------------------------------------------------------------------

/** Everything stored to the "swarm" (bus spy record; SDPs in-memory only). */
export interface WireRecord {
	from: string;
	to: string;
	isSync: boolean;
	type: CallMessageTypeValue;
	uuid: string;
	at: number;
	sdps: string[];
	sdpMLineIndexes: number[];
	sdpMids: string[];
	dropped: boolean;
}

/**
 * In-process signaling bus. Models the swarm: `store()` fans a message out
 * to every endpoint registered under the destination Session ID (multiple
 * endpoints per ID = multiple linked devices polling the same swarm),
 * EXCLUDING the storing endpoint itself (session.js hash-dedupes a device's
 * own stores; linked devices observe them). Supports:
 *   - `wire` — the spy: every stored message, in order;
 *   - `deliveryDelayMs` — per-message delivery latency (poll-cadence
 *     simulation for the Tier-2 poll-latency scenario);
 *   - `drop` — predicate dropper (Tier-2 signaling-loss scenario).
 */
export class SignalingBus {
	readonly endpoints: BusSession[] = [];
	/** Bus spy: every stored message (incl. dropped ones, flagged). */
	readonly wire: WireRecord[] = [];
	deliveryDelayMs = 0;
	drop: ((rec: WireRecord) => boolean) | undefined;
	#nextId = 1;

	attach(ep: BusSession): void {
		this.endpoints.push(ep);
	}
	detach(ep: BusSession): void {
		const i = this.endpoints.indexOf(ep);
		if (i >= 0) this.endpoints.splice(i, 1);
	}

	store(
		sender: BusSession,
		to: string,
		msg: OutgoingCallMessage,
		opts: { isSync: boolean },
	): { messageHash: string; timestamp: number } {
		const rec: WireRecord = {
			from: sender.id,
			to: opts.isSync ? sender.id : to,
			isSync: opts.isSync,
			type: msg.type,
			uuid: msg.uuid,
			at: Date.now(),
			sdps: msg.sdps ?? [],
			sdpMLineIndexes: msg.sdpMLineIndexes ?? [],
			sdpMids: msg.sdpMids ?? [],
			dropped: false,
		};
		this.wire.push(rec);
		const hash = `bus-${this.#nextId++}`;
		if (this.drop?.(rec) === true) {
			rec.dropped = true;
			return { messageHash: hash, timestamp: rec.at };
		}
		const event: CallMessageEvent = {
			uuid: rec.uuid,
			type: rec.type,
			from: rec.from,
			timestamp: rec.at,
			sdps: [...rec.sdps],
			sdpMLineIndexes: [...rec.sdpMLineIndexes],
			sdpMids: [...rec.sdpMids],
		};
		const targets = this.endpoints.filter((e) => e.id === rec.to && e !== sender);
		const deliver = (): void => {
			for (const t of targets) t.deliver(event);
		};
		if (this.deliveryDelayMs > 0) {
			setTimeout(deliver, this.deliveryDelayMs);
		} else {
			queueMicrotask(deliver);
		}
		return { messageHash: hash, timestamp: rec.at };
	}

	/** Spy helper: stored message types, optionally filtered by from/to id. */
	types(filter?: { from?: string; to?: string; isSync?: boolean }): CallMessageTypeValue[] {
		return this.wire
			.filter(
				(w) =>
					(filter?.from === undefined || w.from === filter.from) &&
					(filter?.to === undefined || w.to === filter.to) &&
					(filter?.isSync === undefined || w.isSync === filter.isSync),
			)
			.map((w) => w.type);
	}

	/** Spy helper: full records filtered by from/to/isSync. */
	records(filter?: { from?: string; to?: string; isSync?: boolean }): WireRecord[] {
		return this.wire.filter(
			(w) =>
				(filter?.from === undefined || w.from === filter.from) &&
				(filter?.to === undefined || w.to === filter.to) &&
				(filter?.isSync === undefined || w.isSync === filter.isSync),
		);
	}
}

/**
 * In-process SessionLike endpoint on a SignalingBus. The swarm replaced by
 * a function call (the examples/offline-echo.ts BusSession pattern, extended
 * with per-endpoint send accounting for multi-device assertions).
 */
export class BusSession implements SessionLike {
	readonly listeners = new Set<(msg: CallMessageEvent) => void>();
	/** Per-endpoint send accounting (distinguishes same-id devices). */
	readonly sent: { to: string; isSync: boolean; type: CallMessageTypeValue; uuid: string }[] = [];
	readonly pollIntervals: number[] = [];
	readonly approvals: string[] = [];

	constructor(
		readonly id: string,
		readonly bus: SignalingBus,
	) {
		bus.attach(this);
	}

	getSessionID(): string {
		return this.id;
	}
	getNowWithNetworkOffset(): number {
		return Date.now();
	}
	on(_event: "call", cb: (msg: CallMessageEvent) => void): void {
		this.listeners.add(cb);
	}
	off(_event: "call", cb: (msg: CallMessageEvent) => void): void {
		this.listeners.delete(cb);
	}
	async sendCallMessage(
		to: string,
		msg: OutgoingCallMessage,
		options?: { isSyncMessage?: boolean },
	): Promise<{ messageHash: string; timestamp: number }> {
		const isSync = options?.isSyncMessage === true;
		this.sent.push({ to: isSync ? this.id : to, isSync, type: msg.type, uuid: msg.uuid });
		return this.bus.store(this, to, msg, { isSync });
	}
	setPollInterval(interval: number): void {
		this.pollIntervals.push(interval);
	}
	async acceptConversationRequest(opts: { from: string }): Promise<unknown> {
		this.approvals.push(opts.from);
		return {};
	}

	/** Bus → poll-delivery into this endpoint's call listeners. */
	deliver(msg: CallMessageEvent): void {
		for (const cb of [...this.listeners]) cb(msg);
	}
}

// ---------------------------------------------------------------------------
// Client kit (backend-agnostic)
// ---------------------------------------------------------------------------

export interface LogLine {
	level: string;
	msg: string;
	meta?: unknown;
	at: number;
}

/** Concatenated capture text (msg + JSON meta) for redaction assertions. */
export function logText(sink: LogLine[]): string {
	return sink
		.map((l) => `${l.level} ${l.msg} ${l.meta === undefined ? "" : JSON.stringify(l.meta)}`)
		.join("\n");
}

export interface ClientKit {
	id: string;
	session: SessionLike;
	manager: CallManager;
	logs: LogLine[];
	incoming: Call[];
	outgoing: Call[];
	ended: CallInfo[];
	missed: MissedCallRecord[];
	errors: { call?: Call; error: Error }[];
	/** Secrets bound to this client (mnemonics) — scrubbed from reports. */
	secrets: string[];
}

function wireKit(
	id: string,
	session: SessionLike,
	options?: CallManagerOptions,
	deps?: CallManagerDeps,
): ClientKit {
	const logs: LogLine[] = [];
	const userLogger = options?.logger;
	const logger: CallLogger = (level, msg, meta) => {
		logs.push({ level, msg, meta, at: Date.now() });
		userLogger?.(level, msg, meta);
	};
	const manager = new CallManager(session, { ...options, logger }, deps);
	const kit: ClientKit = {
		id,
		session,
		manager,
		logs,
		incoming: [],
		outgoing: [],
		ended: [],
		missed: [],
		errors: [],
		secrets: [],
	};
	manager.on("incoming", (call) => {
		kit.incoming.push(call);
		call.on("ended", (info) => kit.ended.push(info));
	});
	manager.on("outgoing", (call) => {
		kit.outgoing.push(call);
		call.on("ended", (info) => kit.ended.push(info));
	});
	manager.on("missed", (record) => kit.missed.push(record));
	manager.on("error", (payload) => kit.errors.push(payload));
	return kit;
}

/**
 * OFFLINE client: BusSession endpoint + CallManager with the real werift
 * media plane and `iceServers: []` (host-candidate ICE only — zero TURN
 * traffic, plan R7 ethics; loopback/host pairing proven by offline-echo).
 */
export function offlineClient(
	id: string,
	bus: SignalingBus,
	options?: CallManagerOptions,
	deps?: CallManagerDeps,
): ClientKit {
	const session = new BusSession(id, bus);
	return wireKit(id, session, { iceServers: [], callTimeoutMs: 30_000, ...options }, deps);
}

/** Auto-accept inbound calls once the OFFER has arrived (remote-ring). */
export function autoAcceptAtRing(kit: ClientKit, timings?: TimingCollector): void {
	kit.manager.on("incoming", (call) => {
		timings?.ring();
		void waitFor(() => call.info.state === "remote-ring", 20_000, "remote-ring before accept")
			.then(() => call.accept())
			.catch((err: unknown) =>
				kit.errors.push({ call, error: err instanceof Error ? err : new Error(String(err)) }),
			);
	});
}

/**
 * NETWORKED client: a real patched-client Session with a freshly generated
 * account (the mnemonic never leaves the process except into the report
 * sanitizer's secret list). Poller interval configurable (default 500 ms).
 */
export async function networkedClient(
	options?: CallManagerOptions & { pollIntervalMs?: number },
): Promise<ClientKit> {
	const { Session, Poller, ready } = await import("../../src/index.js");
	const { encode } = await import("@session.js/mnemonic");
	const { generateSeedHex } = await import("@session.js/keypair");
	await ready;
	const session = new Session();
	const mnemonic = encode(generateSeedHex());
	session.setMnemonic(mnemonic);
	session.addPoller(new Poller({ interval: options?.pollIntervalMs ?? 500 }));
	// Structural bridge: the fork Session satisfies SessionLike (plan §4.4;
	// the same cast the networked integration test uses).
	const kit = wireKit(session.getSessionID(), session as never, options);
	kit.secrets.push(mnemonic);
	return kit;
}

// ---------------------------------------------------------------------------
// Scenario / report plumbing
// ---------------------------------------------------------------------------

export interface ScenarioContext {
	/** --real-timeouts: run the true 60 s timeout variants (nightly). */
	realTimeouts: boolean;
	/** --capture-pcm: write raw PCM captures into the report dir. */
	capturePcm: boolean;
	/** networked scenario repetition count (S1 sampling). */
	networkRuns: number;
	verbose: boolean;
}

export interface ScenarioResult {
	name: string;
	mode: "offline" | "networked";
	tier: "tier1" | "tier2";
	pass: boolean;
	skipped: boolean;
	skipReason?: string;
	error?: string;
	checks: number;
	checkFailures: string[];
	timings: ScenarioTimings;
	detail: Record<string, unknown>;
	durationMs: number;
}

export interface ScenarioOutcome {
	checks: Checks;
	timings: ScenarioTimings;
	detail: Record<string, unknown>;
	secrets?: string[];
	pcm?: Record<string, Int16Array>;
}

export interface Scenario {
	name: string;
	mode: "offline" | "networked";
	tier: "tier1" | "tier2";
	/** Hard per-scenario guard (ms); exceeding it fails the scenario. */
	guardMs?: number;
	run(ctx: ScenarioContext): Promise<ScenarioOutcome>;
}

export interface RunReport {
	runId: string;
	generatedAt: string;
	tier: string;
	networked: boolean;
	runtime: { name: string; version: string; platform: string; arch: string };
	repo: { branch?: string; head?: string };
	durationMs: number;
	totals: { pass: number; fail: number; skip: number; checks: number };
	results: ScenarioResult[];
}

export function runtimeInfo(): RunReport["runtime"] {
	const isBun = "Bun" in globalThis;
	return {
		name: isBun ? "bun" : "node",
		version: isBun ? (process.versions as { bun?: string }).bun ?? "unknown" : process.version,
		platform: process.platform,
		arch: process.arch,
	};
}

export function repoInfo(): RunReport["repo"] {
	try {
		const branch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
			cwd: REPO_ROOT,
			encoding: "utf8",
			timeout: 5_000,
		});
		const head = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
			cwd: REPO_ROOT,
			encoding: "utf8",
			timeout: 5_000,
		});
		return {
			branch: branch.status === 0 ? branch.stdout.trim() : undefined,
			head: head.status === 0 ? head.stdout.trim() : undefined,
		};
	} catch {
		return {};
	}
}

/** Run a set of scenarios with per-scenario isolation and guard timeouts. */
export async function runScenarios(
	scenarios: Scenario[],
	ctx: ScenarioContext,
	opts: { tier: "tier1" | "tier2"; onResult?: (r: ScenarioResult) => void },
): Promise<{
	report: RunReport;
	allSecrets: string[];
	pcmByScenario: Map<string, Record<string, Int16Array>>;
}> {
	const started = Date.now();
	const results: ScenarioResult[] = [];
	const allSecrets: string[] = [];
	const pcmByScenario = new Map<string, Record<string, Int16Array>>();

	for (const sc of scenarios) {
		const scStart = Date.now();
		const guardMs = sc.guardMs ?? (sc.mode === "networked" ? 200_000 : 120_000);
		let result: ScenarioResult;
		try {
			const outcome = await withGuard(sc.run(ctx), guardMs, `scenario "${sc.name}" guard`);
			for (const s of outcome.secrets ?? []) allSecrets.push(s);
			if (outcome.pcm) pcmByScenario.set(sc.name, outcome.pcm);
			result = {
				name: sc.name,
				mode: sc.mode,
				tier: opts.tier,
				pass: outcome.checks.pass,
				skipped: false,
				checks: outcome.checks.count,
				checkFailures: outcome.checks.failures,
				timings: outcome.timings,
				detail: outcome.detail,
				durationMs: Date.now() - scStart,
			};
		} catch (err) {
			result = {
				name: sc.name,
				mode: sc.mode,
				tier: opts.tier,
				pass: false,
				skipped: false,
				error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
				checks: 0,
				checkFailures: [],
				timings: {},
				detail: {},
				durationMs: Date.now() - scStart,
			};
		}
		results.push(result);
		opts.onResult?.(result);
	}

	const report: RunReport = {
		runId: makeRunId(opts.tier),
		generatedAt: new Date().toISOString(),
		tier: opts.tier,
		networked: results.some((r) => r.mode === "networked"),
		runtime: runtimeInfo(),
		repo: repoInfo(),
		durationMs: Date.now() - started,
		totals: {
			pass: results.filter((r) => r.pass).length,
			fail: results.filter((r) => !r.pass && !r.skipped).length,
			skip: results.filter((r) => r.skipped).length,
			checks: results.reduce((acc, r) => acc + r.checks, 0),
		},
		results,
	};
	return { report, allSecrets, pcmByScenario };
}

export function withGuard<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const guard = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${what}: exceeded ${ms} ms`)), ms);
	});
	return Promise.race([p, guard]).finally(() => clearTimeout(timer)) as Promise<T>;
}

export function makeRunId(tier: string): string {
	return `${new Date().toISOString().replace(/[:.]/g, "-")}-${tier}`;
}

// ---------------------------------------------------------------------------
// Report sanitization + writer (evidence protocol, plan §6)
// ---------------------------------------------------------------------------

/**
 * Markers that must NEVER appear in a written/committed report: TURN
 * credentials, DTLS fingerprints, SDP bodies (v=/o=/m= lines, a=fingerprint),
 * PEM key material. TURN HOSTS are public constants (shipped in every
 * official client) and MAY appear.
 */
export const FORBIDDEN_REPORT_MARKERS: { re: RegExp; label: string }[] = [
	{ re: /session202111/, label: "TURN username" },
	{ re: /053c268164bc7bd7/, label: "TURN password" },
	{ re: /a=fingerprint/i, label: "DTLS fingerprint" },
	// SDP bodies — matched in raw text (real CRLF) AND in JSON-serialized
	// text (escaped \r\n → literal backslash sequences).
	{ re: /v=0(\r\n|\n|\\r\\n)/, label: "SDP body (v=0)" },
	{ re: /o=- \d/, label: "SDP origin line" },
	{ re: /m=audio \d/, label: "SDP media line" },
	{ re: /-----BEGIN /, label: "PEM key material" },
];

/** redactSensitive + caller-supplied secrets (mnemonics, …). */
export function sanitizeReportText(text: string, secrets: string[] = []): string {
	let out = redactSensitive(text);
	for (const s of secrets) {
		if (s && s.length > 0) out = out.split(s).join("[REDACTED-SECRET]");
	}
	return out;
}

/** Throws if the text still contains anything sensitive. */
export function assertReportClean(text: string, secrets: string[] = []): void {
	for (const { re, label } of FORBIDDEN_REPORT_MARKERS) {
		if (re.test(text)) {
			throw new Error(`report NOT sanitized: matches ${label} (${re})`);
		}
	}
	for (const s of secrets) {
		if (s && s.length > 0 && text.includes(s)) {
			throw new Error("report NOT sanitized: contains a caller-supplied secret");
		}
	}
}

const jsonReplacer = (_key: string, value: unknown): unknown => {
	if (value instanceof Error) {
		return { name: value.name, message: value.message, code: (value as { code?: string }).code };
	}
	if (value instanceof Int16Array) {
		return { __pcmFrames: Math.floor(value.length / FRAME_SAMPLES) };
	}
	return value;
};

export interface WriteReportOptions {
	reportsRoot?: string;
	runId: string;
	report: RunReport;
	secrets?: string[];
	pcmByScenario?: Map<string, Record<string, Int16Array>>;
}

/**
 * Write report.json (+ per-scenario raw .pcm captures) under
 * <reportsRoot>/<runId>/. The JSON is sanitized, asserted clean, and
 * re-parsed before touching disk. Returns the report directory.
 */
export function writeRunReport(opts: WriteReportOptions): { dir: string; reportPath: string } {
	const reportsRoot = opts.reportsRoot ?? path.join(CALLS_ROOT, "e2e", "reports");
	const dir = path.join(reportsRoot, opts.runId);
	mkdirSync(dir, { recursive: true });

	const raw = JSON.stringify(opts.report, jsonReplacer, 2);
	const clean = sanitizeReportText(raw, opts.secrets);
	assertReportClean(clean, opts.secrets);
	JSON.parse(clean); // must remain valid JSON after redaction
	const reportPath = path.join(dir, "report.json");
	writeFileSync(reportPath, clean);

	for (const [scenario, captures] of opts.pcmByScenario ?? new Map()) {
		const scDir = path.join(dir, scenario);
		mkdirSync(scDir, { recursive: true });
		for (const [name, pcm] of Object.entries(captures)) {
			writeFileSync(
				path.join(scDir, `${name}.pcm`),
				Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength),
			);
		}
	}
	return { dir, reportPath };
}

// ---------------------------------------------------------------------------
// Wire-golden regression helper (Tier-1): shells out to the repo script
// ---------------------------------------------------------------------------

export function verifyWireFixtures(): { pass: boolean; output: string } {
	const r = spawnSync("bun", ["scripts/verify-fixtures.ts"], {
		cwd: REPO_ROOT,
		encoding: "utf8",
		timeout: 120_000,
	});
	const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
	return { pass: r.status === 0, output };
}

// ---------------------------------------------------------------------------
// CLI table printer
// ---------------------------------------------------------------------------

function fmtMs(v: number | undefined): string {
	return v === undefined ? "—" : `${v}`;
}

export function printTable(report: RunReport): void {
	const header = ["scenario", "mode", "result", "checks", "ring", "connect", "audio1st", "total", "dur"];
	const rows = report.results.map((r) => [
		r.name,
		r.mode,
		r.skipped ? "SKIP" : r.pass ? "PASS" : "FAIL",
		`${r.checks}${r.checkFailures.length ? ` (${r.checkFailures.length}✗)` : ""}`,
		fmtMs(r.timings.ringMs),
		fmtMs(r.timings.connectMs),
		fmtMs(r.timings.audioFirstFrameMs),
		fmtMs(r.timings.totalMs),
		`${Math.round(r.durationMs / 100) / 10}s`,
	]);
	const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => (row[i] ?? "").length)));
	const line = (cells: string[]): string => cells.map((c, i) => (c ?? "").padEnd(widths[i] ?? 0)).join("  ");
	console.log("");
	console.log(line(header));
	console.log(line(widths.map((w) => "-".repeat(w))));
	for (const row of rows) console.log(line(row));
	console.log("");
	console.log(
		`totals: ${report.totals.pass} pass / ${report.totals.fail} fail / ${report.totals.skip} skip — ` +
			`${report.totals.checks} checks — ${Math.round(report.durationMs / 100) / 10}s total`,
	);
	for (const r of report.results.filter((x) => !x.pass && !x.skipped)) {
		console.log(`FAIL ${r.name}${r.error ? `: ${r.error}` : ""}`);
		for (const f of r.checkFailures) console.log(`  ✗ ${f}`);
	}
}

// ---------------------------------------------------------------------------
// Unhandled-rejection tracker (containment evidence for stress scenarios)
// ---------------------------------------------------------------------------

export function trackRejections(): string[] {
	const rejections: string[] = [];
	process.on("unhandledRejection", (reason: unknown) => {
		rejections.push(reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason));
	});
	return rejections;
}

export { CallMessageType, FRAME_MS, FRAME_SAMPLES, SAMPLE_RATE };

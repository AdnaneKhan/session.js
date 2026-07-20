// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PCM↔Opus codec abstraction for the voice-call media plane (plan §4.1 D3,
// §4.7, P4-T2). Written fresh — no lines copied from GPL/AGPL sources.
//
// FINDING (P3-T1 spike, werift@0.23.0): werift provides the Opus RTP PIPELINE
// — codec negotiation (`useOPUS`), payloading/depayloading (`OpusRtpPayload`;
// for Opus the RTP payload IS the raw Opus packet), sender/receiver plumbing,
// jitter handling — but it ships NO PCM↔Opus conversion. PCM conversion is
// supplied by this module behind the `Codec` interface.
//
// D3 primary path, as realized:
//   PCM --[Codec.encode]--> Opus packet --[werift MediaStreamTrack.writeRtp]--> RTP
//   RTP --[werift track.onReceiveRtp]--> Opus packet --[Codec.decode]--> PCM
//
// Current implementation: DiscordOpusCodec, backed by @discordjs/opus
// (MIT-licensed native N-API binding of Xiph libopus). Declared as an
// OPTIONAL dependency: installs that cannot provide the native binary still
// install cleanly; constructing the codec without it throws a descriptive
// error (RuntimeUnsupported-class, plan §P6-T3).
//
// Plugging in an alternative later (e.g. a WASM build of libopus, or a
// different N-API binding): implement `Codec` and pass it to AudioBridge via
// `AudioBridgeOptions.codec`. A WASM codec would likely need async
// instantiation — keep construction out of hot paths (it already is:
// AudioBridge creates one codec instance per session).

import { cpSync, existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";

// Duplicated from dsp.js on purpose: this module must carry NO relative
// imports so spike scripts can load it directly from source under Node's
// native type-stripping (which does not rewrite .js → .ts).
const SAMPLE_RATE = 48_000;
const FRAME_SAMPLES = 960;

/**
 * Synchronous PCM↔Opus codec over the plan §4.3 audio contract
 * (48 kHz, mono, signed 16-bit PCM, 960-sample / 20 ms frames).
 */
export interface Codec {
	/** Human-readable implementation name (diagnostics). */
	readonly name: string;
	/**
	 * Encode one 960-sample Int16 PCM frame into one Opus packet.
	 * Implementations may assume (and validate) the 960-sample contract.
	 */
	encode(pcm: Int16Array): Uint8Array;
	/**
	 * Decode one Opus packet into Int16 PCM. Typically 960 samples; callers
	 * must not assume a size (AudioBridge rechunks to the 960 contract).
	 */
	decode(packet: Uint8Array): Int16Array;
}

// ---------------------------------------------------------------------------
// @discordjs/opus binding (optional dependency)
// ---------------------------------------------------------------------------

/** Structural type for the parts of @discordjs/opus we use. */
interface NativeOpusEncoder {
	encode(pcm: Int16Array): Buffer;
	decode(packet: Uint8Array): Buffer;
}

interface NativeOpusModule {
	OpusEncoder: new (rate: number, channels: number, application?: number) => NativeOpusEncoder;
}

const req = createRequire(import.meta.url);

/**
 * Load the @discordjs/opus native module, repairing node-pre-gyp's prebuild
 * lookup when the current runtime's ABI label does not match the shipped
 * prebuild directory name.
 *
 * Why this exists (P3-T1/P4-T2 evidence): @discordjs/opus locates its
 * N-API binary via `@discordjs/node-pre-gyp` `find()`, which interpolates
 * `node-v${process.versions.modules}` into the prebuild path. The npm
 * tarball ships the prebuild labeled for one Node ABI (e.g. `node-v141`
 * for Node 25), but other N-API ≥ 3 runtimes disagree on `modules`
 * (Bun reports 137). The binary itself is N-API-v3 — ABI-stable across
 * runtimes — so the repair aliases any existing `napi-v3-<platform>-<arch>`
 * prebuild directory under the expected name and retries once. Best-effort:
 * failures fall through to the original error.
 */
function loadNativeOpus(): NativeOpusModule {
	try {
		return req("@discordjs/opus") as NativeOpusModule;
	} catch (err) {
		repairPrebuildAlias();
		try {
			return req("@discordjs/opus") as NativeOpusModule;
		} catch {
			throw err;
		}
	}
}

function repairPrebuildAlias(): void {
	try {
		const { find } = req("@discordjs/node-pre-gyp") as {
			find: (packageJsonPath: string) => string;
		};
		const pkgPath: string = req.resolve("@discordjs/opus/package.json");
		const expectedDir = dirname(find(pkgPath));
		if (existsSync(expectedDir)) {
			return;
		}
		const root = dirname(expectedDir);
		const needle = `napi-v3-${process.platform}-${process.arch}`;
		const sibling = readdirSync(root).find(
			(d) => d.includes(needle) && d !== basename(expectedDir),
		);
		if (sibling === undefined) {
			return;
		}
		cpSync(join(root, sibling), expectedDir, { recursive: true });
	} catch {
		// Best-effort only — the subsequent require re-throw carries the real error.
	}
}

/**
 * Opus codec backed by @discordjs/opus (MIT; wraps Xiph libopus, BSD-3).
 * Encodes at the Opus-native 48 kHz / mono / 960-sample frame size using
 * libopus default bitrate control. The SDP-level `cbr=1` constraint lives in
 * sdp.ts per the Android-parity munging (plan §4.7/D4).
 *
 * KNOWN-ISSUE FINDINGS (P3-T1 spike, @discordjs/opus@0.10.0):
 *
 * 1. `applyEncoderCTL(OPUS_SET_BITRATE=4002, value)` with values ≲ 32 kbps
 *    deterministically SIGSEGVs inside the bundled libopus (darwin-arm64
 *    verified) on the FIRST subsequent encode of non-silent audio (12k/24k/
 *    32k crash; 64k and OPUS_AUTO=-1000 do not; silence never crashes). We
 *    therefore never touch encoder CTLs — libopus defaults produce
 *    wire-compatible Opus either way, and the exact local bitrate is not
 *    part of Session's wire contract.
 *
 * 2. The native `OpusEncoder` object aliases internal memory between its
 *    encode() and decode() paths: using ONE instance for both directions
 *    corrupts audio (measured: echo chain tone-SNR −3.9 dB shared vs
 *    +191 dB with separate instances), because buffers returned by one call
 *    are invalidated by the next call on the same object. This class
 *    therefore instantiates TWO native encoders — one used exclusively for
 *    encode(), one exclusively for decode() — making bidirectional use of a
 *    single Codec safe by construction.
 */
export class DiscordOpusCodec implements Codec {
	readonly name = "discordjs-opus";
	#encodeOnly: NativeOpusEncoder;
	#decodeOnly: NativeOpusEncoder;

	constructor() {
		const mod = loadNativeOpus();
		this.#encodeOnly = new mod.OpusEncoder(SAMPLE_RATE, 1);
		this.#decodeOnly = new mod.OpusEncoder(SAMPLE_RATE, 1);
	}

	encode(pcm: Int16Array): Uint8Array {
		if (pcm.length !== FRAME_SAMPLES) {
			throw new TypeError(
				`opus encode expects ${FRAME_SAMPLES}-sample frames, got ${pcm.length}`,
			);
		}
		// @discordjs/opus reads the whole typed array; copy if this is an
		// offset view so we never encode adjacent memory.
		const owned = pcm.byteOffset === 0 ? pcm : Int16Array.from(pcm);
		const pkt = this.#encodeOnly.encode(owned);
		// Copy out of the native-owned buffer: it is reused by the next call.
		return Uint8Array.from(pkt);
	}

	decode(packet: Uint8Array): Int16Array {
		const buf = this.#decodeOnly.decode(packet);
		// Copy into an owned Int16Array (buf is int16 LE PCM bytes over a
		// native buffer reused by the next call).
		const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
		return new Int16Array(ab);
	}
}

/**
 * Create the default codec for AudioBridge (D3 primary).
 * Throws a descriptive error when the optional native dependency is missing
 * or cannot load on this platform.
 */
export function createDefaultCodec(): Codec {
	try {
		return new DiscordOpusCodec();
	} catch (err) {
		throw new Error(
			"No usable Opus codec: the optional dependency @discordjs/opus failed to load " +
				"(native N-API binary missing or incompatible with this runtime). " +
				"Reinstall with network access, or provide AudioBridgeOptions.codec explicitly. " +
				`Original error: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

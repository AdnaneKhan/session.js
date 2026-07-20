// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Minimal DSP helpers for the voice-call media plane (plan §4.3 audio
// contract, §4.7). Written fresh — no lines copied from GPL/AGPL sources.
//
// Audio contract: 48 kHz, mono, signed 16-bit LE PCM, 20 ms frames
// (960 samples / 1920 bytes) — the Opus native frame size.
//
// These helpers exist for tests and spike scripts (tone detection,
// round-trip verification). They are deliberately dependency-free.

/** Opus native sample rate (plan §4.3). */
export const SAMPLE_RATE = 48_000;

/** Samples per 20 ms frame at 48 kHz (plan §4.3). */
export const FRAME_SAMPLES = 960;

/** Frame duration in ms. */
export const FRAME_MS = 20;

/**
 * Generate one 20 ms sine frame.
 * @param frameIndex zero-based frame counter (phase continues across frames).
 * @param freq tone frequency in Hz (default 440).
 * @param amplitude peak sample value (default 8000 ≈ −15.6 dBFS).
 */
export function sineFrame(frameIndex: number, freq = 440, amplitude = 8000): Int16Array {
	const out = new Int16Array(FRAME_SAMPLES);
	const w = (2 * Math.PI * freq) / SAMPLE_RATE;
	const base = frameIndex * FRAME_SAMPLES;
	for (let i = 0; i < FRAME_SAMPLES; i++) {
		out[i] = Math.round(amplitude * Math.sin(w * (base + i)));
	}
	return out;
}

export interface GoertzelResult {
	/** Signal power at the target frequency (mean-square amplitude units). */
	power: number;
	/** Magnitude normalized by frame count (≈ peak amplitude of a pure tone). */
	magnitude: number;
	/** Estimated phase at the target frequency, radians. */
	phase: number;
}

/**
 * Goertzel single-frequency DFT over `samples`.
 * Returns power/magnitude/phase at `freq` for a signal sampled at `sampleRate`.
 * For a pure sine of peak amplitude A the magnitude ≈ A (within bin leakage).
 */
export function goertzel(
	samples: ArrayLike<number>,
	freq: number,
	sampleRate: number,
): GoertzelResult {
	const n = samples.length;
	if (n === 0) {
		return { power: 0, magnitude: 0, phase: 0 };
	}
	const w = (2 * Math.PI * freq) / sampleRate;
	const coeff = 2 * Math.cos(w);
	let sPrev = 0;
	let sPrev2 = 0;
	for (let i = 0; i < n; i++) {
		const s = (samples[i] as number) + coeff * sPrev - sPrev2;
		sPrev2 = sPrev;
		sPrev = s;
	}
	// Complex DFT bin: X = s[n-1] - s[n-2] * e^{-jw}
	const re = sPrev - sPrev2 * Math.cos(w);
	const im = sPrev2 * Math.sin(w);
	const magnitude = Math.sqrt(re * re + im * im) * (2 / n);
	return {
		power: (re * re + im * im) * (4 / (n * n)),
		magnitude,
		phase: Math.atan2(im, re),
	};
}

/**
 * Tone-to-noise ratio in dB: power at `freq` versus total mean-square power
 * minus the tone power. Pure tones → large positive dB; silence or noise
 * around the tone → ≤ 0 dB. A threshold of ~20 dB is a robust "tone present".
 */
export function toneSnrDb(
	samples: ArrayLike<number>,
	freq: number,
	sampleRate: number,
): number {
	const n = samples.length;
	if (n === 0) {
		return Number.NEGATIVE_INFINITY;
	}
	let total = 0;
	for (let i = 0; i < n; i++) {
		const v = samples[i] as number;
		total += v * v;
	}
	const meanSquare = total / n;
	const tonePower = goertzel(samples, freq, sampleRate).power;
	const noisePower = Math.max(meanSquare - tonePower, 1e-12);
	if (tonePower <= 0) {
		return Number.NEGATIVE_INFINITY;
	}
	return 10 * Math.log10(tonePower / noisePower);
}

export interface CorrelationResult {
	/** Best normalized cross-correlation coefficient in [-1, 1]. */
	coefficient: number;
	/** Lag (in samples) at which the best coefficient was found. */
	lag: number;
}

/**
 * Normalized cross-correlation of `signal` against `reference`, searching
 * lags [0, maxLag]. Both are treated as same-rate sample streams; the
 * reference is slid over the signal. Returns the best |coefficient| and lag.
 *
 * Cost is O(n·maxLag) — fine for spike/test sizes (a few hundred ms).
 */
export function bestCrossCorrelation(
	signal: ArrayLike<number>,
	reference: ArrayLike<number>,
	maxLag: number,
): CorrelationResult {
	const n = reference.length;
	let refMean = 0;
	for (let i = 0; i < n; i++) {
		refMean += reference[i] as number;
	}
	refMean /= n;
	let refEnergy = 0;
	for (let i = 0; i < n; i++) {
		const v = (reference[i] as number) - refMean;
		refEnergy += v * v;
	}
	let best: CorrelationResult = { coefficient: 0, lag: 0 };
	if (refEnergy === 0 || signal.length <= n) {
		return best;
	}
	const limit = Math.min(maxLag, signal.length - n);
	for (let lag = 0; lag <= limit; lag++) {
		let sigMean = 0;
		for (let i = 0; i < n; i++) {
			sigMean += signal[lag + i] as number;
		}
		sigMean /= n;
		let cross = 0;
		let sigEnergy = 0;
		for (let i = 0; i < n; i++) {
			const a = (signal[lag + i] as number) - sigMean;
			const b = (reference[i] as number) - refMean;
			cross += a * b;
			sigEnergy += a * a;
		}
		const denom = Math.sqrt(sigEnergy * refEnergy);
		const coefficient = denom === 0 ? 0 : cross / denom;
		if (Math.abs(coefficient) > Math.abs(best.coefficient)) {
			best = { coefficient, lag };
		}
	}
	return best;
}

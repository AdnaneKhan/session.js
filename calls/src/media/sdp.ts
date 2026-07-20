// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Local-SDP munging for Android interop parity (plan §3.4, §4.1 D4, §4.7).
//
// Ported from session-android `app/src/main/java/org/thoughtcrime/securesms/
// webrtc/PeerConnectionWrapper.kt` (GPLv3) and session-desktop
// `ts/session/utils/calling/CallManager.ts` (AGPLv3), © Session Foundation,
// modified (rewritten as pure line-wise string transforms over werift's
// Unified-Plan SDP; Kotlin/Java SDP-manipulation logic preserved).
// Shipped under AGPL-3.0-or-later.
//
// RULE: ONLY local descriptions are munged. Remote SDPs pass through
// untouched — PeerConnectionManager never applies these to remote input.
//
// Transforms (Android `correctSessionDescription` / forced-codec parity):
//   1. Force Opus CBR: append `;cbr=1` to the `a=fmtp:<pt>` line whose
//      `a=rtpmap:<pt>` advertises `opus/48000/2` (payload type discovered
//      dynamically — never hardcoded). If the codec has no fmtp line
//      (werift's default opus parameters are empty), one is created right
//      after the rtpmap line: `a=fmtp:<pt> cbr=1`.
//   2. Strip the audio-level header extension: drop any `a=extmap:` line
//      referencing `urn:ietf:params:rtp-hdrext:ssrc-audio-level`
//      (with or without a URI suffix).
// Both transforms are idempotent.
//
// A Plan-B↔Unified-Plan converter (plan fallback F1) is deliberately NOT
// implemented: P3 validated werift↔werift; the converter is only built if
// the P3-T3 live-interop gate proves it necessary.

const OPUS_RTPMAP_RE = /^a=rtpmap:(\d+) opus\/48000\/2[ \t]*\r?$/i;
const FMTP_RE = /^a=fmtp:(\d+)[ \t]+(.*)$/;
const SSRC_AUDIO_LEVEL_EXTMAP_RE =
	/^a=extmap:[^\s]+[ \t]+urn:ietf:params:rtp-hdrext:ssrc-audio-level(?:\S*)?(?:[ \t]|$)/;
const CBR_PRESENT_RE = /(^|;)\s*cbr=1(;|$)/i;

/**
 * Apply the Android-parity local-description transforms. Pure and
 * idempotent; preserves the input's line-ending style and all unrelated
 * lines (m= ordering, fingerprints, ice credentials, other extmaps…).
 *
 * NEVER call this on a remote SDP (§4.7).
 */
export function mungeLocalSdp(sdp: string): string {
	const eol = sdp.includes("\r\n") ? "\r\n" : "\n";
	const lines = sdp.split(/\r\n|\n/);

	// Pass 1: payload types advertising opus/48000/2, and which of them
	// already carry an fmtp line.
	const opusPts = new Set<string>();
	const fmtpPts = new Set<string>();
	for (const line of lines) {
		const rm = OPUS_RTPMAP_RE.exec(line);
		if (rm?.[1] !== undefined) {
			opusPts.add(rm[1]);
			continue;
		}
		const fm = FMTP_RE.exec(line);
		if (fm?.[1] !== undefined && opusPts.has(fm[1])) {
			fmtpPts.add(fm[1]);
		}
	}

	// Pass 2: rewrite.
	const out: string[] = [];
	for (const line of lines) {
		// (2) strip ssrc-audio-level extmaps.
		if (SSRC_AUDIO_LEVEL_EXTMAP_RE.test(line)) {
			continue;
		}
		// (1a) append ;cbr=1 to the opus fmtp line (once per PT).
		const fm = FMTP_RE.exec(line);
		if (fm?.[1] !== undefined && opusPts.has(fm[1])) {
			const params = fm[2] ?? "";
			if (CBR_PRESENT_RE.test(params)) {
				out.push(line); // already forced — idempotent
			} else {
				out.push(`${line};cbr=1`);
			}
			continue;
		}
		out.push(line);
		// (1b) opus rtpmap without an fmtp line: create one right after.
		const rm = OPUS_RTPMAP_RE.exec(line);
		if (rm?.[1] !== undefined && !fmtpPts.has(rm[1])) {
			out.push(`a=fmtp:${rm[1]} cbr=1`);
			fmtpPts.add(rm[1]); // guard against duplicate rtpmaps
		}
	}
	return out.join(eol);
}

/**
 * Extract the ice-ufrag from an SDP (first occurrence). Test/diagnostic
 * helper — ICE restart verification compares ufrags across offers.
 */
export function extractUfrag(sdp: string): string | undefined {
	const m = /^a=ice-ufrag:(\S+)/m.exec(sdp);
	return m?.[1];
}

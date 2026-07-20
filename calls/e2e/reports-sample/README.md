# Committed sample E2E report

One full offline Tier-1 run output, committed as a format reference and
sanitization exemplar (plan P7-T1/P7-T2). Generated with:

```sh
cd calls && bun e2e/run-tier1.ts --sample
```

- Run: `2026-07-20T18-19-41-818Z-tier1/report.json`
- 10 scenarios, 99 checks, all PASS, 18.2 s total (Bun, darwin arm64).
- sha256: `e45d60bdf90df60a3ac8fea811f799c2bd95536c357cccb663b0ffec9f9b3f27`

Sanitization: every report passes through `redactSensitive` (TURN
credentials, DTLS fingerprints) + a forbidden-marker scan (SDP bodies —
`v=0`/`o=-`/`m=audio`/`a=fingerprint` — and PEM material) + secret
scrubbing, and is asserted clean and JSON-reparseable BEFORE being
written. This file contains no mnemonics, keys, credentials, or SDP.

Live runs land in `calls/e2e/reports/` (gitignored) and are never
committed.

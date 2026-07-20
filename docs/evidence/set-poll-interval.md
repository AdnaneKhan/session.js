# setPollInterval prerequisite (plan §4.4.5 — poller interval control)

- Task id: set-poll-interval
- Agent id: agent:wave1-core
- Date: 2026-07-20
- Branch: feat/voice-calls-core

## Summary

`setPollInterval(this: Session, interval: number)` added to `src/instance/polling.ts`
(alongside `addPoller`). Validates `interval` is a positive integer (`Number.isInteger` &&
`> 0`), else throws `SessionValidationError(InvalidOptions)`. Iterates `this.pollers`
(protected `Set<Poller>`, accessible inside the instance module) and calls
`poller.setInterval(interval)` on each (`Poller.setInterval` already exists at
`src/polling/index.ts:109` — stops, updates, restarts if authorized).

Bound as `public setPollInterval = setPollInterval.bind(this)` in `src/instance/index.ts`
with TSDoc ("Advanced use. Sets polling interval on all registered pollers..."). This lets
the calls package boost cadence (3000 ms → 500 ms during calls) without internals (§4.6).

## Files

- Modified: `src/instance/polling.ts` (setPollInterval)
- Modified: `src/instance/index.ts` (import + binding + TSDoc)
- Test: `test/set-poll-interval.test.ts`

## Commands & results

```
$ bun test test/set-poll-interval.test.ts
 3 pass
 0 fail
Ran 3 tests across 1 file. [38.00ms]
exit code: 0
```

Test coverage (offline): `Session` + `Poller({ interval: null })` with a stub network (no
network calls), `addPoller`, `setPollInterval(500)` → no throw, `poller.isPolling()` stays
false (instance not authorized — Poller.setInterval only starts when authorized); applies to
multiple pollers; invalid intervals (0, -100, 1.5, NaN) throw SessionValidationError.

```
$ bun run build
exit code: 0
```

Full suite: `bun test` → 38 pass / 1 fail (pre-existing live-network test only).

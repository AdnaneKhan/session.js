# Upstream Pin Record (plan P0-T1)

This fork is pinned to a specific upstream commit. Record any rebase here.

## Pin

| Field | Value |
|---|---|
| Upstream repository | <https://git.hloth.dev/session.js/client> |
| Upstream mirror | <https://github.com/sessionjs/client> |
| Upstream package | `@session.js/client@0.0.57` |
| Fork point commit | `70e14c0` — `70e14c02cfaac1ce182c40571868ca4335c4b9d8` ("Refactoring, versions bump") |
| Pin date | 2026-07-20 |
| Fork branch (initial) | `feat/voice-calls` (fork); feature branches e.g. `feat/voice-calls-docs` |
| Baseline verified | `bun install` (183 packages) + `bun run build` (exit 0) on the pin — see `docs/evidence/P0-T1.md` |

## Rebase policy (plan R9)

- **Monthly rebase on upstream releases.** When upstream publishes a new
  release (tag/version bump on `git.hloth.dev`), rebase our fork branches onto
  it within the month, re-run the integration tests against the new base, and
  update this record (new fork point commit, date, baseline results).
- Upstream is currently dormant (development "frozen until libsession
  migration", Gitea issue #3), so rebases are expected to be infrequent and
  low-risk; the monthly cadence is a guardrail, not a forecast.
- Never push to or merge from origin without explicit task approval; rebases
  happen on fork branches only.

## Rebase history

| Date | New base commit | Notes |
|---|---|---|
| 2026-07-20 | `70e14c0` | Initial fork point. |

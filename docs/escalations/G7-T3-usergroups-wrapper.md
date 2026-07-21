# DECISION GATE — G7-T3: libsession `UserGroups` config wrapper (namespace 5)

- **Type**: DECISION GATE (closed-groups plan §2.6 mechanism (b), §4 P7, open question GQ4)
- **Status**: **DECIDED — DEFER to v1.1** (not adopted in v1)
- **Opened**: 2026-07-21
- **Decided by**: fork maintainer (implementation-time design gate)
- **Gate outcome decides**: whether v1 closed groups sync group state via the
  modern libsession `UserGroups` `SharedConfigMessage` (namespace 5,
  protobuf-in-config-wrapper) in addition to the legacy `ConfigurationMessage`.

## Background

Legacy closed-group state syncs to linked devices two ways upstream (plan §2.6):

- **(a) Legacy `ConfigurationMessage`** — `activeClosedGroups[] { publicKey,
  name, encryptionKeyPair }`, latest keypair only, 30-day TTL. The schema and
  emit path already exist in this client (G2-T4); v1 adds the parse/reconcile
  path (G7-T1/T2) and a `sendConfigurationMessage` on the session.
- **(b) libsession `UserGroups` wrapper** — a `SharedConfigMessage` on namespace
  5 wrapping a protobuf `UserGroups` config. This is the modern mechanism the
  official clients now use; it is also where the groupv2/v3 rewrite lives.

## Decision

**Defer (b); v1 ships (a) only.**

Rationale:

1. **Scope & risk.** (a) is fully wired and tested offline (G7-T1/T2) and is
   what legacy closed-group clients of the pinned era consume. (b) requires
   porting the libsession config-wrapper machinery (seqno management, wrapper
   encode/decode, namespace-5 config merge semantics) — a substantial,
   largely-independent subsystem better landed with the groupv2/v3 work.
2. **Both mechanisms carry only the latest keypair** (plan §2.6), so (b) buys no
   decryption-history advantage over (a) for legacy groups — only parity with
   the newest official clients' config transport.
3. **Upstream flux.** The `UserGroups`/config-wrapper layer is actively changing
   with the groupv3 rewrite (session-desktop `unstable`); porting it now risks
   churn. The plan already scopes group v2/v3 as separate future work (§1
   non-goals, GQ5).

## Consequences / follow-ups

- v1 multi-device group sync works between **this client's** linked devices and
  with legacy-era official clients reading `ConfigurationMessage`. A linked
  **latest** official client that ignores legacy `ConfigurationMessage` will not
  pick up v1 groups via config (it may still join via the NEW invite DM).
  Documented as a limitation in the user-facing docs (P9) and to be re-checked
  in the networked interop matrix (P8).
- **v1.1 work item**: adopt the `UserGroups` `SharedConfigMessage` wrapper
  (namespace 5) alongside groupv2/v3 support; re-open this gate then.

## References

- `docs/closed-groups/IMPLEMENTATION.md` §2.6, §4 (P7), §6 (GQ4)
- Evidence: `docs/evidence/G7-T1.md`, `docs/evidence/G7-T2.md`

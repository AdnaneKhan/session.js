# Wire golden fixtures — CallMessage

Golden byte vectors for Session `CallMessage` signaling, used by the wire-compat
regression tests (plan §2.3 S7, §6, Appendix D). Each `*.hex` file contains the
hex-encoded serialization of a full `SignalService.Content` envelope:

```
hex( SignalService.Content.encode(new SignalService.Content({ callMessage })).finish() )
```

where the bindings are the pbjs static bindings vendored in
`@session.js/types/signal-bindings` (compiled from `signalservice.proto`, which
carries the full official `CallMessage` schema — all 6 `Type` enum values, all 5
fields; `Content.callMessage` = field 3).

## Fixtures

| File | Message | Provenance |
|---|---|---|
| `pre-offer.hex` | `PRE_OFFER` (type 6), uuid only | computed |
| `offer.hex` | `OFFER` (type 1), `sdps=[SDP_OFFER]` | computed |
| `answer.hex` | `ANSWER` (type 2), `sdps=[SDP_ANSWER]` | computed |
| `ice-candidates.hex` | `ICE_CANDIDATES` (type 4), 2 candidates, parallel arrays | computed |
| `end-call.hex` | `END_CALL` (type 5), uuid only | computed |

## Provenance markers

- **computed** — derived from the published `SessionProtos.proto` field facts
  via `scripts/generate-goldens.ts`. Protobuf encoding is deterministic, so any
  compliant encoder (including every official Session client) must produce
  byte-identical output for the same field values. Regenerate with
  `bun scripts/generate-goldens.ts`; verify with `bun scripts/verify-fixtures.ts`.
- **captured** — *(none yet)* observed from a real official client via swarm
  `retrieve` on a test account while a real client calls it (operator task,
  plan P0-T3). Captured fixtures record the exact envelope bytes seen on the
  wire and are added only via human-reviewed change, with the capture
  environment (client, version, date) noted in this README and in
  `docs/evidence/P0-T3.md`.

## Canonical input values (verbatim)

```
UUID       = 11111111-1111-4111-8111-111111111111
SDP_OFFER  = v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n
SDP_ANSWER = v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=recvonly\r\n
CAND1      = candidate:1 1 udp 2130706431 192.168.1.10 50000 typ host
CAND2      = candidate:2 1 udp 1694498815 203.0.113.7 50000 typ srflx raddr 192.168.1.10 rport 50000
```

`\r\n` above denotes literal CRLF bytes inside the SDP strings. The
`ice-candidates` fixture uses `sdps = [CAND1, CAND2]`,
`sdpMLineIndexes = [0, 0]`, `sdpMids = ["0", "0"]` (parallel arrays).

## Change policy

Goldens are regenerated ONLY via human-reviewed change (plan Appendix D).
Tests compare live encoding output against these committed hex files;
`scripts/verify-fixtures.ts` decodes them, asserts field values, and asserts a
byte-perfect re-encode roundtrip.

---

# Wire golden fixtures — Closed groups (`groups/`)

Golden byte vectors for the legacy closed-group control messages and the group
chat (visible) message, used by `test/group-mapper.test.ts` (closed-groups plan
§4 P1, evidence `G1-T2`). Each `groups/*.hex` is:

```
hex( SignalService.Content.encode(new SignalService.Content({ dataMessage })).finish() )
```

Control messages carry **only** `DataMessage.closedGroupControlMessage` (field
104) — no `GroupContext` (verified against the pinned session-desktop outgoing
shapes, `docs/closed-groups/reference-pins.md`). The group chat message carries a
`GroupContext` (field 3) whose `id` is the **UTF-8 of the 05-prefixed hex
string** (66 bytes), `type = DELIVER`.

## Fixtures

| File | Message | Provenance |
|---|---|---|
| `groups/new.hex` | `NEW` (type 1): publicKey, name, members, admins, expirationTimer=3600, encryptionKeyPair | computed |
| `groups/name-change.hex` | `NAME_CHANGE` (type 4): name | computed |
| `groups/members-added.hex` | `MEMBERS_ADDED` (type 5): members | computed |
| `groups/members-removed.hex` | `MEMBERS_REMOVED` (type 6): members | computed |
| `groups/member-left.hex` | `MEMBER_LEFT` (type 7): no extra fields | computed |
| `groups/encryption-key-pair.hex` | `ENCRYPTION_KEY_PAIR` (type 3): 2 wrappers | computed |
| `groups/visible.hex` | group chat message: body + `GroupContext{id:utf8("05…"), type:DELIVER}` | computed |

`ENCRYPTION_KEY_PAIR_REQUEST` (type 8) is unused by the official clients and is
deliberately not generated.

## Canonical input values (verbatim)

```
GROUP_PUBKEY    = 05 + "11"*32        (05-prefixed 33-byte group address)
GROUP_MEMBER_A  = 05 + "aa"*32
GROUP_MEMBER_B  = 05 + "bb"*32
GROUP_MEMBER_C  = 05 + "cc"*32
GROUP_NAME      = Test Group
GROUP_ENC_PUB   = "22"*32             (unprefixed 32-byte x25519 encryption pubkey)
GROUP_ENC_PRIV  = "33"*32             (unprefixed 32-byte x25519 encryption privkey)
GROUP_WRAPPER_CIPHERTEXT = "44"*80    (stand-in sealed KeyPair-proto blob)
GROUP_BODY      = hello group
GROUP_TIMESTAMP = 1751000000000
```

The `new` fixture uses `members = [A, B, C]`, `admins = [A]`. The
`encryption-key-pair` fixture wraps to `[B, C]` with the same ciphertext
stand-in. Regenerate with `bun scripts/generate-goldens.ts`; verify with
`bun scripts/verify-fixtures.ts` (both now cover the call and group fixtures).


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

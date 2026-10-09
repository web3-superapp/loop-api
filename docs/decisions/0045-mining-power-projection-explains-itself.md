# Decision 0045: The community-side `miningPower` explains itself

- Status: Accepted (S21b, Development baseline still Decision 0043/0044).
- Date: 2026-09-16
- Scope: the `miningPower` projection on `GET /v2/communities/{id}` (and
  every write that returns the community resource),
  `GET /v2/communities/{id}/members.items[]`, and
  `GET /v2/connections.items[]`. No path, no other field, no migration.

## Context

After S20 the `available` branch was `{power, snapshotId, formulaVersion,
computedAt}`. Two gaps surfaced in the S21 client work:

1. No `scope`. The summary page labels a development baseline from
   `formula.scope`; a community row had only `formulaVersion` and would have
   had to pattern-match `devBaseline` in an identifier to draw the same
   label. The client correctly refused to treat an identifier as semantics.
2. No `weight`, no `participants`. A community card saying `0` could not
   say why; the reader had to open `GET /v2/mining/communities/{id}`.

## Rulings

| Topic                        | Ruling                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scope`                      | Required on every `available` projection. Same enum and same source as the summary page: `formula.scope` of the version in force (`development_baseline` or `null` for a product version), read through `resolveMiningBaseline`. A client that labels by `scope` needs no code change when the product version arrives.                                                                                                                                                                                                                                                                                                                        |
| `weight`                     | Required on a **community** projection, in exactly the shape of `GET /v2/mining/communities/{id}.weight` (`approved` with `value/configVersion/reviewedAt`, or `unavailable` with `reasonCode` + `reviewStatus: pending_review`). Built by one function, `projectCommunityWeight` in `mining-community-projection.ts`, which the mining service and the reader both call. No card-friendly simplification: a simplified `{value}` would be a second definition of the same fact, would drop `configVersion` (the only thing that ties the number to the version in force), and would drift from the mining page the first time either changed. |
| `participants`               | Required on a community projection, shape `{status: "available", count}` \| unavailable, from `projectParticipants` over the same standing row the mining page reads. Same reasoning as `weight`.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `subject` tag                | The three fields describe a community. A member row and a connection row publish one **account's** total power across assets (`listMemberPowers.totalPower`); no single community weight or participant count explains it, and inventing one (or emitting `weight: unavailable` with a fabricated `reviewStatus`) would be a fixture standing in for a fact. So the `available` branch is a tagged union on `subject`: `community` carries `scope`, `weight`, `participants`; `account` carries `scope` only. Both are strictly decodable; nothing is "sometimes present" without a tag that says when.                                        |
| `unavailable` branch         | Byte-identical to S20: `{status: "unavailable", reasonCode}`. Asserted as a JSON substring in the route tests.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| One definition, three routes | `miningPowerSchema` in `community-schemas.ts` is the only wire definition; its `weight`/`participants`/`scope` fragments are imported from `mining-shared-schemas.ts`, the same constants the mining route schema uses. The reader (`mining-power-reader.ts`) is the only producer; the community service passes its result through untouched at all five sites that return the community resource.                                                                                                                                                                                                                                            |
| Extra read                   | `readCommunityPower` now reads the weight record on the available branch too (previously only when there was no standing) because only the record carries `configVersion` and `reviewedAt`. One indexed read per community resource. If the record vanishes between the two reads the projection is `MINING_RUNTIME_UNAVAILABLE`, never a partial object.                                                                                                                                                                                                                                                                                      |

## Why the shared schema module

`community-schemas.ts` importing `mining-schemas.ts` created the cycle
`community-schemas → mining-schemas → launch-schemas → community-schemas`
(launch borrows the cursor schemas), which left `nullableCursorSchema`
undefined at load time and broke every launch route in the mining test
process. `mining-shared-schemas.ts` imports only `mining-contract.ts`, so
neither route-schema file depends on the other.

## Consequences

- The client's `LoopMiningPowerSettled` decoder gains `scope` and a
  `subject`-tagged detail; the summary page's baseline label and the
  community card's label now come from the same field.
- On the Development database (2026-09-16, snapshot
  `0e358b31-e49f-48b9-89b2-c5c908c3ad5e`) `mock-defi-morning` publishes
  `weight 0.8`, `participants 0`, `power 0`; `builders-guild` publishes
  `weight 1.5`, `participants 0`, `power 0`; both `scope:
development_baseline`. The zeros are real holdings, unchanged from 0043.
- Nothing about the formula, the snapshot lane, rewards, or referral moves.

## Verification

- Unit: `test/mining-dev-baseline.test.ts` "community mining power reader"
  (community shape with hand-written `92`/`0.8`/`3`, unavailable branch as an
  exact JSON string, account shape with `scope: null` under a scope-less
  version); `test/v2-community-routes.test.ts` "Mining Power projections"
  (detail + member rows, connection rows, same-source assertion against
  `GET /v2/mining/communities/{id}` and the join response, `scope: null`,
  byte-identical unavailable substrings for three reason codes).
- OpenAPI regenerated; the fragments appear once per use site by design.

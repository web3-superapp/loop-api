# Decision 0201: Intel promotion "LOOP 挖矿算力周榜" links to the leaderboard sub-page

- Status: Accepted
- Date: 2026-11-05
- Scope: S369-api. Amends Decision 0100 (intel promotion deeplink
  allow-list) and the S112 placeholder list. Source: requester acceptance
  item 9 (LOOP `docs/62-需求方验收九条-2026-11-05.md`); client counterpart
  S368 / LOOP 0292.

## Problem

The shipped placeholder card「LOOP 挖矿算力周榜」(id
`5b0f8a2e-6d1c-4e7a-9b3f-2c8d4e6f1a01`) carried `deeplink: "/intel"`. The
client maps `/intel` to "switch to the hash-power tab", so a tap landed on
the tab the user was already looking at instead of the leaderboard.

## What changed

- `intelPromotionDeeplinkPatternSource` admits exactly one more route:
  `/mining/rank` (the leaderboard sub-page: community / user / referral
  boards). Nothing else is added; `/mining`, `/mining/rank/`,
  `/mining/rank?scope=…` and other `/mining/*` paths stay refused.
- The placeholder card's `deeplink` is now `/mining/rank`. Id, title,
  subtitle, window and order are unchanged.
- The admin promotion editor (`GET /admin/v1/settings/intel-promotions`
  `deeplinkChoices`) lists `/mining/rank` so an operator can pick it; the
  console save path validates with the same pattern.
- Route schema descriptions (`/v2/intel/promotions`, the item `deeplink`
  property) name the new value; OpenAPI regenerated. No new response key,
  no new error code, no database change.

## Deployment order (mandatory)

Clients up to and including TF 67 validate `deeplink` against an allow-list
without `/mining/rank` and treat the whole promotions resource as invalid
if any card fails. Therefore:

1. Client S368 (allow-list adds `/mining/rank`) ships in TF 68.
2. Only after TF 68 is uploaded may this change be deployed to staging.

Until then staging must stay on a build without this decision. An operator
must likewise not save a console list containing `/mining/rank` before
TF 68 is out (the pattern now admits it).

## Unavailable behaviour

Unchanged from Decision 0100 / 0102: an empty `items` hides the strip; the
`market` module disabled → 404.

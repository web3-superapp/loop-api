# Decision 0105: operator console hardening, list fixes, defaultRoute (S119b / FIX-C)

- Status: Accepted (S119b-api, FIX-C)
- Date: 2026-10-09
- Scope: review `LOOP/docs/integration/review-2026-10-09/loop-api-s111-s119-review.md` items M3, M4, M6, m1, m4, m5, m7, n1, n2, with the main agent's rulings written in that report. No migration, no new route, no new stable ID. One new console error code (`ADMIN_LOGIN_BUSY`, 429); three new console reason codes; two new environment keys (`MEME_OPERATOR_PRIVATE_KEY`, `INTEL_PROMOTION_IMAGE_HOSTS`, API process only); two `/v2` wire changes (`defaultRoute` const, `listingReason.reasonCode` casing).
- Baseline: `integration/v2` = `bedb36e`
- Amends: Decision 0102 (login lock, audit ordering, pause signer, promotion validation, open question 4), Decision 0100 (open question 1: `defaultRoute`), Decision 0103 (§3 slot0 read placement in `category=meme`), Decision 0029/0064 (`defaultRoute` value).

## 1. M3: login lock cannot be raced; argon2 memory is bounded

Before: the lock check ran, then argon2id (19 MiB, t=2) ran, then the failure was counted. N concurrent wrong logins all passed the check, so the five-failure lock could be exceeded by any amount, and N derivations ran at once (N × 19 MiB).

Now (`src/features/admin/admin-auth.ts`):

- `AdminLoginThrottle.admit()` is one synchronous step: refuse when locked (`locked`, 423), refuse when another attempt is being verified (`busy`), otherwise reserve this attempt's failure (`failures += 1`) and hand back a ticket. The ticket ends exactly once: `succeed()` resets the counter and lock, `fail()` keeps the reservation and starts the 15-minute lock at the fifth, `cancel()` refunds it (the verifier itself refused or crashed). Because the reservation is taken before any `await`, no interleaving can skip the count.
- Single flight: at most one login verification per process. A concurrent one is **429 `ADMIN_LOGIN_BUSY`** (`category: rateLimit`, `retryable: true`, `detailsSafe.retryAfterSeconds: 1`, `Retry-After: 1`), not counted as a failure.
- Global argon2 cap: `adminArgon2MaximumConcurrency = 2` derivations per process (login plus anything else that hashes). The slot is taken synchronously; when both are taken the call throws `AdminArgon2BusyError` instead of queueing, which the login maps to 429 and refunds. Peak argon2 memory is therefore ≤ 2 × 19 MiB regardless of request rate.
- Input-shape checks (types, lengths) run before `admit()`, so malformed requests never take the slot.

Test: 200 concurrent wrong logins per wave → exactly one verification per wave (199 × 429), the lock lands on the fifth wave with exactly five `session.login_failed` rows, then 200 more concurrent attempts (the right password included) are all 423 and none reaches argon2; six concurrent `verifyAdminPassword` calls → two fulfilled, four `AdminArgon2BusyError`, in-flight counter back to 0.

## 2. M4: intent audit row first for writes with an external effect

Before: pause/unpause broadcast first and appended the audit row after; community review ran the review path (status, notification, push) first and recorded the audit after. A failed audit write left an action with no trace.

Now the console writes that leave the database (or that call another module's transaction) follow **intent → execute → outcome**:

| Write                            | Intent row (before)                                                        | Success row                                                                                | Failure row                                                                           |
| -------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `POST /communities/{id}/review`  | `community.review.requested` (`after: {decision, reasonCode, reasonText}`) | `community.review.decided` (same transaction as the review note, `after.requestedAuditId`) | `community.review.failed` (`after.errorCode`, e.g. `community_data_stale`)            |
| `POST /meme/tokens/{id}/pause`   | `meme.pause.requested`                                                     | `meme.pause.submitted` (`transactionHash`)                                                 | `meme.pause.failed` (`MEME_PAUSE_SIMULATION_REVERTED`, `MEME_PAUSE_BROADCAST_FAILED`) |
| `POST /meme/tokens/{id}/unpause` | `meme.unpause.requested`                                                   | `meme.unpause.submitted`                                                                   | `meme.unpause.failed`                                                                 |

- Intent row cannot be written → **503 `CAPABILITY_UNAVAILABLE` / `ADMIN_AUDIT_UNAVAILABLE`**, and nothing runs: no status change, no notification, nothing signed.
- Outcome row cannot be written after the effect happened → logged with the intent's ID; the response still reports what happened (`audit` then references the intent row). The intent row proves the operator asked.
- Validation, not-found, state and pending refusals happen before the intent row (nothing was attempted, nothing to audit), as before.
- Other console writes were checked and already satisfy "no effect without audit": recommended communities, intel promotions, formula draft/approve/withdraw, and MEME listing write the change and its audit row in **one** database transaction (`src/database/admin-repository.ts`). Login/logout audit rows stay best-effort (they guard no external effect; a lost row is logged).
- History: rows written before S119b keep the old actions (`community.review.verify|reject`, `meme.pause|unpause`). Append-only; nothing is rewritten.

Tests: audit store down → pause 503 `ADMIN_AUDIT_UNAVAILABLE` with zero signer calls, review 503 with the community still `pending` and no note; simulation revert, broadcast failure, and a throwing signer each leave exactly `requested` + `failed`; a refused review (already verified) leaves `requested` + `failed`; PostgreSQL integration: a review writes `requested` + `decided`, a refused one `requested` + `failed`.

## 3. m4: pause/unpause signs with its own key, one per token at a time

- New key `MEME_OPERATOR_PRIVATE_KEY` (API process only; 32-byte hex; blank = pause unavailable with reasonCode **`MEME_OPERATOR_KEY_MISSING`**; malformed refuses boot; never logged). `AppConfig.memeOperator` replaces `memeGraduationExecutor` in the API process, and the API env schema **no longer reads** `MEME_GRADUATION_EXECUTOR_ENABLED` / `LAUNCH_DEPLOYER_PRIVATE_KEY` at all — the deployer key lives only in the worker, which signs `graduate`. The two signers can no longer race for one nonce.
- Unavailable composition order is unchanged otherwise: key → MEME contract (`MEME_CONTRACT_NOT_CONFIGURED` / `MEME_USD1_NOT_CONFIGURED`) → testnet only (`MEME_MAINNET_SIGNING_CLOSED`) → RPC (`MEME_CHAIN_RPC_NOT_CONFIGURED`). BSC Mainnet signing stays closed.
- The curve is `Ownable2Step` and `pause` / `unpause` are `onlyOwner` (`loop-contracts/contracts/LoopMemeCurve.sol`). The operator address must become the owner (`transferOwnership` by the current owner, then `acceptOwnership` signed by the operator key). Until then every dry run reverts → 409 `MEME_PAUSE_SIMULATION_REVERTED` (requested + failed rows). `graduate` is permissionless, so the worker's fallback is unaffected; `setTreasury` / `injectResidual` move with ownership (see open question 1).
- Single flight per token (in process): the token ID is claimed synchronously after the last `await` that precedes the state checks; a second request while one is in flight → **409 `ADMIN_CONFLICT` / `MEME_PAUSE_PENDING`**.
- Unconfirmed pause: after a broadcast the process remembers `{transactionHash, submittedAt}` per token. A later pause/unpause of that token asks the signer `transactionState(hash)`: `settled` (receipt exists, or the node no longer knows the transaction = dropped) → forget and proceed (the dry run then decides, e.g. an already-paused curve reverts); `pending` (known, not mined) or `unknown` (RPC failed) → 409 `MEME_PAUSE_PENDING` with `transactionHash`. The memory is bounded in time: an entry older than 10 minutes is forgotten. Double clicks therefore send one transaction.
- In-process scope matches Decision 0102 (one API process per environment). A second API replica would need a database lock; not built.

## 4. m7: lockout and logout stay in memory (accepted)

Ruling: accepted for one administrator behind Cloudflare Access. Behaviour after an API restart (deploy, launchd restart): the failure counter and any lock are cleared; a session the operator logged out of but whose 12 h have not elapsed becomes valid again; the pause pending memory (§3) is cleared (the dry run still refuses an already-applied pause once mined). Rotating `ADMIN_SESSION_SECRET` and restarting revokes every session at once. Written in `docs/admin-v1-api.md` §2 and `docs/local-development.md`. Closes Decision 0102 open question 4.

## 5. n1: intel promotion text and images

- `defineIntelPromotions` (used by the console write, the stored-value reader, and the shipped constant) now also refuses control, format, surrogate, line- and paragraph-separator characters (`\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}`: newlines, zero-width, bidi overrides) in `title` and `subtitle`, and an `imageUrl` longer than 512 characters.
- Image host allow-list: `INTEL_PROMOTION_IMAGE_HOSTS` (comma-separated lower-case DNS names, ≤ 20; anything with a scheme, port, path, or upper case refuses boot). The console write requires `imageUrl` to be null or an `https:` URL without credentials or port whose host is listed; otherwise 422 `ADMIN_PROMOTION_INVALID` with `index` and `field: "imageUrl"`. Not configured → every `imageUrl` must be null.
- Read side: `GET /v2/intel/promotions` serves a stored `imageUrl` only while its host is still listed; otherwise the card is served with `imageUrl: null` (fail closed when the list shrinks). The console GET keeps showing the stored value.
- Console resource: `GET/PUT /admin/v1/settings/intel-promotions` add `imageHosts: string[]` and `imageUrlMaximumLength: 512`. `/v2` schema: `imageUrl` gains `maxLength: 512` (narrowing a value the server already guaranteed).

## 6. n2: `listingReason.reasonCode` is an upper-case catalog code on `/v2`

The console stores the operator's lower-case code (`^[a-z][a-z0-9_]{0,63}$`, DB check unchanged). `GET /v2/meme/tokens/{id}` now publishes `listingReason.reasonCode = "OPERATOR_" + upper(code)` (e.g. `OPERATOR_USER_REPORTS`), schema `^OPERATOR_[A-Z][A-Z0-9_]{0,63}$`, or null. It matches every other `/v2` reasonCode's casing and cannot collide with a system code. The console's own `listingReasonCode` stays lower-case. **Client impact:** `loop-mobile` `loop_v2_meme_codec.dart` validates the lower-case pattern today and must accept the new one, otherwise a hidden token's detail fails to decode. `docs/frontend-v2-meme-api.md` updated.

## 7. M6: `defaultRoute` is `"chat"`

`V2ClientPolicyProjection.defaultRoute` and the `GET /v2/meta/client-policy` schema `const` change from `"community"` to `"chat"` (= `navigation.primaryTabs[0]`), inside the same policy version `productPolicyV2.2026-10-08` (ruling: same version). The session response's embedded policy follows.

Old-client compatibility: TestFlight builds that strictly decode `defaultRoute == "community"` will reject the whole policy and fail to read it. Those builds already cannot work against the v3 backend (Decision 0100 replaced the whole `primaryTabs` enum), so no compatibility branch is added; they must upgrade. The current `loop-mobile` accepts both `community` and `chat`. `docs/routes-manifest.json` is the frozen prototype mirror (2026-09-01) and is intentionally left unchanged.

## 8. m1: `hot` pages are not shortened by hidden tokens

Before: the `hot` tab sliced `limit + 1` ranking entries, then dropped hidden ones, so a page could come back short with `nextCursor: null` while ranked tokens remained.

Now the page keeps reading the 60-second ranking snapshot in chunks of the missing count until it holds `limit` visible tokens or the ranking ends. `nextCursor` is non-null exactly when ranking entries remain after the last entry read, and points after that entry (hidden entries already examined are not re-read). A last page may be short, or rarely empty when every remaining entry is hidden. Other tabs are unchanged (their SQL already filters `listing`).

## 9. m5: `category=meme` candidates are cut by sort; slot0 is read per page in one batch

Before: the candidate SQL ordered every MEME/Launch asset by `asset_id` and cut at 100, so which tokens competed depended on their addresses; every page re-read `slot0` for every graduated candidate.

Now `MarketCategoryRepository.listMemeCandidates(limit, sort = "marketCap")` returns two buckets, each cut at `limit` (100) in SQL:

- **Curve bucket** (`trading`/`full`, listed, registry not blocked): ordered by the requested sort computed from the snapshot — `marketCap` by price `trunc(vUsd1·1e18 / vToken)` (same order as the cap at the fixed 1e9 supply), `change24h` by `(price − ref) / ref` with `ref` = the newest trade price at or before now − 24 h or the opening price, `volume24h` by the 24 h wallet-side USD1 sum — descending, nulls last, then `asset_id`.
- **Provider-priced bucket** (graduated MEME tokens, Launch project tokens not hidden): ordered by recency (`graduated_at`, or the newest sale `created_at`), then `asset_id`. Their DexScreener batch stays ≤ 100 addresses.

The service still prices and orders the union exactly as before (the ordering keys are unchanged, `marketCategoryOrdering`). The pool `slot0` fallback (Decision 0103) moved after paging: it fills the quote of rows **on the returned page** only, through one batched read (`MemeContractAdapter.readPoolSqrtPriceX96Many`, a single multicall with per-pool failure; adapters without it fall back to concurrent single reads) that shares the 1.5 s price cache. A slot0 price is therefore display-only and never a sort key: such rows order with the unpriced rows (the ordering is named `dexscreener_*`), and the cursor is computed from the unfilled key so paging stays consistent. A failed pool read keeps the earlier reason, as before.

## 10. Error and reason catalogue changes (console)

| Code / reasonCode                                             | HTTP                         | Where                                                                                                |
| ------------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| `ADMIN_LOGIN_BUSY` (new code, `rateLimit`, retryable)         | 429                          | login, another verification in progress or argon2 slots full; `retryAfterSeconds: 1` + `Retry-After` |
| `ADMIN_AUDIT_UNAVAILABLE` (reasonCode)                        | 503 `CAPABILITY_UNAVAILABLE` | review, pause/unpause: intent row not written, nothing executed                                      |
| `MEME_PAUSE_PENDING` (reasonCode, optional `transactionHash`) | 409 `ADMIN_CONFLICT`         | pause/unpause of a token with one in flight or unmined                                               |
| `MEME_OPERATOR_KEY_MISSING` (reasonCode)                      | 503 / `pause.reasonCode`     | replaces `MEME_EXECUTOR_DISABLED` for the console                                                    |

## 11. Unavailable behaviour

- No `MEME_OPERATOR_PRIVATE_KEY` → `pause.available: false`, `reasonCode: MEME_OPERATOR_KEY_MISSING`; pause/unpause 503.
- Audit table unwritable → review and pause/unpause 503 `ADMIN_AUDIT_UNAVAILABLE` (nothing executed); transactional writes 503 `ADMIN_DATABASE_UNAVAILABLE` as before.
- No `INTEL_PROMOTION_IMAGE_HOSTS` → `imageHosts: []`, every `imageUrl` must be null; stored URLs are served as null.
- slot0 multicall fails → affected rows keep `quote: null` + their earlier reason.

## Deployment (dev / staging)

1. Generate a new operator key outside Git; put `MEME_OPERATOR_PRIVATE_KEY=0x…` in the **API** env file only (`ops/api-dev.local.env`); remove `MEME_GRADUATION_EXECUTOR_ENABLED` / `LAUNCH_DEPLOYER_PRIVATE_KEY` from the API env if present (the worker env keeps them).
2. Send the operator address a little tBNB (each pause/unpause is one transaction).
3. Make it the curve owner: `transferOwnership(<operator>)` from the current owner (deployer), then `acceptOwnership()` from the operator key.
4. Optional: `INTEL_PROMOTION_IMAGE_HOSTS=<cdn host>` when promotion images are hosted.
5. Restart the API (main agent; sub-agents do not restart the ops stack). No migration.

## Rulings (main agent, 2026-10-09)

1. Ownership: accepted on testnet. The operator key is the curve owner (`transferOwnership` / `acceptOwnership` done; operator `0x475c9242d901f941Ad220E36324b92F6ffEE1Ab0`), and it therefore also holds `setTreasury` / `injectResidual`. **To do:** the next curve contract version adds a separate `pauser` role so ownership can go back to the deployer or a multisig.
2. `loop-mobile` accepts `OPERATOR_<CODE>` for `listingReason.reasonCode` (loop-mobile `14b21c7` / `fa56a7c`).
3. Single API process per environment accepted. The pause single flight and pending memory (§3) are per process; running more than one API replica requires moving them to a database lock (e.g. a row or advisory lock per token) first.

## Verification

- `test/admin-routes.test.ts`: 200-concurrent login waves (§1), audit-down refusals, requested/failed rows for revert/broadcast failure/throw, in-flight and unmined `MEME_PAUSE_PENDING`, review `requested`/`decided`/`failed`, promotion text and image-host refusals with the `/v2` read.
- `test/admin-auth-settings.test.ts`: `admit()` reservation/busy/cancel, argon2 cap, `parseMemeOperator`, `parseIntelPromotionImageHosts`, reader nulling a de-listed image host.
- `test/meme-pause-sender.test.ts`: `transactionState` settled / pending / dropped / unknown over a custom transport.
- `test/v2-meme-routes.test.ts`: `hot` page filled past hidden tokens, cursor by ranking remainder; `OPERATOR_USER_REPORTS`.
- `test/v2-market-routes.test.ts`: `listMemeCandidates(100, sort)`, one batched slot0 read per page with only the page's pool.
- `test/meme-pool-price.test.ts`: `readMany` one multicall, cache, per-pool failure, whole-call failure.
- `test/v2-meta-routes.test.ts`, `test/v2-session-routes.test.ts`: `defaultRoute: "chat"`.
- `test/market-meme-candidates.integration.test.ts` (PostgreSQL): curve bucket cut by each sort, hidden/paused excluded, graduated bucket by recency.
- `test/admin-console.integration.test.ts` (PostgreSQL): review audit rows.

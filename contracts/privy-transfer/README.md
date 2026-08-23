# Privy same-chain transfer production contract v6

Privy official SDKs and Wallet API are the wallet and delivery core. Stream is only the communication authority; Hyperliquid is only the Perp authority. viem and Anza packages are thin address/ENS/Solana adapters. They do not own formatting, signing, wallets, delivery, action polling, webhooks, reconciliation, or any provider lifecycle. Custom formatter, signature, wallet, or provider-lifecycle implementations are forbidden.

## Disabled production boundary

Missing credentials fail closed. No declared SDK is installed or imported by this static prototype. The offline app continues to display Simulated Privy — no network, no signing. production_integration_complete is false.

Deployment configuration categories come only from a secret manager:

- Privy public application, server authorization, user authorization, policy, and optional Enterprise webhook categories
- Alchemy EVM RPC and ENS allowlisted-network audit category
- Chainalysis screening category; endpoint and raw fields remain pending_credentialed_audit
- isolated staging and production applications, wallets, policies, and webhook categories

## Six operations and the page/private boundary

There are exactly six BFF operations.

`recipient_preflight` is one POST operation with two exact authenticated request/response variants. `resolve` accepts only `command`, `asset_selection_id`, and `recipient_input`. `acknowledge` accepts only `command`, opaque `preflight_handle`, and `acknowledgement_kind`. The server derives the owner/wallet/epoch/asset/recipient digest binding, records only explicit user acknowledgement, and clears it after every material change.

Page-level `review_prepare` returns exactly `{prepared_review_handle}`. Formatter bytes and digests are forbidden from F3–F5 page responses.

`authorization_submission` remains one operation with two private F11/Flutter commands. `issue_payload` is reachable only from F11 Continue through the private signer handoff; it accepts an opaque prepared handle and returns the prepared handle, `official_formatter_envelope_bytes_base64`, and `official_formatter_envelope_sha256`. `submit_signature` accepts only the handle, authorization signature, and that full-envelope digest. The server compares them to the full formatter-envelope bytes and digest retained in its private authenticated session.

The server uses `@privy-io/node` 0.29.0 `formatRequestForAuthorizationSignature`. Flutter uses `privy_flutter` 0.10.1 `PrivyUser.generateAuthorizationSignatureFromBytes` after canonical base64-to-`Uint8List` decoding. The Flutter dependency is pinned to the exact pub.dev archive URL and SHA-256 `3f3b3215b0ea41ad059ed5a11a9edadcfffa72b6efed45e9694c089281ef643e`; both registry metadata and the archive `pubspec.yaml` identify `https://github.com/privy-io/flutter-sdk` without a `.git` suffix, and the archive carries the MIT license. Privy is the cryptographic authority. The BFF only validates encoding, presence, digest, and private-session binding; it does not implement cryptography.

## Exact replay and state lifecycle

The replay schema keeps `body_base64`/`body_sha256` separate from `official_formatter_envelope_bytes_base64`/`official_formatter_envelope_sha256`. The full envelope covers exact `{version,url,method,headers,body}`. The verifier strictly decodes canonical base64 and canonical JSON, rejects `{}`, rejects body-only substitution, deep-compares URL, POST, the three signed headers and transfer body, and binds duplicated idempotency key, expiry, server session, replay material, signature submission, and SubmissionAttempt to one full-envelope digest. The in-contract byte sequence lives only under `schema_examples`, states `schema_example_only_not_provider_evidence`, and is only a serialization example—not an official formatter golden or provider output. Task 4 must replace pending evidence by running the official formatter.

SubmissionAttempt uses exact required/null presence rules plus persistent `transport_ordinal`, `replay_origin`, and `replay_reason`. Eight `unknown_reason` variants distinguish prewrite crash ambiguity, initial write/timeout ambiguity, response-before-durable-record, expiry, first 5xx before replay, a second uncertain outcome after the sole replay, second synchronous 5xx after the sole replay, and nonallowlisted 4xx. The exact replay is ordinal two, preserves its full-envelope digest, idempotency key, original expiry and any earlier 5xx proof, and sets replay count one. Replay start/in-progress is accepted only while `updated_at_ms < request_expiry_ms`; `signed_expiry_elapsed` requires `updated_at_ms >= request_expiry_ms`. The t09 and t13 audit payloads bind the same expiry and observation timestamp, and event occurrence equals that observation. Any later timeout, ambiguous response or 5xx is durably unknown, retains the lock, and can never replay again. Safe terminal states erase replay material.

When replay follows the first synchronous 5xx, `replay_reason=first_synchronous_5xx` requires the append-only first 5xx proof to survive replay-in-progress, durable response recording, and action binding. Its record version remains strictly below the post-replay parent record version. A replay caused by another uncertain outcome uses `replay_reason=other_uncertain` and carries no synthetic 5xx. The legal success history is explicit: t05 first 5xx → t09 exact replay → t10 durable response → t11 action bind, with one submission/owner/wallet/action/envelope-digest identity. The companion `SubmissionAttempt` and audit history are one recomputable CAS timeline: t05 points to the first-5xx record, t10 points to the durable response record, and t11's version, fence, and timestamp equal the terminal action-bound attempt. Provider response receipt is later than the first 5xx and no later than its durable t10 event or the terminal update.

The audited definitive-4xx tuple allowlist is empty. Therefore no active `provider_rejected_before_action` instance is permitted. A nonallowlisted 4xx is durably recorded, transitions through `t07_nonallowlisted_4xx` to `submission_unknown`, and retains the lock. A definitive 4xx can unlock only after a credentialed exact tuple and durable no-action proof.

Each allowed transition has a unique `transition_id` and one aligned cut point. `audit_histories` are independent legal traces; mutually exclusive branches are never presented as one history. Every trace starts with an attempt-lock whose predecessor state/version/fence are null and whose after values are positive. Within one trace, every predecessor equals the prior successor, before version/fence equal the prior after values, record version increments by one, identity remains fixed, and event payload is the exact transition-specific union. The designated final events cover every transition exactly. Cross-submission, state rollback and CAS/fence discontinuity are rejected.

Action binding is an exact union. `post_response` references the durable provider response record; `verified_event` references a durable signature-verified exact-action event record and does not fabricate a POST response. Both bind the same submission, owner, wallet, action, record version and fence. Operator close uses an exact reason enum and bounded actor, recomputes the evidence digest, and atomically binds matching tombstone and close/update time.

Recovery performs startup and periodic eligible-state scans. Lease acquisition and renewal use CAS over the current record version, lease owner and fencing token; every acquisition monotonically advances the fence. A stale worker may neither write nor send. The single byte-identical replay is allowed only before the original signed expiry. The successful replay history header and every event bind the same `submission_record_id` / `owner_user_id` / `wallet_id` as the terminal attempt, and its state/version/fencing-token parent chain is contiguous. These are executable contract constraints, not claims that a credentialed production recovery run has occurred.

## Result and polling lifecycle

`GET /v1/transfer/current-result` accepts no query, body, handle, cursor, action ID, or submission ID. The cursor exists only inside the authenticated server session. The response is exactly `TransferResultSnapshot | unavailable`.

Privy REST is the primary polling and conflict-reconciliation source through `GET /v1/wallets/{wallet_id}/actions/{action_id}?include=steps` with server-bound IDs. Its exact status map contains only `pending`, `succeeded`, `rejected`, and `failed`; any unrecognized value is quarantined and projected unavailable pending a Privy schema audit. Pending polling can resume after an authenticated reload. Once the first terminal status is observed, polling permanently stops across route, visibility, and reload changes.

Privy Enterprise webhooks remain disabled until credentialed schema and raw-body signature audits pass. The bounded pre-response inbox has an exact capacity and TTL. Event IDs deduplicate, pending advances once to terminal, conflicts quarantine then reconcile via REST, same-terminal messages merge steps, and similar transactions never bind.

## Pending Flutter and formatter evidence

The canonical formatter SHA file remains exactly `PENDING`. In Flutter and provenance evidence, `authorization_payload_base64` is null and `authorization_payload_sha256` is the literal `PENDING`; the authorization signature, public verification material, official canonical payload digest, generation timestamp, and tool versions remain null. The separately verifiable pub.dev supply-chain evidence—package, version, publisher, archive URL, archive SHA-256, MIT license, and canonical repository—is exact and does not claim that the credentialed formatter/signature run occurred. Status remains `NOT RUN — CREDENTIALS REQUIRED`. The exact Task 4 generation command is recorded but has not run. No fake canonical golden, SDK result, or provider signature evidence is present.

## Staging R0 exact command-to-evidence map

The original six gates remain exact, with `--credentials-required` included in each mapped command:

1. `staging-r0 official-formatter-flutter-signature --credentials-required` → `official_flutter_and_server_formatter_staging_execution`
2. `staging-r0 amount-base-units-decimals-oracle --credentials-required` → `amount_base_units_decimals_independent_oracle`
3. `staging-r0 alchemy-chainalysis-ens-failure-injection --credentials-required` → `credentialed_alchemy_chainalysis_ens_failure_injection`
4. `staging-r0 same-chain-action-steps-explorer-reconcile --credentials-required` → `same_chain_named_asset_action_steps_hash_explorer_reconciliation`
5. `staging-r0 uncertain-submit-at-most-once-proxy --credentials-required` → `uncertain_submit_cut_points_at_most_once`
6. `staging-r0 succeeded-only-balance-history-recalculation --credentials-required` → `succeeded_only_balance_history_refresh_recalculation`

Additional audits may append evidence, but cannot replace or rename these gates. All remain NOT RUN — CREDENTIALS REQUIRED.

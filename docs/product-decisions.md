# LOOP API current product decisions

Status: current scope baseline. These decisions override conflicting historical
prototype research in `contracts/integration-catalog/` and
`contracts/app-integrations-p0/`. They do not claim that any provider is live.

## Provider boundaries

- Privy is the identity credential, wallet, authorization, and signing provider.
- Hyperliquid is the Core-whitelist perpetual market provider.
- Stream Chat + Stream Video/Audio Rooms is the current Chat and voice provider.
- LOOP implements thin adapters, policy mapping, orchestration, and projections;
  it does not implement replacement wallet, matching, Chat, RTC, or SFU cores.

The repository now has a local Fastify runtime, the Development
`POST /v1/bootstrap` Privy verification boundary, and implemented Stream token
HTTP interfaces backed by persistent issuance policy. It also has six strict
Hyperliquid Testnet private-read HTTP interfaces with server-owned wallet
authority, freshness, decimal-string, Core-market, and opaque-cursor checks. It
also has a durable master-wallet binding lifecycle, fresh exact Privy wallet
resolution, and a lossless fixed-Testnet private reader guarded by a global
weighted quota. The reader is default-off. The repository still has no
production deployment, successful real-token physical-device evidence,
licensed Stream issuer composition, nonempty Testnet-account end-to-end
evidence, or private trading mutation path. Stream remains `blocked-provider`;
Hyperliquid private reads are implemented but not yet “integrated” under the
evidence definition below.

The generic reconciliation loop now has a separate process entry point and
runtime image. Its default-off fixed-Testnet capability can reconcile only a
Core limit `order` through strict cloid-bound Info evidence and atomically
finalize generic plus Perp records. Market orders and unsupported Perp actions
are operator-held before a provider call. The worker has no provider writer,
replay path, transfer finalizer, or deployment; read-only process operability is
not provider-integration evidence.

## Identity model

The durable LOOP account key is a random, opaque internal user ID. Stream user
IDs and other provider subjects are derived or mapped server-side from that
internal identity.

Bootstrap derives the future Stream subject as
`loop_<lowercase-internal-uuid-without-hyphens>`. Returning that subject does not
connect Stream or mint a Chat/Video token.

Wallets are bindable, replaceable credentials. A user may attach, rotate, or
remove an eligible wallet without replacing the internal account, social graph,
Chat identity, preferences, or audit ownership. Client-selected wallet addresses
must not become database primary keys, Stream user IDs, or trusted authorization
claims.

The current lifecycle supports the Privy embedded Ethereum master wallet only.
An explicit version-checked PUT may select a sole eligible wallet or refresh the
exact stored wallet; it never accepts authority from the client. The API exposes
only binding state, monotonic epoch, fixed-or-null account kind, and last
verification time. Interactive selection among multiple wallets and subaccounts
requires a separate decision.

## Local personalization and inactive alerts

Decision 0009 selects LOOP PostgreSQL as the narrow system of record for the
current user's mutable alias/opaque avatar reference, privacy preferences,
grouped ordered Watchlist, inactive price-alert definitions, notification
preferences, and sanitized alert-event history.

This ownership is deliberately local and non-authoritative. Alias is display
data, asset keys are references rather than market facts, and
`copy_trade_visibility` does not authorize following or trading. Profile and
Watchlist replacements use optimistic versions; alert creation uses a UUID
idempotency key and canonical decimal-string threshold.

No alert can be activated in the current runtime. There is no selected price
fact/evaluator/scheduler, no trigger writer, no Firebase device registration or
delivery, and no notification inbox. An enabled preference records user intent
while the API continues to report delivery unavailable. Social discovery,
following/followers/blocklist, copy-trading authorization, account export/delete,
and retention automation require separate decisions.

## Stream large-group Go/No-Go

The product target includes a persistent group with up to 200,000 members. LOOP
must not assume that one Stream channel satisfies this target.

A persistent 200,000-member single-channel design is allowed only after Stream
confirms the following in writing and credentialed tests reproduce the approved
semantics:

- member limit and persistent message-history behavior;
- concurrent connections, fan-out, read/unread, mentions, replies, and reactions;
- member and message pagination;
- moderation roles and operational controls;
- API/event rate limits and failure behavior;
- commercial pricing, support model, and SLA.

If written confirmation is missing, incomplete, or negative, the required model
is partitioned groups/topic channels with an application-level directory,
discovery, and aggregate presentation. LOOP must not build a custom IM transport
or pretend multiple channels are one provider-level channel.

## Pay scope

Pay and payment processing are outside the current phase. The backend must not add
payment intent, QR payment, payment confirmation, fiat on-ramp/off-ramp, payment
provider, settlement, ledger, or payment webhook endpoints. Historical Pay and
MoonPay records remain only for traceability and future re-evaluation.

## Risk presentation

LOOP may display verifiable facts returned by an approved authoritative source,
including the source, observation time, and freshness/availability state. Unknown,
stale, malformed, or unavailable facts must remain visibly unknown or unavailable.

LOOP does not endorse an “AI Guard” verdict, proprietary risk score, or synthetic
numeric safety rating. Model-generated text, provider marketing language, and
fixtures cannot be promoted to risk authority. Sanctions, contract, address,
approval, and transaction-preview facts retain their separate provider scopes and
must not be collapsed into an unsupported universal score.

## Definition of integrated

A provider may be described as integrated only after all of the following exist:

1. exact SDK/API version and license approval;
2. production runtime composition with fail-closed configuration;
3. server-only credential handling and short-lived client authorization;
4. credentialed sandbox/testnet tests, including negative and reconnect cases;
5. device evidence for Flutter paths that depend on native SDK behavior;
6. observability, audit, rate-limit, privacy, export, and deletion controls;
7. a deployed environment whose endpoint ownership and runbook are recorded.

Until then, the correct labels are “selected”, “contract baseline”, “prototype”,
or “pending”, never “live” or “integrated”.

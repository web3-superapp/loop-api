# Contract status

These files were migrated from `Doog-bot534/web3-superapp-prototype` as implementation evidence and design inputs. They are not generated from a running production backend.

## Current baselines

- `hyperliquid-core-perp/`: Hyperliquid Core market and account contract baseline.
- `privy-transfer/`: Privy authorization and transfer contract baseline.
- `stream-chat/`: Stream Chat + Stream Video/Audio Rooms provider boundary.
- `stream-ui/`: presentation projections over the Stream communication boundary.

All current baselines still require review against the exact SDK/API versions selected during implementation, credentialed sandbox or testnet integration, and automated contract tests. No live SDK, server runtime, deployed token endpoint, or provider connection exists in this repository.

The 200,000-member persistent single-group requirement is not an assumed Stream capability. It remains a Go/No-Go pending written provider confirmation of the exact scale, semantics, pricing, limits, and SLA. The default implementation model is partitioned groups/topic channels until that confirmation is accepted.

## Historical records

- `app-integrations-p0/`: earlier P0 provider-orchestration proposal.
- `integration-catalog/`: provider research, locks, and screen inventory from the prototype phase.

Historical catalog entries for Pay, payment providers, AI Guard, or numerical risk scoring are not current implementation authority. Pay is outside the current backend scope. Risk presentation may expose only verifiable provider facts with their source and observation time.

Do not implement a provider solely because it appears in a historical contract. The root `README.md` and `docs/product-decisions.md` define the current system boundary.

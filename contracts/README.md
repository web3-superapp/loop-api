# Contract status

These files were migrated from `Doog-bot534/web3-superapp-prototype` as implementation evidence and design inputs. They are not generated from a running production backend.

## Current baselines

- `hyperliquid-core-perp/`: Hyperliquid Core market and account contract baseline.
- `privy-transfer/`: Privy authorization and transfer contract baseline.

Both still require review against the exact SDK/API versions selected during implementation, credentialed sandbox or testnet integration, and automated contract tests.

## Historical records

- `app-integrations-p0/`: earlier P0 provider-orchestration proposal.
- `integration-catalog/`: provider research, locks, and screen inventory from the prototype phase.
- `stream-chat/` and `stream-ui/`: superseded communication proposal retained only for traceability. LOOP's current communication target is Agora Chat + RTC.

Do not implement a provider solely because it appears in a historical contract. The root `README.md` defines the current system boundary.

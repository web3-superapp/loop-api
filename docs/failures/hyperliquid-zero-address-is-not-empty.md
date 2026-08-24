# Hyperliquid zero address is not an empty account

## Summary

The EVM zero address cannot be used as a placeholder when a LOOP user has no
verified Hyperliquid account binding. Hyperliquid accepts it as an ordinary
account query subject, so doing so can return unrelated real Testnet data.

## Root Cause

Hyperliquid private Info reads are keyed by the supplied 42-character master or
subaccount address. The API does not define a special missing-account address.
The zero address is therefore a valid lookup key, not an empty-result sentinel.

## Detection

A read-only Testnet probe on 2026-08-24 returned nonempty clearinghouse data and
a saturated fills response for the zero address. No response body or account
fact is retained here; the significant evidence is that the result was not an
empty sentinel.

## Prevention

- Resolve a unique current server-verified wallet binding before every private
  read.
- Return `wallet_binding_required` before provider work when the binding is
  missing or ambiguous.
- Reject the zero address and malformed/noncanonical addresses at the feature
  boundary, even if a resolver returns one.
- Keep regression tests proving that the reader is not called for those cases.

## Evidence

- Hyperliquid documents that user data must be queried with the actual master or
  subaccount address and warns against using an agent address:
  <https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint>
- The read-only Testnet observation above was made against the documented
  Testnet API origin on 2026-08-24.
